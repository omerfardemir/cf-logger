import type { Context, MiddlewareHandler } from 'hono'
import type { LogFields, Logger } from './types'
import { resolveTrace, buildTraceparent } from './trace'
import { runWithLogger, setLoggerContext } from './als'

/**
 * Creates a Hono middleware that initializes the ALS logging context.
 *
 * Accepts either a Logger instance (shared across requests) or a factory
 * function `(c) => Logger` that is called per-request.
 *
 * Handles `X-Request-Id` and `X-Trace-Id` headers automatically:
 * - Reads from the incoming request header if present, otherwise generates a new value.
 * - Sets both on the response headers.
 * - Adds `requestId` to the ALS logger context so it appears on every log line.
 * - `traceId` is already on every log line via the ALS trace context.
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

    await runWithLogger(
      { logger, trace },
      async () => {
        c.set('logger' as never, logger as never)
        c.set('requestId' as never, requestId as never)
        c.set('traceId' as never, trace.traceId as never)

        setLoggerContext({ requestId })
        await next()
      },
    )

    c.header('X-Request-Id', requestId)
    c.header('X-Trace-Id', trace.traceId)
    c.header('traceparent', buildTraceparent(trace))
  }
}

export type GenerateIdOptions = {
  contextKey: string
  headerName: string
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