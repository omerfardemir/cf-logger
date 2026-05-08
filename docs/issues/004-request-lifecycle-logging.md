# 004: Add request lifecycle logging to useLogger middleware

**Priority:** P1
**Type:** AFK
**Status:** DONE
**Commit:** ec6e423

## What was built

`useLogger` now emits `request.start` and `request.end` structured logs automatically. Includes method, path, requestId, traceId, statusCode, and duration (ms). Error paths handled — `request.end` always fires, even on throws.

## Acceptance criteria

- [x] `useLogger` emits a structured log on request start with: `method`, `path`, `requestId`, `traceId`
- [x] `useLogger` emits a structured log on request end with: `method`, `path`, `statusCode`, `duration` (ms), `requestId`, `traceId`
- [x] Duration is measured from before `next()` to after it completes (including error paths)
- [x] Request end log is emitted even when `next()` throws (with 500 status code)
- [x] Log messages use consistent, greppable format (`request.start GET /path`, `request.end GET /path`)
- [x] Tests verify both logs are emitted with correct fields (5 new tests)
