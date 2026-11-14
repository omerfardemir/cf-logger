import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createLogger,
  getLogger,
  getTraceContext,
  runWithLogger,
  setLoggerContext,
  _captureEntries,
  _reset,
} from './logger'
import { tracedFetch, tracedFetcher } from './fetch'
import { parseTraceparent } from './trace'

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c'
const CALLER_SPAN = 'b7ad6b7169203331'
const TRACEPARENT = `00-${TRACE_ID}-${CALLER_SPAN}-01`

const rootLogger = () => createLogger({ service: 'fetch-svc' })

/** A Fetcher-shaped mock that records every call. */
function mockBinding(respond: () => Promise<Response> = async () => new Response('ok')) {
  const fetch = vi.fn((..._args: unknown[]) => respond())
  const connect = vi.fn(function (this: unknown) {
    return this
  })
  return { fetch, connect }
}

/** The headers the binding would send for a call: init's headers, else the Request's. */
function sentHeaders(args: unknown[]): Headers {
  const [input, init] = args as [unknown, RequestInit | undefined]
  if (init?.headers !== undefined) return new Headers(init.headers)
  return input instanceof Request ? input.headers : new Headers()
}

function inContext<R>(fn: () => R, fields?: Record<string, string>): R {
  return runWithLogger({ logger: rootLogger(), traceparent: TRACEPARENT, fields }, fn)
}

describe('tracedFetcher', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it("sends a traceparent carrying the caller's trace ID and span", async () => {
    const binding = mockBinding()
    let spanId: string | undefined
    await inContext(async () => {
      spanId = getTraceContext()!.spanId
      await tracedFetcher(binding).fetch('https://svc/api')
    })

    const parsed = parseTraceparent(sentHeaders(binding.fetch.mock.calls[0]).get('traceparent')!)
    expect(parsed?.traceId).toBe(TRACE_ID)
    expect(parsed?.spanId).toBe(spanId)
  })

  it('sends tracestate when the trace has one', async () => {
    const binding = mockBinding()
    await runWithLogger(
      { logger: rootLogger(), traceparent: TRACEPARENT, tracestate: 'congo=t61rcWkgMzE' },
      () => tracedFetcher(binding).fetch('https://svc/api'),
    )
    expect(sentHeaders(binding.fetch.mock.calls[0]).get('tracestate')).toBe('congo=t61rcWkgMzE')
  })

  it('fetch(input, init): keeps init and its headers, without mutating init or its Headers', async () => {
    const binding = mockBinding()
    const callerHeaders = new Headers({ Authorization: 'Bearer abc' })
    const signal = new AbortController().signal
    const init: RequestInit = {
      method: 'POST',
      body: '{"a":1}',
      headers: callerHeaders,
      redirect: 'manual',
      signal,
    }
    const before = { ...init }

    await inContext(() => tracedFetcher(binding).fetch('https://svc/api', init))

    expect(init).toEqual(before)
    expect(init.headers).toBe(callerHeaders)
    expect([...callerHeaders]).toEqual([['authorization', 'Bearer abc']])

    const [input, sent] = binding.fetch.mock.calls[0] as [string, RequestInit]
    expect(input).toBe('https://svc/api')
    expect(sent).not.toBe(init)
    expect(sent).toMatchObject({ method: 'POST', body: '{"a":1}', redirect: 'manual', signal })
    const headers = new Headers(sent.headers)
    expect(headers.get('authorization')).toBe('Bearer abc')
    expect(headers.get('traceparent')).toMatch(new RegExp(`^00-${TRACE_ID}-`))
  })

  it('fetch(request): keeps the request and its streaming body, without mutating it', async () => {
    const binding = mockBinding()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed'))
        controller.close()
      },
    })
    const request = new Request('https://svc/upload', {
      method: 'PUT',
      body: stream,
      headers: { 'X-Custom': 'v' },
      redirect: 'manual',
      duplex: 'half',
    } as RequestInit)

    await inContext(() => tracedFetcher(binding).fetch(request))

    // The caller's Request is untouched: same headers, body not read.
    expect([...request.headers]).toEqual([['x-custom', 'v']])
    expect(request.bodyUsed).toBe(false)

    const [input, sent] = binding.fetch.mock.calls[0] as [Request, RequestInit]
    expect(input).toBe(request)
    // Only headers are overridden; method, body, redirect, signal (and cf) come from the Request.
    expect(Object.keys(sent)).toEqual(['headers'])
    const headers = new Headers(sent.headers)
    expect(headers.get('x-custom')).toBe('v')
    expect(headers.get('traceparent')).toMatch(new RegExp(`^00-${TRACE_ID}-`))

    // What the binding builds from these arguments keeps the body and method.
    const built = new Request(input, sent)
    expect(built.method).toBe('PUT')
    expect(built.redirect).toBe('manual')
    expect(await built.text()).toBe('streamed')
  })

  it('fetch(request, init): init headers win over the Request headers, as in fetch()', async () => {
    const binding = mockBinding()
    const request = new Request('https://svc/api', { headers: { 'X-From': 'request' } })
    await inContext(() => tracedFetcher(binding).fetch(request, { headers: { 'X-From': 'init' } }))
    const headers = sentHeaders(binding.fetch.mock.calls[0])
    expect(headers.get('x-from')).toBe('init')
    expect(headers.get('traceparent')).toBeTruthy()
  })

  it('fetch(url, request): uses a Request passed as init without mutating it', async () => {
    const binding = mockBinding()
    const forwarded = new Request('https://old/api', {
      method: 'POST',
      body: 'payload',
      headers: { 'X-Custom': 'v' },
    })
    await inContext(() => tracedFetcher(binding).fetch('https://svc/api', forwarded))

    expect([...forwarded.headers]).toEqual([
      ['content-type', 'text/plain;charset=UTF-8'],
      ['x-custom', 'v'],
    ])
    const [input, sent] = binding.fetch.mock.calls[0] as [string, Request]
    expect(input).toBe('https://svc/api')
    const built = new Request(input, sent)
    expect(built.method).toBe('POST')
    expect(built.headers.get('x-custom')).toBe('v')
    expect(built.headers.get('traceparent')).toBeTruthy()
    expect(await built.text()).toBe('payload')
  })

  it('outside a Logging Context, passes the same arguments through and returns the same promise', async () => {
    const response = new Response('ok')
    const promise = Promise.resolve(response)
    const binding = { fetch: vi.fn((..._args: unknown[]) => promise) }
    const request = new Request('https://svc/api')
    const init = { headers: { 'X-Custom': 'v' } }

    const svc = tracedFetcher(binding, { spans: true, forwardRequestId: true })
    expect(svc.fetch(request)).toBe(promise)
    expect(svc.fetch('https://svc/api', init)).toBe(promise)

    expect(binding.fetch.mock.calls[0]).toEqual([request])
    expect(binding.fetch.mock.calls[0][0]).toBe(request)
    expect(binding.fetch.mock.calls[1][1]).toBe(init)
    expect(init).toEqual({ headers: { 'X-Custom': 'v' } })
  })

  it('returns what the binding returns and rejects with the same error', async () => {
    const response = new Response('hi', { status: 503 })
    const ok = mockBinding(async () => response)
    await inContext(async () => {
      expect(await tracedFetcher(ok).fetch('https://svc/api')).toBe(response)
    })

    const error = new TypeError('network down')
    const failing = mockBinding(() => Promise.reject(error))
    await inContext(async () => {
      await expect(tracedFetcher(failing).fetch('https://svc/api')).rejects.toBe(error)
    })
    expect(failing.fetch).toHaveBeenCalledOnce() // no retry
  })

  it('a header value it cannot send never fails the call: it is left out', async () => {
    const binding = mockBinding()
    await runWithLogger(
      { logger: rootLogger(), traceparent: TRACEPARENT, tracestate: 'bad\nvalue' },
      () => tracedFetcher(binding).fetch('https://svc/api'),
    )
    const headers = sentHeaders(binding.fetch.mock.calls[0])
    expect(headers.get('traceparent')).toBeTruthy()
    expect(headers.has('tracestate')).toBe(false)
  })

  it('invalid caller headers reach the binding unchanged, so it throws its own error', async () => {
    const binding = mockBinding()
    const init = { headers: [['bad header', 'v']] } as unknown as RequestInit
    await inContext(() => tracedFetcher(binding).fetch('https://svc/api', init))
    expect(binding.fetch.mock.calls[0]).toEqual(['https://svc/api', init])
    expect(binding.fetch.mock.calls[0][1]).toBe(init)
  })

  describe('forwardRequestId', () => {
    it('is off by default', async () => {
      const binding = mockBinding()
      await inContext(() => tracedFetcher(binding).fetch('https://svc/api'), { requestId: 'r-1' })
      expect(sentHeaders(binding.fetch.mock.calls[0]).has('x-request-id')).toBe(false)
    })

    it('sends the requestId Context Field as X-Request-Id', async () => {
      const binding = mockBinding()
      const svc = tracedFetcher(binding, { forwardRequestId: true })
      await inContext(() => svc.fetch('https://svc/api'), { requestId: 'r-1' })
      await inContext(() => svc.fetch(new Request('https://svc/api')), { requestId: 'r-2' })
      expect(sentHeaders(binding.fetch.mock.calls[0]).get('x-request-id')).toBe('r-1')
      expect(sentHeaders(binding.fetch.mock.calls[1]).get('x-request-id')).toBe('r-2')
    })

    it('reads requestId when the call is made, after setLoggerContext', async () => {
      const binding = mockBinding()
      await inContext(() => {
        setLoggerContext({ requestId: 'set-later' })
        return tracedFetcher(binding, { forwardRequestId: true }).fetch('https://svc/api')
      })
      expect(sentHeaders(binding.fetch.mock.calls[0]).get('x-request-id')).toBe('set-later')
    })

    it('never overwrites an X-Request-Id the caller set, in init or on the Request', async () => {
      const binding = mockBinding()
      const svc = tracedFetcher(binding, { forwardRequestId: true })
      await inContext(
        async () => {
          await svc.fetch('https://svc/api', { headers: { 'x-request-id': 'mine' } })
          await svc.fetch(new Request('https://svc/api', { headers: { 'X-Request-Id': 'mine-2' } }))
        },
        { requestId: 'context-id' },
      )
      expect(sentHeaders(binding.fetch.mock.calls[0]).get('x-request-id')).toBe('mine')
      expect(sentHeaders(binding.fetch.mock.calls[1]).get('x-request-id')).toBe('mine-2')
    })

    it('sends nothing when there is no requestId, or it is not a safe header value', async () => {
      const binding = mockBinding()
      const svc = tracedFetcher(binding, { forwardRequestId: true })
      await inContext(() => svc.fetch('https://svc/api'))
      await inContext(() => svc.fetch('https://svc/api'), { requestId: 'a\r\nb' })
      expect(sentHeaders(binding.fetch.mock.calls[0]).has('x-request-id')).toBe(false)
      expect(sentHeaders(binding.fetch.mock.calls[1]).has('x-request-id')).toBe(false)
    })
  })

  describe('spans', () => {
    it('writes no span by default', async () => {
      const entries = _captureEntries()
      await inContext(() => tracedFetcher(mockBinding()).fetch('https://svc/api'))
      expect(entries).toEqual([])
    })

    it('writes one span.end per call with method, host, path (no query) and statusCode', async () => {
      const entries = _captureEntries()
      const binding = mockBinding(async () => new Response(null, { status: 201 }))
      const svc = tracedFetcher(binding, { spans: true })
      await inContext(async () => {
        await svc.fetch('https://svc.internal:8443/users/42?token=secret#frag', { method: 'post' })
        await svc.fetch(new Request('https://svc.internal/health'))
      })

      expect(entries).toHaveLength(2)
      const [first, second] = entries
      expect(first).toMatchObject({
        level: 'INFO',
        message: 'span.end fetch',
        method: 'POST',
        host: 'svc.internal:8443',
        path: '/users/42',
        statusCode: 201,
        span: { operation: 'fetch', status: 'OK' },
      })
      expect(JSON.stringify(first)).not.toContain('secret')
      expect(second).toMatchObject({ method: 'GET', host: 'svc.internal', path: '/health' })
    })

    it('the span is the parent of the downstream work: traceparent carries its span ID', async () => {
      const entries = _captureEntries()
      const binding = mockBinding()
      await inContext(() => tracedFetcher(binding, { spans: true }).fetch('https://svc/api'))

      const sent = parseTraceparent(sentHeaders(binding.fetch.mock.calls[0]).get('traceparent')!)
      expect(entries[0].traceId).toBe(TRACE_ID)
      expect(entries[0].spanId).toBe(sent?.spanId)
      expect(entries[0].parentSpanId).not.toBe(sent?.spanId)
    })

    it('a 5xx response is a successful call: OK status, statusCode recorded, no throw', async () => {
      const entries = _captureEntries()
      const response = new Response(null, { status: 502 })
      const svc = tracedFetcher(
        mockBinding(async () => response),
        { spans: true },
      )
      const res = await inContext(() => svc.fetch('https://svc/api'))
      expect(res).toBe(response)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ level: 'INFO', statusCode: 502, span: { status: 'OK' } })
    })

    it('logs ERROR on a network failure and rethrows the same error', async () => {
      const entries = _captureEntries()
      const error = new TypeError('Network connection lost.')
      const binding = mockBinding(() => Promise.reject(error))
      const svc = tracedFetcher(binding, { spans: true })

      await inContext(async () => {
        await expect(svc.fetch('https://svc/api?key=1')).rejects.toBe(error)
      })

      expect(binding.fetch).toHaveBeenCalledOnce()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        level: 'ERROR',
        message: 'span.end fetch',
        method: 'GET',
        host: 'svc',
        path: '/api',
        span: { status: 'ERROR', error: 'Network connection lost.' },
      })
      expect(entries[0].statusCode).toBeUndefined()
    })

    it('a binding that throws synchronously still throws synchronously, after an ERROR span', () => {
      const entries = _captureEntries()
      const error = new Error('sync')
      const binding = {
        fetch: (_input: string): Promise<Response> => {
          throw error
        },
      }
      inContext(() => {
        expect(() => tracedFetcher(binding, { spans: true }).fetch('https://svc/api')).toThrow(
          error,
        )
      })
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ level: 'ERROR', span: { status: 'ERROR' } })
    })

    it('span fields stay on the span.end line, not in the caller context', async () => {
      const entries = _captureEntries()
      await inContext(async () => {
        await tracedFetcher(mockBinding(), { spans: true }).fetch('https://svc/api')
        getLogger().info('after')
      })
      expect(entries[1].message).toBe('after')
      expect(entries[1].path).toBeUndefined()
      expect(entries[1].statusCode).toBeUndefined()
    })

    it('outside a Logging Context, writes no span', async () => {
      const entries = _captureEntries()
      await tracedFetcher(mockBinding(), { spans: true }).fetch('https://svc/api')
      expect(entries).toEqual([])
    })
  })

  describe('Fetcher shape', () => {
    it('passes other members through, called on the binding itself', () => {
      const binding = mockBinding()
      const svc = tracedFetcher(binding)
      expect(svc.connect()).toBe(binding)
      expect(binding.connect).toHaveBeenCalledOnce()
    })

    it('passes non-function members and RPC-style methods through', async () => {
      const binding = {
        fetch: async () => new Response('ok'),
        name: 'svc',
        add: vi.fn(async (a: number, b: number) => a + b),
      }
      const svc = tracedFetcher(binding)
      expect(svc.name).toBe('svc')
      expect(await svc.add(2, 3)).toBe(5)
      expect('add' in svc).toBe(true)
    })

    it('does not change the binding', async () => {
      const binding = mockBinding()
      const original = binding.fetch
      tracedFetcher(binding, { spans: true })
      expect(binding.fetch).toBe(original)
    })
  })
})

describe('tracedFetch options', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('records a span with spans: true', async () => {
    const entries = _captureEntries()
    const mockFetch = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', mockFetch)

    await inContext(() =>
      tracedFetch('https://api.example.com/v1/items?page=2', undefined, { spans: true }),
    )

    expect(mockFetch).toHaveBeenCalledOnce()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      message: 'span.end fetch',
      method: 'GET',
      host: 'api.example.com',
      path: '/v1/items',
      statusCode: 404,
    })
  })

  it('logs ERROR on a network failure and rethrows the same error', async () => {
    const entries = _captureEntries()
    const error = new TypeError('fetch failed')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(error)),
    )

    await inContext(async () => {
      await expect(tracedFetch('https://api.example.com/', {}, { spans: true })).rejects.toBe(error)
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ level: 'ERROR', span: { status: 'ERROR' } })
  })

  it('keeps the headers of a Request passed on its own', async () => {
    const mockFetch = vi.fn(async (..._args: unknown[]) => new Response('ok'))
    vi.stubGlobal('fetch', mockFetch)
    const request = new Request('https://api.example.com/', { headers: { Authorization: 'x' } })

    await inContext(() => tracedFetch(request))

    const headers = sentHeaders(mockFetch.mock.calls[0])
    expect(headers.get('authorization')).toBe('x')
    expect(headers.get('traceparent')).toBeTruthy()
    expect([...request.headers]).toEqual([['authorization', 'x']])
  })
})
