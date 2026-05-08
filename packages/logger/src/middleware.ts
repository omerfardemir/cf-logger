import type { Context, MiddlewareHandler } from 'hono'
import type { LogFields, Logger } from './types'
import { resolveTrace, buildTraceparent } from './trace'
import { runWithLogger, setLoggerContext } from './logger'

/**
 * Logging Middleware for Hono.
 *
 * Initializes the ALS logging context for each request.
 * Accepts either a `Logger` instance (shared across requests) or a factory
 * function `(c) => Logger` that is called per-request.
 *
 * Handles `X-Request-Id`, `X-Trace-Id`, and `traceparent` headers automatically:
 * - Reads from the incoming request header if present, otherwise generates a new value.
 * - Sets all three on the response headers.
 * - Adds `requestId` to the ALS logger context so it appears on every log line.
 * - `traceId` is already on every log line via the ALS trace context.
 *
 * @template T - The type of user-defined log fields.
 * @param {Logger<T> | ((c: Context) => Logger<T>)} loggerOrFactory - A logger instance or a per-request factory.
 * @returns {MiddlewareHandler} The middleware handler function.
 *
 * @example
 * ```ts
 * import { Hono } from 'hono'
 * import { useLogger } from '@cf-logger/logger/hono'
 * import { createLogger } from '@cf-logger/logger'
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
    const logger = 'info' in loggerOrFactory
      ? loggerOrFactory
      : loggerOrFactory(c)

    const trace = resolveTrace(c.req.header('traceparent'))
    const requestId = c.req.header('X-Request-Id') || c.var?.requestId || crypto.randomUUID()
    const method = c.req.method
    const path = new URL(c.req.url).pathname

    await runWithLogger(
      { logger, trace },
      async () => {
        c.set('logger' as never, logger as never)
        c.set('requestId' as never, requestId as never)
        c.set('traceId' as never, trace.traceId as never)

        setLoggerContext({ requestId })

        logger.info({ method, path, requestId, traceId: trace.traceId }, `request.start ${method} ${path}`)

        const start = Date.now()
        try {
          await next()
        } catch (err) {
          c.res = c.res ?? new Response('Internal Server Error', { status: 500 })
          if (!c.res.status || c.res.status < 400) {
            c.res = new Response('Internal Server Error', { status: 500 })
          }
        } finally {
          const duration = Date.now() - start
          const statusCode = c.res.status

          logger.info({ method, path, statusCode, duration, requestId, traceId: trace.traceId }, `request.end ${method} ${path}`)

          c.header('X-Request-Id', requestId)
          c.header('X-Trace-Id', trace.traceId)
          c.header('traceparent', buildTraceparent(trace))
        }
      },
    )
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
  return async function generateId(c, next) {
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