# 003: Use object spread instead of Object.assign in Workers browser.write

**Priority:** P1
**Type:** AFK

## What to build

The Workers path in `workersPinoOptions` does `Object.assign(obj, getALSFields())`, mutating Pino's internal object in-place. Replace with an object spread (`{ ...obj, ...getALSFields() }`) to avoid coupling to Pino's internal object lifecycle.

## Acceptance criteria

- [ ] `browser.write` uses spread instead of `Object.assign`
- [ ] Log output shape is unchanged (verified by existing tests or a new Workers-path test)
- [ ] No mutation of the `o` parameter passed by Pino

## Blocked by

None — can start immediately
