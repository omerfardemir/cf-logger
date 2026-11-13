# cf-logger

Structured logging for Cloudflare Workers and Node.js. Built on [Pino](https://getpino.io/) with per-request context via `AsyncLocalStorage`, W3C trace propagation, and a Session Factory pattern for RPC trace propagation across service bindings.

## Install

```bash
pnpm add cf-logger
# Hono is an optional peer dependency
pnpm add hono
```

## Entry Points

| Import              | Contents                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `cf-logger`         | Core: `createLogger`, `createSimpleLogger`, `LoggerFactory`, `loggerOptionsFromEnv`, ALS context, trace utilities, types |
| `cf-logger/hono`    | `useLogger`, `generateId` — Hono middleware                                                                              |
| `cf-logger/workers` | `TracedSession`, `TracedEntrypoint`, `tracedWorker`, `withTrace`, `tracedSession`                                        |

## How Trace Propagation Works

Every log line includes `traceId`, `spanId`, and optionally `parentSpanId`. When a request flows through multiple workers, they all share the same `traceId`:

```
User → main-worker (traceId: abc, spanId: 111)
         → bind-worker (traceId: abc, spanId: 222, parentSpanId: 111)
              → math-worker (traceId: abc, spanId: 333, parentSpanId: 222)
              → math-worker (traceId: abc, spanId: 444, parentSpanId: 222)
```

Search your log backend for `traceId = "abc"` to see the entire request across all workers. See [docs/rpc-trace-propagation.md](docs/rpc-trace-propagation.md) for the technical deep-dive.

---

## Cloudflare Worker Requirements

`cf-logger` uses `AsyncLocalStorage` through `node:async_hooks`.
Cloudflare Workers must enable Node.js compatibility in `wrangler.jsonc`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
}
```

The package expects these environment variables when using `loggerOptionsFromEnv()` or `tracedWorker()`:

```jsonc
{
  "vars": {
    "NAME": "my-worker",
    "LOG_LEVEL": "info",
    "ENVIRONMENT": "production",
    "VERSION": "1.0.0",
  },
}
```

## Core API (`cf-logger`)

### `createLogger(options)`

Create a logger with service name and additional fields baked in. Platform-aware: uses Pino `mixin` + stream on Node.js, `browser.write` on CF Workers.

```ts
import { createLogger } from 'cf-logger'

const logger = createLogger({
  service: 'my-worker',
  level: 'debug',
  environment: 'production',
  version: '1.2.3',
  requestId: '550e8400-e29b-41d4-a716-446655440000',
})

logger.info({ userId: 'u-42' }, 'Request started')
// → {"time":"...","level":"INFO","service":"my-worker","environment":"production","version":"1.2.3","requestId":"550e...","userId":"u-42","message":"Request started"}
```

All extra keys beyond `service` and `level` become persistent bindings on every log line.

### `createSimpleLogger(options)`

Minimal logger with just `service` — no extra bindings. Useful for standalone scripts, cron handlers, queue consumers.

```ts
const logger = createSimpleLogger({ service: 'cron-handler', level: 'info' })
```

### `getLogger(service?)`

Get the current request-scoped logger (inside ALS) or a cached standalone logger (outside ALS).

```ts
import { getLogger } from 'cf-logger'

// Inside middleware/traced():
const log = getLogger() // returns the ALS-scoped logger
log.info('has traceId automatically')

// Outside ALS:
const log = getLogger('cron') // cached standalone logger
```

### `setLoggerContext(fields)`

Add fields to the current request's logging context. All subsequent log lines in the same request include these fields.

```ts
import { setLoggerContext } from 'cf-logger'

setLoggerContext({ userId: 'u-42', feature: 'checkout' })
// All logs from this point include userId and feature
```

### `runWithLogger(options, fn)`

Run a function within a logging context. Framework-agnostic — works in any runtime.

```ts
import { runWithLogger, createLogger, resolveTrace } from 'cf-logger'

const logger = createLogger({ service: 'queue-handler' })
const trace = resolveTrace() // new root trace

runWithLogger({ logger, trace }, () => {
  getLogger().info('Inside ALS context — has traceId')
})
```

You can also pass a `traceparent` string instead of a resolved trace:

```ts
runWithLogger({ logger, traceparent: incomingTraceparent }, () => {
  // trace is parsed and continued automatically
})
```

### `getTraceContext()`

Read the current W3C trace context from ALS. Returns `null` outside a logging context.

```ts
import { getTraceContext, buildTraceparent } from 'cf-logger'

const trace = getTraceContext()
// { traceId: '...', spanId: '...', parentSpanId: '...', traceFlags: 0 }

const header = buildTraceparent(trace!)
// '00-{traceId}-{spanId}-00'
```

### Trace Utilities

```ts
import {
  generateTraceId, // → 32 hex chars
  generateSpanId, // → 16 hex chars
  parseTraceparent, // header string → TraceContext | null
  buildTraceparent, // TraceContext → header string
  resolveTrace, // parse incoming or start new root trace
} from 'cf-logger'
```

### `loggerOptionsFromEnv(env)`

Map the conventional Worker environment variables into `LoggerOptions`.

```ts
import { createLogger, loggerOptionsFromEnv } from 'cf-logger'

const logger = createLogger(loggerOptionsFromEnv(env))
```

---

## Hono Middleware (`cf-logger/hono`)

### `useLogger(loggerOrFactory)`

Creates a Hono middleware that:

1. Parses `traceparent` from the incoming request header
2. Reads `X-Request-Id` from the request or generates a new UUID
3. Creates an ALS context via `runWithLogger` with the logger and trace
4. Sets `c.var.logger`, `c.var.requestId`, and `c.var.traceId` for use in route handlers
5. Adds `requestId` to the ALS logger context so it appears on every log line
6. Sets response headers: `X-Request-Id`, `X-Trace-Id`, `traceparent`
7. Lets Hono own error responses, then logs `request.error` and `request.end` using the final `c.res.status`

```ts
import { Hono } from 'hono'
import { useLogger } from 'cf-logger/hono'
import { createLogger, setLoggerContext } from 'cf-logger'

const app = new Hono()

// Option A: per-request logger factory (recommended)
app.use(
  useLogger((c) =>
    createLogger({
      service: c.env.NAME,
      level: c.env.LOG_LEVEL,
      environment: c.env.ENVIRONMENT,
      version: c.env.VERSION,
      requestId: c.var.requestId,
    }),
  ),
)

// Option B: shared logger instance
app.use(useLogger(createLogger({ service: 'my-worker' })))

app.get('/', (c) => {
  setLoggerContext({ userId: 'u-42' })
  c.var.logger.info('Hello world') // includes traceId, spanId, userId
  return c.text('ok')
})
```

`useLogger()` does not catch, create, or replace error responses. It lets Hono run downstream handlers and app-level `onError()` normally, then checks `c.error` after `await next()`. Failed requests emit `request.error` with the final `c.res.status`; all requests emit `request.end` with the final `c.res.status`.

---

## CF Workers RPC (`cf-logger/workers`)

Propagate trace context across Cloudflare Worker service bindings using the **Session Factory pattern**.

### Why?

CF Workers RPC has no header/metadata channel. You can't attach a `traceparent` to `c.env.BIND.add(5, 7)`. The Session Factory solves this by passing `traceparent` via `binding.session(traceparent)` which returns an `RpcTarget` with trace context stored in a private field.

### `TracedSession<Env>`

Base class for RPC sessions. Extends `RpcTarget`. Your RPC methods go here.

```ts
import { TracedSession, tracedWorker } from 'cf-logger/workers'

interface Env {
  NAME: string
  LOG_LEVEL: string
  ENVIRONMENT: string
  VERSION: string
}

class MySession extends TracedSession<Env> {
  async add(a: number, b: number): Promise<number> {
    return this.traced(() => {
      this.logger.info({ a, b }, 'Adding')
      return a + b
    }, 'my-service.add') // optional: operation name enables span logging
  }
}

export default tracedWorker(MySession)
```

**Key members:**

| Member                        | Description                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `this.traced(fn, operation?)` | Runs `fn` within ALS trace context. Optional `operation` enables span timing. |
| `this.logger`                 | Request-scoped logger (must be called inside `traced()`)                      |
| `this.env`                    | Worker env (bindings, vars) — for multi-hop RPC calls                         |

### `tracedWorker(SessionClass)`

Creates a `WorkerEntrypoint` with a `session(traceparent)` method that instantiates your session class. Zero boilerplate.

```ts
// This is your entire worker export:
export default tracedWorker(MySession)

// Or extend it if you need scheduled(), queue(), etc:
export default class extends tracedWorker(MySession) {
  async scheduled(event: ScheduledEvent) {
    /* ... */
  }
}
```

### `withTrace(binding, fn, fields?)`

**Caller-side** one-liner. Reads `traceparent` from current ALS, calls `binding.session(traceparent, fields)`, passes the session to your callback.

```ts
import { withTrace } from 'cf-logger/workers'

// In a route handler or another traced() method:
const result = await withTrace(c.env.BIND, (s) => s.add(5, 7))

// With propagated fields — appear on all downstream logs:
const result = await withTrace(c.env.BIND, (s) => s.add(5, 7), { requestId: 'abc' })
```

### `tracedSession(binding, fields?)`

Lower-level alternative to `withTrace` — returns the session for multiple calls:

```ts
import { tracedSession } from 'cf-logger/workers'

const session = tracedSession(c.env.BIND)
const a = await session.add(1, 2)
const b = await session.add(3, 4)

// With propagated fields:
const session = tracedSession(c.env.BIND, { requestId: 'abc' })
```

### Multi-Hop RPC

Sessions have access to `this.env`, so they can call other service bindings with `withTrace`:

```ts
class BindSession extends TracedSession<Env> {
  async multiHop(value: number): Promise<number> {
    return this.traced(async () => {
      // bind-worker → math-worker (trace propagates automatically)
      const multiplied = await withTrace(this.env.MATH, (s) => s.multiply(value, 3))
      const divided = await withTrace(this.env.MATH, (s) => s.divide(multiplied, 2))
      return divided
    }, 'bind.multiHop')
  }
}
```

All workers in the chain share the same `traceId`.

### `TracedEntrypoint<Env>`

Alternative to `tracedWorker()` for manual entrypoint setup. Extends `WorkerEntrypoint` and provides `this.loggerOptions` from env vars (`NAME`, `LOG_LEVEL`, `ENVIRONMENT`, `VERSION`).

```ts
import { TracedEntrypoint, TracedSession } from 'cf-logger/workers'

class MySession extends TracedSession<Env> {
  /* ... */
}

export default class extends TracedEntrypoint<Env> {
  session(traceparent: string, fields?: Record<string, unknown>, tracestate?: string) {
    return new MySession(traceparent, this.loggerOptions, this.env, fields, tracestate)
  }

  async scheduled(event: ScheduledEvent) {
    /* ... */
  }
}
```

### Service Type Convention

Define shared service method interfaces and use `TracedServiceBinding<T>` for Worker bindings:

```ts
import type { TracedServiceBinding } from 'cf-logger/workers'

export interface BindService {
  add(a: number, b: number): Promise<number>
  multiHop(value: number): Promise<number>
}
```

Then type your env bindings:

```ts
interface Env {
  BIND: TracedServiceBinding<BindService>
  MATH: TracedServiceBinding<MathService>
}
```

---

## Span Logging

Pass an operation name as the second argument to `traced()` to get structured span logs with timing:

```ts
return this.traced(() => {
  // your logic
  return result
}, 'math.multiply')
```

Emits a span-end log on completion:

```json
{
  "level": "INFO",
  "span": {
    "operation": "math.multiply",
    "startTime": 1777021502058,
    "endTime": 1777021502059,
    "duration": 1,
    "status": "OK"
  },
  "message": "span.end math.multiply",
  "traceId": "...",
  "spanId": "...",
  "parentSpanId": "..."
}
```

On error, `status` is `"ERROR"` with an `error` field, logged at error level.

The span object intentionally does **not** duplicate `traceId`/`spanId`/`parentSpanId` — those are already on every log line via the ALS mixin.

Span logging is **optional**. Without an operation name, `traced()` has zero overhead beyond ALS setup.

---

## Platform Detection

The logger automatically detects the runtime:

- **CF Workers**: `navigator.userAgent === 'Cloudflare-Workers'` → uses `browser.write` (no streams)
- **Node.js**: uses Pino `mixin` + stream to `console.log`

Both produce identical JSON output with uppercase level strings.

---

## Development

```
cf-logger/
├── src/                  # cf-logger source and colocated *.test.ts
│   ├── index.ts          # Core entry: logger, ALS context, trace utilities, types
│   ├── hono.ts           # cf-logger/hono entry
│   └── workers.ts        # cf-logger/workers entry
├── dev/                  # Local Worker fixtures for e2e verification (not published)
│   ├── services.d.ts     # Shared RPC service interfaces
│   ├── main-worker/      # Gateway worker (Hono + routes)
│   ├── bind-worker/      # Mid-tier worker (single + multi-hop RPC)
│   └── math-worker/      # Leaf worker (multiply, divide)
├── scripts/e2e-local.ps1 # Starts the dev workers and probes trace propagation
└── docs/                 # Design deep-dives
```

The dev workers import `cf-logger` by package name, which resolves to this package's built `dist/` — run `pnpm build` before `pnpm dev`.

| Script                             | Purpose                                                    |
| ---------------------------------- | ---------------------------------------------------------- |
| `pnpm build`                       | Build `dist/` with tsdown                                  |
| `pnpm test`                        | Run unit tests (Vitest)                                    |
| `pnpm typecheck` / `typecheck:dev` | Typecheck the package / the dev workers (needs a build)    |
| `pnpm lint` / `lint:fix`           | Lint with oxlint                                           |
| `pnpm format` / `format:check`     | Format with oxfmt                                          |
| `pnpm dev`                         | Run all three dev workers on `http://localhost:8787`       |
| `pnpm e2e:local`                   | Build, start the dev workers, and assert trace propagation |
| `pnpm release:check`               | Everything above plus `npm pack --dry-run`                 |
