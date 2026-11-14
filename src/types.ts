/**
 * Supported log severity levels.
 *
 * @example
 * ```ts
 * const level: LogLevel = 'info'
 * ```
 */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

/**
 * Allowed types for log field values.
 *
 * Supports primitives, `Date`, nested objects, and arrays.
 */
export type LogValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | { [key: string]: LogValue }
  | LogValue[]

/**
 * Key-value map of structured log fields.
 *
 * Passed to `setLoggerContext()` or included as logger bindings.
 */
export type LogFields = {
  [key: string]: LogValue
}

/**
 * Parsed W3C Trace Context derived from a `traceparent` header.
 *
 * @see {@link https://www.w3.org/TR/trace-context/#traceparent-header} for the specification.
 *
 * @example
 * ```ts
 * const trace: TraceContext = {
 *   traceId: 'abcdef1234567890abcdef1234567890',
 *   spanId: 'abcdef1234567890',
 *   traceFlags: 0x01,
 * }
 * ```
 */
export interface TraceContext {
  /** 32 lowercase hex chars identifying the whole trace. */
  traceId: string
  /** 16 lowercase hex chars identifying the current span. */
  spanId: string
  /** 16 lowercase hex chars identifying the caller's span. */
  parentSpanId?: string
  /** 8-bit field (usually `0x00` or `0x01`). */
  traceFlags: number
  /** W3C tracestate header value for vendor-specific key-value pairs. */
  tracestate?: string
}

/**
 * The wire form of a Trace Context, as it travels in HTTP headers, an RPC
 * `session()` call, or a queue message.
 *
 * Get one with `getTraceCarrier()`; continue it with `runWithLogger({ logger, ...carrier })`.
 */
export interface TraceCarrier {
  /** W3C `traceparent` value. Absent outside a Logging Context. */
  traceparent?: string
  /** W3C `tracestate` value, when the trace has one. */
  tracestate?: string
}

/**
 * Structured span data logged on `span.end` by `withSpan()` and `TracedSession.traced()`.
 *
 * Trace IDs (`traceId`, `spanId`, `parentSpanId`) are already on every log line
 * from the Logging Context, so they are not duplicated inside the span object.
 */
export interface SpanContext {
  /** Human-readable operation name (e.g. `'bind.add'`). */
  operation: string
  /** Epoch milliseconds when the operation started. */
  startTime: number
  /** Epoch milliseconds when the operation ended. */
  endTime: number
  /** Duration in milliseconds (`endTime - startTime`). */
  duration: number
  /** `'OK'` on success, `'ERROR'` on failure. */
  status: 'OK' | 'ERROR'
  /** Error message when `status` is `'ERROR'`. */
  error?: string
}

/**
 * Shape of the `AsyncLocalStorage` store behind each Logging Context.
 *
 * Created internally by `runWithLogger()` and `withSpan()`; never exposed.
 *
 * @template T - The type of user-defined log fields.
 */
export interface ALSStore<T extends LogFields = LogFields> {
  /** Protected trace context not writable via `setLoggerContext()`. */
  trace: TraceContext
  /** Mutable user fields `setLoggerContext()` writes here. */
  fields: T
  /** The Logger wrapper bound to this request. */
  logger: Logger<T>
}

/**
 * Options for creating a Logger instance.
 *
 * @example
 * ```ts
 * const logger = createLogger({
 *   service: 'api-gateway',
 *   level: 'debug',
 *   environment: 'production',
 * })
 * ```
 */
export interface LoggerOptions {
  /** Service name included on every log line. */
  service: string
  /** Minimum log level. Defaults to `'info'`. `'silent'` writes nothing. */
  level?: LogLevel | 'silent'
  /** Deployment environment (e.g. `'production'`, `'development'`). */
  environment?: string
  /** Application version (e.g. `'1.2.0'`). */
  version?: string
}

/**
 * A single log-level method.
 *
 * @param {unknown} obj - Structured data to include in the log entry.
 * @param {string} [msg] - Optional message string (supports `printf`-style placeholders).
 * @param {...unknown} args - Substitution values for `msg` placeholders.
 */
type LogFn = (obj: unknown, msg?: string, ...args: unknown[]) => void

/**
 * Public logger interface.
 *
 * `T` provides autocomplete for `setLoggerContext()` while still
 * allowing arbitrary extra fields via the `LogFields` base.
 *
 * @template T - The type of user-defined log fields.
 *
 * @example
 * ```ts
 * const logger: Logger = getLogger()
 * logger.info({ userId: 42 }, 'user signed in')
 * ```
 */
export interface Logger<T extends LogFields = LogFields> {
  /** Most detailed, fine-grained logs. severity: 10 */
  trace: LogFn
  /** Debug-level logs. severity: 20 */
  debug: LogFn
  /** Informational logs. severity: 30 */
  info: LogFn
  /** Warning logs. severity: 40 */
  warn: LogFn
  /** Error logs. severity: 50 */
  error: LogFn
  /** Critical errors causing service failure. severity: 60 */
  fatal: LogFn

  /**
   * Create a scoped child logger with extra bindings baked in.
   *
   * Does NOT affect other loggers only this instance and its descendants.
   *
   * @param {Record<string, unknown>} bindings - Key-value pairs to include on every log line.
   * @returns {Logger<T>} A new child logger.
   */
  child(bindings: Record<string, unknown>): Logger<T>
}
