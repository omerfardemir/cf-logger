# 008: Add traceFlags sampling support

**Priority:** P2
**Type:** AFK

## What to build

`traceFlags` is parsed and stored but never acted upon. The W3C spec defines bit `0x01` as the "sampled" flag. Support sampling so upstream services can control whether a trace is recorded. This allows cost control at scale — not every request needs full logging.

## Acceptance criteria

- [ ] `resolveTrace` preserves the `sampled` flag from incoming traceparent
- [ ] New root traces default to sampled (`traceFlags: 0x01`)
- [ ] `LoggerFactory` / `runWithLogger` can optionally suppress logging when `sampled = false`
- [ ] `TracedSession` respects the sampled flag (skip span logs when not sampled)
- [ ] `buildTraceparent` correctly propagates the sampled flag downstream
- [ ] Tests verify sampled/unsampled traces behave differently
- [ ] Document the sampling behavior and how to configure it

## Blocked by

None — can start immediately
