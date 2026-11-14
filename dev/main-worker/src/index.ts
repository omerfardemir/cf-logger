import { Hono } from 'hono'
import { logger, useLogger } from './logger'
import {
  setLoggerContext,
  getTraceContext,
  getTraceCarrier,
  tracedFetcher,
  type Logger,
} from 'loggercf'
import { withTrace } from 'loggercf/workers'
import type { BindService, ServiceSession } from './types'

type Context = {
  Bindings: {
    BIND: ServiceSession<BindService> & Fetcher
    NAME: string
    LOG_LEVEL: string
    ENVIRONMENT: string
    VERSION: string
  }
  Variables: {
    logger: Logger
    requestId: string
    traceId: string
  }
}

const app = new Hono<Context>()

app.use(
  useLogger(logger, {
    // request.start / request.end get userAgent and cf: { colo, country, asn }
    include: { userAgent: true, cf: true },
    // on request.end only, computed after the route handler ran
    endFields: (c) => ({ contentType: c.res.headers.get('content-type') ?? undefined }),
  }),
)

/** GET / Simple: log levels demo + single-hop RPC */
app.get('/', async (c) => {
  const log = c.var.logger

  // Demo: all log levels
  log.trace('Trace-level log (most verbose)')
  log.debug('Debug-level log')
  log.info('Hello from the main worker')
  log.warn({ warning: 'test' }, 'Warning with structured data')
  log.error('Error-level log (not a real error)')

  // Demo: setLoggerContext enriches all subsequent logs
  setLoggerContext({ userId: 'user-42', feature: 'demo' })
  log.info('This log has userId and feature fields attached')

  // Demo: single-hop RPC with trace propagation → bind-worker
  const total = await withTrace(c.env.BIND, (s) => s.add(5, 7))
  log.info({ total }, 'Single-hop RPC: 5 + 7 = %d', total)

  return c.json({
    message: 'Single-hop RPC demo',
    total,
    traceId: getTraceContext()?.traceId,
  })
})

/** GET /multi-hop Multi-hop: main → bind-worker → math-worker */
app.get('/multi-hop', async (c) => {
  const log = c.var.logger

  setLoggerContext({ userId: 'user-99', feature: 'multi-hop' })
  log.info('Starting multi-hop demo: main → bind → math')

  // This single call triggers: main → bind-worker → math-worker (×2 calls)
  // All three workers share the same traceId in their logs
  const result = await withTrace(c.env.BIND, (s) => s.multiHop(10))
  log.info({ result }, 'Multi-hop complete: f(10) = (10 * 3) / 2 = %d', result)

  return c.json({
    message: 'Multi-hop RPC demo: main → bind → math (×2)',
    input: 10,
    formula: '(10 × 3) ÷ 2',
    result,
    traceId: getTraceContext()?.traceId,
  })
})

/** GET /error Error handling: division by zero in downstream worker */
app.get('/error', async (c) => {
  const log = c.var.logger

  setLoggerContext({ feature: 'error-demo' })
  log.info('About to trigger an error in downstream worker')

  try {
    // math-worker will throw "Division by zero"
    // The error propagates back through the RPC chain
    await withTrace(c.env.BIND, (s) => s.divideByZero(42))
    return c.text('Should not reach here')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ error: message }, 'Caught RPC error from downstream worker')
    return c.json(
      {
        message: 'Error propagated from math-worker through bind-worker',
        error: message,
        traceId: getTraceContext()?.traceId,
      },
      500,
    )
  }
})

/** GET /trace Shows current trace context */
app.get('/trace', async (c) => {
  const trace = getTraceContext()
  const { traceparent = null } = getTraceCarrier()

  c.var.logger.info({ trace }, 'Current trace context')

  return c.json({
    traceId: trace?.traceId,
    spanId: trace?.spanId,
    parentSpanId: trace?.parentSpanId,
    traceparent,
  })
})

/** GET /fetcher HTTP over a service binding: bind-worker's useLogger continues this trace */
app.get('/fetcher', async (c) => {
  // traceparent / tracestate and X-Request-Id go with the request; one span.end fetch is logged.
  const bind = tracedFetcher(c.env.BIND, { forwardRequestId: true, spans: true })
  // The query string is not logged on the span (it can carry tokens).
  const res = await bind.fetch('https://bind-test/echo-trace?token=not-logged')
  const downstream = await res.json()
  c.var.logger.info({ downstream }, 'Service binding fetch complete')

  return c.json({
    message: 'HTTP over a service binding: main → bind-worker (useLogger)',
    traceId: getTraceContext()?.traceId,
    downstream,
  })
})

/**
 * POST /fetcher-forward A gateway forwarding its own incoming Request over a service binding.
 * The client's X-Request-Id is replaced by this Worker's Request ID, and its tracestate goes
 * only when this trace continued from the client's traceparent.
 */
app.post('/fetcher-forward', async (c) => {
  const bind = tracedFetcher(c.env.BIND, { forwardRequestId: true, spans: true })
  const res = await bind.fetch(c.req.raw)
  return c.json({ traceId: getTraceContext()?.traceId, downstream: await res.json() })
})

export default app
