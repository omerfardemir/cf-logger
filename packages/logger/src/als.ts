import type { LogFields, Logger, TraceContext, ALSStore } from './types'
import { als } from './store'
import { createSimpleLogger } from './logger'
import { resolveTrace } from './trace'

/**
 * Cached standalone loggers keyed by service name.
 */
const _cache = new Map<string | symbol, Logger>()

/**
 * Default key when no service name is provided.
 */
const DEFAULT_KEY = Symbol('default')

/**
 * Get a logger for the current context.
 *
 * - **Inside ALS** (middleware / `runWithLogger`): returns the request-scoped
 *   logger with trace context. `service` is ignored (already set by factory).
 * - **Outside ALS**: returns a cached standalone logger, optionally tagged with
 *   a service name.
 *
 * @template T - The type of user-defined log fields.
 * @param {string} [service] - Service name used for the standalone fallback logger.
 * @returns {Logger<T>} The logger for the current context.
 *
 * @example
 * ```ts
 * const logger = getLogger()
 * logger.info({ userId: 42 }, 'user signed in')
 * ```
 */
export function getLogger<T extends LogFields = LogFields>(
  service?: string,
): Logger<T> {
  const store = als.getStore()
  if (store) return store.logger as Logger<T>

  const key = service ?? DEFAULT_KEY
  let logger = _cache.get(key)
  if (!logger) {
    logger = createSimpleLogger({ service: service ?? 'unknown' })
    _cache.set(key, logger)
  }
  return logger as Logger<T>
}

/**
 * Enrich the current logging context with extra fields.
 *
 * - **Inside ALS**: fields appear on all subsequent log lines in the same request
 *   (via pino mixin).
 * - **Outside ALS**: replaces every cached logger with a child that includes these
 *   fields, so subsequent `getLogger(service)` calls include them.
 *
 * @template T - The type of user-defined log fields.
 * @param {Partial<T>} fields - Key-value pairs to merge into the logging context.
 *
 * @example
 * ```ts
 * setLoggerContext({ requestId: 'abc-123', tenantId: 'acme' })
 * ```
 */
export function setLoggerContext<T extends LogFields = LogFields>(
  fields: Partial<T>,
): void {
  const store = als.getStore()
  if (store) {
    Object.assign(store.fields, fields)
    return
  }

  // Outside ALS upgrade every cached logger with a child that has these bindings
  for (const [key, logger] of _cache) {
    _cache.set(key, logger.child(fields))
  }
}

/**
 * Run a function within a logging context.
 *
 * Framework-agnostic, use this directly in any runtime (Node.js, CF Workers,
 * RPC entrypoints, scheduled handlers, queue consumers, etc.).
 *
 * @template T - The type of user-defined log fields.
 * @template R - The return type of `fn`.
 * @param {object} options - Context options.
 * @param {Logger<T>} options.logger - The logger instance for this context.
 * @param {TraceContext} [options.trace] - An already-parsed trace context.
 * @param {string | null} [options.traceparent] - A raw `traceparent` header to parse. Ignored when `trace` is set.
 * @param {Partial<T>} [options.fields] - Initial log fields.
 * @param {() => R} fn - The function to execute inside the ALS context.
 * @returns {R} The return value of `fn`.
 *
 * @example
 * ```ts
 * const logger = createLogger({ service: 'worker' })
 * runWithLogger({ logger, traceparent: req.headers.get('traceparent') }, () => {
 *   getLogger().info('inside ALS')
 * })
 * ```
 */
export function runWithLogger<T extends LogFields = LogFields, R = unknown>(
  options: {
    logger: Logger<T>
    trace?: TraceContext
    traceparent?: string | null
    fields?: Partial<T>
  },
  fn: () => R,
): R {
  const trace = options.trace ?? resolveTrace(options.traceparent)
  const store: ALSStore = {
    trace,
    fields: (options.fields ?? {}) as T,
    logger: options.logger,
  }
  return als.run(store, fn)
}

/**
 * Read the current trace context from ALS.
 *
 * @returns {TraceContext | null} The current trace context, or `null` if called outside a logging context.
 *
 * @example
 * ```ts
 * const trace = getTraceContext()
 * if (trace) {
 *   c.header('traceparent', buildTraceparent(trace))
 * }
 * ```
 */
export function getTraceContext(): TraceContext | null {
  const store = als.getStore()
  return store ? {...store.trace } : null
}

/**
 * Reset all cached standalone loggers.
 *
 * Used internally by tests to clear state between runs.
 */
export function _reset(): void {
  _cache.clear()
}
