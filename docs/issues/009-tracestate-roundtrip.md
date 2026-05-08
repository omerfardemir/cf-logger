# 009: Add W3C tracestate round-trip support

**Priority:** P3
**Type:** AFK

## What to build

The W3C Trace Context spec defines `tracestate` alongside `traceparent` for vendor-specific key-value pairs. Currently `tracestate` is silently dropped. Parse, store, and propagate `tracestate` through the request lifecycle and across RPC hops so vendor-specific context (Datadog, Jaeger, custom keys) survives.

## Acceptance criteria

- [ ] `TraceContext` type includes optional `tracestate: string`
- [ ] `parseTraceparent` is paired with a `parseTracestate` or the middleware reads both headers
- [ ] `useLogger` reads `tracestate` header from incoming request and stores it in trace context
- [ ] `buildTraceparent` is paired with `buildTracestate` or `useLogger` sets both response headers
- [ ] `TracedSession` propagates `tracestate` alongside `traceparent` through the Session Factory
- [ ] `tracedFetch` (if #007 is done) includes `tracestate` on outgoing requests
- [ ] `ServiceSession` interface updated to accept `tracestate`
- [ ] Tests verify `tracestate` round-trips through middleware → RPC → downstream
- [ ] Tests verify `tracestate` is optional — existing code without it still works

## Blocked by

None — can start immediately (but benefits from #007 being done first)
