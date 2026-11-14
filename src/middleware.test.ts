import { describe, it, expect, beforeEach } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { createLogger, _captureEntries, _captureLines, _reset } from './logger'
import type { Logger } from './types'
import { useLogger, _resetMiddlewareWarnings, type UseLoggerOptions } from './middleware'

function setup() {
  const entries = _captureEntries()
  const logger = createLogger({ service: 'test-mw' })
  const app = new Hono()
  app.use(useLogger(logger))
  return { entries, app }
}

function messageStartsWith(prefix: string) {
  return (entry: Record<string, unknown>) =>
    typeof entry.message === 'string' && entry.message.startsWith(prefix)
}

describe('useLogger lifecycle logging', () => {
  beforeEach(() => _reset())

  it('emits request.start and request.end on success', async () => {
    const { entries, app } = setup()
    app.get('/hello', (c) => c.text('ok'))

    const res = await app.request('/hello')
    expect(res.status).toBe(200)

    const start = entries.find(messageStartsWith('request.start'))
    expect(start).toBeDefined()
    expect(start!.method).toBe('GET')
    expect(start!.path).toBe('/hello')
    expect(start!.requestId).toBeDefined()
    expect(start!.traceId).toBeDefined()

    const end = entries.find(messageStartsWith('request.end'))
    expect(end).toBeDefined()
    expect(end!.method).toBe('GET')
    expect(end!.path).toBe('/hello')
    expect(end!.statusCode).toBe(200)
    expect(typeof end!.duration).toBe('number')
    expect(end!.duration).toBeGreaterThanOrEqual(0)
  })

  it('emits request.end even when handler throws', async () => {
    const { entries, app } = setup()
    app.get('/boom', () => {
      throw new Error('kaboom')
    })

    const res = await app.request('/boom')
    expect(res.status).toBe(500)

    const end = entries.find(messageStartsWith('request.end'))
    expect(end).toBeDefined()
    expect(end!.statusCode).toBe(500)
    expect(typeof end!.duration).toBe('number')
  })

  it('lets app-level Hono error handling own thrown route errors', async () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'test-mw' })
    const app = new Hono()
    app.onError((err, c) => c.text(`handled: ${err.message}`, 418))
    app.use(useLogger(logger))
    app.get('/boom', () => {
      throw new Error('boom')
    })

    const res = await app.request('/boom')
    expect(res.status).toBe(418)
    expect(await res.text()).toBe('handled: boom')
    expect(entries).toContainEqual(
      expect.objectContaining({
        message: 'request.end GET /boom',
        statusCode: 418,
      }),
    )
    expect(entries).toContainEqual(
      expect.objectContaining({
        message: 'request.error GET /boom',
        statusCode: 418,
        err: expect.objectContaining({ message: 'boom' }),
      }),
    )
  })

  it('logs HTTPException status when Hono turns it into a response', async () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'test-mw' })
    const app = new Hono()
    app.onError((err, c) => {
      if (err instanceof HTTPException) {
        return err.getResponse()
      }
      return c.text('handled', 500)
    })
    app.use(useLogger(logger))
    app.get('/bad-request', () => {
      throw new HTTPException(400, { message: 'bad request' })
    })

    const res = await app.request('/bad-request')
    expect(res.status).toBe(400)
    expect(entries).toContainEqual(
      expect.objectContaining({
        message: 'request.end GET /bad-request',
        statusCode: 400,
      }),
    )
    expect(entries).toContainEqual(
      expect.objectContaining({
        message: 'request.error GET /bad-request',
        statusCode: 400,
        err: expect.objectContaining({ message: 'bad request' }),
      }),
    )
  })

  it('includes correct method and path in lifecycle logs', async () => {
    const { entries, app } = setup()
    app.post('/users', (c) => c.json({ id: 1 }, 201))

    const res = await app.request('/users', { method: 'POST' })
    expect(res.status).toBe(201)

    const start = entries.find(messageStartsWith('request.start'))
    expect(start!.method).toBe('POST')
    expect(start!.path).toBe('/users')

    const end = entries.find(messageStartsWith('request.end'))
    expect(end!.statusCode).toBe(201)
  })

  it('sets response headers', async () => {
    const { app } = setup()
    app.get('/h', (c) => c.text('ok'))

    const res = await app.request('/h')
    expect(res.headers.get('X-Request-Id')).toBeDefined()
    expect(res.headers.get('X-Trace-Id')).toBeDefined()
    expect(res.headers.get('traceparent')).toBeDefined()
  })

  it('sets response headers even on error', async () => {
    const { app } = setup()
    app.get('/fail', () => {
      throw new Error('fail')
    })

    const res = await app.request('/fail')
    expect(res.status).toBe(500)
    expect(res.headers.get('X-Request-Id')).toBeDefined()
    expect(res.headers.get('X-Trace-Id')).toBeDefined()
    expect(res.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-\d{2}$/)
  })

  it('measures duration accurately', async () => {
    const { entries, app } = setup()
    app.get('/slow', async (c) => {
      await new Promise((r) => setTimeout(r, 50))
      return c.text('done')
    })

    await app.request('/slow')

    const end = entries.find(messageStartsWith('request.end'))
    expect(end!.duration).toBeGreaterThanOrEqual(40)
  })

  it('exposes a per-request logger whose lines carry requestId', async () => {
    const { entries, app } = setup()
    let capturedLogger: unknown

    app.get('/child', (c) => {
      capturedLogger = c.get('logger' as never)
      ;(capturedLogger as any).info({}, 'from handler')
      return c.text('ok')
    })

    await app.request('/child')

    const handlerLog = entries.find((e) => e.message === 'from handler')
    expect(handlerLog).toBeDefined()
    expect(handlerLog!.requestId).toBeDefined()
  })

  it('writes requestId exactly once per log line', async () => {
    const lines = _captureLines()
    const app = new Hono()
    app.use(useLogger(createLogger({ service: 'test-mw' })))
    app.get('/once', (c) => {
      ;(c.get('logger' as never) as Logger).info('from handler')
      return c.text('ok')
    })

    await app.request('/once', { headers: { 'X-Request-Id': 'req-once' } })

    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line.match(/"requestId":/g)).toHaveLength(1)
    }
  })

  it('gives different logger instances to concurrent requests', async () => {
    const { app } = setup()
    const loggers: unknown[] = []

    app.get('/concurrent', (c) => {
      loggers.push(c.get('logger' as never))
      return c.text('ok')
    })

    await Promise.all([app.request('/concurrent'), app.request('/concurrent')])

    expect(loggers).toHaveLength(2)
    expect(loggers[0]).not.toBe(loggers[1])
  })

  it('round-trips tracestate header', async () => {
    const { app } = setup()
    app.get('/ts', (c) => c.text('ok'))

    const res = await app.request('/ts', {
      headers: {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        tracestate: 'congo=t61rcWkgMzE,rojo=00f067aa0ba902b7',
      },
    })

    expect(res.headers.get('tracestate')).toBe('congo=t61rcWkgMzE,rojo=00f067aa0ba902b7')
  })

  it('does not set tracestate header when not present on request', async () => {
    const { app } = setup()
    app.get('/no-ts', (c) => c.text('ok'))

    const res = await app.request('/no-ts')
    expect(res.headers.get('tracestate')).toBeNull()
  })
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CF_RAY = '8f1e2d3c4b5a6978-SJC'

function requestIdApp(options?: UseLoggerOptions, before?: MiddlewareHandler) {
  const entries = _captureEntries()
  const app = new Hono()
  if (before) app.use(before)
  app.use(useLogger(createLogger({ service: 'test-mw' }), options))
  app.get('/', (c) => c.text(String(c.get('requestId' as never))))
  return { entries, app }
}

/** Sends one request and returns the request ID, checking line, header and c.var agree. */
async function requestIdOf(
  { app, entries }: ReturnType<typeof requestIdApp>,
  headers: Record<string, string> = {},
  path = '/',
) {
  const res = await app.request(path, { headers })
  const end = entries.find(messageStartsWith('request.end'))!
  expect(res.headers.get('X-Request-Id')).toBe(end.requestId)
  expect(await res.text()).toBe(end.requestId)
  return end.requestId as string
}

const setRequestIdVar =
  (id: string): MiddlewareHandler =>
  async (c, next) => {
    c.set('requestId' as never, id as never)
    await next()
  }

function cfRayApp(options?: UseLoggerOptions) {
  const lines = _captureLines()
  const app = new Hono()
  app.use(useLogger(createLogger({ service: 'test-mw' }), options))
  app.get('/', (c) => {
    ;(c.get('logger' as never) as Logger).info('from handler')
    return c.text('ok')
  })
  return {
    lines,
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    app,
  }
}

describe('useLogger request ID', () => {
  beforeEach(() => _reset())

  it('reuses a valid incoming X-Request-Id', async () => {
    expect(await requestIdOf(requestIdApp(), { 'X-Request-Id': 'req-e2e-local' })).toBe(
      'req-e2e-local',
    )
  })

  it('accepts UUIDs, cf-ray values and IDs with = : .', async () => {
    for (const id of [crypto.randomUUID(), CF_RAY, 'a.b:c=d_e-f']) {
      expect(await requestIdOf(requestIdApp(), { 'X-Request-Id': id })).toBe(id)
    }
  })

  it('generates an ID when there is no incoming one', async () => {
    expect(await requestIdOf(requestIdApp())).toMatch(UUID_RE)
  })

  it('replaces an oversized incoming ID with a generated one', async () => {
    expect(await requestIdOf(requestIdApp(), { 'X-Request-Id': 'a'.repeat(129) })).toMatch(UUID_RE)
  })

  it('accepts an incoming ID of exactly 128 characters', async () => {
    const id = 'a'.repeat(128)
    expect(await requestIdOf(requestIdApp(), { 'X-Request-Id': id })).toBe(id)
  })

  it('replaces an incoming ID with disallowed characters with a generated one', async () => {
    for (const id of ['abc def', 'abc"def', 'abc,requestId=x', '{"a":1}', 'a/b', 'caf%C3%A9']) {
      expect(await requestIdOf(requestIdApp(), { 'X-Request-Id': id })).toMatch(UUID_RE)
    }
  })

  it('falls back to c.var.requestId from an earlier middleware', async () => {
    expect(await requestIdOf(requestIdApp(undefined, setRequestIdVar('from-earlier')))).toBe(
      'from-earlier',
    )
  })

  it('prefers the X-Request-Id header over c.var.requestId by default', async () => {
    const id = await requestIdOf(requestIdApp(undefined, setRequestIdVar('from-earlier')), {
      'X-Request-Id': 'from-header',
    })
    expect(id).toBe('from-header')
  })

  it('falls through an invalid header to c.var.requestId', async () => {
    const id = await requestIdOf(requestIdApp(undefined, setRequestIdVar('from-earlier')), {
      'X-Request-Id': 'bad id',
    })
    expect(id).toBe('from-earlier')
  })

  it('validates c.var.requestId too', async () => {
    expect(await requestIdOf(requestIdApp(undefined, setRequestIdVar('x'.repeat(200))))).toMatch(
      UUID_RE,
    )
  })

  it('respects the from order, with cf-ray as the primary source', async () => {
    const id = await requestIdOf(
      requestIdApp({ requestId: { from: ['cf-ray', 'x-request-id'] } }),
      {
        'cf-ray': CF_RAY,
        'X-Request-Id': 'from-client',
      },
    )
    expect(id).toBe(CF_RAY)
  })

  it('moves to the next source in from when one is missing or invalid', async () => {
    const options: UseLoggerOptions = { requestId: { from: ['cf-ray', 'x-request-id'] } }
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'from-client' })).toBe(
      'from-client',
    )
    expect(
      await requestIdOf(requestIdApp(options), {
        'cf-ray': 'not valid',
        'X-Request-Id': 'from-client',
      }),
    ).toBe('from-client')
  })

  it('reads only the sources listed in from, then c.var.requestId', async () => {
    const options: UseLoggerOptions = { requestId: { from: ['cf-ray'] } }
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'from-client' })).toMatch(
      UUID_RE,
    )
    expect(
      await requestIdOf(requestIdApp(options, setRequestIdVar('from-earlier')), {
        'X-Request-Id': 'from-client',
      }),
    ).toBe('from-earlier')
  })

  it('reads nothing but c.var.requestId with an empty from', async () => {
    const options: UseLoggerOptions = { requestId: { from: [] } }
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'from-client' })).toMatch(
      UUID_RE,
    )
  })

  it('accepts a function as a source', async () => {
    const options: UseLoggerOptions = {
      requestId: { from: [(c) => c.req.query('rid'), 'x-request-id'] },
    }
    expect(
      await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'from-client' }, '/?rid=q-1'),
    ).toBe('q-1')
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'from-client' })).toBe(
      'from-client',
    )
  })

  it('throws when useLogger is built with an invalid header name in from', () => {
    for (const name of ['', 'x request id', 'x-request-id\n']) {
      expect(() =>
        useLogger(createLogger({ service: 'test-mw' }), { requestId: { from: [name] } }),
      ).toThrow(TypeError)
    }
  })

  it('validates values returned by a function source', async () => {
    expect(await requestIdOf(requestIdApp({ requestId: { from: [() => 'bad id'] } }))).toMatch(
      UUID_RE,
    )
  })

  it('trustIncoming: false ignores client headers', async () => {
    const id = await requestIdOf(requestIdApp({ requestId: { trustIncoming: false } }), {
      'X-Request-Id': 'from-client',
    })
    expect(id).toMatch(UUID_RE)
  })

  it('trustIncoming: false ignores every source in from', async () => {
    const options: UseLoggerOptions = {
      requestId: { trustIncoming: false, from: ['cf-ray', () => 'from-function'] },
    }
    expect(await requestIdOf(requestIdApp(options), { 'cf-ray': CF_RAY })).toMatch(UUID_RE)
  })

  it('trustIncoming: false ignores c.var.requestId from an earlier middleware too', async () => {
    const options: UseLoggerOptions = { requestId: { trustIncoming: false } }
    const id = await requestIdOf(requestIdApp(options, setRequestIdVar('from-app')), {
      'X-Request-Id': 'from-client',
    })
    expect(id).toMatch(UUID_RE)
  })

  it('trustIncoming: false still rejects an invalid header name in from at setup', () => {
    expect(() =>
      useLogger(createLogger({ service: 'test-mw' }), {
        requestId: { trustIncoming: false, from: ['x request id'] },
      }),
    ).toThrow(TypeError)
  })

  it('marks every line with requestIdRejected when an incoming ID is rejected', async () => {
    const ctx = requestIdApp()
    const id = await requestIdOf(ctx, { 'X-Request-Id': 'bad id' })
    expect(id).toMatch(UUID_RE)
    expect(ctx.entries.length).toBeGreaterThan(0)
    for (const entry of ctx.entries) {
      expect(entry.requestIdRejected).toBe(true)
      expect(JSON.stringify(entry)).not.toContain('bad id')
    }
  })

  it('marks requestIdRejected when an earlier source fails but a later one is used', async () => {
    const ctx = requestIdApp({ requestId: { from: ['cf-ray', 'x-request-id'] } })
    expect(await requestIdOf(ctx, { 'cf-ray': 'not valid!', 'X-Request-Id': 'r-2' })).toBe('r-2')
    expect(ctx.entries.find(messageStartsWith('request.end'))!.requestIdRejected).toBe(true)
  })

  it('does not mark requestIdRejected when no incoming ID was sent or it was accepted', async () => {
    const cases: Record<string, string>[] = [{}, { 'X-Request-Id': 'r-ok' }]
    for (const headers of cases) {
      const ctx = requestIdApp()
      await requestIdOf(ctx, headers)
      for (const entry of ctx.entries) expect(entry).not.toHaveProperty('requestIdRejected')
    }
  })

  it('rejects a value a custom validate accepts when it is not a safe header value', async () => {
    for (const unsafe of ['a\r\nSet-Cookie: x=1', ' padded ', 'ümlaut']) {
      const ctx = requestIdApp({ requestId: { from: [() => unsafe], validate: () => true } })
      const res = await ctx.app.request('/')
      expect(res.status).toBe(200)
      const end = ctx.entries.find(messageStartsWith('request.end'))!
      expect(end.requestId).toMatch(UUID_RE)
      expect(end.requestIdRejected).toBe(true)
      expect(res.headers.get('X-Request-Id')).toBe(end.requestId)
    }
  })

  it('replaces a generated ID that is not a safe header value, with one WARN per isolate', async () => {
    _resetMiddlewareWarnings()
    for (const bad of ['', 'line\nbreak']) {
      const ctx = requestIdApp({ requestId: { generate: () => bad } })
      expect(await requestIdOf(ctx)).toMatch(UUID_RE)
    }
    const ctx = requestIdApp({ requestId: { generate: () => 'x\ny' } })
    await requestIdOf(ctx)
    // The WARN was written by the first app above; this isolate does not warn again.
    expect(ctx.entries.filter((e) => e.level === 'WARN')).toHaveLength(0)
  })

  it('writes the unsafe generated ID WARN the first time', async () => {
    _resetMiddlewareWarnings()
    const ctx = requestIdApp({ requestId: { generate: () => 'x\ny' } })
    await requestIdOf(ctx)
    const warns = ctx.entries.filter((e) => e.level === 'WARN')
    expect(warns).toHaveLength(1)
    expect(String(warns[0]!.message)).toContain('requestId.generate')
  })

  it('uses a custom generate function, called once with the Hono context', async () => {
    let calls = 0
    const options: UseLoggerOptions = {
      requestId: {
        generate: (c) => {
          calls++
          return `gen-${c.req.method}`
        },
      },
    }
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'bad id' })).toBe('gen-GET')
    expect(calls).toBe(1)
  })

  it('does not call generate when an incoming ID is used', async () => {
    let calls = 0
    const options: UseLoggerOptions = {
      requestId: {
        generate: () => {
          calls++
          return 'generated'
        },
      },
    }
    await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'from-client' })
    expect(calls).toBe(0)
  })

  it('uses a custom validate regex in place of the default', async () => {
    const options: UseLoggerOptions = { requestId: { validate: /^[0-9a-f-]{36}$/ } }
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'req-e2e-local' })).toMatch(
      UUID_RE,
    )
    const uuid = crypto.randomUUID()
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': uuid })).toBe(uuid)
  })

  it('gives the same answer every time for a global validate regex', async () => {
    const options: UseLoggerOptions = { requestId: { validate: /^[a-z-]+$/g } }
    for (let i = 0; i < 3; i++) {
      expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'from-client' })).toBe(
        'from-client',
      )
    }
  })

  it('uses a custom validate function', async () => {
    const seen: string[] = []
    const options: UseLoggerOptions = {
      requestId: {
        validate: (id) => {
          seen.push(id)
          return id.startsWith('ok-')
        },
      },
    }
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'nope' })).toMatch(UUID_RE)
    expect(seen).toEqual(['nope'])
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'ok-1' })).toBe('ok-1')
  })

  it('does not validate the generated ID', async () => {
    const options: UseLoggerOptions = {
      requestId: { validate: () => false, generate: () => 'generated id with spaces' },
    }
    expect(await requestIdOf(requestIdApp(options), { 'X-Request-Id': 'from-client' })).toBe(
      'generated id with spaces',
    )
  })
})

describe('useLogger cfRay', () => {
  beforeEach(() => _reset())

  it('records cfRay on every line when the cf-ray header is present', async () => {
    const { entries, app } = cfRayApp()
    await app.request('/', { headers: { 'cf-ray': CF_RAY, 'X-Request-Id': 'r-1' } })
    expect(entries().length).toBeGreaterThanOrEqual(3)
    for (const entry of entries()) {
      expect(entry.cfRay).toBe(CF_RAY)
      expect(entry.requestId).toBe('r-1')
    }
  })

  it('records cfRay when it is also the request ID, exactly once per line', async () => {
    const { entries, lines, app } = cfRayApp({ requestId: { from: ['cf-ray'] } })
    await app.request('/', { headers: { 'cf-ray': CF_RAY } })
    const end = entries().find(messageStartsWith('request.end'))!
    expect(end.cfRay).toBe(CF_RAY)
    expect(end.requestId).toBe(CF_RAY)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line.match(/"cfRay":/g)).toHaveLength(1)
  })

  it('does not record cfRay with trustIncoming: false', async () => {
    const { entries, app } = cfRayApp({ requestId: { trustIncoming: false } })
    const res = await app.request('/', { headers: { 'cf-ray': CF_RAY } })
    const end = entries().find(messageStartsWith('request.end'))!
    expect(end.requestId).toMatch(UUID_RE)
    expect(res.headers.get('X-Request-Id')).toBe(end.requestId)
    for (const entry of entries()) expect(entry).not.toHaveProperty('cfRay')
  })

  it('omits cfRay when the header is absent', async () => {
    const { entries, app } = cfRayApp()
    await app.request('/')
    expect(entries().length).toBeGreaterThan(0)
    for (const entry of entries()) expect(entry).not.toHaveProperty('cfRay')
  })

  it('omits a cf-ray header that fails the default format check', async () => {
    const { entries, app } = cfRayApp()
    await app.request('/', { headers: { 'cf-ray': 'x'.repeat(500) } })
    expect(entries().length).toBeGreaterThan(0)
    for (const entry of entries()) expect(entry).not.toHaveProperty('cfRay')
  })
})
