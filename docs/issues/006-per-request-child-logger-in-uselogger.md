# 006: Create per-request child logger in useLogger to avoid shared instance trap

**Priority:** P2
**Type:** AFK
**Status:** DONE
**Commit:** 616ea50

## What was built

`useLogger` now creates `logger.child({ requestId })` per request. Each request gets its own logger instance with `requestId` baked in as a binding. `c.var.logger` and the ALS store hold the per-request child, not the shared parent.

## Acceptance criteria

- [x] `useLogger` creates a `logger.child({ requestId })` per request
- [x] `c.var.logger` is the per-request child, not the shared parent
- [x] The ALS store holds the per-request child
- [x] Two concurrent requests get different logger instances (not `===`)
- [x] Test: verify `c.var.logger` has `requestId` as a binding
