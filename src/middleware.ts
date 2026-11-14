import type { Context, MiddlewareHandler } from 'hono'
import { matchedRoutes, routePath } from 'hono/route'
import type { LogFields, LogLevel, Logger } from './types'
import { extractCarrier, injectCarrier } from './trace'
import { getLogger, getTraceCarrier, getTraceContext, runWithLogger } from './logger'

/**
 * Where `useLogger` reads an incoming request ID from: a request header name
 * (case-insensitive), or a function that returns the ID, or `undefined` when it has none.
 */
export type RequestIdSource = string | ((c: Context) => string | undefined)

/**
 * How `useLogger` picks the request ID. The first valid value wins:
 *
 * 1. each source in `from`, in order (skipped entirely when `trustIncoming` is `false`),
 * 2. `c.var.requestId`, when an earlier middleware set it,
 * 3. `generate(c)`.
 *
 * Every value from steps 1 and 2 must pass `validate`; one that fails is skipped.
 * The generated ID is used as is.
 */
export interface RequestIdOptions {
  /**
   * Sources to read the incoming ID from, in order. A source is a header name or a function.
   * Defaults to `['x-request-id']`. Use `['cf-ray', 'x-request-id']` to prefer Cloudflare's Ray ID.
   * `useLogger` throws a `TypeError` for a header name that is not a valid HTTP header name.
   */
  from?: RequestIdSource[]
  /**
   * `false` ignores every source in `from`, so `useLogger` reads no request header for the ID.
   * `c.var.requestId` from an earlier middleware is still used (validated), because the app set
   * it; a middleware that copies a client header there (such as `generateId`) passes it through.
   * Defaults to `true`.
   */
  trustIncoming?: boolean
  /**
   * Accepts or rejects an incoming ID. Replaces the default check, including its length cap,
   * so anchor a pattern (`^...$`) and bound its length.
   * Defaults to `/^[\w\-=:.]{1,128}$/`: 1 to 128 of `A-Z a-z 0-9 _ - = : .`.
   */
  validate?: RegExp | ((id: string, c: Context) => boolean)
  /** Builds an ID when no source gives a valid one. Defaults to `crypto.randomUUID()`. */
  generate?: (c: Context) => string
}

/**
 * Request details `useLogger` can add to `request.start` and `request.end`. Each is off by
 * default and is left out when the request does not have it.
 */
export interface RequestDetailsOptions {
  /** `userAgent`: the `User-Agent` request header, as sent. */
  userAgent?: boolean
  /**
   * `cf`: `{ colo, country, asn }` from Cloudflare's `request.cf`. Only those three keys, and
   * only values of the expected type. There is no `request.cf` on Node.js or in most tests.
   */
  cf?: boolean
}

/** Options for `useLogger`. */
export interface UseLoggerOptions {
  /** How the request ID is read, validated and generated. */
  requestId?: RequestIdOptions
  /** `false` writes no `request.start` line, only `request.end`. Defaults to `true`. */
  requestStart?: boolean
  /**
   * Picks the level of `request.end` from the final status and the error Hono caught
   * (`c.error`), if any. Defaults to `defaultRequestEndLevel`: `error` for an error or a 5xx,
   * `warn` for a 4xx, `info` otherwise. When it throws or returns an unknown level, the default
   * is used and one WARN is written.
   */
  level?: (statusCode: number, err: Error | undefined, c: Context) => LogLevel
  /**
   * Context Fields to add at the start of the request, so they are on every line of it,
   * `request.start` included. Runs before the handlers, so it sees the request but not what
   * later middleware sets. `requestId` and `cfRay` cannot be replaced. When it throws, the
   * request is logged without these fields and one WARN is written.
   */
  fields?: (c: Context) => LogFields | undefined
  /**
   * Fields to add to `request.end` only. Runs after the handlers, so it sees `c.var` values
   * they set (an authenticated user ID, for example). It cannot replace `method`, `path`,
   * `route`, `statusCode`, `duration` or `err`. When it throws, `request.end` is written
   * without these fields and one WARN is written.
   */
  endFields?: (c: Context) => LogFields | undefined
  /** Request details to add to `request.start` and `request.end`. All off by default. */
  include?: RequestDetailsOptions
}

/**
 * The default `level` of `request.end`: `error` when Hono caught an error or the status is
 * 5xx, `warn` for 4xx, `info` otherwise.
 */
export function defaultRequestEndLevel(statusCode: number, err: Error | undefined): LogLevel {
  return err || statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info'
}

const LOG_LEVELS: ReadonlySet<unknown> = new Set<LogLevel>([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
])

type Hook = 'fields' | 'endFields' | 'level'

const HOOK_FAILURE: Record<Hook, string> = {
  fields: 'useLogger: the fields option failed; the request is logged without its fields',
  endFields: 'useLogger: the endFields option failed; request.end is written without its fields',
  level: 'useLogger: the level option failed; request.end uses the default level',
}

/**
 * Reports an option hook that threw or returned an unknown level: one WARN per hook per
 * `useLogger()` call, so a hook that fails on every request does not double the log volume.
 */
function hookFailureReporter() {
  const reported = new Set<Hook>()
  return (logger: Logger, hook: Hook, details: Record<string, unknown>): void => {
    if (reported.has(hook)) return
    reported.add(hook)
    logger.warn({ hook, ...details }, HOOK_FAILURE[hook])
  }
}

type Attempt<R> = { ok: true; value: R } | { ok: false; err: unknown }

/** Runs an option hook, turning a throw into a value so it never reaches the app. */
function attempt<R>(fn: () => R): Attempt<R> {
  try {
    return { ok: true, value: fn() }
  } catch (err) {
    return { ok: false, err }
  }
}

/**
 * The pattern of the endpoint a request was routed to, read when `useLogger` runs.
 *
 * Of the routes matched after `useLogger` itself, the first one registered for a method
 * (`app.get`, `app.post`, `app.on`, ...; `app.use` and `app.all` register for every method) is
 * the endpoint. A catch-all registered after it does not replace it, and a middleware that
 * answers before it runs (an auth check returning 401) does not either. When no such route
 * matched, the last matched route's pattern is used: an `app.all` handler's, or a middleware's
 * (`/*`) for a request no handler matched.
 */
function routeOf(c: Context): string {
  const routes = matchedRoutes(c).slice(c.req.routeIndex + 1)
  const route = routes.find((r) => r.method !== 'ALL') ?? routes.at(-1)
  return route?.path ?? routePath(c)
}

/** The `include` details of a request; a detail the request does not have is left out. */
function requestDetails(c: Context, include: RequestDetailsOptions): LogFields {
  const details: LogFields = {}
  if (include.userAgent) {
    const userAgent = c.req.header('user-agent')
    if (userAgent) details.userAgent = userAgent
  }
  if (include.cf) {
    const cf = (c.req.raw as { cf?: unknown }).cf
    if (cf !== null && typeof cf === 'object') {
      const { colo, country, asn } = cf as Record<string, unknown>
      const basics: LogFields = {}
      if (typeof colo === 'string') basics.colo = colo
      if (typeof country === 'string') basics.country = country
      if (typeof asn === 'number') basics.asn = asn
      if (Object.keys(basics).length > 0) details.cf = basics
    }
  }
  return details
}

/**
 * The default `requestId.validate`. Accepts UUIDs and `cf-ray` values. It is also the check
 * a `cf-ray` header must pass to be recorded as `cfRay`.
 */
const DEFAULT_REQUEST_ID_PATTERN = /^[\w\-=:.]{1,128}$/

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
function requestIdPicker(options: RequestIdOptions = {}): (c: Context) => string {
  const {
    from = DEFAULT_REQUEST_ID_SOURCES,
    trustIncoming = true,
    validate = DEFAULT_REQUEST_ID_PATTERN,
    generate = () => crypto.randomUUID(),
  } = options

  const readers = (trustIncoming ? from : []).map((source): ((c: Context) => unknown) => {
    if (typeof source === 'function') return source
    if (!HEADER_NAME.test(source)) {
      throw new TypeError(
        `useLogger: invalid header name in requestId.from: ${JSON.stringify(source)}`,
      )
    }
    return (c) => c.req.header(source)
  })
  readers.push((c) => c.get('requestId' as never))

  const accepts = typeof validate === 'function' ? validate : (id: string) => matches(validate, id)
  const isValid = (id: unknown, c: Context): id is string =>
    typeof id === 'string' && id !== '' && accepts(id, c)

  return (c) => {
    for (const read of readers) {
      const id = read(c)
      if (isValid(id, c)) return id
    }
    return generate(c)
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
 * - Adds `requestId`, and `cfRay` when the `cf-ray` header is present, to the Context Fields
 *   so they appear on every log line.
 * - Logs `request.start` (unless `requestStart: false`) and one `request.end` with `method`,
 *   `path` (never the query string), `route` (the matched pattern), `statusCode`, `duration`,
 *   and `err` when Hono caught an error. Its level comes from `options.level`.
 * - Sets `c.var.logger`, `c.var.requestId`, `c.var.traceId` and the response headers.
 *
 * An option hook (`fields`, `endFields`, `level`) that throws never changes the response
 * and never drops `request.end`: the line is written without that hook's result, and one WARN
 * per hook per `useLogger()` call names it.
 *
 * @template T - The type of user-defined log fields.
 * @param {Logger<T> | ((c: Context) => Logger<T>)} loggerOrFactory - A logger instance or a per-request factory.
 * @param {UseLoggerOptions} [options] - Request ID, request lines and extra fields.
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
  const { requestStart = true, level, fields, endFields, include = {} } = options
  const reportHookFailure = hookFailureReporter()

  return async (c, next) => {
    const rootLogger = 'info' in loggerOrFactory ? loggerOrFactory : loggerOrFactory(c)

    const requestId = pickRequestId(c)
    const cfRay = c.req.header('cf-ray')
    const method = c.req.method
    // The pathname only: a query string often carries tokens and personal data.
    const path = new URL(c.req.url).pathname
    // Known before the handler runs, so request.start has it too.
    const route = routeOf(c)
    const details = requestDetails(c, include)
    const appFields = fields && attempt(() => fields(c))

    const contextOptions = {
      logger: rootLogger,
      ...extractCarrier((name) => c.req.header(name)),
      fields: {
        ...(appFields?.ok && appFields.value),
        requestId,
        ...(cfRay !== undefined && matches(DEFAULT_REQUEST_ID_PATTERN, cfRay) && { cfRay }),
      },
    }
    await runWithLogger(contextOptions, async () => {
      const logger = getLogger<T>()
      const trace = getTraceContext()!
      c.set('logger' as never, logger as never)
      c.set('requestId' as never, requestId as never)
      c.set('traceId' as never, trace.traceId as never)

      if (appFields && !appFields.ok) reportHookFailure(logger, 'fields', { err: appFields.err })
      if (requestStart) {
        logger.info({ ...details, method, path, route }, `request.start ${method} ${path}`)
      }

      const start = Date.now()
      await next()

      const duration = Date.now() - start
      const statusCode = c.res.status
      const err = c.error

      const extra = endFields && attempt(() => endFields(c))
      if (extra && !extra.ok) reportHookFailure(logger, 'endFields', { err: extra.err })

      let endLevel = defaultRequestEndLevel(statusCode, err)
      const picked = level && attempt(() => level(statusCode, err, c))
      if (picked && !picked.ok) reportHookFailure(logger, 'level', { err: picked.err })
      else if (picked && LOG_LEVELS.has(picked.value)) endLevel = picked.value
      else if (picked) reportHookFailure(logger, 'level', { returned: String(picked.value) })

      logger[endLevel](
        {
          ...(extra?.ok && extra.value),
          ...details,
          method,
          path,
          route,
          statusCode,
          duration,
          ...(err !== undefined && { err }),
        },
        `request.end ${method} ${path}`,
      )

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
