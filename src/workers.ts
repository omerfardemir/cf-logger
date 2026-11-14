import { DurableObject, RpcTarget, WorkerEntrypoint, env as workersEnv } from 'cloudflare:workers'
import type { LogFields, Logger, LoggerOptions, TraceCarrier } from './types'
import {
  getLogger,
  getTraceCarrier,
  getTraceContext,
  registerDefaultLogger,
  setLoggerContext,
  withSpan,
} from './logger'
import { loggerOptionsFromEnv, type EnvMapping } from './env'
import { extractCarrier } from './trace'
import {
  defineMethod,
  registerRootLogger,
  rootLoggerFor,
  runLogged,
  sameEnvMapping,
  type Method,
} from './workers-shared'

export { loggerOptionsFromEnv } from './env'
export type { EnvMapping, EnvSource } from './env'
export { withScheduled, withQueueMessage, withWorkflow, tracedStep } from './handlers'
export type { HandlerOptions } from './handlers'

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
    return runLogged(
      {
        logger: this.#rootLogger,
        traceparent: this.#init.traceparent,
        tracestate: this.#init.tracestate,
        fields: this.#init.fields,
      },
      fn,
      operation,
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
    registerRootLogger(() => this.rootLogger)
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

/**
 * Options for `withLogging()`.
 *
 * @template E - The worker environment type.
 */
export interface WithLoggingOptions<E = unknown> {
  /**
   * Record each call as a Span: one `span.end` with duration and status, at `ERROR`
   * (with `err`) when the method throws or rejects. Default `false`.
   */
  spans?: boolean
  /**
   * Add `session(init)`, which returns a Traced Session over the same methods, so
   * callers that use `tracedSession()` / `withTrace()` continue their trace.
   * Default `false`: the entrypoint exposes exactly the methods it already has.
   */
  session?: boolean
  /**
   * Wrap `fetch` too, so each request runs in its own Logging Context that continues
   * an incoming `traceparent` header. Default `true`. Set `false` when `fetch` hands
   * the request to a Hono app that uses `useLogger`: `useLogger` opens its own
   * Logging Context and continues `traceparent` itself, and a second one around it
   * would split the request into two root traces. With `false`, `fetch` is inherited
   * unchanged.
   */
  fetch?: boolean
  /** Where the Root Logger's options come from in env (see `loggerOptionsFromEnv`). */
  env?: EnvMapping<E>
}

/** A `WorkerEntrypoint` subclass, as `withLogging()` accepts it. */
type EntrypointClass = new (ctx: ExecutionContext<any>, env: any) => WorkerEntrypoint<any, any>

/** A `DurableObject` subclass, as `withLogging()` accepts it. */
type DurableObjectSubclass = new (ctx: DurableObjectState<any>, env: any) => DurableObject<any, any>

/**
 * The env type of an entrypoint class, read from its constructor.
 *
 * @template C - The entrypoint class.
 */
type EntrypointEnv<C> = C extends new (ctx: any, env: infer E) => any ? E : unknown

/** Event handlers, which JSRPC never calls by name. */
const HANDLERS = [
  'fetch',
  'connect',
  'email',
  'queue',
  'scheduled',
  'tail',
  'tailStream',
  'test',
  'trace',
] as const

type HandlerName = (typeof HANDLERS)[number]

/**
 * A Durable Object's event handlers, which JSRPC never calls by name. All but
 * `connect` are wrapped: each is one unit of work on the object.
 */
const DURABLE_OBJECT_HANDLERS = [
  'fetch',
  'connect',
  'alarm',
  'webSocketMessage',
  'webSocketClose',
  'webSocketError',
] as const

/** The Durable Object handlers `withLogging()` wraps besides `fetch`, which has its own option. */
const DURABLE_OBJECT_WRAPPED = ['alarm', 'webSocketMessage', 'webSocketClose', 'webSocketError']

/**
 * The Context Fields naming one Durable Object: `objectName` when its ID has a name
 * (`idFromName` / `getByName`), otherwise `objectId`.
 *
 * @param {DurableObjectState | undefined} state - The object's `ctx`.
 * @returns {LogFields} The fields, empty when the state has no ID.
 */
function objectFieldsOf(state: DurableObjectState | undefined): LogFields {
  const id = state?.id
  if (!id) return {}
  return id.name ? { objectName: id.name } : { objectId: id.toString() }
}

/**
 * The RPC methods of an entrypoint instance: its public methods minus the event handlers.
 *
 * @template T - The entrypoint instance type.
 */
type RpcMethodsOf<T> = {
  [
    K in keyof T as K extends HandlerName ? never : T[K] extends (...args: any[]) => any ? K : never
  ]: T[K]
}

/**
 * The methods JSRPC can see on an entrypoint or Durable Object class: functions on
 * its prototype chain below `base` (`WorkerEntrypoint.prototype` or
 * `DurableObject.prototype`), nearest definition first, without `constructor`,
 * accessors, or a method an accessor shadows.
 *
 * @param {Function} Class - The class.
 * @param {object} base - The runtime base class's prototype, where the walk stops.
 * @returns {Map<string, Method>} Method name to the class's implementation.
 */
function prototypeMethods(Class: Function, base: object): Map<string, Method> {
  const methods = new Map<string, Method>()
  const seen = new Set<string>(['constructor'])
  for (
    let proto: object | null = Class.prototype;
    proto && proto !== base && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (seen.has(name)) continue
      seen.add(name)
      const { value } = Object.getOwnPropertyDescriptor(proto, name)!
      if (typeof value === 'function') methods.set(name, value as Method)
    }
  }
  return methods
}

/**
 * The classes `withLogging()` returned, with the options each was made with. Kept
 * here, not on the class, so the class carries no extra property.
 */
const loggedClasses = new WeakMap<object, WithLoggingOptions<any>>()

/**
 * Whether two `withLogging()` options produce the same wrapping: the same `spans` and
 * `session` (default `false`), the same `fetch` (default `true`), and Env Mappings
 * with the same keys and values (a derive function compares by identity).
 *
 * @param {WithLoggingOptions} a - One set of options.
 * @param {WithLoggingOptions} b - The other.
 * @returns {boolean} `true` when they are the same.
 */
function sameOptions(a: WithLoggingOptions<any>, b: WithLoggingOptions<any>): boolean {
  return (
    !!a.spans === !!b.spans &&
    !!a.session === !!b.session &&
    (a.fetch ?? true) === (b.fetch ?? true) &&
    sameEnvMapping(a.env, b.env)
  )
}

/**
 * Open a Logging Context around every public method of a plain `WorkerEntrypoint`
 * or a `DurableObject`, with no caller changes.
 *
 * Each RPC method call, and `fetch`, runs in its own Logging Context from the
 * isolate's Root Logger, built with `loggerOptionsFromEnv(this.env, options.env)` and
 * cached like `TracedEntrypoint`'s. When `Class` is a `TracedEntrypoint` subclass,
 * its own `rootLogger` (from its `envMapping` / `loggerOptions`) is used instead, and
 * passing `options.env` throws. A plain RPC call carries no Trace Carrier, so each
 * one starts a new root trace; `fetch` continues the request's `traceparent` header
 * when there is one. `fetch: false` leaves `fetch` unwrapped: use it when `fetch`
 * hands the request to a Hono app that uses `useLogger`, which opens its own Logging
 * Context and continues `traceparent` itself. Every line carries the Context Fields
 * `rpcMethod` (the method name) and `entrypoint` (the class name; left off for an
 * anonymous class). A method called while any Logging Context is active (one public
 * method calling another, or a call inside your own `runWithLogger`) joins that
 * context, as a child Span when `spans` is on, and adds no `rpcMethod` or
 * `entrypoint` of its own.
 *
 * The methods are wrapped, never changed: arguments, return values (sync or async,
 * an `RpcTarget` or a stub included) and thrown errors pass through as they are.
 * The returned class has the same RPC methods as `Class`; `scheduled`, `queue`,
 * `tail` and the other handlers are inherited unchanged. Its constructor registers
 * the Root Logger as the Default Logger unless one is already set (first seen
 * wins), so `getLogger()` in those handlers logs with `service` too. Getters, and
 * the body of an `async *` method (which runs on each `.next()`), run outside the
 * Logging Context. Methods named like a handler (`trace`, `test`, `email`, `connect`,
 * `queue`, `tail`, `tailStream`) are never wrapped.
 *
 * Only the methods `Class` has when it is wrapped are wrapped. A method added or
 * overridden in a subclass of the returned class runs outside every Logging Context,
 * so put every RPC method on `Class` and extend the result only to add handlers.
 *
 * `session: true` adds `session(init)` for gradual migration: callers that move to
 * `tracedSession()` / `withTrace()` continue their trace, while the rest keep
 * calling the methods directly.
 *
 * Wrapping a class `withLogging()` returned gives back that class when the options
 * are the same, and throws when they differ. Wrapping a subclass of one throws, and
 * so does wrapping a class that extends neither `WorkerEntrypoint` nor `DurableObject`.
 *
 * **Durable Objects.** For a `DurableObject` subclass, `fetch`, every RPC method,
 * `alarm`, `webSocketMessage`, `webSocketClose` and `webSocketError` each run in their
 * own Logging Context (`fetch` continuing a `traceparent` header, the rest starting
 * a new root trace), with the Context Fields `rpcMethod` (the method or handler
 * name), `durableObject` (the class name; left off for an anonymous class) and either
 * `objectName` (`ctx.id.name`, for an object reached by name) or `objectId`
 * (`ctx.id.toString()`). `connect` is inherited unchanged. `session` is not
 * available: the object gets no extra RPC method. `spans`, `fetch` and `env` work as
 * for an entrypoint.
 *
 * @template C - The entrypoint or Durable Object class.
 * @param {C} Class - A `WorkerEntrypoint` or `DurableObject` subclass.
 * @param {WithLoggingOptions} [options] - `spans`, `session`, `fetch`, and the `env` mapping.
 * @returns A subclass of `Class` whose public methods run in a Logging Context.
 *
 * @example
 * ```ts
 * class SearchWorker extends WorkerEntrypoint<Env> {
 *   async search(q: string) {
 *     getLogger().info({ q }, 'searching') // service, traceId, spanId, rpcMethod, entrypoint
 *   }
 * }
 *
 * export default withLogging(SearchWorker, { spans: true, session: true })
 *
 * class RoomObject extends DurableObject<Env> {
 *   async join(user: string) {
 *     getLogger().info({ user }, 'joined') // ..., rpcMethod, durableObject, objectName
 *   }
 * }
 *
 * export const Room = withLogging(RoomObject)
 * ```
 */
export function withLogging<C extends EntrypointClass>(
  Class: C,
  options: WithLoggingOptions<EntrypointEnv<C>> & { session: true },
): (new (...args: ConstructorParameters<C>) => InstanceType<C> & {
  session(init: SessionInit): TracedSession<EntrypointEnv<C>> & RpcMethodsOf<InstanceType<C>>
}) &
  C
export function withLogging<C extends EntrypointClass>(
  Class: C,
  options?: WithLoggingOptions<EntrypointEnv<C>>,
): C
export function withLogging<C extends DurableObjectSubclass>(
  Class: C,
  options?: Omit<WithLoggingOptions<EntrypointEnv<C>>, 'session'>,
): C
export function withLogging<C extends EntrypointClass | DurableObjectSubclass>(
  Class: C,
  options: WithLoggingOptions<EntrypointEnv<C>> = {},
): C {
  const { spans = false, session = false, fetch: wrapFetch = true, env: mapping } = options
  const entrypoint = Class.name
  const where = `withLogging(${entrypoint})`

  const isDurableObject = Class.prototype instanceof DurableObject
  if (!isDurableObject && !(Class.prototype instanceof WorkerEntrypoint)) {
    throw new TypeError(
      `${where}: ${entrypoint || 'the class'} does not extend WorkerEntrypoint or DurableObject`,
    )
  }
  if (isDurableObject && session) {
    throw new TypeError(
      `${where}: ${entrypoint} is a Durable Object; session() is only for WorkerEntrypoint classes`,
    )
  }

  const previous = loggedClasses.get(Class)
  if (previous) {
    if (sameOptions(previous, options)) return Class
    throw new TypeError(`${where}: ${entrypoint} is already wrapped with other options`)
  }
  for (let base = Object.getPrototypeOf(Class); base; base = Object.getPrototypeOf(base)) {
    if (loggedClasses.has(base)) {
      throw new TypeError(
        `${where}: ${entrypoint} extends a class already wrapped by withLogging(); wrap one of them, not both`,
      )
    }
  }
  if (session && 'session' in Class.prototype) {
    throw new TypeError(`${where}: ${entrypoint} already defines session()`)
  }
  const isTracedEntrypoint = Class.prototype instanceof TracedEntrypoint
  if (isTracedEntrypoint && mapping) {
    throw new TypeError(
      `${where}: ${entrypoint} is a TracedEntrypoint; override its envMapping getter instead of passing env`,
    )
  }

  /**
   * The Root Logger for one entrypoint instance: its own `rootLogger` for a
   * `TracedEntrypoint`, otherwise the cached one for its env and the Env Mapping.
   *
   * @param {object} target - The entrypoint instance.
   * @returns {Logger} The Root Logger.
   */
  const rootLoggerOf = (target: object): Logger =>
    isTracedEntrypoint
      ? (target as unknown as { rootLogger: Logger }).rootLogger
      : rootLoggerFor(loggerOptionsFromEnv((target as { env: unknown }).env, mapping as EnvMapping))

  /** Each Durable Object instance's `objectName` / `objectId`, read in its constructor. */
  const objectFields = new WeakMap<object, LogFields>()

  /**
   * The Context Fields of one call: `rpcMethod`, and `entrypoint` unless the class
   * is anonymous. For a Durable Object, `durableObject` in place of `entrypoint`, and
   * `objectName` or `objectId`.
   *
   * @param {string} name - The method name.
   * @param {object} [target] - The instance the method is called on.
   * @returns {LogFields} The Context Fields.
   */
  const fieldsOf = (name: string, target?: object): LogFields => {
    if (!isDurableObject) return entrypoint ? { rpcMethod: name, entrypoint } : { rpcMethod: name }
    return {
      rpcMethod: name,
      ...(entrypoint ? { durableObject: entrypoint } : {}),
      ...(target ? objectFields.get(target) : {}),
    }
  }

  /**
   * The Span operation name of one call, `<Class>.<method>` (the bare method name for
   * an anonymous class), or `undefined` when `spans` is off.
   *
   * @param {string} name - The method name.
   * @returns {string | undefined} The operation name.
   */
  const operationOf = (name: string): string | undefined =>
    spans ? (entrypoint ? `${entrypoint}.${name}` : name) : undefined

  const Logged = class extends (Class as EntrypointClass) {
    constructor(ctx: ExecutionContext, env: unknown) {
      super(ctx, env)
      if (isDurableObject) {
        objectFields.set(this, objectFieldsOf(ctx as unknown as DurableObjectState))
      }
      registerRootLogger(() => rootLoggerOf(this))
    }
  }
  Object.defineProperty(Logged, 'name', { value: entrypoint, configurable: true })

  /**
   * Wrap one entrypoint method: a new Logging Context, or a child Span of the current one.
   *
   * @param {string} name - The method name.
   * @param {Method} method - The class's implementation.
   * @param {(args: unknown[]) => TraceCarrier} [carrierOf] - Reads a Trace Carrier from the call's arguments.
   * @returns {Method} The wrapped method.
   */
  const wrap = (name: string, method: Method, carrierOf?: (args: unknown[]) => TraceCarrier) =>
    function (this: object, ...args: unknown[]) {
      const run = () => method.apply(this, args)
      const operation = operationOf(name)
      if (getTraceContext()) return operation ? withSpan(operation, run) : run()
      return runLogged(
        { logger: rootLoggerOf(this), ...carrierOf?.(args), fields: fieldsOf(name, this) },
        run,
        operation,
      )
    }

  const methods = prototypeMethods(
    Class,
    isDurableObject ? DurableObject.prototype : WorkerEntrypoint.prototype,
  )
  const handlers: readonly string[] = isDurableObject ? DURABLE_OBJECT_HANDLERS : HANDLERS
  const rpcMethods = [...methods].filter(([name]) => !handlers.includes(name))
  for (const [name, method] of rpcMethods) defineMethod(Logged.prototype, name, wrap(name, method))
  // A Durable Object's alarm and WebSocket handlers are each a unit of work on the object.
  if (isDurableObject) {
    for (const name of DURABLE_OBJECT_WRAPPED) {
      const handler = methods.get(name)
      if (handler) defineMethod(Logged.prototype, name, wrap(name, handler))
    }
  }
  // `fetch` is wrapped with its request as a Trace Carrier.
  const fetch = wrapFetch ? methods.get('fetch') : undefined
  if (fetch) {
    defineMethod(
      Logged.prototype,
      'fetch',
      wrap('fetch', fetch, (args) =>
        extractCarrier((header) => (args[0] as Request | undefined)?.headers?.get(header)),
      ),
    )
  }

  if (session) {
    /** What `session(init)` returns: the same RPC methods, continuing the caller's trace. */
    class LoggedSession extends TracedSession<unknown> {
      #target: object

      constructor(init: SessionInit, rootLogger: Logger, env: unknown, target: object) {
        super(init, rootLogger, env)
        this.#target = target
      }

      /**
       * `TracedSession.traced()`, reached through `super` so that a user method named
       * `traced`, copied onto this prototype, cannot shadow it.
       *
       * @template R - The return type of `fn`.
       * @param {() => R} fn - The method call.
       * @param {string} [operation] - Span operation name.
       * @returns {R} The return value of `fn`.
       */
      #traced<R>(fn: () => R, operation?: string): R {
        return super.traced(fn, operation)
      }

      static {
        for (const [name, method] of rpcMethods) {
          /**
           * One RPC method on the session: the entrypoint's implementation, called on the
           * entrypoint, inside a Logging Context continuing the caller's trace. A caller
           * field named `rpcMethod` or `entrypoint` is replaced.
           *
           * @param {...unknown} args - The call's arguments, passed through unchanged.
           * @returns {unknown} The method's return value, unchanged.
           */
          const sessionMethod = function (this: LoggedSession, ...args: unknown[]) {
            const target = this.#target
            return this.#traced(() => {
              setLoggerContext(fieldsOf(name))
              return method.apply(target, args)
            }, operationOf(name))
          }
          defineMethod(this.prototype, name, sessionMethod)
        }
      }
    }

    /**
     * `session(init)` on the entrypoint: a Traced Session over the same RPC methods.
     *
     * @param {SessionInit} [init] - The caller's Trace Carrier and fields.
     * @returns {LoggedSession} The session.
     */
    const sessionOf = function (this: object, init?: SessionInit) {
      return new LoggedSession(init ?? {}, rootLoggerOf(this), (this as { env: unknown }).env, this)
    }
    defineMethod(Logged.prototype, 'session', sessionOf)
  }

  loggedClasses.set(Logged, { spans, session, fetch: wrapFetch, env: mapping })
  return Logged as unknown as C
}
