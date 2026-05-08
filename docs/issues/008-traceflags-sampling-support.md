# 008: Add traceFlags sampling support

**Priority:** P2
**Type:** AFK
**Status:** DONE
**Commit:** 39f6148

## What was built

New root traces default to sampled (`traceFlags: 0x01`). Incoming `traceFlags` are preserved via `resolveTrace`. `TracedSession.traced()` skips span logs when the sampled bit (`0x01`) is not set — business logic still runs regardless.

## Acceptance criteria

- [x] `resolveTrace` preserves the `sampled` flag from incoming traceparent
- [x] New root traces default to sampled (`traceFlags: 0x01`)
- [x] `TracedSession.traced()` skips span logs when not sampled
- [x] `buildTraceparent` correctly propagates the sampled flag downstream
- [x] Tests verify sampled/unsampled traces behave differently (5 new tests)
