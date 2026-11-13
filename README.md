# loggercf

Structured logging for Cloudflare Workers and Node.js. Built on [Pino](https://getpino.io/) with per-request context via `AsyncLocalStorage`, W3C trace propagation, and a Session Factory pattern for RPC trace propagation across service bindings.

## Install

```bash
pnpm add loggercf
# Hono is an optional peer dependency
pnpm add hono
```

## Entry Points

| Import             | Contents                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `loggercf`         | Core: `createLogger`, `runWithLogger`, `withSpan`, `getLogger`, `setLoggerContext`, `loggerOptionsFromEnv`, trace utilities, types |
| `loggercf/hono`    | `useLogger`, `generateId` — Hono middleware                                                                                        |
| `loggercf/workers` | `TracedSession`, `TracedEntrypoint`, `tracedWorker`, `withTrace`, `tracedSession`                                                  |

## How Trace Propagation Works

Every log line includes `traceId`, `spanId`, and optionally `parentSpanId`. When a request flows through multiple workers, they all share the same `traceId`:

```
User → main-worker (traceId: abc, spanId: 111)
         → bind-worker (traceId: abc, spanId: 222, parentSpanId: 111)
              → math-worker (traceId: abc, spanId: 333, parentSpanId: 222)
              → math-worker (traceId: abc, spanId: 444, parentSpanId: 222)
```

Search your log backend for `traceId = "abc"` to see the entire request across all workers. See [docs/rpc-trace-propagation.md](docs/rpc-trace-propagation.md) for the technical deep-dive.

---

## Cloudflare Worker Requirements

`loggercf` uses `AsyncLocalStorage` through `node:async_hooks`.
Cloudflare Workers must enable Node.js compatibility in `wrangler.jsonc`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
}
```

The package expects these environment variables when using `loggerOptionsFromEnv()` or `tracedWorker()`:

```jsonc
{
  "vars": {
    "NAME": "my-worker",
    "LOG_LEVEL": "info",
    "ENVIRONMENT": "production",
    "VERSION": "1.0.0",
  },
}
```

## Core API (`loggercf`)

### `createLogger(options)`

Create a **Root Logger**: build it once per process or isolate and share it. Works the same on Node.js and CF Workers (see [Log Output](#log-output)).

```ts
import { createLogger } from 'loggercf'

const logger = createLogger({
  service: 'my-worker',
  level: 'debug',
  environment: 'production',
  version: '1.2.3',
})

logger.info({ userId: 'u-42' }, 'Request started')
// → {"time":"...","level":"INFO","service":"my-worker","environment":"production","version":"1.2.3","userId":"u-42","message":"Request started"}
```

`level` defaults to `'info'`. `service`, `environment` and `version` are on every line. An optional second argument adds more fixed fields. Keep these to per-process data: an isolate serves many requests at once, so per-request data (`requestId`, `userId`, ...) belongs in a Logging Context's fields (see `runWithLogger`).

### `getLogger(service?)`

Get the current Logging Context's logger. Outside any Logging Context, it returns a standalone logger cached per `service` (default `'unknown'`), useful for code that doesn't know whether it runs inside a context. Where you do know, prefer your Root Logger or `runWithLogger`.

```ts
import { getLogger } from 'loggercf'

// Inside useLogger / traced() / runWithLogger:
const log = getLogger() // the Logging Context's logger
log.info('has traceId automatically')

// Outside a Logging Context:
const log = getLogger('cron') // cached standalone logger
```

### `setLoggerContext(fields)`

Add fields to the current Logging Context. All subsequent log lines in that context include them. Fields set inside a `withSpan()` stay inside that span.

```ts
import { setLoggerContext } from 'loggercf'

setLoggerContext({ userId: 'u-42', feature: 'checkout' })
// All logs from this point include userId and feature
```

Outside a Logging Context the fields are **ignored**, and one `WARN` line naming the ignored keys is written per isolate. An isolate serves many requests at once, so fields stored outside a context would leak into unrelated requests.

### `runWithLogger(options, fn)`

Open a **Logging Context**: the single way to scope logging to one unit of work (HTTP request, RPC call, queue message, cron run). `useLogger` and `TracedSession` use it under the hood.

```ts
import { runWithLogger, createLogger, getLogger } from 'loggercf'

const logger = createLogger({ service: 'queue-handler' }) // Root Logger, created once

export default {
  async queue(batch) {
    for (const msg of batch.messages) {
      await runWithLogger(
        {
          logger,
          traceparent: msg.body.traceparent, // optional: continue a trace
          tracestate: msg.body.tracestate, // optional
          fields: { messageId: msg.id }, // optional: per-unit-of-work fields
        },
        async () => {
          getLogger().info('processing') // has traceId, spanId, messageId
        },
      )
    }
  },
}
```

Without a valid `traceparent` a new root trace starts. Either way the context gets its own `spanId`. `fields` is copied, never mutated.

### `withSpan(operation, fn)`

Time a sub-operation as a **Span** nested in the current Logging Context: new `spanId`, `parentSpanId` = the current span, same `traceId`. Works sync or async; errors are logged and rethrown. Logs `span.end` only when the trace is sampled. Outside a Logging Context it just runs `fn`.

```ts
import { withSpan } from 'loggercf'

app.get('/users/:id', async (c) => {
  const user = await withSpan('db.getUser', () => db.getUser(c.req.param('id')))
  return c.json(user)
})
```

### `getTraceContext()`

Read the current Trace Context (IDs and flags). Returns `null` outside a Logging Context.

```ts
import { getTraceContext } from 'loggercf'

const trace = getTraceContext()
// { traceId: '...', spanId: '...', parentSpanId: '...', traceFlags: 1 }
```

### `getTraceCarrier()`

Get the current **Trace Carrier**, `{ traceparent, tracestate? }`, to pass the trace on over any transport. Returns `{}` outside a Logging Context. Its keys match `runWithLogger`'s options, so the receiving side just spreads it in.

```ts
import { getTraceCarrier, runWithLogger } from 'loggercf'

// Producer: put the carrier in the message
await env.QUEUE.send({ ...payload, trace: getTraceCarrier() })

// Consumer: continue the same trace
await runWithLogger({ logger, ...msg.body.trace }, async () => {
  /* ... */
})
```

`useLogger` (HTTP headers), `tracedFetch` (outgoing requests) and `tracedSession` / `withTrace` (RPC) do this for you.

### `loggerOptionsFromEnv(env)`

Map the conventional Worker environment variables into `LoggerOptions`.

```ts
import { createLogger, loggerOptionsFromEnv } from 'loggercf'

const logger = createLogger(loggerOptionsFromEnv(env))
```

---

## Hono Middleware (`loggercf/hono`)

### `useLogger(loggerOrFactory)`

Creates a Hono middleware that:

1. Reads `X-Request-Id` from the request or generates a new UUID
2. Opens a Logging Context via `runWithLogger`, continuing `traceparent` / `tracestate` from the request
3. Adds `requestId` to the Logging Context's fields so it appears on every log line
4. Sets `c.var.logger`, `c.var.requestId`, and `c.var.traceId` for use in route handlers
5. Sets response headers: `X-Request-Id`, `X-Trace-Id`, `traceparent` (and `tracestate` when present)
6. Lets Hono own error responses, then logs `request.error` and `request.end` using the final `c.res.status`

```ts
import { Hono } from 'hono'
import { useLogger } from 'loggercf/hono'
import { createLogger, loggerOptionsFromEnv, setLoggerContext, type Logger } from 'loggercf'

const app = new Hono()

// Option A: shared Root Logger (recommended)
app.use(useLogger(createLogger({ service: 'my-worker' })))

// Option B: build the Root Logger from c.env, once per isolate
let rootLogger: Logger | undefined
app.use(useLogger((c) => (rootLogger ??= createLogger(loggerOptionsFromEnv(c.env)))))

app.get('/', (c) => {
  setLoggerContext({ userId: 'u-42' })
  c.var.logger.info('Hello world') // includes traceId, spanId, userId
  return c.text('ok')
})
```

`useLogger()` does not catch, create, or replace error responses. It lets Hono run downstream handlers and app-level `onError()` normally, then checks `c.error` after `await next()`. Failed requests emit `request.error` with the final `c.res.status`; all requests emit `request.end` with the final `c.res.status`.

---

## CF Workers RPC (`loggercf/workers`)

Propagate trace context across Cloudflare Worker service bindings using the **Session Factory pattern**.

### Why?

CF Workers RPC has no header/metadata channel. You can't attach a `traceparent` to `c.env.BIND.add(5, 7)`. The Session Factory solves this by passing the Trace Carrier via `binding.session({ traceparent, tracestate, fields })`, which returns an `RpcTarget` with the trace stored in a private field.

### `TracedSession<Env>`

Base class for RPC sessions. Extends `RpcTarget`. Your RPC methods go here.

```ts
import { TracedSession, tracedWorker } from 'loggercf/workers'

interface Env {
  NAME: string
  LOG_LEVEL: string
  ENVIRONMENT: string
  VERSION: string
}

class MySession extends TracedSession<Env> {
  async add(a: number, b: number): Promise<number> {
    return this.traced(() => {
      this.logger.info({ a, b }, 'Adding')
      return a + b
    }, 'my-service.add') // optional: operation name enables span logging
  }
}

export default tracedWorker(MySession)
```

**Key members:**

| Member                        | Description                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `this.traced(fn, operation?)` | Runs `fn` in a Logging Context continuing the caller's trace. Optional `operation` reports the call as a Span. |
| `this.logger`                 | Request-scoped logger (must be called inside `traced()`)                                                       |
| `this.env`                    | Worker env (bindings, vars) — for multi-hop RPC calls                                                          |

### `tracedWorker(SessionClass)`

Creates a `WorkerEntrypoint` with a `session(init)` method that instantiates your session class. Zero boilerplate.

```ts
// This is your entire worker export:
export default tracedWorker(MySession)

// Or extend it if you need scheduled(), queue(), etc:
export default class extends tracedWorker(MySession) {
  async scheduled(event: ScheduledEvent) {
    /* ... */
  }
}
```

### `withTrace(binding, fn, fields?)`

**Caller-side** one-liner. Calls `binding.session({ ...getTraceCarrier(), fields })` and passes the session to your callback.

```ts
import { withTrace } from 'loggercf/workers'

// In a route handler or another traced() method:
const result = await withTrace(c.env.BIND, (s) => s.add(5, 7))

// With propagated fields — appear on all downstream logs:
const result = await withTrace(c.env.BIND, (s) => s.add(5, 7), { requestId: 'abc' })
```

### `tracedSession(binding, fields?)`

Lower-level alternative to `withTrace` — returns the session for multiple calls:

```ts
import { tracedSession } from 'loggercf/workers'

const session = tracedSession(c.env.BIND)
const a = await session.add(1, 2)
const b = await session.add(3, 4)

// With propagated fields:
const session = tracedSession(c.env.BIND, { requestId: 'abc' })
```

### Multi-Hop RPC

Sessions have access to `this.env`, so they can call other service bindings with `withTrace`:

```ts
class BindSession extends TracedSession<Env> {
  async multiHop(value: number): Promise<number> {
    return this.traced(async () => {
      // bind-worker → math-worker (trace propagates automatically)
      const multiplied = await withTrace(this.env.MATH, (s) => s.multiply(value, 3))
      const divided = await withTrace(this.env.MATH, (s) => s.divide(multiplied, 2))
      return divided
    }, 'bind.multiHop')
  }
}
```

All workers in the chain share the same `traceId`.

### `TracedEntrypoint<Env>`

Alternative to `tracedWorker()` for manual entrypoint setup. Extends `WorkerEntrypoint` and provides `this.loggerOptions` from env vars (`NAME`, `LOG_LEVEL`, `ENVIRONMENT`, `VERSION`) and `this.rootLogger`, built from them once per isolate. Override `loggerOptions` to customize.

```ts
import { TracedEntrypoint, TracedSession, type SessionInit } from 'loggercf/workers'

class MySession extends TracedSession<Env> {
  /* ... */
}

export default class extends TracedEntrypoint<Env> {
  session(init: SessionInit) {
    return new MySession(init, this.rootLogger, this.env)
  }

  async scheduled(event: ScheduledEvent) {
    /* ... */
  }
}
```

### Service Type Convention

Define shared service method interfaces and use `TracedServiceBinding<T>` for Worker bindings:

```ts
import type { TracedServiceBinding } from 'loggercf/workers'

export interface BindService {
  add(a: number, b: number): Promise<number>
  multiHop(value: number): Promise<number>
}
```

Then type your env bindings:

```ts
interface Env {
  BIND: TracedServiceBinding<BindService>
  MATH: TracedServiceBinding<MathService>
}
```

---

## Span Logging

Pass an operation name as the second argument to `traced()` to report the RPC call as a Span (or use `withSpan()` for a sub-operation anywhere in a Logging Context):

```ts
return this.traced(() => {
  // your logic
  return result
}, 'math.multiply')
```

Emits a span-end log on completion:

```json
{
  "level": "INFO",
  "span": {
    "operation": "math.multiply",
    "startTime": 1777021502058,
    "endTime": 1777021502059,
    "duration": 1,
    "status": "OK"
  },
  "message": "span.end math.multiply",
  "traceId": "...",
  "spanId": "...",
  "parentSpanId": "..."
}
```

On error, `status` is `"ERROR"` with an `error` field, logged at error level.

The span object intentionally does **not** duplicate `traceId`/`spanId`/`parentSpanId` — those are already on every log line.

Span logging is **optional**. Without an operation name, `traced()` only opens the Logging Context. Span logs are skipped when the trace is unsampled (`traceFlags` bit 0 unset).

---

## Log Output

Every runtime builds the same JSON line, one per log call (covered by a test that compares the two):

- Starts with `time` (ISO 8601) and `level` (`TRACE` … `FATAL`); no `pid` or `hostname`.
- When keys collide, strongest first: trace IDs (`traceId`, `spanId`, `parentSpanId`, which can't be overridden) → fields passed to the log call → logger fields (`createLogger` / `.child()`) → Context Fields.
- Errors become `{ type, message, stack, ...own fields (e.g. code), cause }`, with `cause` nested the same way. `logger.error(err)` and `logger.error(err, 'msg')` both keep the error under `err`.
- Circular references are written as `"[Circular]"` and `BigInt` as a string; logging never throws.

Only the final write differs, detected at startup:

- **CF Workers** (`navigator.userAgent === 'Cloudflare-Workers'`): `console.debug` / `info` / `warn` / `error` by level, so Cloudflare assigns the right severity.
- **Node.js**: `console.log` for every level (stdout).

---

## Agent skill

The package ships an [Agent Skill](https://agentskills.io) at `skills/loggercf/SKILL.md` for AI coding agents working in your project. It covers which API fits each unit of work (Hono, Worker RPC, queues, cron), the rules the types can't express (one Root Logger per isolate, per-request data in Context Fields, `this.traced` around every RPC method, log call shape) and the Wrangler setup. For signatures it points back to this README.

With pnpm 12.11 or later, run `pnpm approve` after installing and approve `loggercf`'s skills. pnpm then links the skill into your agents' skill directories (`.claude/skills`, `.cursor/skills`, `.agents/skills`, ...). See [pnpm's agent skills docs](https://pnpm.io/agent-skills).

---

## Development

```
loggercf/
├── src/                  # loggercf source and colocated *.test.ts
│   ├── index.ts          # Core entry: logger, Logging Context, Trace Carrier, types
│   ├── hono.ts           # loggercf/hono entry
│   └── workers.ts        # loggercf/workers entry
├── dev/                  # Local Worker fixtures for e2e verification (not published)
│   ├── services.d.ts     # Shared RPC service interfaces
│   ├── main-worker/      # Gateway worker (Hono + routes)
│   ├── bind-worker/      # Mid-tier worker (single + multi-hop RPC)
│   └── math-worker/      # Leaf worker (multiply, divide)
├── skills/loggercf/     # Agent skill shipped in the package
├── scripts/e2e-local.mjs # Starts the dev workers, probes trace propagation, checks their logs
└── docs/                 # Design deep-dives
```

The dev workers import `loggercf` by package name, which resolves to this package's built `dist/` — run `pnpm build` before `pnpm dev`.

| Script                             | Purpose                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm build`                       | Build `dist/` with tsdown                                                    |
| `pnpm test`                        | Run unit tests (Vitest)                                                      |
| `pnpm typecheck` / `typecheck:dev` | Typecheck the package / the dev workers (needs a build)                      |
| `pnpm check:skill`                 | Typecheck the ts snippets in `skills/**/SKILL.md` (needs a build)            |
| `pnpm lint` / `lint:fix`           | Lint with oxlint                                                             |
| `pnpm format` / `format:check`     | Format with oxfmt                                                            |
| `pnpm dev`                         | Run all three dev workers on `http://localhost:8787`                         |
| `pnpm e2e:local`                   | Build, start the dev workers, assert trace propagation in responses and logs |
| `pnpm release:check`               | Everything above plus `npm pack --dry-run`                                   |

CI (`.github/workflows/ci.yml`) runs every check above, plus the e2e, on Ubuntu for each pull request and push to `main`.

## Releasing

Releases are cut by hand from the **Publish** workflow (Actions → Publish → Run workflow) on `main`. Pick `patch`, `minor`, or `major` and it:

1. runs the full CI suite on that commit,
2. bumps `package.json`, commits `chore(release): vX.Y.Z`, and tags `vX.Y.Z`,
3. pushes the commit and tag to `main` together (rejected if `main` moved after you started it),
4. publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements),
5. creates a GitHub Release with generated notes.

npm authenticates the workflow through [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so there is no npm token or repository secret.

If npm publish fails after step 3, the version commit and tag are already on `main`. Fix the cause, then publish that tag by hand (`git checkout vX.Y.Z && pnpm install && npm publish --access public`, logged in with 2FA) and create the release with `gh release create vX.Y.Z --verify-tag --generate-notes`. Don't re-run the workflow, because it would bump the version again.

## License

[MIT](LICENSE)
