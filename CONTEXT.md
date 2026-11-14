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
The Context Field (`requestId`) that names one HTTP request in its Logging Context. The Hono middleware takes it from a configured source (a header such as `X-Request-Id` or `cf-ray`, or `c.var.requestId` from an earlier middleware) only when it passes validation, and generates one otherwise (always, when incoming IDs are not trusted). A rejected incoming value is marked with `requestIdRejected: true`, never logged. `cf-ray`, when present and trusted, is also recorded as its own Context Field, `cfRay`.
_Avoid_: correlation ID, trace ID (that is the Trace Context's)

**Request Lines**:
The lines the Hono middleware writes about one HTTP request itself: an optional `request.start`, and one `request.end` that records the outcome (`statusCode`, `duration`, `route`, and `err` when Hono caught an error) at a level chosen from it. `route` is the matched route pattern, not the concrete path; the query string is never on them. For a throw that escapes the middleware, the response is decided above it (an outer middleware, Hono calling `onError` again, or the runtime), so `request.end` records an assumed `statusCode: 500`, marked `statusCodeAssumed: true`.
_Avoid_: access log, `request.error` (folded into `request.end`)

**Owned Keys**:
The keys the Hono middleware writes itself on the Request Lines and as Context Fields (`requestId`, `requestIdRejected`, `cfRay`, `method`, `path`, `route`, `statusCode`, `statusCodeAssumed`, `duration`, `err`, `originalErr`, and `userAgent` / `cf` when they are included). A `fields` or `endFields` hook cannot set them: they are dropped from its result, and one WARN names them, never their values.
_Avoid_: protected keys, own keys, reserved keys

**Root Logger**:
The logger built once per process or isolate from Logger Options, carrying only per-process data (`service`, `environment`, `version`). It never holds per-unit-of-work data, because an isolate serves many requests concurrently.
_Avoid_: base logger, factory

**Default Logger**:
The Root Logger (or a `.child()` of one with per-process fields only) an isolate registers for code that runs outside every Logging Context (module scope, plain RPC methods, `scheduled`, shared packages); `getLogger()` writes through it there. Set with `setDefaultLogger`, or registered by `useLogger`, `TracedEntrypoint`, `tracedWorker`, `withLogging` or `defaultLoggerFromEnv` the first time they see a Root Logger, unless one is already set. It carries no Context Fields, so no unit of work's data reaches another through it. `getLogger()` outside a Logging Context resolves it when each line is written, so a logger kept at module scope before registration still uses it.
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
