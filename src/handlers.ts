// Logging Context helpers for the units of work outside HTTP and RPC: cron runs,
// queue messages and Workflows. Exported from `loggercf/workers`.
//
// None of them owns control flow: they never ack, retry, iterate a batch, catch an
// error or decide anything about the work. Arguments and return values pass through
// unchanged, and a throw is logged and rethrown as it is.

import {
  WorkflowEntrypoint,
  env as workersEnv,
  type WorkflowStep,
  type WorkflowStepConfig,
  type WorkflowStepContext,
  type WorkflowStepRollbackOptions,
} from 'cloudflare:workers'
import type { LogFields, Logger } from './types'
import { captureLoggingContext, setLoggerContext, withSpan } from './logger'
import { loggerOptionsFromEnv, type EnvMapping } from './env'
import {
  carrierFromBody,
  defineMethod,
  registerRootLogger,
  rootLoggerFor,
  runLogged,
  sameEnvMapping,
  type Method,
} from './workers-shared'

/**
 * Options for `withScheduled()`, `withQueueMessage()` and `withWorkflow()`.
 *
 * @template E - The worker environment type.
 */
export interface HandlerOptions<E = Cloudflare.Env> {
  /** Where the Root Logger's options come from in env (see `loggerOptionsFromEnv`). */
  env?: EnvMapping<E>
}

/**
 * The isolate's Root Logger for `env` and an Env Mapping, registered as the Default
 * Logger unless one is already set (first seen wins).
 *
 * @param {unknown} env - The Worker's env.
 * @param {EnvMapping} [mapping] - The Env Mapping.
 * @returns {Logger} The Root Logger.
 */
function rootLoggerFromEnv(env: unknown, mapping: EnvMapping<any> | undefined): Logger {
  const logger = rootLoggerFor(loggerOptionsFromEnv(env, mapping))
  registerRootLogger(() => logger)
  return logger
}

/**
 * Run a `scheduled` (cron) handler in a Logging Context.
 *
 * Each run starts a new root trace, with the Context Fields `cron` and
 * `scheduledTime` (ms since the epoch, as the controller gives it), and is recorded
 * as one Span, `span.end scheduled`: `INFO` with its duration, or `ERROR` with `err`
 * when the handler throws or rejects. The Root Logger is built from the handler's
 * `env` through `options.env`, cached per isolate, and registered as the Default
 * Logger unless one is already set (first seen wins).
 *
 * The handler gets the same arguments, its return value is returned as it is, and a
 * throw is rethrown unchanged. The wrapper never calls `controller.noRetry()`.
 *
 * On a class entrypoint, wrap the handler once at module scope and call it from the
 * `scheduled` method with `this.env` and `this.ctx`.
 *
 * @template E - The worker environment type.
 * @template R - The handler's return type.
 * @param {(controller: ScheduledController, env: E, ctx: ExecutionContext) => R} handler - The `scheduled` handler.
 * @param {HandlerOptions<E>} [options] - `env`: the Env Mapping for the Root Logger.
 * @returns A `scheduled` handler with the same signature.
 *
 * @example
 * ```ts
 * export default {
 *   fetch: app.fetch,
 *   scheduled: withScheduled(async (controller, env: Env) => {
 *     getLogger().info('nightly cleanup') // ..., traceId, cron, scheduledTime
 *   }),
 * } satisfies ExportedHandler<Env>
 *
 * // On a class entrypoint:
 * const nightly = withScheduled(async (controller, env: Env) => { ... })
 * export default class extends WorkerEntrypoint<Env> {
 *   scheduled(controller: ScheduledController) {
 *     return nightly(controller, this.env, this.ctx)
 *   }
 * }
 * ```
 */
export function withScheduled<E = Cloudflare.Env, R = void | Promise<void>>(
  handler: (controller: ScheduledController, env: E, ctx: ExecutionContext) => R,
  options: HandlerOptions<E> = {},
): (controller: ScheduledController, env: E, ctx: ExecutionContext) => R {
  const mapping = options.env
  return function scheduled(this: unknown, controller, env, ctx) {
    return runLogged(
      {
        logger: rootLoggerFromEnv(env, mapping),
        fields: { cron: controller.cron, scheduledTime: controller.scheduledTime },
      },
      () => handler.call(this, controller, env, ctx),
      'scheduled',
    )
  }
}

/**
 * Run the work for one queue message in its own Logging Context. Call it inside
 * your own loop over `batch.messages`: it never iterates the batch, and never calls
 * `ack`, `retry`, `ackAll` or `retryAll`. Your code decides those.
 *
 * The Context Fields are `queue` (from the batch), `messageId` and `attempts`. When
 * the message body carries a Trace Carrier under `trace` (the producer sent
 * `{ ...payload, trace: getTraceCarrier() }`), the message continues the producer's
 * trace; otherwise it starts a new root trace. The body is never changed. Each call
 * is recorded as one Span, `span.end queue.message`: `INFO` with its duration, or
 * `ERROR` with `err` when `fn` throws or rejects. `fn`'s return value is returned as
 * it is, and a throw is rethrown unchanged.
 *
 * The Root Logger is built from the Worker's env (read through
 * `import { env } from 'cloudflare:workers'`, as `defaultLoggerFromEnv` does) with
 * `options.env`, cached per isolate, and registered as the Default Logger unless one
 * is already set (first seen wins).
 *
 * @template R - The return type of `fn`.
 * @template E - The worker environment type.
 * @param {Pick<MessageBatch, 'queue'>} batch - The batch the message came in.
 * @param {Pick<Message, 'id' | 'attempts' | 'body'>} message - The message.
 * @param {() => R} fn - The work for this message.
 * @param {HandlerOptions<E>} [options] - `env`: the Env Mapping for the Root Logger.
 * @returns {R} The return value of `fn`, unchanged.
 *
 * @example
 * ```ts
 * // Producer, inside a Logging Context:
 * await env.ORDERS.send({ ...order, trace: getTraceCarrier() })
 *
 * // Consumer:
 * export default {
 *   async queue(batch, env) {
 *     for (const message of batch.messages) {
 *       await withQueueMessage(batch, message, async () => {
 *         getLogger().info('processing') // ..., traceId, queue, messageId, attempts
 *         message.ack()
 *       })
 *     }
 *   },
 * } satisfies ExportedHandler<Env, Order>
 * ```
 */
export function withQueueMessage<R, E = Cloudflare.Env>(
  batch: Pick<MessageBatch, 'queue'>,
  message: Pick<Message, 'id' | 'attempts' | 'body'>,
  fn: () => R,
  options: HandlerOptions<E> = {},
): R {
  return runLogged(
    {
      logger: rootLoggerFromEnv(workersEnv, options.env),
      ...carrierFromBody(message.body),
      fields: { queue: batch.queue, messageId: message.id, attempts: message.attempts },
    },
    fn,
    'queue.message',
  )
}

/** A `WorkflowEntrypoint` subclass, as `withWorkflow()` accepts it. */
type WorkflowClass = new (ctx: ExecutionContext<any>, env: any) => WorkflowEntrypoint<any, any>

/**
 * The env type of a class, read from its constructor.
 *
 * @template C - The class.
 */
type ClassEnv<C> = C extends new (ctx: any, env: infer E) => any ? E : unknown

/** The classes `withWorkflow()` returned, with the options each was made with. */
const workflowClasses = new WeakMap<object, HandlerOptions<any>>()

/**
 * Run a Workflow's `run(event, step)` in a Logging Context, with the Context Field
 * `workflowInstanceId`.
 *
 * When the payload carries a Trace Carrier under `trace` (the creator called
 * `env.WORKFLOW.create({ params: { ...params, trace: getTraceCarrier() } })`), every
 * execution of `run` continues that trace, so its replays share one `traceId`;
 * otherwise each execution starts a new root trace. The Root Logger is built from
 * the Workflow's env through `options.env`, cached per isolate, and registered as
 * the Default Logger in the constructor unless one is already set (first seen wins).
 *
 * `run` itself is not recorded as a Span: the engine replays it from the top after
 * every sleep, wait or restart, and a pause or termination surfaces in it as a throw,
 * so one "run" Span would not describe one unit of work. Wrap each step with
 * `tracedStep()` instead, for one Span per attempt.
 *
 * Nothing about the Workflow changes: no step is added, the event, `step` and the
 * return value pass through as they are, and a throw is rethrown unchanged. `run`
 * must be a method on the class (not a class field), and the returned class should
 * be the one exported. Wrapping the result again with the same `env` returns it;
 * other options, or a subclass of it, throw.
 *
 * @template C - The Workflow class.
 * @param {C} Class - A `WorkflowEntrypoint` subclass.
 * @param {HandlerOptions} [options] - `env`: the Env Mapping for the Root Logger.
 * @returns A subclass of `Class` whose `run` runs in a Logging Context.
 *
 * @example
 * ```ts
 * class ReportWorkflow extends WorkflowEntrypoint<Env, Params> {
 *   async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
 *     const rows = await tracedStep(step, 'fetch rows', async () => fetchRows())
 *     getLogger().info({ rows: rows.length }, 'fetched') // ..., workflowInstanceId
 *   }
 * }
 *
 * export const Report = withWorkflow(ReportWorkflow)
 * ```
 */
export function withWorkflow<C extends WorkflowClass>(
  Class: C,
  options: HandlerOptions<ClassEnv<C>> = {},
): C {
  const name = Class.name
  const where = `withWorkflow(${name})`

  if (!(Class.prototype instanceof WorkflowEntrypoint)) {
    throw new TypeError(`${where}: ${name || 'the class'} does not extend WorkflowEntrypoint`)
  }
  const previous = workflowClasses.get(Class)
  if (previous) {
    if (sameEnvMapping(previous.env, options.env)) return Class
    throw new TypeError(`${where}: ${name} is already wrapped with other options`)
  }
  for (let base = Object.getPrototypeOf(Class); base; base = Object.getPrototypeOf(base)) {
    if (workflowClasses.has(base)) {
      throw new TypeError(
        `${where}: ${name} extends a class already wrapped by withWorkflow(); wrap one of them, not both`,
      )
    }
  }
  const run = ownRun(Class)
  if (!run) {
    throw new TypeError(
      `${where}: ${name} has no run() method; define run as a method, not a field`,
    )
  }

  const mapping = options.env
  /** The Root Logger for one Workflow instance, from its env. */
  const rootLoggerOf = (target: object) =>
    rootLoggerFor(loggerOptionsFromEnv((target as { env: unknown }).env, mapping as EnvMapping))

  const Logged = class extends (Class as WorkflowClass) {
    constructor(ctx: ExecutionContext, env: unknown) {
      super(ctx, env)
      registerRootLogger(() => rootLoggerOf(this))
    }
  }
  Object.defineProperty(Logged, 'name', { value: name, configurable: true })

  /**
   * `run` in a Logging Context: the class's implementation, called unchanged.
   *
   * @param {...unknown} args - `event`, `step`, and anything else, passed through.
   * @returns {unknown} The return value of `run`, unchanged.
   */
  const loggedRun = function (this: object, ...args: unknown[]) {
    const event = args[0] as { instanceId?: unknown; payload?: unknown } | undefined
    const fields: LogFields =
      typeof event?.instanceId === 'string' ? { workflowInstanceId: event.instanceId } : {}
    return runLogged(
      { logger: rootLoggerOf(this), ...carrierFromBody(event?.payload), fields },
      () => run.apply(this, args),
    )
  }
  defineMethod(Logged.prototype, 'run', loggedRun)

  workflowClasses.set(Logged, { env: mapping })
  return Logged as unknown as C
}

/**
 * The `run` method a Workflow class defines, nearest first, below
 * `WorkflowEntrypoint.prototype`.
 *
 * @param {WorkflowClass} Class - The Workflow class.
 * @returns {Method | undefined} The method, or `undefined` when no class defines one.
 */
function ownRun(Class: WorkflowClass): Method | undefined {
  for (
    let proto: object | null = Class.prototype;
    proto && proto !== WorkflowEntrypoint.prototype && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'run')
    if (descriptor) return typeof descriptor.value === 'function' ? descriptor.value : undefined
  }
  return undefined
}

/**
 * The Context Fields of one step attempt: `step`, and `attempt` when the engine
 * passes a step context.
 *
 * @param {string} name - The step name.
 * @param {unknown} ctx - The step context `step.do` passed to the callback.
 * @returns {LogFields} The Context Fields.
 */
function stepFields(name: string, ctx: unknown): LogFields {
  const attempt = (ctx as { attempt?: unknown } | undefined)?.attempt
  return typeof attempt === 'number' ? { step: name, attempt } : { step: name }
}

/**
 * `step.do(name, ...)` with each attempt recorded as a Span, named after the step,
 * with the Context Fields `step` and `attempt`. Takes the same arguments as
 * `step.do` after `step`: an optional config, the callback, and optional rollback
 * options.
 *
 * Call it inside `run` of a class wrapped with `withWorkflow()`. The engine calls the
 * callback back over RPC, outside the Logging Context `run` opened; `tracedStep`
 * re-enters it, so lines in the callback carry `workflowInstanceId` and the run's
 * trace too, and the Span's parent is the run's span. A retried attempt writes its
 * own Span: `ERROR` with `err` for an attempt that throws, `INFO` for the one that
 * succeeds. A step whose result the engine already has (on a replay) runs no
 * callback, so it writes nothing.
 *
 * Determinism is kept: `step.do` is called once, with the same name, the same config
 * and rollback options objects, and a callback that returns the original's value (or
 * throws its error) unchanged. No step is added. Outside a Logging Context it calls
 * `step.do` with the arguments untouched.
 *
 * @template T - The step's return type.
 * @param {WorkflowStep} step - The `step` passed to `run`.
 * @param {string} name - The step name, as for `step.do`.
 * @returns {Promise<T>} What `step.do` returns, unchanged.
 *
 * @example
 * ```ts
 * const user = await tracedStep(step, 'load user', async () => db.getUser(id))
 * await tracedStep(step, 'charge', { retries: { limit: 3, delay: '5 seconds' } }, async (ctx) => {
 *   getLogger().info('charging') // ..., workflowInstanceId, step: 'charge', attempt
 * })
 * ```
 */
export function tracedStep<T extends Rpc.Serializable<T>>(
  step: WorkflowStep,
  name: string,
  callback: (ctx: WorkflowStepContext) => Promise<T>,
  rollbackOptions?: WorkflowStepRollbackOptions<T>,
): Promise<T>
export function tracedStep<T extends Rpc.Serializable<T>>(
  step: WorkflowStep,
  name: string,
  config: WorkflowStepConfig,
  callback: (ctx: WorkflowStepContext) => Promise<T>,
  rollbackOptions?: WorkflowStepRollbackOptions<T>,
): Promise<T>
export function tracedStep(step: WorkflowStep, name: string, ...rest: unknown[]): Promise<unknown> {
  const stepDo = (args: unknown[]) =>
    (step as unknown as { do: (...a: unknown[]) => Promise<unknown> }).do(name, ...args)

  const enter = captureLoggingContext()
  const at = typeof rest[0] === 'function' ? 0 : 1
  const callback = rest[at]
  if (!enter || typeof callback !== 'function') return stepDo(rest)

  const args = [...rest]
  args[at] = (...callbackArgs: unknown[]) =>
    enter(() =>
      withSpan(name, () => {
        setLoggerContext(stepFields(name, callbackArgs[0]))
        return (callback as Method).apply(undefined, callbackArgs)
      }),
    )
  return stepDo(args)
}
