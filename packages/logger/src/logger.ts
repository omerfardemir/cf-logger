import pino from 'pino'
import type { LogFields, LoggerOptions, Logger, TraceContext, ALSStore } from './types'
import { als } from './store'

/** Detect Cloudflare Workers runtime */
const IS_WORKERS = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers'

/**
 * Cast a pino instance to our Logger interface.
 */
function asLogger<T extends LogFields = LogFields>(p: pino.Logger): Logger<T> {
  return p as unknown as Logger<T>
}

/** Node.js destination, writes JSON to console.log */
const consoleDestination = { write(msg: string) { console.log(msg.trimEnd()) } }

/** Shared ALS field builder */
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

/** Pino options for Node.js — uses mixin for ALS fields, stream destination */
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

/** Map level labels to console methods for correct OTLP severity */
const LEVEL_TO_CONSOLE: Record<string, 'debug' | 'info' | 'warn' | 'error'> = {
  TRACE: 'debug',
  DEBUG: 'debug',
  INFO:  'info',
  WARN:  'warn',
  ERROR: 'error',
  FATAL: 'error',
}

/** Pino options for CF Workers — uses browser.write for ALS fields */
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

/** Create a pino instance with platform-appropriate configuration */
function createPino(level: string): pino.Logger {
  if (IS_WORKERS) {
    return pino(workersPinoOptions(level))
  }
  return pino(nodePinoOptions(level), consoleDestination)
}

/**
 * Create a standalone logger — no ALS, no factory.
 * Use this when you just need a logger outside of request context.
 */
export function createSimpleLogger<T extends LogFields = LogFields>(
  options: LoggerOptions,
): Logger<T> {
  const p = createPino(options.level ?? 'debug')
  return asLogger<T>(p.child({ service: options.service }))
}

/**
 * Create a standalone root logger with context fields baked in.
 * `service` and `level` configure the logger; all other keys become
 * persistent bindings on every log line.
 */
export function createLogger<T extends LogFields = LogFields>(
  options: LoggerOptions & Partial<T>,
): Logger<T> {
  const { service, level, ...fields } = options
  const p = createPino(level ?? 'debug')
  return asLogger<T>(p.child({ service, ...fields }))
}

export class LoggerFactory<T extends LogFields = LogFields> {
  private readonly basePino: pino.Logger

  constructor(private readonly options: LoggerOptions) {
    this.basePino = createPino(options.level ?? 'debug')
  }

  /**
   * Run a function within an ALS context with the given trace context.
   * Creates the per-request Pino child and Logger wrapper.
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
