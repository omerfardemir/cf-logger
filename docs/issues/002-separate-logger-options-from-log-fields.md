# 002: Separate LoggerOptions from LogFields, make `service` required

**Priority:** P1
**Type:** AFK

## What to build

`LoggerOptions extends LogFields` allows arbitrary keys to leak into logger config silently — typos like `environemnt` compile fine and appear on every log line. Separate the two types: `LoggerOptions` should have explicit, known fields (`service`, `level`, `environment`, `version`). Extra bindings go through a dedicated `bindings` property or a second argument.

Make `service` required — a logger with no service name produces unfiltereable logs in Loki.

## Acceptance criteria

- [ ] `LoggerOptions` no longer extends `LogFields` — only known keys (`service`, `level`, `environment?`, `version?`) are allowed
- [ ] `service` is required (not optional)
- [ ] Extra per-logger bindings are passed explicitly (e.g. `bindings` property or second arg to `createLogger`)
- [ ] `createLogger({ service: 'x', level: 'info', potato: true })` is a compile error
- [ ] All callers updated: `createLogger`, `createSimpleLogger`, `LoggerFactory`, `envLoggerOptions`, worker examples
- [ ] Tests pass with updated types

## Blocked by

None — can start immediately
