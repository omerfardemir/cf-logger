# 006: Create per-request child logger in useLogger to avoid shared instance trap

**Priority:** P2
**Type:** AFK

## What to build

When `useLogger(logger)` receives a shared Logger instance, the same object is stored in every request's ALS and in `c.var.logger`. If a caller does `c.var.logger.child(...)`, the child is shared. Create a per-request child inside the middleware so each request gets its own logger instance with request-scoped bindings (`requestId`, etc.) baked in.

## Acceptance criteria

- [ ] `useLogger` creates a `logger.child({ requestId })` per request
- [ ] `c.var.logger` is the per-request child, not the shared parent
- [ ] The ALS store holds the per-request child
- [ ] Two concurrent requests get different logger instances (not `===`)
- [ ] Test: verify `c.var.logger` has `requestId` as a binding, not just via ALS mixin

## Blocked by

None — can start immediately
