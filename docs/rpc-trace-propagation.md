# RPC Trace Propagation on Cloudflare Workers

## The Problem

Cloudflare Workers RPC (Service Bindings) provides **no user-accessible header or metadata channel**. When Worker A calls Worker B via `c.env.BIND.add(5, 7)`, there's no way to attach a `traceparent`. CF's observability auto-instruments `fetch`, KV, R2, D1, and DO — but **not RPC calls between workers**.

This means distributed tracing across service bindings requires a user-space solution.

## Approaches We Explored

### ❌ Approach 1: Proxy on Fetcher Stub (Hidden Trace Bag)

Wrap the service binding in a JS `Proxy` to intercept method calls and append a hidden `{__$$trace: traceparent}` argument. Strip it on the receiver.

**Blocked by:** `DataCloneError` — wrapping a `Fetcher`/service binding stub in a `Proxy` throws `ServiceStub serialization requires the 'experimental' compat flag` (workerd [#6358](https://github.com/cloudflare/workerd/issues/6358)). The `experimental` flag prevents deployment to production.

> **Note:** The _receiver-side_ Proxy (wrapping `this` inside an `RpcTarget`) was fixed in workerd [#3212](https://github.com/cloudflare/workerd/pull/3212) (Dec 2024, `v1.20241213.0`). But the _caller-side_ Proxy on `Fetcher` remains broken.

### ❌ Approach 2: Cap'n Web (RPC over HTTP)

Use Cloudflare's `capnweb` library to route RPC over HTTP through service bindings, injecting `traceparent` as an HTTP header.

**Technically functional** but replaced native JSRPC with a custom HTTP protocol. Adds complexity, changes semantics, and the library is immature. Rejected as not production-ready.

### ❌ Approach 3: Explicit Argument Passing

Pass `traceparent` as an extra argument to every RPC method.

**Works** but terrible developer experience — every method signature and call site needs boilerplate. Doesn't scale across ~20 workers with 6-10 hops per request.

### ✅ Approach 4: Session Factory Pattern (Adopted)

Use `RpcTarget` private fields to carry trace context. The caller calls `binding.session({ traceparent, tracestate, fields })` which returns an `RpcTarget` instance with that object stored in a `#private` field (never serialized over the wire). RPC methods on the session wrap their logic in `traced()` which sets up ALS with the correct trace context.

**Why it works:**

- `binding.session({ traceparent, tracestate, fields })` is a standard RPC method call — CF supports passing plain objects
- Private fields (`#traceparent`) on `RpcTarget` stay server-side — only prototype methods are exposed via JSRPC
- Each session generates a new `spanId` and links `parentSpanId` to the caller's `spanId`
- The caller reads traceparent from ALS automatically via `withTrace()`

## The Solution: How It Works

### Architecture

```
HTTP Request (with traceparent header)
  │
  ▼
┌─────────────────────────────────────────────────┐
│  main-worker (Hono + useLogger middleware)       │
│  traceId: abc   spanId: 111                     │
│                                                  │
│  withTrace(c.env.BIND, s => s.multiHop(10))     │
│    └─ reads traceparent from ALS                 │
│    └─ calls BIND.session({ traceparent })        │
└─────────────┬───────────────────────────────────┘
              │  JSRPC (traceparent as method arg)
              ▼
┌─────────────────────────────────────────────────┐
│  bind-worker (TracedSession)                     │
│  traceId: abc   spanId: 222   parent: 111       │
│                                                  │
│  this.traced(async () => {                       │
│    withTrace(this.env.MATH, s => s.multiply())   │
│    withTrace(this.env.MATH, s => s.divide())     │
│  }, 'bind.multiHop')                             │
└─────────────┬──────────┬────────────────────────┘
              │          │  JSRPC
              ▼          ▼
┌──────────────────┐  ┌──────────────────┐
│  math-worker     │  │  math-worker     │
│  traceId: abc    │  │  traceId: abc    │
│  spanId: 333     │  │  spanId: 444     │
│  parent: 222     │  │  parent: 222     │
└──────────────────┘  └──────────────────┘
```

All four invocations share `traceId: abc`. Search Grafana for that ID and you see the entire request.

### Receiver Side

```ts
import { TracedSession, tracedWorker } from 'cf-logger/workers'

class MathSession extends TracedSession<Env> {
  async multiply(a: number, b: number): Promise<number> {
    return this.traced(() => {
      const result = a * b
      this.logger.info({ a, b, result }, 'Multiplied %d × %d = %d', a, b, result)
      return result
    }, 'math.multiply') // operation name → span logging
  }
}

export default tracedWorker(MathSession)
```

**`TracedSession`** handles:

- Stores `traceparent` in `#private` field (never sent over wire)
- `traced(fn, operation?)` opens a Logging Context (`runWithLogger`) continuing the caller's trace; with `operation`, the call is reported as a Span
- `this.logger` returns the Logging Context's logger with traceId/spanId
- `this.env` provides access to bindings for multi-hop RPC

**`tracedWorker(SessionClass)`** generates the entrypoint:

- Implements `session(init)` → instantiates your session class
- Builds one Root Logger per isolate from env vars (NAME, LOG_LEVEL, ENVIRONMENT, VERSION) and hands it to every session
- Includes a default `fetch()` returning 404

### Caller Side

```ts
import { withTrace } from 'cf-logger/workers'

// One-liner: reads traceparent from ALS, creates session, runs callback
const result = await withTrace(c.env.BIND, (s) => s.add(5, 7))

// Or for multiple calls on the same session:
import { tracedSession } from 'cf-logger/workers'
const session = tracedSession(c.env.BIND)
const a = await session.add(1, 2)
const b = await session.multiply(3, 4)
```

### Service Interfaces

Define shared service method interfaces and use the package-provided traced binding type:

```ts
import type { TracedServiceBinding } from 'cf-logger/workers'

export interface BindService {
  add(a: number, b: number): Promise<number>
  multiHop(value: number): Promise<number>
}

export interface MathService {
  multiply(a: number, b: number): Promise<number>
  divide(a: number, b: number): Promise<number>
}
```

Type your env bindings:

```ts
interface Env {
  BIND: TracedServiceBinding<BindService>
  MATH: TracedServiceBinding<MathService>
}
```

### Wrangler Config

```jsonc
// bind-worker/wrangler.jsonc
{
  "services": [{ "binding": "MATH", "service": "math-test" }],
  "vars": {
    "NAME": "bind-test",
    "LOG_LEVEL": "debug",
    "ENVIRONMENT": "development",
    "VERSION": "1.0.0",
  },
}
```

## Span Logging

Pass an operation name to `traced()` to get structured span timing:

```ts
return this.traced(() => {
  // your logic
}, 'math.multiply')
```

Emits on completion:

```json
{
  "level": "INFO",
  "span": { "operation": "math.multiply", "duration": 3, "status": "OK" },
  "message": "span.end math.multiply",
  "traceId": "abc...",
  "spanId": "333...",
  "parentSpanId": "222..."
}
```

On error: `status: "ERROR"`, `error: "message"`, logged at error level. The span object is intentionally lean — trace IDs are already on every log line.

Span logging is **optional**. Omit the operation name and `traced()` has zero span overhead.

## What Cloudflare Could Still Improve

1. **Auto-propagate trace context through RPC** — like they do for `fetch`. This is the ideal fix and most likely eventual path given their OTel investment. When/if this ships, our `traceId`/`spanId` fields will align with CF's native spans automatically.

2. **Allow metadata/headers on RPC calls** — a user-space channel to attach context to RPC invocations. Would eliminate the need for the session pattern.

3. **Fix Proxy on Fetcher stubs** (workerd [#6358](https://github.com/cloudflare/workerd/issues/6358)) — would enable transparent tracing without changing method signatures.

## Key Decisions

| Decision                             | Rationale                                                            |
| ------------------------------------ | -------------------------------------------------------------------- |
| Session Factory over Proxy           | CF platform limitation (workerd #6358) blocks Proxy on Fetcher stubs |
| Private fields for traceparent       | `#field` on RpcTarget stays server-side, never serialized            |
| `withTrace()` one-liner API          | Clean DX without changing method signatures                          |
| Span data excludes trace IDs         | Already on every log line — no duplicate bytes                       |
| Optional span logging                | Zero overhead when you don't need timing                             |
| Env var convention (NAME, LOG_LEVEL) | Consistent across workers, readable from wrangler config             |
