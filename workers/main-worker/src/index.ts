import { Hono } from 'hono';
import { logger, useLogger } from './logger';
import { setLoggerContext, getTraceContext, buildTraceparent, type Logger } from '@cf-logger/logger';
import { withTrace } from '@cf-logger/logger/workers';
import { getClientDetails } from './network';
import type { BindService, ServiceSession } from './types';

type Context = {
  Bindings: {
    BIND: ServiceSession<BindService>;
    NAME: string;
    LOG_LEVEL: string;
    ENVIRONMENT: string;
    VERSION: string;
  };
  Variables: {
    logger: Logger;
    requestId: string;
    traceId: string;
  };
}

const app = new Hono<Context>();

app
.use(useLogger(logger))
.use('*', async (c, next) => {
  // Enrich all logs with connection metadata
  const conn = getClientDetails(c);
  const fields: Record<string, string> = {
    method: conn.method,
    path: conn.path,
  };
  if (conn.country) fields.country = conn.country;
  if (conn.user_agent) fields.user_agent = conn.user_agent;
  setLoggerContext(fields);
  await next();
});

/** GET / Simple: log levels demo + single-hop RPC */
app.get('/', async (c) => {
  const log = c.var.logger;

  // Demo: all log levels
  log.trace('Trace-level log (most verbose)');
  log.debug('Debug-level log');
  log.info('Hello from the main worker');
  log.warn({ warning: 'test' }, 'Warning with structured data');
  log.error('Error-level log (not a real error)');

  // Demo: setLoggerContext enriches all subsequent logs
  setLoggerContext({ userId: 'user-42', feature: 'demo' });
  log.info('This log has userId and feature fields attached');

  // Demo: single-hop RPC with trace propagation → bind-worker
  const total = await withTrace(c.env.BIND, (s) => s.add(5, 7));
  log.info({ total }, 'Single-hop RPC: 5 + 7 = %d', total);

  return c.json({
    message: 'Single-hop RPC demo',
    total,
    traceId: getTraceContext()?.traceId,
  });
});

/** GET /multi-hop Multi-hop: main → bind-worker → math-worker */
app.get('/multi-hop', async (c) => {
  const log = c.var.logger;

  setLoggerContext({ userId: 'user-99', feature: 'multi-hop' });
  log.info('Starting multi-hop demo: main → bind → math');

  // This single call triggers: main → bind-worker → math-worker (×2 calls)
  // All three workers share the same traceId in their logs
  const result = await withTrace(c.env.BIND, (s) => s.multiHop(10));
  log.info({ result }, 'Multi-hop complete: f(10) = (10 * 3) / 2 = %d', result);

  return c.json({
    message: 'Multi-hop RPC demo: main → bind → math (×2)',
    input: 10,
    formula: '(10 × 3) ÷ 2',
    result,
    traceId: getTraceContext()?.traceId,
  });
});

/** GET /error Error handling: division by zero in downstream worker */
app.get('/error', async (c) => {
  const log = c.var.logger;

  setLoggerContext({ feature: 'error-demo' });
  log.info('About to trigger an error in downstream worker');

  try {
    // math-worker will throw "Division by zero"
    // The error propagates back through the RPC chain
    await withTrace(c.env.BIND, (s) => s.multiHop(0));
    return c.text('Should not reach here');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'Caught RPC error from downstream worker');
    return c.json({
      message: 'Error propagated from math-worker through bind-worker',
      error: message,
      traceId: getTraceContext()?.traceId,
    }, 500);
  }
});

/** GET /trace Shows current trace context */
app.get('/trace', async (c) => {
  const trace = getTraceContext();
  const traceparent = trace ? buildTraceparent(trace) : null;

  c.var.logger.info({ trace }, 'Current trace context');

  return c.json({
    traceId: trace?.traceId,
    spanId: trace?.spanId,
    parentSpanId: trace?.parentSpanId,
    traceparent,
  });
});

export default app;
