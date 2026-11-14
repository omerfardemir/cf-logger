import { RpcTarget, WorkerEntrypoint, env as workersEnv } from 'cloudflare:workers'
import type { LogFields, Logger, LoggerOptions, TraceCarrier } from './types'
import {
  createLogger,
  getLogger,
  getTraceCarrier,
  getTraceContext,
  hasDefaultLogger,
  recordSpan,
  registerDefaultLogger,
  runWithLogger,
} from './logger'
import { loggerOptionsFromEnv, type EnvMapping } from './env'

export { loggerOptionsFromEnv } from './env'
export type { EnvMapping, EnvSource } from './env'

/**
 * What a caller hands a Traced Session: its Trace Carrier plus any Context
 * Fields to propagate. One plain object, so adding keys never changes the
 * `session()` call.
 */
export interface SessionInit extends TraceCarrier {
  /** Context Fields to carry into the receiver's Logging Context. */
  fields?: LogFields
}

/**
 * A service binding whose entrypoint exposes `session(init)`.
 *
 * @template T - The Traced Session type returned by `session()`.
 */
export type TracedServiceBinding<T> = {
  session(init: SessionInit): T
}

/**
 * Root Loggers keyed by their Logger Options, one per isolate.
 *
 * Safe to share across concurrent requests because a Root Logger carries only
 * per-process data; per-request data lives in each Logging Context.
 */
const rootLoggers = new Map<string, Logger>()

/**
 * Get the isolate's Root Logger for these Logger Options, creating it once.
 *
 * @param {LoggerOptions} options - Logger Options (usually from `loggerOptionsFromEnv`).
 * @returns {Logger} The cached Root Logger.
 */
function rootLoggerFor(options: LoggerOptions): Logger {
  const key = JSON.stringify([options.service, options.level, options.environment, options.version])
  let logger = rootLoggers.get(key)
  if (!logger) {
    logger = createLogger(options)
    rootLoggers.set(key, logger)
  }
  return logger
}

/**
 * The isolate's Root Logger, built from the Worker's `env` (read through
 * `import { env } from 'cloudflare:workers'`, so it works at module scope and
 * anywhere without a handler's `env`), and registered as the Default Logger.
 *
 * Reads `NAME`, `LOG_LEVEL`, `ENVIRONMENT` and `VERSION` by default; pass an Env
 * Mapping to read other vars or derive fields (see `loggerOptionsFromEnv`). The
 * Root Logger is created once per Logger Options and shared with `TracedEntrypoint`
 * and `tracedWorker`. It becomes the Default Logger unless one is already set
 * (first seen wins); `setDefaultLogger()` always replaces it.
 *
 * @template E - The worker environment type.
 * @param {EnvMapping<E>} [mapping] - Per-field var name or derive function.
 * @returns {Logger} The Root Logger.
 *
 * @example
 * ```ts
 * import { getLogger } from 'loggercf'
 * import { useLogger } from 'loggercf/hono'
 * import { defaultLoggerFromEnv } from 'loggercf/workers'
 *
 * const logger = defaultLoggerFromEnv({ version: (env) => env.CF_VERSION_METADATA.id })
 * app.use(useLogger(logger))
 * getLogger().info('module scope') // service, environment, version from env
 * ```
 */
export function defaultLoggerFromEnv<E = Cloudflare.Env>(mapping?: EnvMapping<E>): Logger {
  const logger = rootLoggerFor(loggerOptionsFromEnv(workersEnv as E, mapping))
  registerDefaultLogger(logger)
  return logger
}

/**
 * Base class for Traced Sessions.
 *
 * Stores `traceparent` in a private field (`#traceparent`) which is never sent
 * over the wire; only prototype methods are exposed via JSRPC.
 * Subclass this with your RPC methods and wrap them with `this.traced()`.
 *
 * @template E - The worker environment type.
 *
 * @example
 * ```ts
 * class MySession extends TracedSession<Env> {
 *   async add(a: number, b: number) {
 *     return this.traced(() => {
 *       this.logger.info({ a, b }, 'adding')
 *       return a + b
 *     }, 'math.add')
 *   }
 * }
 *
 * export default tracedWorker(MySession)
 * ```
 */
export class TracedSession<E = unknown> extends RpcTarget {
  #init: SessionInit
  #rootLogger: Logger
  /** Worker env instance property, never exposed over RPC. */
  protected env: E

  /**
   * @param {SessionInit} init - The caller's Trace Carrier and Context Fields.
   * @param {Logger} rootLogger - The isolate's Root Logger (see `TracedEntrypoint.rootLogger`).
   * @param {E} env - The worker environment bindings.
   */
  constructor(init: SessionInit, rootLogger: Logger, env: E) {
    super()
    this.#init = { ...init }
    this.#rootLogger = rootLogger
    this.env = env
  }

  /**
   * Run a function in a Logging Context continuing the caller's trace.
   *
   * Each call gets its own span ID whose parent is the caller's span. When
   * `operation` is provided, the call is reported as a Span (`span.end` with
   * timing and status) if the trace is sampled.
   *
   * @template R - The return type of `fn`.
   * @param {() => R} fn - The function to execute inside the Logging Context.
   * @param {string} [operation] - Span operation name (e.g. `'bind.add'`).
   * @returns {R} The return value of `fn`.
   */
  protected traced<R>(fn: () => R, operation?: string): R {
    return runWithLogger(
      {
        logger: this.#rootLogger,
        traceparent: this.#init.traceparent,
        tracestate: this.#init.tracestate,
        fields: this.#init.fields,
      },
      operation ? () => recordSpan(operation, fn) : fn,
    )
  }

  /**
   * The current Logging Context's logger inside `this.traced()`, otherwise the
   * Root Logger.
   *
   * @returns {Logger} The logger to use.
   */
  protected get logger(): Logger {
    return getTraceContext() ? getLogger() : this.#rootLogger
  }
}

/**
 * Base class for RPC worker entrypoints that build Traced Sessions by hand.
 *
 * Reads `NAME`, `LOG_LEVEL`, `ENVIRONMENT` and `VERSION` from env by default.
 * Override the `envMapping` getter to read other vars or derive fields, or the
 * `loggerOptions` getter to build Logger Options yourself.
 *
 * The constructor registers `rootLogger` as the Default Logger unless one is
 * already set (first seen wins), so `getLogger()` in `scheduled()`, `queue()` or a
 * plain RPC method logs with its `service`. The first instance in an isolate reads
 * `rootLogger` before subclass fields are initialized: build `envMapping` /
 * `loggerOptions` overrides from `this.env`, not from instance fields, and not from
 * `this.ctx.props` (which differ per caller). A Worker that exports several
 * entrypoints with different services should register its default explicitly at
 * module scope (`defaultLoggerFromEnv()` or `setDefaultLogger()`), because otherwise
 * whichever class is constructed first in an isolate wins.
 *
 * @template E - The worker environment type.
 *
 * @example
 * ```ts
 * export default class extends TracedEntrypoint<Env> {
 *   protected override get envMapping(): EnvMapping<Env> {
 *     return { version: (env) => env.CF_VERSION_METADATA?.tag || env.CF_VERSION_METADATA?.id }
 *   }
 *
 *   session(init: SessionInit) {
 *     return new MySession(init, this.rootLogger, this.env)
 *   }
 * }
 * ```
 */
export class TracedEntrypoint<E = unknown> extends WorkerEntrypoint<E> {
  /**
   * @param {ExecutionContext} ctx - The execution context.
   * @param {E} env - The worker environment bindings.
   */
  constructor(ctx: ExecutionContext, env: E) {
    super(ctx, env)
    // Once a default is set, skip working out the Logger Options on every request or RPC call.
    if (!hasDefaultLogger()) registerDefaultLogger(this.rootLogger)
  }

  /**
   * Where `loggerOptions` reads each field from. Default: no overrides.
   *
   * @returns {EnvMapping<E>} The per-field var name or derive function.
   */
  protected get envMapping(): EnvMapping<E> {
    return {}
  }

  /**
   * Logger Options from env through `envMapping` (see `loggerOptionsFromEnv`).
   *
   * @returns {LoggerOptions} The Logger Options.
   */
  protected get loggerOptions(): LoggerOptions {
    return loggerOptionsFromEnv(this.env, this.envMapping)
  }

  /**
   * The isolate's Root Logger for `loggerOptions`, created once and shared.
   *
   * @returns {Logger} The Root Logger.
   */
  protected get rootLogger(): Logger {
    return rootLoggerFor(this.loggerOptions)
  }
}

/**
 * Options for `tracedWorker()`.
 *
 * @template E - The worker environment type.
 */
export interface TracedWorkerOptions<E = unknown> {
  /** Where the Root Logger's options come from in env (see `loggerOptionsFromEnv`). */
  env?: EnvMapping<E>
}

/**
 * The env type of a `TracedSession` subclass.
 *
 * @template S - The `TracedSession` subclass.
 */
type SessionEnv<S> = S extends TracedSession<infer E> ? E : unknown

/**
 * Create a `WorkerEntrypoint` class that auto-implements `session()` for
 * the given `TracedSession` subclass. Zero boilerplate.
 *
 * Reads `NAME`, `LOG_LEVEL`, `ENVIRONMENT` and `VERSION` from env by default;
 * pass `options.env` to read other vars or derive fields.
 *
 * @template S - The `TracedSession` subclass.
 * @param {new (...args: any[]) => S} SessionClass - The session class to wrap.
 * @param {TracedWorkerOptions<SessionEnv<S>>} [options] - `env`: the Env Mapping for the Root Logger.
 * @returns A `WorkerEntrypoint` class with `session()` and `fetch()` implemented.
 *
 * @example
 * ```ts
 * class BindSession extends TracedSession<Env> {
 *   async add(a: number, b: number) {
 *     return this.traced(() => a + b, 'bind.add')
 *   }
 * }
 *
 * // Zero-config entrypoint:
 * export default tracedWorker(BindSession)
 *
 * // Read the version from a `version_metadata` binding:
 * export default tracedWorker(BindSession, {
 *   env: { version: (env) => env.CF_VERSION_METADATA?.tag || env.CF_VERSION_METADATA?.id },
 * })
 *
 * // Or extend if you need scheduled(), etc.:
 * export default class extends tracedWorker(BindSession) {
 *   scheduled() { /* ... *\/ }
 * }
 * ```
 */
export function tracedWorker<S extends TracedSession>(
  SessionClass: new (init: SessionInit, rootLogger: Logger, env: any) => S,
  options: TracedWorkerOptions<SessionEnv<S>> = {},
): {
  new (...args: any[]): {
    session(init: SessionInit): S
    fetch(): Response | Promise<Response>
  }
} {
  return class extends TracedEntrypoint<SessionEnv<S>> {
    protected override get envMapping(): EnvMapping<SessionEnv<S>> {
      return options.env ?? {}
    }

    /**
     * Cloudflare Workers entrypoints must include a `fetch` method.
     *
     * @returns {Response | Promise<Response>} A 404 response.
     */
    fetch(): Response | Promise<Response> {
      return new Response(null, { status: 404 })
    }

    session(init: SessionInit): S {
      return new SessionClass(init ?? {}, this.rootLogger, this.env)
    }
  } as any
}

/**
 * Create a traced session from a service binding.
 *
 * Passes the current Trace Carrier (and `fields`) to `binding.session()`. Outside a
 * Logging Context the carrier is empty and the receiver starts a new root trace.
 *
 * @template T - The session type returned by `binding.session()`.
 * @param {object} binding - The service binding with a `session()` method.
 * @param {LogFields} [fields] - Optional log fields to forward to the session.
 * @returns {T} A traced session stub.
 *
 * @example
 * ```ts
 * const session = tracedSession(c.env.BIND)
 * const result = await session.add(5, 7)
 *
 * // With `using` for auto-disposal:
 * using session = tracedSession(c.env.BIND)
 * const result = await session.add(5, 7)
 * ```
 */
export function tracedSession<T>(binding: TracedServiceBinding<T>, fields?: LogFields): T {
  return binding.session({ ...getTraceCarrier(), ...(fields ? { fields } : {}) })
}

/**
 * Create a traced session, run the callback, and return the result.
 *
 * @template T - The session type returned by `binding.session()`.
 * @template R - The return type of `fn`.
 * @param {object} binding - The service binding with a `session()` method.
 * @param {(session: T) => Promise<R> | R} fn - Callback that receives the traced session.
 * @param {LogFields} [fields] - Optional log fields to forward to the session.
 * @returns {Promise<R>} The result of `fn`.
 *
 * @example
 * ```ts
 * const result = await withTrace(c.env.BIND, s => s.add(5, 7))
 *
 * // With propagated fields:
 * const result = await withTrace(c.env.BIND, s => s.add(5, 7), { requestId: 'abc' })
 * ```
 */
export async function withTrace<T, R>(
  binding: TracedServiceBinding<T>,
  fn: (session: T) => Promise<R> | R,
  fields?: LogFields,
): Promise<R> {
  const session = tracedSession(binding, fields)
  return fn(session)
}
