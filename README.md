# cf-logger

Cross-platform structured logging for **Cloudflare Workers** and **Node.js** with automatic trace propagation across RPC service bindings.

## Monorepo Structure

```
cf-logger/
├── packages/
│   └── logger/              # @cf-logger/logger — core logging package
│       └── src/
│           ├── index.ts     # Main exports
│           ├── types.ts     # Logger, TraceContext, SpanContext, etc.
│           ├── logger.ts    # Pino factory (platform-aware config)
│           ├── als.ts       # AsyncLocalStorage context management
│           ├── store.ts     # Shared ALS instance
│           ├── trace.ts     # W3C traceparent parse/build/resolve
│           ├── middleware.ts # Hono middleware (useLogger)
│           ├── hono.ts      # Re-export for @cf-logger/logger/hono
│           └── workers.ts   # Session Factory for RPC trace propagation
├── workers/                 # Example workers demonstrating usage
│   ├── services.d.ts        # Shared RPC service interfaces
│   ├── main-worker/         # Gateway worker (Hono + routes)
│   ├── bind-worker/         # Mid-tier worker (single + multi-hop RPC)
│   └── math-worker/         # Leaf worker (multiply, divide)
└── docs/                    # Documentation and design deep-dives
```

## Quick Start

```bash
pnpm install
pnpm dev   # starts all 3 workers with multi-worker dev
```

Hit `http://localhost:8787/` to see structured logs with trace context across workers.

## Package: `@cf-logger/logger`

Three entry points:

| Import | Use Case |
|--------|----------|
| `@cf-logger/logger` | Core: createLogger, getLogger, setLoggerContext, trace utilities |
| `@cf-logger/logger/hono` | Hono middleware: useLogger |
| `@cf-logger/logger/workers` | CF Workers RPC: TracedSession, withTrace, tracedWorker |

See [packages/logger/README.md](packages/logger/README.md) for full API docs.

## How Trace Propagation Works

Every log line includes `traceId`, `spanId`, and optionally `parentSpanId`. When a request flows through multiple workers, they all share the same `traceId`:

```
User → main-worker (traceId: abc, spanId: 111)
         → bind-worker (traceId: abc, spanId: 222, parentSpanId: 111)
              → math-worker (traceId: abc, spanId: 333, parentSpanId: 222)
              → math-worker (traceId: abc, spanId: 444, parentSpanId: 222)
```

Search Grafana for `traceId = "abc"` and you see the entire request across all workers.

### The Problem

Cloudflare Workers RPC (Service Bindings) has **no header/metadata channel** — you can't attach a `traceparent` to `c.env.BIND.add(5, 7)`. There's no built-in way to propagate trace context yet. In the future Cloudflare may add trace propagation to bindings, but until then, we need a workaround.

### The Solution: Session Factory Pattern

Instead of calling RPC methods directly on the binding, you call `binding.session(traceparent)` which returns an `RpcTarget` that carries trace context in a private field:

```ts
// Caller — one-liner with withTrace():
const result = await withTrace(c.env.BIND, s => s.add(5, 7))

// Receiver — TracedSession handles everything:
class BindSession extends TracedSession<Env> {
  async add(a: number, b: number) {
    return this.traced(() => {
      this.logger.info({ a, b }, 'Adding')
      return a + b
    }, 'bind.add')  // optional operation name for span logging
  }
}
export default tracedWorker(BindSession)
```

See [docs/rpc-trace-propagation.md](docs/rpc-trace-propagation.md) for the full technical deep-dive.

## Log Output

Every log line is structured JSON with trace context:

```json
{
  "time": "2026-04-24T09:05:02.059Z",
  "level": "INFO",
  "service": "bind-test",
  "environment": "development",
  "version": "1.0.0",
  "a": 5, "b": 7, "result": 12,
  "message": "Added 5 + 7 = 12",
  "traceId": "df8ff57e1b74314da69b381c02680a7f",
  "spanId": "6b470306cc5b904d",
  "parentSpanId": "31963346247f26e4"
}
```

When spans are enabled (operation name passed to `traced()`), a span-end log is emitted:

```json
{
  "level": "INFO",
  "span": {
    "operation": "bind.add",
    "startTime": 1777021502058,
    "endTime": 1777021502059,
    "duration": 1,
    "status": "OK"
  },
  "message": "span.end bind.add",
  "traceId": "df8ff57e1b74314da69b381c02680a7f",
  "spanId": "6b470306cc5b904d",
  "parentSpanId": "31963346247f26e4"
}
```

## Wrangler Config Convention

Each worker needs these env vars for the logger:

```jsonc
{
  "vars": {
    "NAME": "my-worker",        // service name in logs
    "LOG_LEVEL": "debug",       // trace | debug | info | warn | error | fatal
    "ENVIRONMENT": "production",
    "VERSION": "1.2.3"
  },
  "observability": {
    "logs": { "enabled": true, "invocation_logs": false }
  }
}
```

## Testing

```bash
cd packages/logger
pnpm test  # 43 tests across trace, ALS, and workers
```