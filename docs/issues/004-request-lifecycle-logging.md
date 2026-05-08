# 004: Add request lifecycle logging to useLogger middleware

**Priority:** P1
**Type:** AFK

## What to build

`useLogger` sets up ALS but never emits structured request logs. Add automatic `request.start` and `request.end` log lines so users get basic observability out of the box — request rate, latency percentiles, error rate by path — without writing any application code.

## Acceptance criteria

- [ ] `useLogger` emits a structured log on request start with: `method`, `path`, `requestId`, `traceId`
- [ ] `useLogger` emits a structured log on request end with: `method`, `path`, `statusCode`, `duration` (ms), `requestId`, `traceId`
- [ ] Duration is measured from before `next()` to after it completes (including error paths)
- [ ] Request end log is emitted even when `next()` throws (with the error status code)
- [ ] Log messages use consistent, greppable format (e.g. `request.start GET /path`, `request.end GET /path`)
- [ ] Tests verify both logs are emitted with correct fields
- [ ] Optional: make lifecycle logging configurable (on by default, opt-out via options)

## Blocked by

None — can start immediately
