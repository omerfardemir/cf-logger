# 003: Use object spread instead of Object.assign in Workers browser.write

**Priority:** P1
**Type:** AFK
**Status:** DONE
**Commit:** 680d634

## What was built

`browser.write` now creates a new merged object via spread (`{ ...raw, ...getALSFields() }`) instead of mutating Pino's internal object with `Object.assign`.

## Acceptance criteria

- [x] `browser.write` uses spread instead of `Object.assign`
- [x] Log output shape is unchanged (verified by existing tests)
- [x] No mutation of the `o` parameter passed by Pino
