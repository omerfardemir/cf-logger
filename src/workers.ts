import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers'
import type { LogFields, Logger, LoggerOptions } from './types'
import { createLogger, getLogger, getTraceContext, recordSpan, runWithLogger } from './logger'
import { buildTraceparent } from './trace'
import { loggerOptionsFromEnv } from './env'

export { loggerOptionsFromEnv } from './env'

export type TracedServiceBinding<T> = {
  session(traceparent: string, fields?: LogFields, tracestate?: string): T
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
  #traceparent: string
  #tracestate: string | undefined
  #rootLogger: Logger
  #fields: LogFields
  /** Worker env instance property, never exposed over RPC. */
  protected env: E

  /**
   * @param {string} traceparent - The W3C `traceparent` header value from the caller.
   * @param {Logger} rootLogger - The isolate's Root Logger (see `TracedEntrypoint.rootLogger`).
   * @param {E} env - The worker environment bindings.
   * @param {LogFields} [fields] - Optional initial Context Fields from the caller.
   * @param {string} [tracestate] - Optional W3C `tracestate` header value.
   */
  constructor(
    traceparent: string,
    rootLogger: Logger,
    env: E,
    fields?: LogFields,
    tracestate?: string,
  ) {
    super()
    this.#traceparent = traceparent
    this.#tracestate = tracestate
    this.#rootLogger = rootLogger
    this.#fields = fields ?? {}
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
        traceparent: this.#traceparent,
        tracestate: this.#tracestate,
        fields: this.#fields,
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
 * Expects `env.NAME` and `env.LOG_LEVEL` by convention. Override the
 * `loggerOptions` getter for custom behavior.
 *
 * @template E - The worker environment type.
 *
 * @example
 * ```ts
 * export default class extends TracedEntrypoint<Env> {
 *   session(traceparent: string, fields?: LogFields, tracestate?: string) {
 *     return new MySession(traceparent, this.rootLogger, this.env, fields, tracestate)
 *   }
 * }
 * ```
 */
export class TracedEntrypoint<E = unknown> extends WorkerEntrypoint<E> {
  /**
   * Logger Options derived from `env.NAME`, `env.LOG_LEVEL`, `env.ENVIRONMENT`, and `env.VERSION`.
   *
   * @returns {LoggerOptions} The Logger Options.
   */
  protected get loggerOptions(): LoggerOptions {
    return loggerOptionsFromEnv(this.env)
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
 * Create a `WorkerEntrypoint` class that auto-implements `session()` for
 * the given `TracedSession` subclass. Zero boilerplate.
 *
 * Expects `env.NAME` and `env.LOG_LEVEL` by convention.
 *
 * @template S - The `TracedSession` subclass.
 * @param {new (...args: any[]) => S} SessionClass - The session class to wrap.
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
 * // Or extend if you need scheduled(), etc.:
 * export default class extends tracedWorker(BindSession) {
 *   scheduled() { /* ... *\/ }
 * }
 * ```
 */
export function tracedWorker<S extends TracedSession>(
  SessionClass: new (
    traceparent: string,
    rootLogger: Logger,
    env: any,
    fields?: LogFields,
    tracestate?: string,
  ) => S,
): {
  new (...args: any[]): {
    session(traceparent: string, fields?: LogFields, tracestate?: string): S
    fetch(): Response | Promise<Response>
  }
} {
  return class extends TracedEntrypoint {
    /**
     * Cloudflare Workers entrypoints must include a `fetch` method.
     *
     * @returns {Response | Promise<Response>} A 404 response.
     */
    fetch(): Response | Promise<Response> {
      return new Response(null, { status: 404 })
    }

    session(traceparent: string, fields?: LogFields, tracestate?: string): S {
      return new SessionClass(traceparent, this.rootLogger, this.env, fields, tracestate)
    }
  } as any
}

/**
 * Create a traced session from a service binding.
 *
 * Reads `traceparent` from the current Logging Context and passes it to `binding.session()`.
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
  const trace = getTraceContext()
  const traceparent = trace ? buildTraceparent(trace) : ''
  return binding.session(traceparent, fields, trace?.tracestate)
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
