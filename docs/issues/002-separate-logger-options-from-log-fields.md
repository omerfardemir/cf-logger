# 002: Separate LoggerOptions from LogFields, make `service` required

**Priority:** P1
**Type:** AFK
**Status:** DONE
**Commit:** bbd77ff

## What was built

`LoggerOptions` is now a standalone interface — no longer extends `LogFields`. Only explicit keys (`service`, `level`, `environment?`, `version?`) are accepted. Extra bindings use a second argument to `createLogger`. `service` is required.

## Acceptance criteria

- [x] `LoggerOptions` no longer extends `LogFields` — only known keys (`service`, `level`, `environment?`, `version?`) are allowed
- [x] `service` is required (not optional)
- [x] Extra per-logger bindings are passed explicitly (second arg to `createLogger`)
- [x] `createLogger({ service: 'x', level: 'info', potato: true })` is a compile error
- [x] All callers updated: `createLogger`, `createSimpleLogger`, `LoggerFactory`, `envLoggerOptions`, worker examples
- [x] Tests pass with updated types (45/45)
