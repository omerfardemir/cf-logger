import { getContextField, getTraceCarrier, setLoggerContext, withSpan } from './logger'
import { injectCarrier } from './trace'

/**
 * Options for `tracedFetch` and `tracedFetcher`. Every option is off by default.
 */
export interface TracedFetchOptions {
  /**
   * Record each call as a Span (`span.end fetch`), with `method`, `host`, `path` (the pathname
   * only: the query string can carry tokens) and the response `statusCode`. A call that throws
   * or rejects (a network failure) is logged at `ERROR` and the same error is rethrown. Any
   * response, 5xx included, is a completed call: the Span's status is `OK` and `statusCode`
   * says what came back. Written only inside a Logging Context, when the trace is sampled.
   */
  spans?: boolean
  /**
   * Send the current `requestId` Context Field as `X-Request-Id`, so the receiver's
   * `useLogger` can reuse it (subject to its own validation). Never overwrites an
   * `X-Request-Id` the caller set, in `init` or on the `Request`.
   */
  forwardRequestId?: boolean
}

/** The shape `tracedFetcher` needs: anything with a `fetch` like a service binding's. */
type FetchLike = (...args: any[]) => Promise<unknown>

/** The Span operation name for an outgoing call. */
const SPAN_OPERATION = 'fetch'

/**
 * A value `Headers#set` accepts and sends unchanged: printable ASCII with no leading or
 * trailing space. Anything else is left out rather than making the call throw.
 */
const SAFE_HEADER_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/

function isRequest(value: unknown): value is Request {
  return typeof Request !== 'undefined' && value instanceof Request
}

/**
 * The arguments to call `fetch` with, carrying the current Trace Carrier (and the Request ID,
 * when asked) in a new `Headers`. Nothing the caller passed is changed: `init` is copied with
 * new headers, and a `Request` passed as `input` is passed on as it is, so its body (streaming
 * or not) is neither read nor teed and its `method`, `redirect`, `signal` and `cf` still apply.
 *
 * The headers start from what `fetch` itself would send: `init.headers` when given, otherwise
 * the `Request`'s. When they cannot be read (invalid caller headers), the arguments are returned
 * unchanged, so the binding rejects them with its own error.
 */
function propagate(args: unknown[], options: TracedFetchOptions): unknown[] {
  const [input, init] = args as [unknown, RequestInit | undefined]
  let headers: Headers
  try {
    const base =
      init?.headers !== undefined ? init.headers : isRequest(input) ? input.headers : undefined
    headers = new Headers(base)
  } catch {
    return args
  }

  injectCarrier(getTraceCarrier(), (name, value) => {
    if (SAFE_HEADER_VALUE.test(value)) headers.set(name, value)
  })
  if (options.forwardRequestId && !headers.has('x-request-id')) {
    const requestId = getContextField('requestId')
    if (typeof requestId === 'string' && SAFE_HEADER_VALUE.test(requestId)) {
      headers.set('X-Request-Id', requestId)
    }
  }

  if (isRequest(init)) {
    // `fetch(url, request)`: a Request's fields are getters a spread would drop.
    try {
      return [input, new Request(init, { headers })]
    } catch {
      return args
    }
  }
  return [input, { ...init, headers }]
}

/** The Span fields for a call. URL parts are left out when the URL cannot be parsed. */
function describe(args: unknown[]): { method: string; host?: string; path?: string } {
  const [input, init] = args as [unknown, RequestInit | undefined]
  try {
    const request = isRequest(input) ? input : undefined
    const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase()
    let url: URL | undefined
    try {
      url = new URL(request ? request.url : String(input))
    } catch {
      // relative or invalid: fetch will reject it
    }
    return { method, ...(url && { host: url.host, path: url.pathname }) }
  } catch {
    return { method: 'GET' }
  }
}

/**
 * Call `doFetch` with the current Trace Carrier in the headers, optionally as a Span.
 * Outside a Logging Context, calls it with exactly `args` and returns its result.
 * Never retries and never handles an error: what `doFetch` returns or throws is what the
 * caller gets.
 */
function tracedCall<R>(
  doFetch: (...args: unknown[]) => Promise<R>,
  args: unknown[],
  options: TracedFetchOptions,
): Promise<R> {
  if (!getTraceCarrier().traceparent) return doFetch(...args)
  if (!options.spans) return doFetch(...propagate(args, options))

  const fields = describe(args)
  return withSpan(SPAN_OPERATION, () => {
    // Context Fields set inside a Span stay on that Span's lines (its `span.end`).
    setLoggerContext(fields)
    // Inside the Span, so the downstream work's parent is this Span.
    return doFetch(...propagate(args, options)).then((response) => {
      const status = (response as { status?: unknown } | null)?.status
      if (typeof status === 'number') setLoggerContext({ statusCode: status })
      return response
    })
  })
}

/**
 * A `fetch` wrapper that sends the current Trace Carrier as `traceparent` / `tracestate`
 * headers. Takes the same arguments as `fetch`, plus optional `options` (Spans, Request ID
 * forwarding). Never mutates `input` or `init`.
 *
 * Outside a Logging Context, behaves like regular `fetch()`.
 *
 * @param {RequestInfo | URL} input - The fetch URL or Request.
 * @param {RequestInit} [init] - Optional fetch init options. Never mutated.
 * @param {TracedFetchOptions} [options] - `spans`, `forwardRequestId`. All off by default.
 * @returns {Promise<Response>} The fetch response, or the rejection `fetch` gave.
 *
 * @example
 * ```ts
 * const res = await tracedFetch('https://api.example.com/items', undefined, { spans: true })
 * ```
 */
export function tracedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: TracedFetchOptions = {},
): Promise<Response> {
  const args = init === undefined ? [input] : [input, init]
  return tracedCall((...a) => fetch(...(a as [RequestInfo | URL, RequestInit?])), args, options)
}

/**
 * Wrap a service binding (a `Fetcher`) so its `fetch` sends the current Trace Carrier as
 * `traceparent` / `tracestate` headers, both as `fetch(input, init)` and `fetch(request)`.
 * The receiver's `useLogger` continues the trace. Nothing the caller passes is mutated.
 *
 * The result has the binding's type: `connect()` and every other member (RPC methods
 * included) pass through to the binding unchanged. Outside a Logging Context, `fetch` calls
 * the binding with exactly the same arguments. Wrap once and reuse it; pass the original
 * binding (not the wrapper) when handing it on to another Worker.
 *
 * @template T - The binding type (e.g. `Fetcher`, or `Service<MyEntrypoint>`).
 * @param {T} binding - The service binding.
 * @param {TracedFetchOptions} [options] - `spans`, `forwardRequestId`. All off by default.
 * @returns {T} The wrapped binding.
 *
 * @example
 * ```ts
 * const svc = tracedFetcher(c.env.SVC, { forwardRequestId: true, spans: true })
 * const res = await svc.fetch(c.req.raw) // traceparent, tracestate and X-Request-Id sent
 * ```
 */
export function tracedFetcher<T extends { fetch: FetchLike }>(
  binding: T,
  options: TracedFetchOptions = {},
): T {
  const opts = { ...options }
  const fetch = (...args: unknown[]) => tracedCall((...a) => binding.fetch(...a), args, opts)
  // Methods of the binding, called on the binding itself (a platform object rejects any
  // other `this`). Wrapped in a Proxy so properties on them, like RPC pipelining, still work.
  const methods = new WeakMap<object, unknown>()

  return new Proxy(binding, {
    get(target, prop) {
      if (prop === 'fetch') return fetch
      const value: unknown = Reflect.get(target, prop)
      if (typeof value !== 'function') return value
      let method = methods.get(value)
      if (!method) {
        method = new Proxy(value, {
          apply: (fn, _this, args) => Reflect.apply(fn, target, args),
        })
        methods.set(value, method)
      }
      return method
    },
  })
}
