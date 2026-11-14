# loggercf

Structured logging and distributed trace propagation for Cloudflare Workers (and Node.js), including across Worker-to-Worker RPC where the platform offers no header channel.

## Language

### Logging

**Logging Context**:
The per-unit-of-work scope (an HTTP request, an RPC call, a queue message, a cron run) that carries one Trace Context, the Context Fields, and the logger every log line in that work is written through.
_Avoid_: Request Scope, ALS context, store. Not to be confused with Hono's `Context` (`c`).

**Context Fields**:
The per-unit-of-work key-value data attached to every log line inside a Logging Context (e.g. `requestId`, `userId`). Isolated per Logging Context; never shared across concurrent work.
_Avoid_: bindings, context, metadata

**Request ID**:
The Context Field (`requestId`) that names one HTTP request in its Logging Context. The Hono middleware takes it from a configured source (a header such as `X-Request-Id` or `cf-ray`, or `c.var.requestId` from an earlier middleware) only when it passes validation, and generates one otherwise. `cf-ray`, when present, is also recorded as its own Context Field, `cfRay`.
_Avoid_: correlation ID, trace ID (that is the Trace Context's)

**Root Logger**:
The logger built once per process or isolate from Logger Options, carrying only per-process data (`service`, `environment`, `version`). It never holds per-unit-of-work data, because an isolate serves many requests concurrently.
_Avoid_: base logger, factory

**Default Logger**:
The Root Logger an isolate registers for code that runs outside every Logging Context (module scope, plain RPC methods, `scheduled`, shared packages); `getLogger()` returns it there. Set with `setDefaultLogger`, or registered by `useLogger`, `TracedEntrypoint`, `tracedWorker` or `defaultLoggerFromEnv` the first time they see a Root Logger, unless one is already set. Like every Root Logger it carries no Context Fields, so no unit of work's data reaches another through it.
_Avoid_: global logger, fallback logger

**Logger Options**:
The per-process configuration a Root Logger is built from: service name, minimum level, environment, version.

**Env Mapping**:
Where each Logger Options field is read from in a Worker's (or process's) env: a var name or a function of env. Unmapped fields read `NAME`, `LOG_LEVEL`, `ENVIRONMENT` and `VERSION`.
_Avoid_: env config, var map

### Tracing

**Trace Context**:
The W3C identity of the current work: trace ID, current span ID, optional parent span ID, trace flags, and optional tracestate.
_Avoid_: trace, traceparent (that is only its wire form)

**Trace Carrier**:
The wire form of a Trace Context: a `traceparent` value plus an optional `tracestate`, as it travels in HTTP headers, an RPC `session()` call, or a queue message.
_Avoid_: trace headers, propagation context

**Span**:
A named, timed operation within a Logging Context, reported once on completion with its duration and status.

**Traced Session**:
An RPC target returned by a Service Binding's `session()` call that carries the caller's Trace Context privately, so every RPC method on it runs inside a Logging Context continuing the caller's trace.
_Avoid_: traced RPC, RPC wrapper
