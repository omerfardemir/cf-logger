import type { MiddlewareHandler } from 'hono'
import type { LogFields, Logger } from './types'
import { resolveTrace, buildTraceparent } from './trace'
import { runWithLogger } from './als'

/**
 * Creates a Hono middleware that initializes the ALS logging context.
 *
 * Accepts either a Logger instance (shared across requests) or a factory
 * function `(c) => Logger` that is called per-request.
 */
export function useLogger<T extends LogFields = LogFields>(
  loggerOrFactory: Logger<T> | ((c: Parameters<MiddlewareHandler>[0]) => Logger<T>),
): MiddlewareHandler {
  return async (c, next) => {
    const logger = 'info' in loggerOrFactory
      ? loggerOrFactory
      : loggerOrFactory(c)

    const trace = resolveTrace(c.req.header('traceparent'))

    await runWithLogger(
      { logger, trace },
      async () => {
        c.set('logger' as never, logger as never)
        await next()
      },
    )

    c.header('traceparent', buildTraceparent(trace))
  }
}
