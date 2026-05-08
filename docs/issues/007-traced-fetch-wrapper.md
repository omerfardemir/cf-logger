# 007: Add traced fetch wrapper for outgoing HTTP trace propagation

**Priority:** P2
**Type:** AFK
**Status:** DONE
**Commit:** 9387b00

## What was built

`tracedFetch(url, init?)` reads trace context from ALS and injects `traceparent` header on outgoing requests. Falls back to regular `fetch()` outside ALS. Does not mutate the original `init` object.

## Acceptance criteria

- [x] `tracedFetch(url, init?)` exported from `@cf-logger/logger`
- [x] Reads current trace context from ALS via `getTraceContext()`
- [x] Sets `traceparent` header on the outgoing request (preserves existing headers)
- [x] Falls back to regular `fetch()` when no ALS context exists (no error)
- [x] Test: within `runWithLogger`, `tracedFetch` sends correct `traceparent` header
- [x] Test: outside ALS, `tracedFetch` works like normal `fetch` (no traceparent)
- [x] Does not modify the original `init` object (spread/clone)
