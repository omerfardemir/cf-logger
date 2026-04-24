# RPC Trace Propagation on Cloudflare Workers

## What We Have Today

The `@pino-log-test/logger` package is a **complete cross-platform structured logging library**:

- **Pino-based** with platform-aware config (Node.js mixin+stream, CF Workers `browser.write`)
- **AsyncLocalStorage** for per-request scoped context (trace, user fields, logger)
- **W3C Trace Context** (`traceparent`) parsing, generation, and propagation
- **Hono middleware** (`useLogger`) that auto-creates ALS context from incoming `traceparent` headers
- **Framework-agnostic** `runWithLogger()` for non-Hono contexts (cron, queue, RPC handlers, etc.)
- All logs include `traceId`, `spanId`, `parentSpanId` — ready for Grafana correlation

**Trace propagation works for HTTP-to-HTTP** (Hono → Hono via `fetch`), because `traceparent` flows as a standard header.

## What Does NOT Work — RPC Trace Propagation

When Worker A calls Worker B via **Service Binding RPC** (`c.env.BIND.add(5, 7)`), **there is no way to attach trace context**. The RPC call goes through Cloudflare's internal JSRPC protocol, which:

1. **Has no user-accessible header/metadata channel** — you can't attach a `traceparent` to an RPC method call
2. **Does not auto-propagate trace context** — CF's observability auto-instruments `fetch`, KV, R2, D1, DO, but **not RPC calls** between workers

We explored three approaches, all blocked:

### Approach 1: Hidden Trace Bag (append to args)

Append a hidden `{__$$trace: traceparent}` object as the last argument via `traced()` Proxy wrapper on the caller, strip it on the receiver via `TracedEntrypoint`.

**Blocked by:** Wrapping a `Fetcher`/service binding stub in a `Proxy` throws `DataCloneError: ServiceStub serialization requires the 'experimental' compat flag` (workerd [#6358](https://github.com/cloudflare/workerd/issues/6358)). The `experimental` flag prevents deployment.

**Note:** The *receiver side* Proxy (wrapping `this` in `TracedEntrypoint` constructor) **was fixed** in workerd [#3212](https://github.com/cloudflare/workerd/pull/3212) (Dec 2024, `v1.20241213.0`). But the *caller side* Proxy on `Fetcher` remains broken.

### Approach 2: Cap'n Web (route RPC over HTTP)

Use Cloudflare's `capnweb` library to route RPC over HTTP through service bindings, injecting `traceparent` as an HTTP header.

**Technically worked** but was an architectural shift that replaced native RPC with a custom HTTP-based protocol. Not solid enough — adds complexity, different semantics, and the library is still young.

### Approach 3: Manual explicit argument passing

Pass `traceparent` as an explicit argument to every RPC method.

**Works** but terrible DX — every RPC method signature needs an extra parameter, every call site needs boilerplate. Doesn't scale across ~20 workers with 6-10 hops.

## What Cloudflare Would Need to Fix

For native RPC trace propagation to work, one of these would need to happen:

1. **CF auto-propagates trace context through RPC** (like they do for `fetch`) — this is the ideal fix and the most likely eventual path given their OTel investment
2. **CF allows metadata/headers on RPC calls** — a user-space channel to attach context to RPC invocations
3. **CF fixes Proxy on Fetcher stubs** (workerd [#6358](https://github.com/cloudflare/workerd/issues/6358)) — would unblock the hidden trace bag approach

## What We Should Do

**Short term:** The logger package is complete as-is. Each worker gets its own scoped `traceId` per request. For the bind-worker pattern, the RPC handler wraps itself in `runWithLogger()` with a fresh trace — logs are structured but traces don't link across workers.

**Monitor:** Watch for CF adding RPC to their auto-instrumentation (most likely path). Their `observability.logs` pipeline already exports to Grafana — once they instrument RPC spans, our `traceId`/`spanId` fields will naturally connect.

**If you need cross-worker correlation now:** The only clean workaround is to **pass traceparent explicitly as a method argument** in the few critical paths where you need it, and use `runWithLogger({ logger, traceparent })` on the receiver. Ugly, but it works without hacks:

```ts
// Caller
const tp = buildTraceparent(getTraceContext()!)
const total = await c.env.BIND.add(5, 7, tp)

// Receiver
async add(a: number, b: number, traceparent?: string) {
  return runWithLogger({ logger, traceparent }, () => { ... })
}
```

This is a conscious tradeoff — apply it only to the critical hops where you need end-to-end traces, not everywhere.
