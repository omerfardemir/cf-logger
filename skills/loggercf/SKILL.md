---
name: loggercf
description: Rules for logging and tracing with the loggercf package on Cloudflare Workers or Node.js. Use when adding or changing logs, log fields, spans, trace propagation, Hono logging middleware, Worker-to-Worker RPC over service bindings, queue or cron handlers, or the Wrangler vars loggercf reads, in a project that depends on loggercf.
---

# loggercf

loggercf is new and is not pino's API: use only what this file and the package itself show. For signatures and full examples, read `node_modules/loggercf/README.md`; for exact types, read `node_modules/loggercf/dist/*.d.ts`. Where they disagree with this file, they win.

Imports come from exactly three entry points:

- `loggercf`: core, any runtime.
- `loggercf/hono`: `useLogger`.
- `loggercf/workers`: Traced Sessions. This imports `cloudflare:workers`, so it is Workers-only.

## Terms

- **Root Logger**: built by `createLogger` once per isolate or process. Carries per-process data only (service, environment, version).
- **Logging Context**: the scope of one unit of work (HTTP request, RPC call, queue message, cron run). Holds one trace, its Context Fields, and the logger every line is written through. Every line logged inside it gets `traceId`, `spanId` and `parentSpanId` automatically.
- **Context Fields**: per-unit-of-work data (`requestId`, `userId`, ...) on every line in a Logging Context.
- **Trace Carrier**: `{ traceparent, tracestate? }`, the wire form of a trace.
- **Span**: a named, timed sub-operation, logged once as `span.end` when the trace is sampled.
- **Traced Session**: the RPC target a service binding's `session()` returns. Every method on it continues the caller's trace.

## Pick the API by unit of work

| Situation                                       | Use                                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| HTTP in a Hono app                              | `app.use(useLogger(rootLogger))`                                                                           |
| Receiving Worker-to-Worker RPC                  | `class S extends TracedSession<Env>`, each method body in `this.traced(fn, 'svc.op')`, `tracedWorker(S)`   |
| Calling another Worker over RPC                 | `withTrace(env.SVC, (s) => s.op())`, or `tracedSession(env.SVC)` for several calls                         |
| Queue consumer, cron, Node job, any other work  | `runWithLogger({ logger: rootLogger, fields }, fn)`                                                        |
| Passing a trace over a queue or other transport | sender puts `getTraceCarrier()` in the payload; receiver calls `runWithLogger({ logger, ...carrier }, fn)` |
| Outbound HTTP                                   | `tracedFetch(url, init)` in place of `fetch`                                                               |
| Timing a sub-operation                          | `withSpan('db.getUser', fn)`                                                                               |
| Logging from code that receives no logger       | `getLogger()`, which returns the Logging Context's logger                                                  |

Queue consumer continuing a producer's trace:

```ts
import { createLogger, getLogger, loggerOptionsFromEnv, runWithLogger } from 'loggercf'
import type { Logger, TraceCarrier } from 'loggercf'

interface Job {
  orderId: string
  trace: TraceCarrier // producer sent { orderId, trace: getTraceCarrier() }
}

let rootLogger: Logger | undefined

export default {
  async queue(batch, env) {
    const logger = (rootLogger ??= createLogger(loggerOptionsFromEnv(env)))
    for (const msg of batch.messages) {
      await runWithLogger(
        { logger, ...msg.body.trace, fields: { orderId: msg.body.orderId } },
        () => getLogger().info('processing order'),
      )
    }
  },
} satisfies ExportedHandler<unknown, Job>
```

## Rules

### One Root Logger per isolate

An isolate serves many requests at once. Build the Root Logger once, at module scope or lazily from `env` on first use, and pass that same instance everywhere. `useLogger`'s factory form runs on every request, so it must cache:

```ts
import { Hono } from 'hono'
import { createLogger, loggerOptionsFromEnv, type Logger } from 'loggercf'
import { useLogger } from 'loggercf/hono'

let rootLogger: Logger | undefined
const app = new Hono()
app.use(useLogger((c) => (rootLogger ??= createLogger(loggerOptionsFromEnv(c.env)))))

export default app
```

```ts wrong
app.use(useLogger((c) => createLogger(loggerOptionsFromEnv(c.env)))) // a new Root Logger per request
```

### Per-request data goes in Context Fields

Pass `requestId`, `userId`, tenant, message id and similar data as `fields` to `runWithLogger`, or call `setLoggerContext({ ... })` inside the Logging Context. Every later line in that context carries them, including `useLogger`'s `request.end` and lines from code that calls `getLogger()`. `useLogger` already adds `requestId`, and `cfRay` when the request has a `cf-ray` header.

```ts
import { Hono } from 'hono'
import { createLogger, setLoggerContext, type Logger } from 'loggercf'
import { useLogger } from 'loggercf/hono'

// useLogger sets c.var.logger, c.var.requestId and c.var.traceId; declare them to use them typed
const app = new Hono<{ Variables: { logger: Logger; requestId: string; traceId: string } }>()
app.use(useLogger(createLogger({ service: 'orders' })))
app.get('/orders/:id', (c) => {
  setLoggerContext({ orderId: c.req.param('id') })
  c.var.logger.info('loading order') // has requestId, orderId, traceId, spanId
  return c.text('ok')
})

export default app
```

```ts wrong
const logger = createLogger({ service: 'orders' }, { userId }) // Root Logger bindings are per-process
const log = rootLogger.child({ requestId }) // only this object carries it; getLogger() lines miss it
```

Context Fields do not cross RPC on their own. To carry them to another Worker, pass them as the last argument of `withTrace` or `tracedSession`.

### Request ID in Hono

`useLogger` reuses an incoming `X-Request-Id` only when it is 1 to 128 characters of `A-Z a-z 0-9 _ - = : .`; otherwise it falls back to `c.var.requestId` set by an earlier middleware, then generates a UUID. The chosen ID is on every line, in `c.var.requestId`, and in the `X-Request-Id` response header. When a non-empty incoming ID was rejected, every line also gets `requestIdRejected: true` (never the rejected value; a `cf-ray` rejected as the ID is not recorded as `cfRay`); an empty one counts as none. When the request has a well-formed `cf-ray` header and `trustIncoming` is not `false`, every line also gets `cfRay`; trust it only on requests straight from Cloudflare's edge, since a Worker calling over a service binding `fetch` can set any `cf-ray`. Configure it with the second argument, not with your own header parsing:

```ts
import { Hono } from 'hono'
import { createLogger } from 'loggercf'
import { useLogger } from 'loggercf/hono'

const app = new Hono()
app.use(
  useLogger(createLogger({ service: 'api' }), {
    requestId: {
      from: ['cf-ray', 'x-request-id'], // header names or (c) => string | undefined, first valid wins
      trustIncoming: true, // false: always generate; ignores `from`, c.var.requestId and cf-ray
      // validate: RegExp | (id, c) => boolean, replaces the default check and its 128 cap
      // generate: (c) => string, used when no source is valid
    },
  }),
)

export default app
```

### Context helpers need a Logging Context

Call these inside `useLogger`, `this.traced`, or `runWithLogger`. Outside a Logging Context, each one quietly degrades:

- `setLoggerContext` ignores the fields and writes one WARN per isolate: `setLoggerContext called outside a Logging Context; fields ignored`. That WARN in the logs means a call site is outside every Logging Context.
- `withSpan` just runs the function, with no Span.
- `getTraceCarrier()` returns `{}`, and `tracedFetch` sends no trace headers.
- `getLogger()` returns a standalone logger with no trace IDs and no Context Fields (`service: 'unknown'` unless you pass a name).

### Traced Sessions: every RPC method runs in `this.traced`

Wrap the body of every RPC method in `this.traced(fn, 'svc.op')`. The operation name makes the call a Span. Inside `traced`, `this.logger` is the Logging Context's logger. Outside it, `this.logger` is the bare Root Logger, with no trace IDs.

```ts
import { TracedSession, tracedWorker, withTrace, type TracedServiceBinding } from 'loggercf/workers'

interface MathService {
  multiply(a: number, b: number): Promise<number>
}

interface Env {
  NAME: string
  LOG_LEVEL: string
  MATH: TracedServiceBinding<MathService> // not the generated `Fetcher` type, which has no session()
}

class BillingSession extends TracedSession<Env> {
  async total(price: number, qty: number, userId: string): Promise<number> {
    return this.traced(async () => {
      this.logger.info({ price, qty }, 'computing total')
      return withTrace(this.env.MATH, (s) => s.multiply(price, qty), { userId })
    }, 'billing.total')
  }
}

export default tracedWorker(BillingSession)
```

`tracedWorker(S)` builds the entrypoint: one Root Logger per isolate from the env vars, a `session(init)` method, and a 404 `fetch`. When the Worker also needs `scheduled`, `queue` or a real `fetch` with logging, extend `TracedEntrypoint` instead. It gives you `this.rootLogger`. A session's constructor is `(init, rootLogger, env)`, and `session()` takes one object, `{ traceparent?, tracestate?, fields? }`:

```ts
import { runWithLogger } from 'loggercf'
import { TracedEntrypoint, TracedSession, type SessionInit } from 'loggercf/workers'

interface Env {
  NAME: string
  LOG_LEVEL: string
}

class MathSession extends TracedSession<Env> {
  async square(n: number): Promise<number> {
    return this.traced(() => n * n, 'math.square')
  }
}

export default class extends TracedEntrypoint<Env> {
  session(init: SessionInit) {
    return new MathSession(init, this.rootLogger, this.env)
  }

  async scheduled() {
    await runWithLogger({ logger: this.rootLogger, fields: { job: 'nightly' } }, async () => {
      // ...
    })
  }
}
```

### Log call shape

Two call styles work, and no argument is ever dropped. Prefer the structured style (fields or an `Error` first, then the message) for data you want to query. The console style (message first) also keeps every argument: a trailing object's keys become top-level fields, the first trailing `Error` becomes `err`, extra strings and numbers join the message, and anything else goes to an `args` array.

```ts
import { createLogger } from 'loggercf'

const logger = createLogger({ service: 'api' })
const err = new Error('payment declined')

// structured
logger.error(err)
logger.error({ err, orderId: 'o-1' }, 'charge failed')
logger.info({ orderId: 'o-1' }, 'charged')

// console style: same fields on the line
logger.error('charge failed', err, { orderId: 'o-1' })
logger.info('charged %s', 'o-1', { amount: 42 })

try {
  throw new Error('declined')
} catch (e) {
  logger.error(e, 'charge failed') // e is unknown: also fine as { err: e } or after the message
}
```

An `Error` is serialized with type, message, stack, own fields and `cause`. `printf` placeholders (`%s %d %i %f %j %o %O %%`) take arguments in order. `%s %d %i %f` don't print an object: the placeholder stays in the text and the object is routed like a later argument:

```ts wrong
logger.info('loaded order %s', order) // message stays 'loaded order %s', order's keys spill onto the line; use logger.info({ order }, 'loaded order')
```

`traceId`, `spanId` and `parentSpanId` are added to every line in a Logging Context. A log call can't overwrite them, or loggercf's other own keys (`time`, `level`, `message`, `service`, `environment`, `version`, `errors`, `args`): an object's values for those keys land in `args` instead. Logger fields (`.child()`) and Context Fields can't set `time`, `level`, `message`, `errors` or `args` either; their values for those keys land in `args` too. An object's `err`, and a string `message` when the call has no other message, are used while still unset. To read the trace IDs, call `getTraceContext()`.

## Wrangler setup

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "NAME": "billing-worker",
    "LOG_LEVEL": "info",
    "ENVIRONMENT": "production",
    "VERSION": "1.0.0",
  },
  "services": [{ "binding": "MATH", "service": "math-worker" }],
}
```

- `nodejs_compat` is required, because loggercf uses `AsyncLocalStorage` from `node:async_hooks`.
- `loggerOptionsFromEnv(env)`, `tracedWorker` and `TracedEntrypoint` read `NAME`, `LOG_LEVEL`, `ENVIRONMENT` and `VERSION`. A missing `NAME` becomes `service: 'unknown'` and a missing `LOG_LEVEL` becomes `'info'`. A missing `ENVIRONMENT` or `VERSION` is left off the log line.
- `LOG_LEVEL` must be lowercase: one of `trace`, `debug`, `info`, `warn`, `error` or `fatal`. Any other value (including `DEBUG`) falls back to `'info'` and writes one `WARN` per isolate that names the bad value.
- To read other vars, pass a mapping. Each field (`service`, `level`, `environment`, `version`) takes a var name or a function of env. Fields you leave out keep their default var. The same mapping goes to `tracedWorker(S, { env })`, or to an `envMapping` getter on a `TracedEntrypoint` subclass.

```ts
import { createLogger, loggerOptionsFromEnv } from 'loggercf'
import { TracedSession, tracedWorker } from 'loggercf/workers'

interface Env {
  NAME: string
  RELEASE: string
  CF_VERSION_METADATA: WorkerVersionMetadata // "version_metadata": { "binding": "CF_VERSION_METADATA" }
}

declare const env: Env

const logger = createLogger(loggerOptionsFromEnv(env, { version: 'RELEASE' }))

class BillingSession extends TracedSession<Env> {}

export default tracedWorker(BillingSession, {
  env: { version: (e) => e.CF_VERSION_METADATA.tag || e.CF_VERSION_METADATA.id },
})
```

- The `version_metadata` binding name is yours to choose in Wrangler, so loggercf never reads it by itself: map it with a function as above. `id` is the deployed version's ID and `tag` is the optional `--tag` from `wrangler versions upload`.
- On Node.js there is no Wrangler config: call `createLogger({ service, level, environment, version })` or `createLogger(loggerOptionsFromEnv(process.env))` at startup.
