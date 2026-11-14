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

**Root Logger**:
The logger built once per process or isolate from Logger Options, carrying only per-process data (`service`, `environment`, `version`). It never holds per-unit-of-work data, because an isolate serves many requests concurrently.
_Avoid_: base logger, factory

**Logger Options**:
The per-process configuration a Root Logger is built from: service name, minimum level, environment, version.

**Env Mapping**:
Where each Logger Options field is read from in a Worker's (or process's) env: a var name or a function of env. Unmapped fields read `NAME`, `LOG_LEVEL`, `ENVIRONMENT` and `VERSION`.
_Avoid_: env config, var map

**Argument Routing**:
The rule that places every argument of a log call in the line (the message, top-level fields, `err` / `errors`, or the Overflow), for both the structured call style (fields or an `Error` first) and the console style (message first). Most arguments land in one part; a leading number, boolean or `BigInt` lands in two (it is the message, and its value is in the Overflow). No argument is ever dropped: only a leading `undefined` / `null` ("no fields") and an `undefined` where the message would be ("no message") write nothing. It runs before serialization, so routed values are serialized like any field.
_Avoid_: argument parsing, normalization

**Overflow**:
The `args` field of a log line: the values of a log call that have no better place (arrays, class instances, functions, an object's values for loggercf's own keys, and a logger binding's or Context Field's value for `time`, `level`, `message`, `errors` or `args`), in call order. Present only when non-empty.
_Avoid_: extras, rest, leftovers

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
