import { Hono, type Context as HonoContext } from 'hono'
import { getTraceContext, type Logger } from 'loggercf'
import { useLogger } from 'loggercf/hono'
import { defaultLoggerFromEnv } from 'loggercf/workers'

type Context = {
  Variables: { logger: Logger; requestId: string }
}

/** Echoes what arrived (trace, Request ID, method, body) and what `useLogger` made of it. */
function echo(c: HonoContext<Context>): Promise<Response> {
  const trace = getTraceContext()
  const requestId = c.var.requestId
  c.var.logger.info({ requestId }, 'bind.echoTrace')
  return c.req.text().then((body) =>
    c.json({
      traceId: trace?.traceId,
      parentSpanId: trace?.parentSpanId,
      requestId,
      traceparent: c.req.header('traceparent') ?? null,
      tracestate: c.req.header('tracestate') ?? null,
      xRequestId: c.req.header('x-request-id') ?? null,
      method: c.req.method,
      body,
    }),
  )
}

/**
 * bind-worker's HTTP interface, reached over the service binding's `fetch`. `useLogger`
 * continues the caller's trace from `traceparent` and reuses its `X-Request-Id`.
 * - `GET /echo-trace`: dev/main-worker `GET /fetcher` calls it with a URL.
 * - `POST /fetcher-forward`: dev/main-worker `POST /fetcher-forward` forwards its own
 *   incoming Request (`c.req.raw`), which keeps the gateway's path.
 */
export const http = new Hono<Context>()
  .use(useLogger(defaultLoggerFromEnv()))
  .get('/echo-trace', echo)
  .post('/fetcher-forward', echo)
