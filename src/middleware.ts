import type { Context, MiddlewareHandler } from 'hono'
import type { LogFields, Logger } from './types'
import { extractCarrier, injectCarrier } from './trace'
import { getLogger, getTraceCarrier, getTraceContext, runWithLogger } from './logger'

/**
 * Logging Middleware for Hono.
 *
 * Opens a Logging Context (via `runWithLogger()`) for each request.
 * Accepts either a Root Logger (shared across requests) or a function
 * `(c) => Logger` called per request that returns one.
 *
 * Handles `X-Request-Id`, `X-Trace-Id`, `traceparent`, and `tracestate` headers:
 * - Continues the incoming trace, or starts a new one.
 * - Reuses an incoming `X-Request-Id`, otherwise generates one.
 * - Adds `requestId` to the Context Fields so it appears on every log line.
 * - Logs `request.start` / `request.end` (and `request.error` when Hono caught one).
 * - Sets `c.var.logger`, `c.var.requestId`, `c.var.traceId` and the response headers.
 *
 * @template T - The type of user-defined log fields.
 * @param {Logger<T> | ((c: Context) => Logger<T>)} loggerOrFactory - A logger instance or a per-request factory.
 * @returns {MiddlewareHandler} The middleware handler function.
 *
 * @example
 * ```ts
 * import { Hono } from 'hono'
 * import { useLogger } from 'cf-logger/hono'
 * import { createLogger } from 'cf-logger'
 *
 * const app = new Hono()
 * const logger = createLogger({ service: 'api', level: 'info' })
 *
 * app.use(useLogger(logger))
 * app.get('/', (c) => c.text('Hello!'))
 * ```
 */
export function useLogger<T extends LogFields = LogFields>(
  loggerOrFactory: Logger<T> | ((c: Parameters<MiddlewareHandler>[0]) => Logger<T>),
): MiddlewareHandler {
  return async (c, next) => {
    const rootLogger = 'info' in loggerOrFactory ? loggerOrFactory : loggerOrFactory(c)

    const requestId = c.req.header('X-Request-Id') || c.var?.requestId || crypto.randomUUID()
    const method = c.req.method
    const path = new URL(c.req.url).pathname

    const contextOptions = {
      logger: rootLogger,
      ...extractCarrier((name) => c.req.header(name)),
      fields: { requestId },
    }
    await runWithLogger(contextOptions, async () => {
      const logger = getLogger<T>()
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
