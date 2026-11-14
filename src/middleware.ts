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
   * is used and one WARN is written. It is not called for a throw that escapes `useLogger` (see
   * `useLogger`): that `request.end` is always at `error`, because its status is only assumed.
   */
  level?: (statusCode: number, err: Error | undefined, c: Context) => LogLevel
  /**
   * Context Fields to add at the start of the request, so they are on every line of it,
   * `request.start` included. Runs before the handlers, so it sees the request but not what
   * later middleware sets. Must be synchronous. It cannot set the keys `useLogger` owns:
   * `requestId`, `requestIdRejected`, `cfRay`, `method`, `path`, `route`, `statusCode`,
   * `statusCodeAssumed`, `duration`, `err`, `originalErr`, and `userAgent` / `cf` when `include`
   * turns them on. Those keys are dropped from its result, and one WARN names them (never their
   * values). When it throws, returns anything but a plain object or `undefined` (a Promise, for
   * example), or its result throws while it is read (a getter, a Proxy), the request is logged
   * without these fields and one WARN is written.
   */
  fields?: (c: Context) => LogFields | undefined
  /**
   * Fields to add to `request.end` only. Runs after the handlers, so it sees `c.var` values
   * they set (an authenticated user ID, for example). Must be synchronous. It cannot set the
   * same keys `fields` cannot, and the same WARN names the ones it returned. When it fails the
   * way `fields` can, `request.end` is written without these fields and one WARN is written.
   */
  endFields?: (c: Context) => LogFields | undefined
  /** Request details to add to `request.start` and `request.end`. All off by default. */
  include?: RequestDetailsOptions
}

/**
 * The default `level` of `request.end`: `error` when Hono caught an error or the status is
 * 5xx, `warn` for 4xx, `info` otherwise. Call it from your own `level` to change one case.
 *
 * @param {number} statusCode - The final response status (`c.res.status`).
 * @param {Error | undefined} err - The error Hono caught (`c.error`), if any.
 * @returns {LogLevel} The level `request.end` is written at.
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

type FieldsHook = 'fields' | 'endFields'

const DROPPED_KEYS: Record<FieldsHook, string> = {
  fields: 'useLogger: the fields option returned keys useLogger owns; they were dropped',
  endFields: 'useLogger: the endFields option returned keys useLogger owns; they were dropped',
}

/**
 * A "warn once" reporter, one per `useLogger()` call: the first call for each `key` writes one
 * WARN through the given logger, later calls for that key write nothing, so a callback that
 * fails on every request does not double the log volume.
 */
function warnOnce() {
  const warned = new Set<string>()
  return (logger: Pick<Logger, 'warn'>, key: string, message: string, fields?: object) => {
    if (warned.has(key)) return
    warned.add(key)
    if (fields) logger.warn(fields, message)
    else logger.warn(message)
  }
}

type WarnOnce = ReturnType<typeof warnOnce>

/** Why a hook's result was not used: what it threw, or a description of what it returned. */
type HookFailure = { err: unknown } | { returned: string }

type HookResult<R> = { value?: R; failure?: HookFailure }

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}

/**
 * Gives a Promise (or other thenable) an app callback returned a no-op rejection handler, so it
 * cannot become an unhandled rejection. It is never awaited. A value whose `then` throws when
 * read or called is left alone.
 */
function ignoreRejection(value: unknown): void {
  try {
    if (isThenable(value)) value.then(undefined, () => {})
  } catch {
    // Nothing to handle: the value is not a usable thenable.
  }
}

/**
 * Calls an option hook and turns its result into what `useLogger` uses, with `use`. A throw,
 * from the hook or from reading its result (a throwing getter, a Proxy trap), or a result
 * `accepts` rejects, becomes a `failure` instead of reaching the app, and nothing of the result
 * is used. A Promise result is never awaited, but its rejection is handled.
 */
function callHook<V, R>(
  fn: () => unknown,
  accepts: (value: unknown) => value is V,
  use: (value: V) => R,
): HookResult<R> {
  try {
    const value = fn()
    ignoreRejection(value)
    return accepts(value)
      ? { value: use(value) }
      : { failure: { returned: describeReturned(value) } }
  } catch (err) {
    return { failure: { err } }
  }
}

/** A short description of an unusable hook result, for the WARN. */
function describeReturned(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (isThenable(value)) return 'Promise'
  return typeof value
}

/** A synchronous `fields` / `endFields` result: a plain object, or nothing. */
function isFields(value: unknown): value is LogFields | undefined {
  if (value === undefined) return true
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return !isThenable(value)
}

function isLevel(value: unknown): value is LogLevel {
  return LOG_LEVELS.has(value)
}

/** The keys `useLogger` writes, which a `fields` or `endFields` result must not set. */
const OWN_KEYS = [
  'requestId',
  'requestIdRejected',
  'cfRay',
  'method',
  'path',
  'route',
  'statusCode',
  'statusCodeAssumed',
  'duration',
  'err',
  'originalErr',
]

function ownKeys(include: RequestDetailsOptions): readonly string[] {
  return [...OWN_KEYS, ...(include.userAgent ? ['userAgent'] : []), ...(include.cf ? ['cf'] : [])]
}

/** A `fields` / `endFields` result, without the keys `useLogger` owns. */
interface HookFields {
  fields: LogFields
  /** The owned keys the hook returned, which were dropped. Key names only, never values. */
  dropped: string[]
}

/**
 * Copies a hook result without the keys `useLogger` owns. Reading the result can throw (a
 * getter, a Proxy), so call it only inside `callHook`.
 */
function withoutKeys(fields: LogFields | undefined, keys: readonly string[]): HookFields {
  const rest = { ...fields }
  const dropped = keys.filter((key) => Object.hasOwn(rest, key))
  for (const key of dropped) delete rest[key]
  return { fields: rest, dropped }
}

/**
 * `err` for a value thrown past `useLogger`: an `Error` as is (the record serializes it),
 * anything else as `{ type, message }`, which every sink can write.
 */
function thrownErr(thrown: unknown): unknown {
  if (thrown instanceof Error) return thrown
  return { type: thrown === null ? 'null' : typeof thrown, message: printable(thrown) }
}

function printable(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    try {
      return String(value)
    } catch {
      return 'unprintable value'
    }
  }
}

/**
 * The endpoint pattern a request is expected to reach, read when `useLogger` runs.
 *
 * Of the routes matched after `useLogger` itself, the first one registered for a method
 * (`app.get`, `app.post`, `app.on`, ...; `app.use` and `app.all` register for every method).
 * A catch-all registered after it does not replace it, and a middleware that answers before it
 * runs (an auth check returning 401) does not either. When no such route matched, the last
 * matched one: an `app.all` handler, or a middleware (`/*`) for a request no handler matched.
 */
function expectedRoute(c: Context): string {
  const routes = matchedRoutes(c).slice(c.req.routeIndex + 1)
  const route = routes.find((r) => r.method !== 'ALL') ?? routes.at(-1)
  return route?.path ?? routePath(c)
}

/**
 * The endpoint pattern for `request.end`: the route that answered, when it was registered for a
 * method, so a method-registered middleware ahead of the handler (`app.get('*', cache())`) does
 * not hide it. Otherwise the route `expectedRoute` found when the request arrived.
 */
function answeredRoute(c: Context, expected: string): string {
  const answered = matchedRoutes(c)[c.req.routeIndex]
  return answered && answered.method !== 'ALL' ? answered.path : expected
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
    ignoreRejection(value)
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
  warn: WarnOnce = warnOnce(),
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
  const generateSafe = (c: Context, logger: Pick<Logger, 'warn'>): string => {
    const id = tryCall(() => generate(c))
    if (typeof id === 'string' && SAFE_HEADER_VALUE.test(id)) return id
    warn(logger, 'requestId.generate', UNSAFE_GENERATED_ID_WARNING)
    return crypto.randomUUID()
  }

  const readCfRay = (c: Context): string | undefined => {
    if (!trustIncoming) return undefined
    const cfRay = c.req.header('cf-ray')
    return cfRay !== undefined && matches(CF_RAY_PATTERN, cfRay) ? cfRay : undefined
  }

  return (c, logger) => {
    const threw = () => warn(logger, 'requestId.callback', REQUEST_ID_CALLBACK_THREW_WARNING)
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
 * - Logs `request.start` (unless `requestStart: false`) and one `request.end` with `method`,
 *   `path` (never the query string), `route` (the matched pattern), `statusCode`, `duration`,
 *   and `err` when Hono caught an error. Its level comes from `options.level`.
 * - Sets `c.var.logger`, `c.var.requestId`, `c.var.traceId` and the response headers.
 *
 * An option hook (`fields`, `endFields`, `level`) that throws never changes the response
 * and never drops `request.end`: the line is written without that hook's result, and one WARN
 * per hook per `useLogger()` call names it.
 *
 * A throw that escapes `useLogger` (a non-`Error` value, or an `onError` that throws) still
 * gets a `request.end` at `error`, with `err`, and is then rethrown unchanged. `useLogger`
 * cannot see the response that follows, so `statusCode: 500` there is an assumption, marked by
 * `statusCodeAssumed: true`: what an outer middleware or the runtime sends decides the real
 * status. Hono catches an `Error` thrown by `onError` one level up and calls `onError` again
 * with it, so an `onError` that throws `new HTTPException(502)` and answers an
 * `HTTPException` with `getResponse()` sends a 502. When `onError` threw, `err` is its error
 * and `originalErr` the handler's error that `onError` was handling. No response headers are
 * set: there is no response yet.
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
  const warn = warnOnce()
  const pickRequestId = requestIdPicker(options.requestId, warn)
  const { requestStart = true, level, fields, endFields, include = {} } = options
  const protectedKeys = ownKeys(include)
  const keepFields = (value: LogFields | undefined) => withoutKeys(value, protectedKeys)
  const reportHookFailure = (logger: Logger, hook: Hook, failure: HookFailure) =>
    warn(logger, hook, HOOK_FAILURE[hook], { hook, ...failure })
  // Owned keys are dropped from a fields/endFields result: one WARN per hook names them (key
  // names only, never values), so the removal stays visible.
  const reportDropped = (logger: Logger, hook: FieldsHook, result: HookFields | undefined) => {
    if (!result?.dropped.length) return
    warn(logger, `${hook}.dropped`, DROPPED_KEYS[hook], { hook, droppedKeys: result.dropped })
  }

  return async (c, next) => {
    const rootLogger = 'info' in loggerOrFactory ? loggerOrFactory : loggerOrFactory(c)

    const { id: requestId, rejected, cfRay } = pickRequestId(c, rootLogger)
    const method = c.req.method
    // The pathname only: a query string often carries tokens and personal data.
    const path = new URL(c.req.url).pathname
    const startRoute = expectedRoute(c)
    const details = requestDetails(c, include)
    const appFields = fields ? callHook(() => fields(c), isFields, keepFields) : undefined
    const ownFields: LogFields = {
      requestId,
      ...(rejected && { requestIdRejected: true }),
      ...(cfRay !== undefined && { cfRay }),
    }

    const contextOptions = {
      logger: rootLogger,
      ...extractCarrier((name) => c.req.header(name)),
      fields: { ...appFields?.value?.fields, ...ownFields },
    }
    await runWithLogger(contextOptions, async () => {
      const logger = getLogger<T>()
      const trace = getTraceContext()!
      c.set('logger' as never, logger as never)
      c.set('requestId' as never, requestId as never)
      c.set('traceId' as never, trace.traceId as never)

      if (appFields?.failure) reportHookFailure(logger, 'fields', appFields.failure)
      reportDropped(logger, 'fields', appFields?.value)
      if (requestStart) {
        logger.info(
          { ...details, method, path, route: startRoute },
          `request.start ${method} ${path}`,
        )
      }

      const start = Date.now()
      // Hono turns an Error into a response itself. A non-Error throw, or an onError that
      // throws, rejects next() instead: request.end is still written, then the same value is
      // rethrown, so whatever handles it upstream sees exactly what it would without useLogger.
      let escaped: { thrown: unknown } | undefined
      try {
        await next()
      } catch (thrown) {
        escaped = { thrown }
      }

      const duration = Date.now() - start
      // useLogger cannot see the response to a throw that escapes it. 500 is what a runtime
      // answers an uncaught exception with, but the real status is decided above useLogger: by
      // an outer middleware, or by Hono, which hands an Error thrown by onError back to onError
      // and sends whatever it returns. So the line says the status is assumed.
      const statusCode = escaped ? 500 : c.res.status
      const err = escaped ? thrownErr(escaped.thrown) : c.error
      // When onError throws, c.error still holds the handler's error, which led to it.
      const originalErr = escaped && c.error !== escaped.thrown ? c.error : undefined

      const endExtra = endFields ? callHook(() => endFields(c), isFields, keepFields) : undefined
      if (endExtra?.failure) reportHookFailure(logger, 'endFields', endExtra.failure)
      reportDropped(logger, 'endFields', endExtra?.value)

      let endLevel: LogLevel = 'error'
      if (!escaped) {
        const caught = c.error
        const picked = level
          ? callHook(
              () => level(statusCode, caught, c),
              isLevel,
              (value) => value,
            )
          : undefined
        if (picked?.failure) reportHookFailure(logger, 'level', picked.failure)
        endLevel = picked?.value ?? defaultRequestEndLevel(statusCode, caught)
      }

      logger[endLevel](
        {
          ...endExtra?.value?.fields,
          ...ownFields,
          ...details,
          method,
          path,
          route: answeredRoute(c, startRoute),
          statusCode,
          ...(escaped && { statusCodeAssumed: true }),
          duration,
          ...(err !== undefined && { err }),
          ...(originalErr !== undefined && { originalErr }),
        },
        `request.end ${method} ${path}`,
      )
      if (escaped) throw escaped.thrown

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
