import { describe, it, expect, beforeEach } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { createLogger, _captureEntries, _captureLines, _reset } from './logger'
import type { Logger } from './types'
import { useLogger, type UseLoggerOptions } from './middleware'

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
        level: 'ERROR',
        message: 'request.end GET /boom',
        statusCode: 418,
        err: expect.objectContaining({ message: 'boom' }),
      }),
    )
    expect(entries.filter(messageStartsWith('request.error'))).toEqual([])
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
    // c.error is set, so the default level is ERROR even though the status is 4xx.
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'ERROR',
        message: 'request.end GET /bad-request',
        statusCode: 400,
        err: expect.objectContaining({ message: 'bad request' }),
      }),
    )
    expect(entries.filter(messageStartsWith('request.error'))).toEqual([])
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

  it('trustIncoming: false still uses a valid c.var.requestId from an earlier middleware', async () => {
    const options: UseLoggerOptions = { requestId: { trustIncoming: false } }
    const id = await requestIdOf(requestIdApp(options, setRequestIdVar('from-app')), {
      'X-Request-Id': 'from-client',
    })
    expect(id).toBe('from-app')
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

  it('records cfRay with trustIncoming: false, without using it as the request ID', async () => {
    const { entries, app } = cfRayApp({ requestId: { trustIncoming: false } })
    await app.request('/', { headers: { 'cf-ray': CF_RAY } })
    const end = entries().find(messageStartsWith('request.end'))!
    expect(end.cfRay).toBe(CF_RAY)
    expect(end.requestId).not.toBe(CF_RAY)
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

function optionsApp(options?: UseLoggerOptions) {
  const lines = _captureLines()
  const app = new Hono()
  app.use(useLogger(createLogger({ service: 'test-mw', level: 'trace' }), options))
  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  const ends = () => entries().filter(messageStartsWith('request.end'))
  const end = () => {
    expect(ends()).toHaveLength(1)
    return ends()[0]
  }
  const starts = () => entries().filter(messageStartsWith('request.start'))
  const start = () => starts()[0]
  const warnings = () => entries().filter((e) => e.level === 'WARN' && e.hook !== undefined)
  return { lines, entries, ends, end, starts, start, warnings, app }
}

describe('useLogger request.end level', () => {
  beforeEach(() => _reset())

  it('writes one request.end at ERROR with err, statusCode, duration, route and path for a thrown 500', async () => {
    const { entries, end, app } = optionsApp()
    app.get('/users/:id', () => {
      throw new Error('kaboom')
    })

    expect((await app.request('/users/42')).status).toBe(500)

    expect(end()).toMatchObject({
      level: 'ERROR',
      message: 'request.end GET /users/42',
      err: expect.objectContaining({ message: 'kaboom' }),
      statusCode: 500,
      duration: expect.any(Number),
      route: '/users/:id',
      path: '/users/42',
    })
    expect(entries().filter(messageStartsWith('request.error'))).toEqual([])
  })

  it('writes ERROR for a returned 5xx, without err', async () => {
    const { end, app } = optionsApp()
    app.get('/down', (c) => c.text('down', 503))
    await app.request('/down')
    expect(end()).toMatchObject({ level: 'ERROR', statusCode: 503 })
    expect(end()).not.toHaveProperty('err')
  })

  it('writes WARN for a 404 on an unmatched path', async () => {
    const { end, app } = optionsApp()
    app.get('/known', (c) => c.text('ok'))
    expect((await app.request('/unknown')).status).toBe(404)
    expect(end()).toMatchObject({ level: 'WARN', statusCode: 404, path: '/unknown' })
  })

  it('writes WARN for a returned 4xx and INFO for 2xx and 3xx', async () => {
    for (const [status, level] of [
      [401, 'WARN'],
      [499, 'WARN'],
      [200, 'INFO'],
      [204, 'INFO'],
      [302, 'INFO'],
    ] as const) {
      const { end, app } = optionsApp()
      app.get('/', () => new Response(null, { status }))
      await app.request('/')
      expect(end()).toMatchObject({ level, statusCode: status })
    }
  })

  it('uses the level option, called with the status, the error and the Hono context', async () => {
    const calls: unknown[][] = []
    const { end, app } = optionsApp({
      level: (status, err, c) => {
        calls.push([status, err?.message, c.req.method])
        return 'fatal'
      },
    })
    app.get('/', () => {
      throw new Error('x')
    })
    await app.request('/')
    expect(end()).toMatchObject({ level: 'FATAL' })
    expect(calls).toEqual([[500, 'x', 'GET']])
  })
})

describe('useLogger route', () => {
  beforeEach(() => _reset())

  it('logs the matched pattern on request.start and request.end, not the concrete path', async () => {
    const { start, end, app } = optionsApp()
    app.get('/users/:id/items/:item', (c) => c.text('ok'))
    await app.request('/users/8f3a/items/42')
    const expected = { route: '/users/:id/items/:item', path: '/users/8f3a/items/42' }
    expect(start()).toMatchObject(expected)
    expect(end()).toMatchObject(expected)
  })

  it('includes the base path of a mounted sub-app', async () => {
    const { end, app } = optionsApp()
    const api = new Hono()
    api.get('/items/:n', (c) => c.text('ok'))
    app.route('/api', api)
    await app.request('/api/items/3')
    expect(end().route).toBe('/api/items/:n')
  })

  it("keeps the handler's pattern when a middleware answers before the handler runs", async () => {
    const { end, app } = optionsApp()
    app.use('/admin/*', async (c) => c.text('denied', 401))
    app.get('/admin/users/:id', (c) => c.text('ok'))
    expect((await app.request('/admin/users/7')).status).toBe(401)
    expect(end()).toMatchObject({ statusCode: 401, route: '/admin/users/:id' })
  })

  it('ignores a catch-all handler registered after the one that answered', async () => {
    const { start, end, app } = optionsApp()
    app.get('/users/:id', (c) => c.text('ok'))
    app.get('*', (c) => c.text('fallback'))
    await app.request('/users/1')
    expect(start().route).toBe('/users/:id')
    expect(end().route).toBe('/users/:id')
  })

  it('logs the handler on request.end when a middleware registered with app.get runs first', async () => {
    const { start, end, app } = optionsApp()
    app.get('/api/*', async (_c, next) => {
      await next()
    })
    app.get('/api/users/:id', (c) => c.text('ok'))
    await app.request('/api/users/1')
    // request.start is written before the handlers run, so it can only expect the first one.
    expect(start().route).toBe('/api/*')
    expect(end().route).toBe('/api/users/:id')
  })

  it('uses the wildcard pattern when only a wildcard handler matches', async () => {
    const { end, app } = optionsApp()
    app.get('/users/:id', (c) => c.text('ok'))
    app.get('/files/*', (c) => c.text('fallback'))
    await app.request('/files/a/b')
    expect(end().route).toBe('/files/*')
  })

  it('logs the pattern of an app.all handler', async () => {
    const { end, app } = optionsApp()
    app.all('/any/:x', (c) => c.text('ok'))
    await app.request('/any/1', { method: 'DELETE' })
    expect(end().route).toBe('/any/:x')
  })

  it("uses the last matching middleware's pattern when no handler matches", async () => {
    const { end, app } = optionsApp()
    app.get('/known', (c) => c.text('ok'))
    await app.request('/unknown')
    expect(end().route).toBe('/*')
  })
})

describe('useLogger requestStart', () => {
  beforeEach(() => _reset())

  it('writes request.start by default', async () => {
    const { start, app } = optionsApp()
    app.get('/', (c) => c.text('ok'))
    await app.request('/')
    expect(start()).toMatchObject({ level: 'INFO', method: 'GET', path: '/', route: '/' })
  })

  it('requestStart: false writes no request.start, and still writes request.end', async () => {
    const { starts, end, app } = optionsApp({ requestStart: false })
    app.get('/', (c) => c.text('ok'))
    await app.request('/')
    expect(starts()).toEqual([])
    expect(end()).toMatchObject({ statusCode: 200 })
  })
})

describe('useLogger fields and endFields', () => {
  beforeEach(() => _reset())

  it('adds fields to every line of the request, as Context Fields', async () => {
    const { entries, app } = optionsApp({
      fields: (c) => ({ tenant: c.req.header('x-tenant') }),
    })
    app.get('/', (c) => {
      ;(c.get('logger' as never) as Logger).info('from handler')
      return c.text('ok')
    })
    await app.request('/', { headers: { 'x-tenant': 't-1' } })
    expect(entries()).toHaveLength(3)
    for (const entry of entries()) expect(entry.tenant).toBe('t-1')
  })

  it('does not let fields replace requestId or cfRay', async () => {
    const { entries, app } = optionsApp({
      fields: () => ({ requestId: 'forged', cfRay: 'forged' }),
    })
    app.get('/', (c) => c.text('ok'))
    await app.request('/', { headers: { 'X-Request-Id': 'r-1', 'cf-ray': CF_RAY } })
    expect(entries().length).toBeGreaterThan(0)
    for (const entry of entries()) expect(entry).toMatchObject({ requestId: 'r-1', cfRay: CF_RAY })
  })

  it('adds endFields to request.end only, computed after the handler ran', async () => {
    const { entries, start, end, app } = optionsApp({
      endFields: (c) => ({ userId: c.get('userId' as never) }),
    })
    app.get('/', (c) => {
      c.set('userId' as never, 'u-42' as never)
      ;(c.get('logger' as never) as Logger).info('from handler')
      return c.text('ok')
    })
    await app.request('/')
    expect(end().userId).toBe('u-42')
    expect(start()).not.toHaveProperty('userId')
    expect(entries().find((e) => e.message === 'from handler')).not.toHaveProperty('userId')
  })

  it('does not let endFields replace the request.end fields, requestId or cfRay', async () => {
    const { end, app } = optionsApp({
      endFields: () => ({
        statusCode: 1,
        route: 'forged',
        path: 'forged',
        duration: -1,
        requestId: 'forged',
        cfRay: 'forged',
      }),
    })
    app.get('/x', (c) => c.text('ok'))
    await app.request('/x', { headers: { 'X-Request-Id': 'r-1', 'cf-ray': CF_RAY } })
    expect(end()).toMatchObject({
      statusCode: 200,
      route: '/x',
      path: '/x',
      requestId: 'r-1',
      cfRay: CF_RAY,
    })
    expect(end().duration).toBeGreaterThanOrEqual(0)
  })

  it('does not add a cfRay to request.end when the request has none', async () => {
    const { end, app } = optionsApp({ endFields: () => ({ cfRay: 'forged' }) })
    app.get('/x', (c) => c.text('ok'))
    await app.request('/x')
    expect(end()).not.toHaveProperty('cfRay')
  })
})

function throwingHook(): never {
  throw new Error('broke')
}

describe('useLogger hook errors', () => {
  beforeEach(() => _reset())

  it('a throwing fields hook leaves the response alone, keeps both request lines, and warns once', async () => {
    const { starts, ends, warnings, app } = optionsApp({
      fields: () => {
        throw new Error('fields broke')
      },
    })
    app.get('/', (c) => c.text('handled'))

    for (let i = 0; i < 2; i++) {
      const res = await app.request('/')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('handled')
    }

    expect(starts()).toHaveLength(2)
    expect(ends()).toHaveLength(2)
    for (const e of ends()) expect(e).toMatchObject({ level: 'INFO', statusCode: 200, route: '/' })
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatchObject({
      hook: 'fields',
      err: expect.objectContaining({ message: 'fields broke' }),
      requestId: expect.any(String),
      traceId: expect.any(String),
    })
  })

  it('a throwing endFields hook keeps request.end without its fields, and warns once', async () => {
    const { ends, warnings, app } = optionsApp({
      endFields: () => {
        throw new Error('endFields broke')
      },
    })
    app.get('/', (c) => c.text('handled'))

    for (let i = 0; i < 2; i++) expect(await (await app.request('/')).text()).toBe('handled')

    expect(ends()).toHaveLength(2)
    for (const e of ends()) expect(e).toMatchObject({ level: 'INFO', statusCode: 200, route: '/' })
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatchObject({
      hook: 'endFields',
      err: expect.objectContaining({ message: 'endFields broke' }),
    })
  })

  it('a throwing level hook falls back to the default level, and warns once', async () => {
    const { ends, warnings, app } = optionsApp({
      level: () => {
        throw new Error('level broke')
      },
    })
    app.get('/', (c) => c.text('nope', 404))

    for (let i = 0; i < 2; i++) expect((await app.request('/')).status).toBe(404)

    expect(ends()).toHaveLength(2)
    for (const e of ends()) expect(e).toMatchObject({ level: 'WARN', statusCode: 404 })
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatchObject({
      hook: 'level',
      err: expect.objectContaining({ message: 'level broke' }),
    })
  })

  it('a level hook that returns an unknown level falls back to the default level, and warns', async () => {
    const { end, warnings, app } = optionsApp({ level: () => 'warning' as never })
    app.get('/', (c) => c.text('ok'))
    await app.request('/')
    expect(end()).toMatchObject({ level: 'INFO' })
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatchObject({ hook: 'level', returned: 'warning' })
  })

  it('treats an async fields or endFields hook as a failure: no fields, one WARN each', async () => {
    const { entries, ends, warnings, app } = optionsApp({
      fields: (async () => ({ tenant: 't-1' })) as never,
      endFields: (async () => ({ userId: 'u-1' })) as never,
    })
    app.get('/', (c) => c.text('ok'))
    await app.request('/')
    for (const entry of entries()) {
      expect(entry).not.toHaveProperty('tenant')
      expect(entry).not.toHaveProperty('userId')
    }
    expect(ends()).toHaveLength(1)
    expect(warnings().map((w) => [w.hook, w.returned])).toEqual([
      ['fields', 'Promise'],
      ['endFields', 'Promise'],
    ])
  })

  it('treats a fields hook that returns a string or an array as a failure', async () => {
    for (const value of ['abc', ['a']]) {
      const { entries, warnings, app } = optionsApp({ fields: () => value as never })
      app.get('/', (c) => c.text('ok'))
      await app.request('/')
      for (const entry of entries()) expect(entry).not.toHaveProperty('0')
      expect(warnings()).toHaveLength(1)
      expect(warnings()[0].hook).toBe('fields')
    }
  })

  it('accepts a fields or endFields hook that returns undefined, without a WARN', async () => {
    const { ends, warnings, app } = optionsApp({
      fields: () => undefined,
      endFields: () => undefined,
    })
    app.get('/', (c) => c.text('ok'))
    await app.request('/')
    expect(ends()).toHaveLength(1)
    expect(warnings()).toEqual([])
  })

  it('warns once per useLogger instance', async () => {
    const lines = _captureLines()
    for (let i = 0; i < 2; i++) {
      const app = new Hono()
      app.use(useLogger(createLogger({ service: 'test-mw' }), { endFields: throwingHook }))
      app.get('/', (c) => c.text('ok'))
      await app.request('/')
      await app.request('/')
    }
    const warns = lines.map((l) => JSON.parse(l)).filter((e) => e.hook === 'endFields')
    expect(warns).toHaveLength(2)
  })
})

describe('useLogger query string', () => {
  beforeEach(() => _reset())

  it('never logs the query string, with every option on', async () => {
    const { lines, end, app } = optionsApp({ include: { userAgent: true, cf: true } })
    app.get('/search', (c) => c.text('ok'))
    await app.request('/search?token=s3cr3t&q=private')
    expect(end()).toMatchObject({
      path: '/search',
      route: '/search',
      message: 'request.end GET /search',
    })
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).not.toContain('s3cr3t')
      expect(line).not.toContain('private')
      expect(line).not.toContain('?')
    }
  })
})

function cfRequest(path: string, cf?: Record<string, unknown>, headers: HeadersInit = {}) {
  const req = new Request(`http://localhost${path}`, { headers })
  if (cf) Object.defineProperty(req, 'cf', { value: cf })
  return req
}

const CF = { colo: 'SJC', country: 'US', asn: 13335, city: 'San Jose', tlsVersion: 'TLSv1.3' }
const CF_BASICS = { colo: 'SJC', country: 'US', asn: 13335 }

describe('useLogger include', () => {
  beforeEach(() => _reset())

  it('adds no userAgent or cf by default', async () => {
    const { entries, app } = optionsApp()
    app.get('/', (c) => c.text('ok'))
    await app.request(cfRequest('/', CF, { 'user-agent': 'curl/8' }))
    expect(entries().length).toBeGreaterThan(0)
    for (const entry of entries()) {
      expect(entry).not.toHaveProperty('userAgent')
      expect(entry).not.toHaveProperty('cf')
    }
  })

  it('adds userAgent and cf colo, country and asn to request.start and request.end only', async () => {
    const { entries, start, end, app } = optionsApp({ include: { userAgent: true, cf: true } })
    app.get('/', (c) => {
      ;(c.get('logger' as never) as Logger).info('from handler')
      return c.text('ok')
    })
    await app.request(cfRequest('/', CF, { 'user-agent': 'curl/8' }))
    for (const line of [start(), end()]) {
      expect(line.userAgent).toBe('curl/8')
      expect(line.cf).toEqual(CF_BASICS)
    }
    const handlerLine = entries().find((e) => e.message === 'from handler')
    expect(handlerLine).not.toHaveProperty('userAgent')
    expect(handlerLine).not.toHaveProperty('cf')
  })

  it('includes only what was asked for', async () => {
    const { end, app } = optionsApp({ include: { cf: true } })
    app.get('/', (c) => c.text('ok'))
    await app.request(cfRequest('/', CF, { 'user-agent': 'curl/8' }))
    expect(end()).not.toHaveProperty('userAgent')
    expect(end().cf).toEqual(CF_BASICS)
  })

  it('omits userAgent and cf when the request has neither, as on Node.js', async () => {
    const { end, app } = optionsApp({ include: { userAgent: true, cf: true } })
    app.get('/', (c) => c.text('ok'))
    await app.request(cfRequest('/'))
    expect(end()).not.toHaveProperty('userAgent')
    expect(end()).not.toHaveProperty('cf')
  })

  it('leaves out cf values of the wrong type', async () => {
    const { end, app } = optionsApp({ include: { cf: true } })
    app.get('/', (c) => c.text('ok'))
    await app.request(cfRequest('/', { colo: 'SJC', country: { x: 1 }, asn: '13335' }))
    expect(end().cf).toEqual({ colo: 'SJC' })
  })
})
