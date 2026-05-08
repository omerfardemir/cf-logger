# 007: Add traced fetch wrapper for outgoing HTTP trace propagation

**Priority:** P2
**Type:** AFK

## What to build

Trace propagation only works via the Session Factory pattern (RPC). Regular `fetch()` calls to external services or HTTP-based worker bindings don't carry `traceparent`. Provide a `tracedFetch` wrapper that reads trace context from ALS and injects the `traceparent` header automatically.

## Acceptance criteria

- [ ] `tracedFetch(url, init?)` exported from `@cf-logger/logger` (or a sub-path like `/fetch`)
- [ ] Reads current trace context from ALS via `getTraceContext()`
- [ ] Sets `traceparent` header on the outgoing request (preserves existing headers)
- [ ] Falls back to regular `fetch()` when no ALS context exists (no error)
- [ ] Test: within `runWithLogger`, `tracedFetch` sends correct `traceparent` header
- [ ] Test: outside ALS, `tracedFetch` works like normal `fetch` (no traceparent)
- [ ] Does not modify the original `init` object (spread/clone)

## Blocked by

None — can start immediately
