# @cf-logger/logger — AI Agent Context

## Identity

- **Package:** `@cf-logger/logger` v0.0.1
- **Monorepo:** `cf-logger` (pnpm workspaces)
- **Purpose:** Cross-platform structured JSON logging for Cloudflare Workers + Node.js with W3C trace propagation across RPC service bindings
- **Built on:** Pino 10.x, AsyncLocalStorage, Hono 4.x (optional)
- **Runtime:** CF Workers (primary), Node.js (secondary). ESM only.
- **Destination:** Cloudflare Observability → OTLP → Grafana Loki

## Repository Layout

```
cf-logger/
├── packages/logger/src/           # @cf-logger/logger — THE package
│   ├── index.ts                   # Public exports barrel
│   ├── types.ts                   # LogLevel, LogFields, Logger, TraceContext, SpanContext, ALSStore, LoggerOptions
│   ├── logger.ts                  # Pino factory: createLogger, createSimpleLogger, LoggerFactory, platform detection
│   ├── als.ts                     # ALS: getLogger, setLoggerContext, runWithLogger, getTraceContext, _reset
│   ├── store.ts                   # Single AsyncLocalStorage<ALSStore> instance
│   ├── trace.ts                   # W3C: generateTraceId, generateSpanId, parseTraceparent, buildTraceparent, resolveTrace
│   ├── middleware.ts              # Hono: useLogger middleware
│   ├── hono.ts                    # Re-export of middleware.ts
│   ├── workers.ts                 # RPC: TracedSession, TracedEntrypoint, tracedWorker, tracedSession, withTrace
│   ├── *.test.ts                  # Colocated tests (43 total)
│   └── vitest.config.ts
├── workers/
│   ├── services.d.ts              # Shared RPC interfaces: ServiceSession<T>, BindService, MathService
│   ├── main-worker/               # Gateway: Hono app, useLogger, routes, calls bind-worker
│   ├── bind-worker/               # Mid-tier: TracedSession, calls math-worker via withTrace
│   └── math-worker/               # Leaf: TracedSession, multiply/divide, no downstream
├── docs/rpc-trace-propagation.md  # Technical deep-dive on the Session Factory pattern
├── pnpm-workspace.yaml            # packages/* + workers/*, catalog versions
└── package.json                   # Root: `pnpm dev` (all 3 workers), `pnpm deploy`
```

## Three Entry Points

```ts
// Core — logger creation, ALS, trace utilities, types
import { createLogger, getLogger, setLoggerContext, runWithLogger, getTraceContext,
         resolveTrace, buildTraceparent, parseTraceparent, generateTraceId, generateSpanId,
         type Logger, type LogFields, type TraceContext, type SpanContext, type LoggerOptions, type LogLevel } from '@cf-logger/logger'

// Hono middleware
import { useLogger } from '@cf-logger/logger/hono'

// CF Workers RPC trace propagation
import { TracedSession, TracedEntrypoint, tracedWorker, tracedSession, withTrace } from '@cf-logger/logger/workers'
```

## Platform Detection & Console Method Mapping

```ts
const IS_WORKERS = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers'
```

**Critical for Grafana:** CF's OTLP pipeline maps the console method to OTLP severity. We map Pino levels to correct console methods:

| Pino Level | JSON `level` | Console Method | CF OTLP severity | Grafana `detected_level` |
|------------|-------------|----------------|-------------------|--------------------------|
| trace (10) | `"TRACE"` | `console.debug()` | debug | debug 🔵 |
| debug (20) | `"DEBUG"` | `console.debug()` | debug | debug 🔵 |
| info (30) | `"INFO"` | `console.info()` | info | info |
| warn (40) | `"WARN"` | `console.warn()` | warn | warning 🟡 |
| error (50) | `"ERROR"` | `console.error()` | error | error 🔴 |
| fatal (60) | `"FATAL"` | `console.error()` | error | error 🔴 |

`console.log()` maps to OTLP `"log"` (not `"info"`) — this breaks Grafana severity panels. Always use `console.info()` for INFO level.

**Node.js path:** Pino `mixin` + stream to `{ write(msg) { console.log(msg.trimEnd()) } }` — severity mapping irrelevant (no OTLP).

## ALS (AsyncLocalStorage) Architecture

Every request runs inside `als.run(store, fn)`. Store shape:

```ts
interface ALSStore {
  trace: TraceContext    // { traceId, spanId, parentSpanId?, traceFlags }
  fields: LogFields      // mutable — setLoggerContext() writes here
  logger: Logger         // pino wrapper for this request
}
```

**Field injection:** On every log call, `getALSFields()` merges `{ traceId, spanId, parentSpanId?, ...fields }` into the log line:
- **Node.js:** via Pino `mixin` option (called per log line)
- **CF Workers:** via `browser.write` (manually `Object.assign` before `JSON.stringify`)

**API:**
- `getLogger(service?)` — inside ALS: returns store.logger. Outside: returns cached standalone logger.
- `setLoggerContext(fields)` — inside ALS: `Object.assign(store.fields, fields)`. Outside: creates child loggers.
- `runWithLogger({ logger, trace?, traceparent?, fields? }, fn)` — creates ALS context. Accepts either resolved `trace` or raw `traceparent` string.
- `getTraceContext()` — returns shallow copy of `store.trace` or null.
- `_reset()` — test helper, clears standalone logger cache.

## Trace System

**W3C traceparent format:** `00-{traceId:32hex}-{spanId:16hex}-{flags:2hex}`

```ts
resolveTrace(traceparent?)  // parse incoming or generate new root. ALWAYS generates new spanId.
parseTraceparent(header)    // → TraceContext | null (strict validation)
buildTraceparent(trace)     // → "00-{traceId}-{spanId}-{flags}"
generateTraceId()           // → 32 hex chars via crypto.getRandomValues
generateSpanId()            // → 16 hex chars via crypto.getRandomValues
```

**Two trace ID layers in production:**
1. **CF's OTLP traceId** — per-worker-invocation, isolated, NOT linked across RPC. Visible in Grafana `Structured metadata`.
2. **Our traceId** — inside JSON body, linked across all workers via Session Factory. Query with `| json | traceId="..."`.

CF's traceId is useless for cross-worker correlation. Our traceId is the one that matters.

## Session Factory Pattern (RPC Trace Propagation)

**Problem:** CF Workers RPC (service bindings) has no header/metadata channel. `c.env.BIND.add(5, 7)` cannot carry a traceparent. CF doesn't auto-instrument RPC calls.

**Solution:** Use `RpcTarget` private fields. Private fields (`#field`) stay server-side — never serialized over JSRPC.

### Data Flow

```
Caller (main-worker):
  withTrace(c.env.BIND, s => s.add(5, 7), { requestId: 'abc' })
    → reads traceparent from ALS
    → calls binding.session(traceparent, fields)
    → calls s.add(5, 7) on returned session

Receiver (bind-worker):
  tracedWorker(BindSession) creates WorkerEntrypoint with:
    session(traceparent, fields?) → new BindSession(traceparent, loggerOptions, env, fields)

  BindSession extends TracedSession<Env>:
    #traceparent = "00-abc...-111...-00"  ← private, never sent over wire
    #loggerOptions = { service: "bind-test", level: "debug", ... }  ← from env vars
    #fields = { requestId: 'abc' }  ← optional propagated fields
    env = { MATH: binding, ... }

  add(a, b):
    this.traced(() => { ... }, 'bind.add')
      → createLogger(#loggerOptions)
      → runWithLogger({ logger, traceparent: #traceparent, fields: #fields }, fn)
        → resolveTrace(traceparent) → new spanId, parentSpanId = caller's spanId
        → ALS context with trace + logger + fields
        → this.logger / getLogger() returns ALS-scoped logger
        → emits span log on completion (if operation provided)
```

### Key Classes & Functions

**`TracedSession<E>`** (extends `RpcTarget`):
- Constructor: `(traceparent, loggerOptions, env, fields?)`
- `#traceparent`, `#loggerOptions`, `#fields` — private, never serialized
- `protected env: E` — instance property, access bindings for multi-hop
- `protected traced<R>(fn, operation?)` — runs fn in ALS context. With operation: records timing, emits span log.
- `protected get logger` — shortcut for `getLogger(service)`

**`tracedWorker(SessionClass)`** — generates `WorkerEntrypoint` with `session(traceparent, fields?)` + default `fetch()` returning 404. Reads `LoggerOptions` from env vars (NAME, LOG_LEVEL, ENVIRONMENT, VERSION).

**`withTrace(binding, fn, fields?)`** — caller-side one-liner. Reads traceparent from ALS, creates session with optional propagated fields, runs callback.

**`tracedSession(binding, fields?)`** — lower-level: returns session for multiple calls.

**`TracedEntrypoint<E>`** — alternative to `tracedWorker()` for manual entrypoint setup. Has `protected get loggerOptions`.

### Optional Field Propagation

```ts
// Without fields (default):
await withTrace(c.env.BIND, s => s.add(5, 7))

// With propagated fields — appear on all downstream logs:
await withTrace(c.env.BIND, s => s.add(5, 7), { requestId: 'abc', userId: 'u-42' })
```

Fields flow: `withTrace → binding.session(tp, fields) → TracedSession.#fields → runWithLogger({ fields }) → ALS store.fields → every log line`

## Span Logging

Optional — pass operation name as second arg to `traced()`:

```ts
this.traced(() => { /* logic */ }, 'math.multiply')
```

Emits on completion:
```json
{ "level": "INFO", "span": { "operation": "math.multiply", "startTime": ..., "endTime": ..., "duration": 3, "status": "OK" }, "message": "span.end math.multiply", "traceId": "...", "spanId": "...", "parentSpanId": "..." }
```

- Handles both sync and async (Promise detection)
- On error: `status: "ERROR"`, `error: "message"`, logged at error level
- Span object excludes traceId/spanId/parentSpanId — already on every log line via ALS mixin
- Without operation name: zero span overhead

## Hono Middleware (`useLogger`)

```ts
useLogger(loggerOrFactory)  // Logger instance OR (c) => Logger factory
```

What it does:
1. Parses `traceparent` from request header
2. Reads/generates `X-Request-Id`
3. Creates ALS context via `runWithLogger({ logger, trace })`
4. Sets `c.var.logger`, `c.var.requestId`, `c.var.traceId`
5. Adds `requestId` to ALS fields via `setLoggerContext({ requestId })`
6. Sets response headers: `X-Request-Id`, `X-Trace-Id`, `traceparent`

## Logger Creation

```ts
createLogger({ service, level, environment, version, requestId, ...extras })
// → pino.child({ service, environment, version, requestId, ... })
// Extra keys beyond service/level become persistent bindings on every log line

createSimpleLogger({ service, level })
// → pino.child({ service }) — minimal, no extra bindings
```

## Env Var Convention

Every worker's `wrangler.jsonc` must have:
```jsonc
{
  "vars": { "NAME": "my-worker", "LOG_LEVEL": "debug", "ENVIRONMENT": "production", "VERSION": "1.2.3" },
  "observability": { "logs": { "enabled": true, "invocation_logs": false } }
}
```

`invocation_logs: false` prevents CF's default invocation logs from duplicating our structured JSON.

`envLoggerOptions(env)` reads these: `{ service: env.NAME, level: env.LOG_LEVEL, environment: env.ENVIRONMENT, version: env.VERSION }`.

## Service Binding Topology

```
main-worker (pino-log-test)     — Hono gateway, useLogger middleware
  └── BIND → bind-worker (bind-test)   — TracedSession, calls math-worker
                └── MATH → math-worker (math-test)  — TracedSession, leaf
```

Shared interfaces in `workers/services.d.ts`:
```ts
interface ServiceSession<T> { session(traceparent: string, fields?: Record<string, unknown>): T }
interface BindService { add(a, b): Promise<number>; multiHop(value): Promise<number> }
interface MathService { multiply(a, b): Promise<number>; divide(a, b): Promise<number> }
```

## Log Output Shape

Every log line is flat JSON with trace context injected by ALS:
```json
{
  "time": "2026-04-25T...",
  "level": "INFO",
  "service": "bind-test",
  "environment": "development",
  "version": "1.0.0",
  "message": "Added 5 + 7 = 12",
  "traceId": "ae781fa56ded9de49c589a7b9dba6970",
  "spanId": "6b470306cc5b904d",
  "parentSpanId": "31963346247f26e4",
  "a": 5, "b": 7, "result": 12
}
```

**Field sources:**
- `time`, `level`, `message` — Pino core
- `service`, `environment`, `version` — createLogger bindings
- `traceId`, `spanId`, `parentSpanId` — ALS trace context (injected by getALSFields)
- `a`, `b`, `result` — first arg to `logger.info({ a, b, result }, 'msg')`
- `requestId`, `userId`, etc. — `setLoggerContext()` or propagated fields

## Grafana Loki Querying

Loki stores log lines as strings. Only `service_name` is an indexed label (set by CF). Extract fields at query time:

```logql
{service_name="bind-test"} | json | traceId="ae781fa5..."
{service_name=~".+"} | json | level="ERROR"
{service_name=~".+"} | json | message=~"span.end.*"
{service_name="pino-log-test"} | json | userId="user-42"
```

## Testing

- **43 tests** across 3 files: `trace.test.ts`, `als.test.ts`, `workers.test.ts`
- **Run:** `pnpm test` in `packages/logger`
- **Mocks:** `cloudflare:workers` is mocked (RpcTarget, WorkerEntrypoint not available in Node.js/Vitest)
- **Pattern:** `vi.spyOn(console, 'log')` captures output, parse as JSON, assert structure
- **Cleanup:** `_reset()` clears cached standalone loggers between tests

## Commands

| Command | Where | What |
|---------|-------|------|
| `pnpm dev` | root | Multi-worker dev (all 3 workers) |
| `pnpm test` | packages/logger | Run all 43 tests |
| `pnpm deploy` | root | Deploy all 3 workers to CF |

## Catalog Dependencies

| Package | Version |
|---------|---------|
| pino | ^10.3.1 |
| hono | ^4.12.14 (optional peer) |
| wrangler | ^4.84.1 |
| vitest | ^4.1.5 |
| typescript | ^6.0.3 |
| @cloudflare/workers-types | ^4.20260422.1 |

## Known Platform Constraints

- **Proxy on Fetcher stubs BROKEN** (workerd #6358) — cannot wrap CF service binding in JS Proxy. Receiver-side Proxy on RpcTarget works (fixed in workerd #3212). This is why Session Factory exists instead of transparent Proxy tracing.
- **RPC has no metadata channel** — CF may add auto-instrumentation eventually (like they did for fetch/KV/R2/D1/DO). When they do, our traceId/spanId fields will naturally align.
- **CF OTLP traceId is per-invocation** — does NOT link across RPC. Our traceId does.
- **console.log() maps to OTLP "log" not "info"** — must use console.info() for correct Grafana severity. Already handled in LEVEL_TO_CONSOLE map.

## Code Conventions

- ESM imports only, no CommonJS
- `import type { ... }` for type-only imports
- No barrel re-exports beyond the 3 entry points
- Tests colocated: `*.test.ts` next to `*.ts`
- Minimal abstractions — TracedSession is the only class hierarchy
- Worker pattern: `class XSession extends TracedSession<Env> { ... } export default tracedWorker(XSession)`
- Tests colocated with source (`*.test.ts` next to `*.ts`)
- Type-only imports where possible (`import type { ... }`)
