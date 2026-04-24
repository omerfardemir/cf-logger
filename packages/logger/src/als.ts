import type { LogFields, Logger, TraceContext, ALSStore } from './types'
import { als } from './store'
import { createSimpleLogger } from './logger'
import { resolveTrace } from './trace'

/** Cached standalone loggers keyed by service name */
const _cache = new Map<string | symbol, Logger>()

/** Default key when no service name is provided */
const DEFAULT_KEY = Symbol('default')

/**
 * Get a logger.
 *
 * - Inside ALS (middleware): returns the request-scoped
 *   logger with trace context. `service` is ignored (already set by factory).
 * - Outside ALS: returns a cached standalone logger, optionally tagged with
 *   a service name.
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
 * - Inside ALS: fields appear on all subsequent log lines in the same request
 *   (via pino mixin).
 * - Outside ALS: replaces the cached logger with a child that includes these
 *   fields, so subsequent `getLogger(service)` calls include them.
 */
export function setLoggerContext<T extends LogFields = LogFields>(
  fields: Partial<T>,
): void {
  const store = als.getStore()
  if (store) {
    Object.assign(store.fields, fields)
    return
  }

  // Outside ALS — upgrade every cached logger with a child that has these bindings
  for (const [key, logger] of _cache) {
    _cache.set(key, logger.child(fields))
  }
}

/**
 * Run a function within a logging context.
 * Framework-agnostic — use this directly in any runtime (Node.js, CF Workers,
 * RPC entrypoints, scheduled handlers, queue consumers, etc.).
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
 * Returns null if called outside a logging context.
 */
export function getTraceContext(): TraceContext | null {
  const store = als.getStore()
  return store?.trace ?? null
}

/** Reset all cached state */
export function _reset(): void {
  _cache.clear()
}
