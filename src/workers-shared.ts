// Internals shared by the Workers helpers (`workers.ts`, `handlers.ts`).
// Not an entry point: nothing here is exported from the package.

import type { Logger, LoggerOptions, TraceCarrier } from './types'
import {
  createLogger,
  hasDefaultLogger,
  recordSpan,
  registerDefaultLogger,
  runWithLogger,
} from './logger'

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
export function rootLoggerFor(options: LoggerOptions): Logger {
  const key = JSON.stringify([options.service, options.level, options.environment, options.version])
  let logger = rootLoggers.get(key)
  if (!logger) {
    logger = createLogger(options)
    rootLoggers.set(key, logger)
  }
  return logger
}

/**
 * Register the isolate's Root Logger as the Default Logger unless one is already set
 * (first seen wins). Shared by every Workers helper.
 *
 * @param {() => Logger} rootLogger - Resolves the Root Logger; called only while no default is set.
 */
export function registerRootLogger(rootLogger: () => Logger): void {
  // Once a default is set, skip working out the Logger Options on every request or RPC call.
  if (!hasDefaultLogger()) registerDefaultLogger(rootLogger())
}

/**
 * Run `fn` in a new Logging Context, as a Span covering that context when
 * `operation` is given. Shared by `TracedSession.traced()`, `withLogging()` and the
 * handler helpers.
 *
 * @template R - The return type of `fn`.
 * @param {Parameters<typeof runWithLogger>[0]} context - The Logging Context to open.
 * @param {() => R} fn - The function to run in it.
 * @param {string} [operation] - Span operation name; no Span without it.
 * @param {boolean} [timed] - `false` writes no `span.end`, only the `<operation> failed`
 *   line on a throw (see `recordSpan`).
 * @returns {R} The return value of `fn`, unchanged.
 */
export function runLogged<R>(
  context: Parameters<typeof runWithLogger>[0],
  fn: () => R,
  operation?: string,
  timed = true,
): R {
  return runWithLogger(context, operation ? () => recordSpan(operation, fn, timed) : fn)
}

/** Any method, as stored on a prototype. */
export type Method = (...args: any[]) => unknown

/**
 * Define a method the way a class body does: non-enumerable, writable, configurable.
 *
 * @param {object} target - The prototype.
 * @param {string} name - The method name; also the function's `name`.
 * @param {Method} fn - The method.
 */
export function defineMethod(target: object, name: string, fn: Method): void {
  Object.defineProperty(fn, 'name', { value: name, configurable: true })
  Object.defineProperty(target, name, {
    value: fn,
    writable: true,
    enumerable: false,
    configurable: true,
  })
}

/**
 * Read the Trace Carrier a producer put in a message body or payload as
 * `{ ...payload, trace: getTraceCarrier() }`. Anything else, including a `trace`
 * of another shape, gives an empty carrier (a new root trace).
 *
 * @param {unknown} body - A queue message body or a Workflow payload.
 * @returns {TraceCarrier} The carrier, with absent or non-string values omitted.
 */
export function carrierFromBody(body: unknown): TraceCarrier {
  if (typeof body !== 'object' || body === null) return {}
  const trace = (body as { trace?: unknown }).trace
  if (typeof trace !== 'object' || trace === null) return {}
  const { traceparent, tracestate } = trace as Record<string, unknown>
  if (typeof traceparent !== 'string') return {}
  return { traceparent, ...(typeof tracestate === 'string' ? { tracestate } : {}) }
}

/**
 * Whether two Env Mappings have the same keys and values (a derive function
 * compares by identity). An absent mapping equals an empty one.
 *
 * @param {object} [a] - One mapping.
 * @param {object} [b] - The other.
 * @returns {boolean} `true` when they are the same.
 */
export function sameEnvMapping(a: object | undefined, b: object | undefined): boolean {
  const envA = (a ?? {}) as Record<string, unknown>
  const envB = (b ?? {}) as Record<string, unknown>
  const keys = new Set([...Object.keys(envA), ...Object.keys(envB)])
  return [...keys].every((key) => envA[key] === envB[key])
}
