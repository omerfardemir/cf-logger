# 001: Add error stack traces to span logging and Pino serializers

**Priority:** P0
**Type:** AFK

## What to build

`TracedSession.traced()` captures only `err.message` on errors, discarding stack traces. Add Pino's `stdSerializers.err` and propagate the full error object into span logs so stack traces appear in Grafana Loki.

End-to-end: when a downstream worker throws, every span log in the RPC chain includes the stack trace — queryable via `| json | span.error.stack=~".+"`.

## Acceptance criteria

- [x] `traced()` span error logs include `stack` alongside `message`
- [x] Pino error serializer (`pino.stdSerializers.err`) is configured in both Node.js and Workers paths
- [x] Tests verify stack trace presence on both sync and async error spans
- [x] Existing error span tests updated (structure may change from `span.error: string` to `span.error: { message, stack }`)

## Status

**DONE** — implemented in commit `a853731`
