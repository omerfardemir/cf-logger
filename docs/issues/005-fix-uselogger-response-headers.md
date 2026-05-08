# 005: Fix useLogger response headers to survive errors and move inside ALS

**Priority:** P2
**Type:** AFK

## What to build

`useLogger` sets response headers (`X-Request-Id`, `X-Trace-Id`, `traceparent`) after `runWithLogger` returns — outside the ALS context and after `next()`. If `next()` throws, headers are never set. Move header setting inside the ALS callback, in a `finally` block, so headers are always set regardless of downstream errors.

## Acceptance criteria

- [ ] Response headers are set inside `runWithLogger` callback, after `next()` completes or throws
- [ ] `X-Request-Id`, `X-Trace-Id`, and `traceparent` headers are present on error responses
- [ ] Test: middleware that throws still produces correct response headers

## Blocked by

- #004 (both touch `useLogger` — implement lifecycle logging first to avoid merge conflicts)
