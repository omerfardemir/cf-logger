import { Hono } from 'hono'
import { getTraceContext, type Logger } from 'loggercf'
import { useLogger } from 'loggercf/hono'
import { defaultLoggerFromEnv } from 'loggercf/workers'

type Context = {
  Variables: { logger: Logger; requestId: string }
}

/**
 * bind-worker's HTTP interface, reached over the service binding's `fetch`
 * (dev/main-worker GET /fetcher uses `tracedFetcher(env.BIND)`). `useLogger`
 * continues the caller's trace from `traceparent` and reuses its `X-Request-Id`.
 */
export const http = new Hono<Context>()
  .use(useLogger(defaultLoggerFromEnv()))
  .get('/echo-trace', (c) => {
    const trace = getTraceContext()
    const requestId = c.var.requestId
    c.var.logger.info({ requestId }, 'bind.echoTrace')
    return c.json({
      traceId: trace?.traceId,
      parentSpanId: trace?.parentSpanId,
      requestId,
      traceparent: c.req.header('traceparent') ?? null,
    })
  })
