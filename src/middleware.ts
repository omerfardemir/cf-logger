import type { Context, MiddlewareHandler } from 'hono'
import type { LogFields, Logger } from './types'
import { extractCarrier, injectCarrier } from './trace'
import { getLogger, getTraceCarrier, getTraceContext, runWithLogger } from './logger'
import { registerDefaultLogger } from './logger'

/**
 * Where `useLogger` reads an incoming request ID from: a request header name
 * (case-insensitive), or a function that returns the ID, or `undefined` when it has none.
 */
export type RequestIdSource = string | ((c: Context) => string | undefined)

/**
 * How `useLogger` picks the request ID. The first valid value wins:
 *
 * 1. each source in `from`, in order,
 * 2. `c.var.requestId`, when an earlier middleware set it,
 * 3. `generate(c)`.
 *
 * With `trustIncoming: false`, steps 1 and 2 are skipped: the ID is always generated.
 *
 * Every non-empty value from steps 1 and 2 must pass `validate`; one that fails (or makes
 * `validate` throw) is skipped, and the request's lines get `requestIdRejected: true`. The
 * rejected value is never logged, not even as `cfRay`. An empty value, or a source that
 * returns nothing or a non-string, counts as "none" and is not a rejection.
 * Whatever `validate` says, a value must also be a safe header value (printable ASCII, no
 * leading or trailing space), because it is echoed in the `X-Request-Id` response header.
 * The generated ID is not validated, but when `generate` throws or returns a value that is not
 * a safe header value, `crypto.randomUUID()` is used instead.
 *
 * A source, `validate` or `generate` that throws never fails the request. Each `useLogger()`
 * writes at most one `WARN` for a throwing source or `validate`, and one for a bad `generate`
 * result, through its Root Logger (no error message, since it may echo the ID).
 */
export interface RequestIdOptions {
  /**
   * Sources to read the incoming ID from, in order. A source is a header name or a function.
   * Defaults to `['x-request-id']`. Use `['cf-ray', 'x-request-id']` to prefer Cloudflare's Ray ID.
   * `useLogger` throws a `TypeError` for a header name that is not a valid HTTP header name.
   */
  from?: RequestIdSource[]
  /**
   * `false` always generates the ID: every source in `from` and `c.var.requestId` are ignored,
   * and the `cf-ray` header is not recorded as `cfRay`, so no request header chooses the request
   * ID or adds `cfRay`. Trace headers (`traceparent`, `tracestate`) are still continued.
   * Defaults to `true`.
   */
  trustIncoming?: boolean
  /**
   * Accepts or rejects an incoming ID. Replaces the default check, including its length cap,
   * so anchor a pattern (`^...$`) and bound its length. The safe-header-value check always
   * applies on top of it. Only a literal `true` accepts; any other result, a throw, or a
   * Promise rejects the value.
   * Defaults to `/^[\w\-=:.]{1,128}$/`: 1 to 128 of `A-Z a-z 0-9 _ - = : .`.
   */
  validate?: RegExp | ((id: string, c: Context) => boolean)
  /** Builds an ID when no source gives a valid one. Defaults to `crypto.randomUUID()`. */
  generate?: (c: Context) => string
}

/** Options for `useLogger`. */
export interface UseLoggerOptions {
  /** How the request ID is read, validated and generated. */
  requestId?: RequestIdOptions
}

/** The default `requestId.validate`. Accepts UUIDs and `cf-ray` values. */
const DEFAULT_REQUEST_ID_PATTERN = /^[\w\-=:.]{1,128}$/

/**
 * The check a `cf-ray` header must pass to be recorded as `cfRay`: the default request ID check,
 * whatever `validate` says.
 */
const CF_RAY_PATTERN = DEFAULT_REQUEST_ID_PATTERN

/**
 * A value that can be echoed in a response header unchanged: printable ASCII with no leading or
 * trailing space (`Headers` would trim it, and the header and the log line would differ).
 */
const SAFE_HEADER_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/

const UNSAFE_GENERATED_ID_WARNING =
  'useLogger: requestId.generate threw or returned a value that is not a safe header value; using crypto.randomUUID()'

const REQUEST_ID_CALLBACK_THREW_WARNING =
  'useLogger: a requestId.from source or requestId.validate threw; the value was skipped'

/** What `useLogger` takes from the request for its Context Fields. */
interface PickedRequestId {
  /** The request ID: a valid incoming value, or a generated one. */
  id: string
  /** Whether a non-empty incoming value was rejected on the way. */
  rejected: boolean
  /** The `cf-ray` header, when incoming headers are trusted and it is well formed. */
  cfRay?: string
}

/**
 * Calls an app callback; a throw counts as "no usable value", never as a failed request.
 * A returned Promise gets a no-op rejection handler, so it can't become an unhandled rejection.
 *
 * @param fn - The app callback.
 * @param [onThrow] - Called when `fn` throws.
 * @returns What `fn` returned, or `undefined` when it threw.
 */
function tryCall<R>(fn: () => R, onThrow?: () => void): R | undefined {
  try {
    const value = fn()
    if (value instanceof Promise) value.catch(() => {})
    return value
  } catch {
    onThrow?.()
    return undefined
  }
}

const DEFAULT_REQUEST_ID_SOURCES: readonly RequestIdSource[] = ['x-request-id']

/** An HTTP header name: one or more RFC 9110 token characters. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function matches(pattern: RegExp, value: string): boolean {
  // A global or sticky RegExp keeps state in lastIndex between test() calls.
  pattern.lastIndex = 0
  return pattern.test(value)
}

/**
 * Builds the per-request request ID picker from the options, once per middleware.
 * Throws a `TypeError` for a header name in `from` that no request could carry.
 */
function requestIdPicker(
  options: RequestIdOptions = {},
): (c: Context, logger: Pick<Logger, 'warn'>) => PickedRequestId {
  const {
    from = DEFAULT_REQUEST_ID_SOURCES,
    trustIncoming = true,
    validate = DEFAULT_REQUEST_ID_PATTERN,
    generate = () => crypto.randomUUID(),
  } = options

  interface Reader {
    read: (c: Context) => unknown
    /** Whether this source is the `cf-ray` header, whose rejected value must not become `cfRay`. */
    isCfRay: boolean
  }
  const readers: Reader[] = from.map((source): Reader => {
    if (typeof source === 'function') return { read: source, isCfRay: false }
    if (!HEADER_NAME.test(source)) {
      throw new TypeError(
        `useLogger: invalid header name in requestId.from: ${JSON.stringify(source)}`,
      )
    }
    return { read: (c) => c.req.header(source), isCfRay: source.toLowerCase() === 'cf-ray' }
  })
  readers.push({ read: (c) => c.get('requestId' as never), isCfRay: false })
  // The header names above are checked either way, so a bad `from` always fails at setup.
  const sources = trustIncoming ? readers : []

  const accepts = typeof validate === 'function' ? validate : (id: string) => matches(validate, id)

  // One WARN of each kind per useLogger() call, written through the Root Logger it was given.
  let warnedUnsafeGenerated = false
  let warnedCallbackThrew = false
  const warnOnce = (logger: Pick<Logger, 'warn'>, kind: 'generate' | 'callback') => {
    if (kind === 'generate' ? warnedUnsafeGenerated : warnedCallbackThrew) return
    if (kind === 'generate') warnedUnsafeGenerated = true
    else warnedCallbackThrew = true
    logger.warn(
      kind === 'generate' ? UNSAFE_GENERATED_ID_WARNING : REQUEST_ID_CALLBACK_THREW_WARNING,
    )
  }

  const generateSafe = (c: Context, logger: Pick<Logger, 'warn'>): string => {
    const id = tryCall(() => generate(c))
    if (typeof id === 'string' && SAFE_HEADER_VALUE.test(id)) return id
    warnOnce(logger, 'generate')
    return crypto.randomUUID()
  }

  const readCfRay = (c: Context): string | undefined => {
    if (!trustIncoming) return undefined
    const cfRay = c.req.header('cf-ray')
    return cfRay !== undefined && matches(CF_RAY_PATTERN, cfRay) ? cfRay : undefined
  }

  return (c, logger) => {
    const threw = () => warnOnce(logger, 'callback')
    let cfRay = readCfRay(c)
    let rejected = false
    for (const { read, isCfRay } of sources) {
      const id = tryCall(() => read(c), threw)
      // No value (absent, empty, or a source that threw or returned a non-string) is not a rejection.
      if (typeof id !== 'string' || id === '') continue
      // Only a literal `true` accepts: a `validate` that throws, or returns a Promise, rejects.
      if (SAFE_HEADER_VALUE.test(id) && tryCall(() => accepts(id, c), threw) === true) {
        return { id, rejected, cfRay }
      }
      rejected = true
      // A `cf-ray` rejected as the request ID is not logged as `cfRay` either. Only that
      // source counts: a client can't drop a genuine `cfRay` by sending its Ray ID elsewhere.
      if (isCfRay) cfRay = undefined
    }
    return { id: generateSafe(c, logger), rejected, cfRay }
  }
}

/**
 * Logging Middleware for Hono.
 *
 * Opens a Logging Context (via `runWithLogger()`) for each request.
 * Accepts either a Root Logger (shared across requests) or a function
 * `(c) => Logger` called per request that returns one.
 *
 * Handles `X-Request-Id`, `X-Trace-Id`, `traceparent`, and `tracestate` headers:
 * - Continues the incoming trace, or starts a new one.
 * - Reuses a valid incoming request ID, otherwise generates one (see `RequestIdOptions`).
 * - Adds `requestId` (plus `requestIdRejected` when an incoming ID was rejected, and `cfRay`
 *   when the `cf-ray` header is trusted and well formed) to the Context Fields, so they appear
 *   on every log line.
 * - Logs `request.start` / `request.end` (and `request.error` when Hono caught one).
 * - Sets `c.var.logger`, `c.var.requestId`, `c.var.traceId` and the response headers.
 *
 * @template T - The type of user-defined log fields.
 * @param {Logger<T> | ((c: Context) => Logger<T>)} loggerOrFactory - A logger instance or a per-request factory.
 * @param {UseLoggerOptions} [options] - How the request ID is read, validated and generated.
 * @returns {MiddlewareHandler} The middleware handler function.
 *
 * @example
 * ```ts
 * import { Hono } from 'hono'
 * import { useLogger } from 'loggercf/hono'
 * import { createLogger } from 'loggercf'
 *
 * const app = new Hono()
 * const logger = createLogger({ service: 'api', level: 'info' })
 *
 * app.use(useLogger(logger, { requestId: { from: ['cf-ray', 'x-request-id'] } }))
 * app.get('/', (c) => c.text('Hello!'))
 * ```
 */
export function useLogger<T extends LogFields = LogFields>(
  loggerOrFactory: Logger<T> | ((c: Context) => Logger<T>),
  options: UseLoggerOptions = {},
): MiddlewareHandler {
  const pickRequestId = requestIdPicker(options.requestId)
  // A factory's logger is not registered: nothing guarantees it is a Root Logger.
  if ('info' in loggerOrFactory) registerDefaultLogger(loggerOrFactory as Logger)

  return async (c, next) => {
    const rootLogger = 'info' in loggerOrFactory ? loggerOrFactory : loggerOrFactory(c)

    const { id: requestId, rejected, cfRay } = pickRequestId(c, rootLogger)
    const method = c.req.method
    const path = new URL(c.req.url).pathname

    const contextOptions = {
      logger: rootLogger,
      ...extractCarrier((name) => c.req.header(name)),
      fields: {
        requestId,
        ...(rejected && { requestIdRejected: true }),
        ...(cfRay !== undefined && { cfRay }),
      },
    }
    await runWithLogger(contextOptions, async () => {
      // Untyped on purpose: these internal lines don't use T, and `Logger<T>`'s
      // structured overload can't be checked against a generic T.
      const logger = getLogger()
      const trace = getTraceContext()!
      c.set('logger' as never, logger as never)
      c.set('requestId' as never, requestId as never)
      c.set('traceId' as never, trace.traceId as never)

      logger.info({ method, path }, `request.start ${method} ${path}`)

      const start = Date.now()
      await next()

      const duration = Date.now() - start
      const statusCode = c.res.status

      if (c.error) {
        logger.error(
          { err: c.error, method, path, statusCode, duration },
          `request.error ${method} ${path}`,
        )
      }
      logger.info({ method, path, statusCode, duration }, `request.end ${method} ${path}`)

      c.header('X-Request-Id', requestId)
      c.header('X-Trace-Id', trace.traceId)
      injectCarrier(getTraceCarrier(), (name, value) => c.header(name, value))
    })
  }
}

/**
 * Options for the `generateId` middleware.
 */
export type GenerateIdOptions = {
  /** The Hono context key used to store the generated ID. */
  contextKey: string
  /** The HTTP header name to read / write the ID. */
  headerName: string
  /** Custom ID generation function. Defaults to `crypto.randomUUID()`. */
  generator?: (c: Context) => string
}

/**
 * ID Middleware for Hono.
 *
 * @param {object} options - Options for ID middleware.
 * @param {string} [options.contextKey] - The context key used to store the ID.
 * @param {string} [options.headerName] - The header name used in ID.
 * @param {generator} [options.generator=() => crypto.randomUUID()] - The ID generation function.
 *
 * @returns {MiddlewareHandler} The middleware handler function.
 *
 * @example
 * ```ts
 * type Variables = RequestIdVariables
 * const app = new Hono<{Variables: Variables}>()
 *
 * app.use(generateId())
 * app.get('/', (c) => {
 *   console.log(c.get('requestId')) // Debug
 *   return c.text('Hello World!')
 * })
 * ```
 */
export const generateId = ({
  contextKey,
  headerName,
  generator = () => crypto.randomUUID(),
}: GenerateIdOptions): MiddlewareHandler => {
  return async function generateIdMiddleware(c, next) {
    // If `headerName` is empty string, req.header will return the object
    let id = headerName ? c.req.header(headerName) : undefined
    if (!id || /[^\w\-=]/.test(id)) {
      id = generator(c)
    }

    c.set(contextKey as never, id)
    if (headerName) {
      c.header(headerName, id)
    }
    await next()
  }
}
