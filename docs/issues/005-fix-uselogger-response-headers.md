# 005: Fix useLogger response headers to survive errors and move inside ALS

**Priority:** P2
**Type:** AFK
**Status:** DONE
**Commit:** 31ef9af

## What was built

Response headers (`X-Request-Id`, `X-Trace-Id`, `traceparent`) moved inside `runWithLogger` callback in a `finally` block. Headers are now always set regardless of downstream errors.

## Acceptance criteria

- [x] Response headers are set inside `runWithLogger` callback, after `next()` completes or throws
- [x] `X-Request-Id`, `X-Trace-Id`, and `traceparent` headers are present on error responses
- [x] Test: middleware that throws still produces correct response headers
