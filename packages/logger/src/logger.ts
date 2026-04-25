import pino from 'pino'
import type { LogFields, LoggerOptions, Logger, TraceContext, ALSStore } from './types'
import { als } from './store'

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
 * Node.js destination that writes JSON to `console.log`.
 */
const consoleDestination = { write(msg: string) { console.log(msg.trimEnd()) } }

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
  INFO:  'info',
  WARN:  'warn',
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
        const obj = o as Record<string, unknown>
        Object.assign(obj, getALSFields())
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
 * `service` and `level` configure the logger; all other keys become
 * persistent bindings on every log line.
 *
 * @template T - The type of user-defined log fields.
 * @param {LoggerOptions & Partial<T>} options - Logger configuration plus extra bindings.
 * @returns {Logger<T>} A logger with the extra fields attached.
 *
 * @example
 * ```ts
 * const logger = createLogger({
 *   service: 'api-gateway',
 *   level: 'info',
 *   environment: 'production',
 *   version: '1.2.0',
 * })
 * logger.info('server started')
 * ```
 */
export function createLogger<T extends LogFields = LogFields>(
  options: LoggerOptions & Partial<T>,
): Logger<T> {
  const { service, level, ...fields } = options
  const p = createPino(level ?? 'debug')
  return asLogger<T>(p.child({ service, ...fields }))
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
    const childOpts: Record<string, unknown> = { service: this.options.service }
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
