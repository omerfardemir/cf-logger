import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createLogger,
  runWithLogger,
  setLoggerContext,
  getTraceContext,
  withSpan,
  _captureEntries,
  _captureLines,
  _setSink,
  _reset,
} from './logger'
import { nodeSink, workersSink, serializeError, stringifyRecord, type Sink } from './output'

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

class DbError extends Error {
  code = 'E_DB'
}

/** The same calls, inside a Logging Context, for comparing adapters. */
function logScenario() {
  const logger = createLogger({
    service: 'contract',
    level: 'trace',
    environment: 'test',
    version: '1.0.0',
  })
  runWithLogger({ logger, traceparent: TRACEPARENT, fields: { requestId: 'req-1' } }, () => {
    const log = logger.child({ component: 'db' })
    log.trace('trace line')
    log.debug({ n: 1 }, 'debug %d', 1)
    log.info({ user: 'u-1' }, 'info line')
    log.warn(new Error('bare warning'))
    log.error({ err: new DbError('query failed', { cause: new Error('socket closed') }) }, 'boom')
    log.fatal('fatal line')
  })
}

/** Run `fn` with `next` as the sink, capturing every console method call. */
function captureConsole(next: Sink, fn: () => void): Array<[method: string, line: string]> {
  const calls: Array<[string, string]> = []
  const methods = ['log', 'debug', 'info', 'warn', 'error'] as const
  const spies = methods.map((m) =>
    vi.spyOn(console, m).mockImplementation((line: string) => calls.push([m, line])),
  )
  const previous = _setSink(next)
  try {
    fn()
  } finally {
    _setSink(previous)
    for (const s of spies) s.mockRestore()
  }
  return calls
}

/** Strip what legitimately differs between two runs: time, the new span ID, stack positions. */
const normalize = (line: string) =>
  line
    .replace(/"time":"[^"]+"/, '"time":"<t>"')
    .replace(/"spanId":"[0-9a-f]+"/, '"spanId":"<span>"')
    .replace(/"stack":"(?:\\.|[^"\\])*"/g, '"stack":"<stack>"')

describe('runtime adapters', () => {
  beforeEach(() => _reset())

  it('Node and Workers write byte-identical lines (time aside) for the same calls', () => {
    const node = captureConsole(nodeSink, logScenario)
    const workers = captureConsole(workersSink, logScenario)

    expect(node).toHaveLength(6)
    expect(node.map(([, line]) => normalize(line))).toEqual(
      workers.map(([, line]) => normalize(line)),
    )
  })

  it('Node writes every level to console.log', () => {
    const node = captureConsole(nodeSink, logScenario)
    expect(new Set(node.map(([method]) => method))).toEqual(new Set(['log']))
  })

  it('Workers picks the console method by level', () => {
    const workers = captureConsole(workersSink, logScenario)
    expect(workers.map(([method]) => method)).toEqual([
      'debug',
      'debug',
      'info',
      'warn',
      'error',
      'error',
    ])
  })
})

describe('record shape', () => {
  beforeEach(() => _reset())

  it('starts with time and level, and has no pid or hostname', () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).info('hello')

    expect(Object.keys(entries[0]).slice(0, 2)).toEqual(['time', 'level'])
    expect(entries[0]).not.toHaveProperty('pid')
    expect(entries[0]).not.toHaveProperty('hostname')
    expect(entries[0]).toMatchObject({ level: 'INFO', service: 'svc', message: 'hello' })
  })

  it('precedence: trace IDs > log-call fields > logger bindings > Context Fields', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    let trace: ReturnType<typeof getTraceContext>

    runWithLogger(
      { logger, traceparent: TRACEPARENT, fields: { requestId: 'ctx', a: 'ctx' } },
      () => {
        trace = getTraceContext()
        setLoggerContext({ b: 'ctx' })
        logger
          .child({ a: 'binding', b: 'binding' })
          .info({ requestId: 'call', traceId: 'forged', parentSpanId: 'forged' }, 'm')
      },
    )

    expect(entries[0]).toMatchObject({
      requestId: 'call',
      a: 'binding',
      b: 'binding',
      traceId: trace!.traceId,
      spanId: trace!.spanId,
      parentSpanId: trace!.parentSpanId,
    })
  })

  it('a log call cannot invent a parentSpanId on a root trace', () => {
    const entries = _captureEntries()
    runWithLogger({ logger: createLogger({ service: 'svc' }) }, () => {
      createLogger({ service: 'svc' }).info({ parentSpanId: 'forged' }, 'm')
    })
    expect(entries[0]).not.toHaveProperty('parentSpanId')
  })

  it('never throws on circular values or BigInt', () => {
    const entries = _captureEntries()
    const loop: Record<string, unknown> = { name: 'loop' }
    loop.self = loop

    createLogger({ service: 'svc' }).info({ loop, big: 10n }, 'odd values')

    expect(entries[0]).toMatchObject({ loop: { name: 'loop', self: '[Circular]' }, big: '10' })
  })
})

describe('errors', () => {
  beforeEach(() => _reset())
  afterEach(() => vi.restoreAllMocks())

  it('keeps a bare Error passed as the first argument', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })

    logger.error(new Error('bare'))
    logger.warn(new Error('with message'), 'custom %s', 'text')

    expect(entries[0]).toMatchObject({ message: 'bare', err: { type: 'Error', message: 'bare' } })
    expect(typeof (entries[0].err as Record<string, unknown>).stack).toBe('string')
    expect(entries[1]).toMatchObject({ message: 'custom text', err: { message: 'with message' } })
  })

  it('serializes own props and nests cause', () => {
    const entries = _captureEntries()
    const err = new DbError('query failed', { cause: new Error('socket closed') })

    createLogger({ service: 'svc' }).error({ err }, 'boom')

    expect(entries[0].err).toMatchObject({
      type: 'DbError',
      message: 'query failed',
      code: 'E_DB',
      cause: { type: 'Error', message: 'socket closed' },
    })
  })

  it('serializes Error values under any top-level key', () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).warn({ reason: new TypeError('bad input') }, 'rejected')
    expect(entries[0].reason).toMatchObject({ type: 'TypeError', message: 'bad input' })
  })

  it('cuts off deep or circular cause chains', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    a.cause = b

    const serialized = serializeError(a)
    const line = stringifyRecord(serialized)

    let depth = 0
    let node = serialized
    while (node.cause && typeof node.cause === 'object') {
      node = node.cause as Record<string, unknown>
      depth++
    }
    expect(depth).toBe(6)
    expect(node.type).toBe('Truncated')
    expect(line.length).toBeGreaterThan(0)
  })
})

/** Strip time, generated span IDs, stacks and span timing, everywhere in a line. */
const normalizeAll = (line: string) =>
  line
    .replace(/"time":"[^"]+"/g, '"time":"<t>"')
    .replace(/"spanId":"[0-9a-f]+"/g, '"spanId":"<span>"')
    .replace(/"parentSpanId":"(?!b7ad)[0-9a-f]+"/g, '"parentSpanId":"<parent>"')
    .replace(/"stack":"(?:\\.|[^"\\])*"/g, '"stack":"<stack>"')
    .replace(/"(start|end)Time":\d+/g, '"$1Time":0')
    .replace(/"duration":\d+/g, '"duration":0')

/**
 * Lines written by loggercf 0.0.1 (on pino 10) for the scenario below, captured
 * before pino was replaced. Key order included: the internal core must match.
 */
const PINO_LINES = [
  String.raw`{"time":"<t>","level":"INFO","service":"svc","environment":"test","version":"1.0.0","region":"eu","message":"outside"}`,
  String.raw`{"time":"<t>","level":"DEBUG","requestId":"req-1","a":"call","service":"svc","environment":"test","version":"1.0.0","region":"eu","component":"db","sub":1,"n":1,"message":"debug 1","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
  String.raw`{"time":"<t>","level":"INFO","requestId":"req-1","a":"binding","service":"svc","environment":"test","version":"1.0.0","region":"eu","component":"db","sub":1,"user":"u-1","message":"info line","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
  String.raw`{"time":"<t>","level":"WARN","requestId":"req-1","a":"binding","service":"svc","environment":"test","version":"1.0.0","region":"eu","component":"db","sub":1,"err":{"type":"Error","message":"bare warning","stack":"<stack>"},"message":"bare warning","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
  String.raw`{"time":"<t>","level":"ERROR","requestId":"req-1","a":"binding","service":"svc","environment":"test","version":"1.0.0","region":"eu","component":"db","sub":1,"err":{"type":"DbError","message":"query failed","stack":"<stack>","code":"E_DB","cause":{"type":"Error","message":"socket closed","stack":"<stack>"}},"message":"boom","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
  String.raw`{"time":"<t>","level":"FATAL","requestId":"req-1","a":"binding","service":"svc","environment":"test","version":"1.0.0","region":"eu","component":"db","sub":1,"message":"fatal x {\"k\":1}","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
  String.raw`{"time":"<t>","level":"INFO","requestId":"req-1","a":"binding","service":"svc","environment":"test","version":"1.0.0","region":"eu","component":"db","sub":1,"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
  String.raw`{"time":"<t>","level":"INFO","requestId":"req-1","a":"binding","service":"svc","environment":"test","version":"1.0.0","region":"eu","component":"db","sub":1,"m":1,"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"b7ad6b7169203331"}`,
  String.raw`{"time":"<t>","level":"INFO","requestId":"req-1","a":"ctx","service":"svc","environment":"test","version":"1.0.0","region":"eu","span":{"operation":"op","startTime":0,"endTime":0,"duration":0,"status":"OK"},"message":"span.end op","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"<parent>"}`,
  String.raw`{"time":"<t>","level":"ERROR","requestId":"req-1","a":"ctx","service":"svc","environment":"test","version":"1.0.0","region":"eu","span":{"operation":"op2","startTime":0,"endTime":0,"duration":0,"status":"ERROR","error":"x"},"err":{"type":"Error","message":"x","stack":"<stack>"},"message":"span.end op2","traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"<span>","parentSpanId":"<parent>"}`,
]

describe('same lines as the pino-based logger', () => {
  beforeEach(() => _reset())

  it('writes byte-identical lines (time, IDs and stacks aside)', async () => {
    const lines = _captureLines()
    const logger = createLogger(
      { service: 'svc', level: 'debug', environment: 'test', version: '1.0.0' },
      { region: 'eu' },
    )
    logger.trace('dropped by level')
    logger.info('outside')
    await runWithLogger(
      { logger, traceparent: TRACEPARENT, fields: { requestId: 'req-1', a: 'ctx' } },
      async () => {
        const log = logger.child({ component: 'db', a: 'binding' }).child({ sub: 1 })
        log.debug({ n: 1, a: 'call' }, 'debug %d', 1)
        log.info({ user: 'u-1' }, 'info line')
        log.warn(new Error('bare warning'))
        log.error(
          { err: new DbError('query failed', { cause: new Error('socket closed') }) },
          'boom',
        )
        log.fatal('fatal %s %j', 'x', { k: 1 })
        log.info({})
        log.info({ m: 1 })
        withSpan('op', () => 1)
        await withSpan('op2', async () => {
          throw new Error('x')
        }).catch(() => {})
      },
    )
    expect(lines.map(normalizeAll)).toEqual(PINO_LINES)
  })
})

describe('levels and child loggers', () => {
  beforeEach(() => _reset())

  it('writes only levels at or above the minimum', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc', level: 'warn' })
    logger.trace('t')
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    logger.fatal('f')
    expect(entries.map((e) => e.level)).toEqual(['WARN', 'ERROR', 'FATAL'])
  })

  it("'silent' writes nothing, and an unknown level throws as before", () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc', level: 'silent' as never }).fatal('f')
    expect(entries).toHaveLength(0)
    expect(() => createLogger({ service: 'svc', level: 'INFO' as never })).toThrow(
      'unknown level INFO',
    )
  })

  it('child() merges bindings immutably: the parent never sees them', () => {
    const entries = _captureEntries()
    const parent = createLogger({ service: 'svc' }, { a: 'root' })
    const child = parent.child({ a: 'child', b: 1 })
    parent.info('p')
    child.info('c')
    child.child({ c: 2 }).info('g')
    expect(entries[0]).toMatchObject({ a: 'root' })
    expect(entries[0]).not.toHaveProperty('b')
    expect(entries[1]).toMatchObject({ a: 'child', b: 1 })
    expect(entries[1]).not.toHaveProperty('c')
    expect(entries[2]).toMatchObject({ a: 'child', b: 1, c: 2 })
  })
})
