# 009: Add W3C tracestate round-trip support

**Priority:** P3
**Type:** AFK
**Status:** DONE
**Commit:** facf23e

## What was built

`tracestate` is now parsed, stored, and propagated through the entire request lifecycle — middleware, ALS, RPC sessions, and outgoing fetch. Vendor-specific context (Datadog, Jaeger, custom keys) survives across hops.

## Acceptance criteria

- [x] `TraceContext` type includes optional `tracestate: string`
- [x] `useLogger` reads `tracestate` header and stores it in trace context
- [x] `useLogger` sets `tracestate` on response headers (when present)
- [x] `TracedSession` propagates `tracestate` through the Session Factory
- [x] `tracedFetch` includes `tracestate` on outgoing requests
- [x] `tracedSession`/`withTrace`/`tracedWorker` updated for tracestate
- [x] Tests verify `tracestate` round-trips through middleware
- [x] Tests verify `tracestate` is optional — existing code without it still works (65/65)
