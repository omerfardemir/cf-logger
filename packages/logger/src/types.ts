/** Log levels */
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace"

/** Allowed types for log field values */
export type LogValue =
	| string
	| number
	| boolean
	| Date
	| null
	| undefined
	| { [key: string]: LogValue }
	| LogValue[]

/** Log tags to attach to logs */
export type LogFields = {
	[key: string]: LogValue
}

/** Parsed W3C Trace Context (from `traceparent` header) */
export interface TraceContext {
  traceId: string       // 32 lowercase hex chars
  spanId: string        // 16 lowercase hex chars
  parentSpanId?: string // 16 lowercase hex chars (caller's spanId)
  traceFlags: number    // 8-bit field (usually 0x00 or 0x01)
}

/** Structured span data emitted by traced() when an operation name is provided.
 *  Trace IDs (traceId, spanId, parentSpanId) are already on every log line
 *  via the ALS mixin — no need to duplicate them inside the span object. */
export interface SpanContext {
  operation: string
  startTime: number   // epoch ms
  endTime: number     // epoch ms
  duration: number    // ms
  status: 'OK' | 'ERROR'
  error?: string
}

/** Shape of the AsyncLocalStorage store for each request */
export interface ALSStore<T extends LogFields = LogFields> {
  /** Protected trace context — not writable via setLoggerContext() */
  trace: TraceContext
  /** Mutable user fields — setLoggerContext() writes here */
  fields: T
  /** The Logger wrapper for this request */
  logger: Logger<T>
}

/**
 * Options for creating a Logger instance.
 */
export interface LoggerOptions extends LogFields {
  /** Service name */
  service?: string
  /** Default log level */
  level?: LogLevel
}

/** Generic logger function */
type LogFn = (obj: unknown, msg?: string, ...args: unknown[]) => void

/**
 * Public logger interface.
 *
 * `T` provides autocomplete for `setLoggerContext()` while still
 * allowing arbitrary extra fields via the `LogFields` base.
 */
export interface Logger<T extends LogFields = LogFields> {
  /* Most detailed, fine-grained logs. severity: 10 */
  trace: LogFn
  /* Debug-level logs. severity: 20 */
  debug: LogFn
  /* Informational logs. severity: 30 */
  info: LogFn
  /* Warning logs. severity: 40 */
  warn: LogFn
  /* Error logs. severity: 50 */
  error: LogFn
  /* Critical errors causing service failure. severity: 60 */
  fatal: LogFn

  /**
   * Create a scoped child logger with extra bindings baked in.
   * Does NOT affect other loggers, only this instance and its descendants.
   */
  child(bindings: Record<string, unknown>): Logger<T>
}
