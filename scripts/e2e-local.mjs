// End-to-end check against the real Workers runtime (wrangler dev / workerd).
//
// Builds the package, starts the three dev Workers (main → bind → math) with
// `pnpm dev`, sends requests carrying a known traceparent, and asserts:
//   - HTTP: status, X-Request-Id / X-Trace-Id / traceparent / tracestate response headers, bodies.
//   - Logs: the Workers' own output continues the trace across every RPC hop,
//     with the span chain intact and no duplicate keys on any line.
//
// Runs on Linux, macOS and Windows.
//
// Env:
//   CF_LOGGER_E2E_LOG_DIR       where wrangler stdout/stderr logs go (default: OS temp dir)
//   CF_LOGGER_E2E_READY_MS      how long to wait for wrangler to be ready (default: 120000)
//   CF_LOGGER_E2E_SKIP_CLEANUP  set to 1 to leave the dev server running

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const logDir = process.env.CF_LOGGER_E2E_LOG_DIR || tmpdir()
const outLog = join(logDir, 'cf-logger-e2e.out.log')
const errLog = join(logDir, 'cf-logger-e2e.err.log')
const readyTimeoutMs = Number(process.env.CF_LOGGER_E2E_READY_MS || 120_000)

const PORT = 8787
// wrangler prints `127.0.0.1` on Windows and `localhost` on Linux.
const READY_RE = new RegExp(String.raw`Ready on (http://(?:localhost|127\.0\.0\.1):${PORT})`)
const TRACE_ID = '11111111111111111111111111111111'
const PARENT_SPAN_ID = '2222222222222222'
const REQUEST_ID = 'req-e2e-local'
const REQUEST_HEADERS = {
  traceparent: `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`,
  tracestate: 'vendor=value',
  'X-Request-Id': REQUEST_ID,
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function portInUse(port) {
  return new Promise((done) => {
    const socket = connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('error', () => done(false))
  })
}

/**
 * `pnpm <script>` as spawn() arguments. Windows needs a shell to run pnpm.cmd,
 * and a shell takes one command string rather than an args array.
 */
function pnpm(script, options) {
  return isWindows
    ? [`pnpm ${script}`, [], { ...options, cwd: repo, shell: true }]
    : ['pnpm', [script], { ...options, cwd: repo }]
}

function runPnpm(script) {
  const result = spawnSync(...pnpm(script, { stdio: 'inherit' }))
  if (result.status !== 0) throw new Error(`pnpm ${script} failed (exit ${result.status})`)
}

function startDevServer() {
  const out = createWriteStream(outLog)
  const err = createWriteStream(errLog)
  const child = spawn(
    ...pnpm('dev', {
      // Own process group on POSIX so cleanup can stop wrangler and workerd together.
      detached: !isWindows,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    }),
  )
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    out.write(chunk)
  })
  child.stderr.on('data', (chunk) => err.write(chunk))
  const flush = () => Promise.all([out, err].map((s) => new Promise((r) => s.end(r))))
  return { child, readStdout: () => stdout, flush }
}

function stopProcessTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
}

/** Wait for wrangler's Ready line and return the base URL it prints. */
async function waitUntilReady(server) {
  const deadline = Date.now() + readyTimeoutMs
  while (Date.now() < deadline) {
    const ready = READY_RE.exec(server.readStdout())
    if (ready) return ready[1]
    if (server.child.exitCode !== null) break
    await sleep(500)
  }
  await server.flush()
  throw new Error(
    `wrangler dev did not become ready within ${readyTimeoutMs}ms.\n` +
      `--- stdout\n${safeRead(outLog)}\n--- stderr\n${safeRead(errLog)}`,
  )
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

async function probe(base, path, expectedStatus) {
  const res = await fetch(`${base}${path}`, { headers: REQUEST_HEADERS })
  const text = await res.text()
  let body = text
  try {
    body = JSON.parse(text)
  } catch {
    // keep raw text
  }
  return {
    path,
    status: res.status,
    expectedStatus,
    body,
    xRequestId: res.headers.get('X-Request-Id'),
    xTraceId: res.headers.get('X-Trace-Id'),
    traceparent: res.headers.get('traceparent'),
    tracestate: res.headers.get('tracestate'),
  }
}

function checkResponses(results, failures) {
  const byPath = Object.fromEntries(results.map((r) => [r.path, r]))
  const traceparentRe = new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`)

  for (const r of results) {
    if (r.status !== r.expectedStatus)
      failures.push(`${r.path} status ${r.status}, expected ${r.expectedStatus}`)
    if (r.xRequestId !== REQUEST_ID) failures.push(`${r.path} X-Request-Id ${r.xRequestId}`)
    if (r.xTraceId !== TRACE_ID) failures.push(`${r.path} X-Trace-Id ${r.xTraceId}`)
    if (!traceparentRe.test(r.traceparent ?? ''))
      failures.push(`${r.path} traceparent ${r.traceparent}`)
    if (r.tracestate !== 'vendor=value') failures.push(`${r.path} tracestate ${r.tracestate}`)
  }

  const expectBody = (path, key, expected) => {
    const actual = byPath[path]?.body?.[key]
    if (actual !== expected)
      failures.push(
        `${path} body.${key} ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
      )
  }
  expectBody('/', 'total', 12)
  expectBody('/', 'traceId', TRACE_ID)
  expectBody('/multi-hop', 'result', 15)
  expectBody('/multi-hop', 'traceId', TRACE_ID)
  expectBody('/trace', 'traceId', TRACE_ID)
  expectBody('/trace', 'parentSpanId', PARENT_SPAN_ID)
  expectBody('/error', 'error', 'Division by zero')
}

/** Parse the JSON log lines out of wrangler's output (it adds prefixes and ANSI colors). */
function readLogRecords() {
  const raw = `${safeRead(outLog)}\n${safeRead(errLog)}`
  const lines = []
  for (const line of raw.split(/\r?\n/)) {
    const plain = stripVTControlCharacters(line)
    const start = plain.indexOf('{"')
    const end = plain.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    const json = plain.slice(start, end + 1)
    try {
      lines.push({ json, record: JSON.parse(json) })
    } catch {
      // not a log record
    }
  }
  return lines
}

/** The keys of a JSON object's top level, in order, duplicates kept (JSON.parse drops them). */
function topLevelKeys(json) {
  const keys = []
  let depth = 0
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]
    if (ch === '"') {
      let j = i + 1
      while (json[j] !== '"') j += json[j] === '\\' ? 2 : 1
      if (depth === 1 && json[j + 1] === ':') keys.push(JSON.parse(json.slice(i, j + 1)))
      i = j
    } else if (ch === '{' || ch === '[') {
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
    }
  }
  return keys
}

function checkLogs(failures) {
  const lines = readLogRecords().filter(({ record }) => record.traceId === TRACE_ID)
  if (lines.length === 0) {
    failures.push('logs: no Worker log lines carry the request traceId')
    return
  }

  for (const { json } of lines) {
    const keys = topLevelKeys(json)
    const duplicates = keys.filter((key, i) => keys.indexOf(key) !== i)
    if (duplicates.length > 0) {
      failures.push(`logs: duplicate keys ${[...new Set(duplicates)]} in ${json.slice(0, 160)}…`)
    }
  }

  const spans = new Map()
  for (const { record } of lines) {
    if (typeof record.message === 'string' && record.message.startsWith('span.end ')) {
      spans.set(record.message.slice('span.end '.length), record)
    }
  }
  const multiHop = spans.get('bind.multiHop')
  const multiply = spans.get('math.multiply')
  if (!multiHop) failures.push('logs: no span.end bind.multiHop')
  if (!multiply) failures.push('logs: no span.end math.multiply')
  if (multiHop && multiply && multiply.parentSpanId !== multiHop.spanId) {
    failures.push(
      `logs: math.multiply parent ${multiply.parentSpanId} is not bind.multiHop span ${multiHop.spanId}`,
    )
  }
  const divideByZero = spans.get('bind.divideByZero')
  if (divideByZero?.span?.status !== 'ERROR' || divideByZero?.err?.message !== 'Division by zero') {
    failures.push('logs: span.end bind.divideByZero is missing its ERROR status or err')
  }
}

async function main() {
  if (await portInUse(PORT))
    throw new Error(`Port ${PORT} is already in use. Stop it before running e2e.`)

  runPnpm('build')
  const server = startDevServer()
  try {
    const base = await waitUntilReady(server)

    const results = []
    for (const [path, status] of [
      ['/', 200],
      ['/multi-hop', 200],
      ['/trace', 200],
      ['/error', 500],
    ]) {
      results.push(await probe(base, path, status))
    }

    await sleep(1000) // let wrangler flush the Workers' log output
    await server.flush()

    const failures = []
    checkResponses(results, failures)
    checkLogs(failures)

    if (failures.length > 0) {
      console.error(`E2E failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
      console.error(`Wrangler logs: ${outLog}, ${errLog}`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(results, null, 2))
    console.log('E2E passed.')
  } finally {
    if (process.env.CF_LOGGER_E2E_SKIP_CLEANUP !== '1') stopProcessTree(server.child)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
