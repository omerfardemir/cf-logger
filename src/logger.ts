import pino from 'pino'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { LogFields, LoggerOptions, Logger, TraceContext, ALSStore } from './types'
import { resolveTrace, buildTraceparent } from './trace'

const als = new AsyncLocalStorage<ALSStore>()

/**
 * Detect Cloudflare Workers runtime.
 *
 * @returns `true` when running inside a Cloudflare Worker.
 */
const IS_WORKERS = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers'

/**
 * Cast a pino instance to the public Logger interface.
 *
 * @template T - The type of user-defined log fields.
 * @param {pino.Logger} p - The pino logger instance to cast.
 * @returns {Logger<T>} The typed Logger wrapper.
 */
function asLogger<T extends LogFields = LogFields>(p: pino.Logger): Logger<T> {
  return p as unknown as Logger<T>
}

/**
 * Pluggable write function for the Node.js destination.
 * Tests replace this via `_captureEntries()` to receive structured objects.
 */
let _writeFn: (msg: string) => void = (msg) => {
  console.log(msg.trimEnd())
}

/**
 * Node.js destination that delegates to `_writeFn`.
 */
const consoleDestination = {
  write(msg: string) {
    _writeFn(msg)
  },
}

/**
 * Build the merged ALS fields (trace context + user fields) for the current request.
 *
 * @returns {Record<string, unknown>} The combined fields from ALS store.
 */
function getALSFields(): Record<string, unknown> {
  const store = als.getStore()
  if (!store) return {}
  const { trace, fields: context } = store
  return {
    traceId: trace.traceId,
    spanId: trace.spanId,
    ...(trace.parentSpanId ? { parentSpanId: trace.parentSpanId } : {}),
    ...context,
  }
}

/**
 * Pino options for Node.js, uses `mixin` for ALS fields and a stream destination.
 *
 * @param {string} level - The minimum log level.
 * @returns {pino.LoggerOptions} Pino configuration for Node.js.
 */
function nodePinoOptions(level: string): pino.LoggerOptions {
  return {
    level,
    messageKey: 'message',
    formatters: {
      level(label) {
        return { level: label.toUpperCase() }
      },
    },
    serializers: { err: pino.stdSerializers.err },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin: getALSFields,
  }
}

/**
 * Map pino level labels to `console` methods for correct OTLP severity.
 */
const LEVEL_TO_CONSOLE: Record<string, 'debug' | 'info' | 'warn' | 'error'> = {
  TRACE: 'debug',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'error',
}

/**
 * Pino options for Cloudflare Workers, uses `browser.write` to inject ALS fields.
 *
 * @param {string} level - The minimum log level.
 * @returns {pino.LoggerOptions} Pino configuration for Workers.
 */
function workersPinoOptions(level: string): pino.LoggerOptions {
  return {
    level,
    messageKey: 'message',
    browser: {
      asObject: true,
      formatters: {
        level(label) {
          return { level: label.toUpperCase() }
        },
      },
      write: (o: object) => {
        const raw = o as Record<string, unknown>
        const obj = { ...raw, ...getALSFields() }
        // Serialize err field if present (browser path doesn't use Pino serializers)
        if (obj.err instanceof Error) {
          const e = obj.err
          obj.err = { type: e.constructor.name, message: e.message, stack: e.stack }
        }
        const msg = JSON.stringify(obj)
        const method = LEVEL_TO_CONSOLE[obj.level as string] ?? 'info'
        console[method](msg)
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  }
}

/**
 * Create a pino instance with platform-appropriate configuration.
 *
 * Detects Cloudflare Workers vs Node.js and applies the matching options.
 *
 * @param {string} level - The minimum log level.
 * @returns {pino.Logger} A configured pino instance.
 */
function createPino(level: string): pino.Logger {
  if (IS_WORKERS) {
    return pino(workersPinoOptions(level))
  }
  return pino(nodePinoOptions(level), consoleDestination)
}

/**
 * Create a simple logger without ALS or factory overhead.
 *
 * Use this when you need a logger outside of request context
 * (e.g. startup, CLI scripts, background jobs).
 *
 * @template T - The type of user-defined log fields.
 * @param {LoggerOptions} options - Logger configuration.
 * @returns {Logger<T>} A standalone logger instance.
 *
 * @example
 * ```ts
 * const logger = createSimpleLogger({ service: 'cli', level: 'debug' })
 * logger.info('ready')
 * ```
 */
export function createSimpleLogger<T extends LogFields = LogFields>(
  options: LoggerOptions,
): Logger<T> {
  const p = createPino(options.level ?? 'debug')
  return asLogger<T>(p.child({ service: options.service }))
}

/**
 * Create a standalone root logger with context fields baked in.
 *
 * `options` configures the logger; `bindings` become persistent fields
 * on every log line.
 *
 * @template T - The type of user-defined log fields.
 * @param {LoggerOptions} options - Logger configuration.
 * @param {Partial<T>} [bindings] - Extra key-value pairs included on every log line.
 * @returns {Logger<T>} A logger with the extra fields attached.
 *
 * @example
 * ```ts
 * const logger = createLogger(
 *   { service: 'api-gateway', level: 'info', environment: 'production', version: '1.2.0' },
 * )
 * logger.info('server started')
 * ```
 */
export function createLogger<T extends LogFields = LogFields>(
  options: LoggerOptions,
  bindings?: Partial<T>,
): Logger<T> {
  const { service, level, environment, version } = options
  const p = createPino(level ?? 'debug')
  return asLogger<T>(
    p.child({
      service,
      ...(environment ? { environment } : {}),
      ...(version ? { version } : {}),
      ...bindings,
    }),
  )
}

/**
 * Logger factory that creates per-request child loggers within ALS context.
 *
 * @template T - The type of user-defined log fields.
 *
 * @example
 * ```ts
 * const factory = new LoggerFactory({ service: 'api', level: 'info' })
 * factory.runInContext(trace, () => {
 *   getLogger().info('inside ALS')
 * })
 * ```
 */
export class LoggerFactory<T extends LogFields = LogFields> {
  private readonly basePino: pino.Logger

  constructor(private readonly options: LoggerOptions) {
    this.basePino = createPino(options.level ?? 'debug')
  }

  /**
   * Run a function within an ALS context with the given trace context.
   *
   * Creates a per-request Pino child and Logger wrapper.
   *
   * @param {TraceContext} trace - The W3C trace context for this request.
   * @param {() => R} fn - The function to execute within the logging context.
   * @param {Partial<T>} [contextFields] - Optional initial log fields.
   * @param {string} [levelOverride] - Optional per-request level override.
   * @returns {R} The return value of `fn`.
   */
  runInContext<R>(
    trace: TraceContext,
    fn: () => R,
    contextFields?: Partial<T>,
    levelOverride?: string,
  ): R {
    const { service, level: _level, environment, version } = this.options
    const childOpts: Record<string, unknown> = {
      service,
      ...(environment ? { environment } : {}),
      ...(version ? { version } : {}),
    }
    if (levelOverride) {
      childOpts.level = levelOverride
    }
    const requestPino = this.basePino.child(childOpts)
    const logger = asLogger<T>(requestPino)
    const store: ALSStore = {
      trace,
      fields: (contextFields ?? {}) as T & LogFields,
      logger,
    }
    return als.run(store, fn)
  }
}

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
export function getLogger<T extends LogFields = LogFields>(service?: string): Logger<T> {
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
export function setLoggerContext<T extends LogFields = LogFields>(fields: Partial<T>): void {
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
  return store ? { ...store.trace } : null
}

/**
 * A `fetch` wrapper that injects the current `traceparent` header from ALS.
 *
 * Outside an ALS context, behaves like regular `fetch()`.
 *
 * @param {RequestInfo | URL} input - The fetch URL or Request.
 * @param {RequestInit} [init] - Optional fetch init options.
 * @returns {Promise<Response>} The fetch response.
 */
export function tracedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const trace = getTraceContext()
  if (!trace) return fetch(input, init)

  const traceparent = buildTraceparent(trace)
  const headers = new Headers(init?.headers)
  headers.set('traceparent', traceparent)
  if (trace.tracestate) {
    headers.set('tracestate', trace.tracestate)
  }
  return fetch(input, { ...init, headers })
}

/**
 * Redirect log output to an in-memory array of parsed objects.
 *
 * Returns the array; entries are pushed as logging occurs.
 * Call `_reset()` to restore normal console output.
 *
 * @internal Test helper, not part of the public API.
 */
export function _captureEntries(): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = []
  _writeFn = (msg) => {
    entries.push(JSON.parse(msg))
  }
  return entries
}

/**
 * Reset all cached standalone loggers.
 *
 * Used internally by tests to clear state between runs.
 */
export function _reset(): void {
  _cache.clear()
}
