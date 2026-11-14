import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  LogFields,
  LogLevel,
  LoggerOptions,
  Logger,
  TraceCarrier,
  TraceContext,
  ALSStore,
  SpanContext,
} from './types'
import { resolveTrace, generateSpanId, injectCarrier, toCarrier } from './trace'
import {
  buildRecord,
  nodeSink,
  stringifyRecord,
  workersSink,
  type LogRecord,
  type Sink,
} from './output'
import { _resetEnvWarnings } from './env'
import { routeArgs } from './route'

const als = new AsyncLocalStorage<ALSStore>()

/**
 * Detect Cloudflare Workers runtime.
 *
 * @returns `true` when running inside a Cloudflare Worker.
 */
const IS_WORKERS = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers'

/**
 * Where finished records go. Chosen by runtime; tests swap it via `_setSink()`.
 * Only the final write differs between runtimes: records are built identically.
 */
let sink: Sink = IS_WORKERS ? workersSink : nodeSink

/** Severity of each level, lowest first. A logger writes levels at or above its minimum. */
const LEVEL_VALUES: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

const LEVELS = Object.keys(LEVEL_VALUES) as LogLevel[]

/**
 * The numeric minimum for a level name. `'silent'` (not a `LogLevel`, but
 * accepted by pino) still writes nothing, so existing configs keep working.
 *
 * @param {string} level - A level name.
 * @returns {number} Its severity.
 * @throws {Error} `unknown level <name>` for anything else.
 */
function levelValue(level: string): number {
  if (level === 'silent') return Infinity
  if (!Object.hasOwn(LEVEL_VALUES, level)) throw new Error(`unknown level ${level}`)
  return LEVEL_VALUES[level as LogLevel]
}

const noop = () => {}

/**
 * Build one log line: route the arguments, add time, level and bindings, then
 * hand it to `buildRecord()` and the current sink.
 *
 * Order of keys: `time`, `level`, bindings, call fields, `message`, `errors`, `args`.
 *
 * @param {string} label - The upper-case level written as `level`.
 * @param {LogRecord} bindings - The logger's bindings (`createLogger` / `.child()`).
 * @param {unknown[]} input - The arguments the log method received.
 */
function write(label: string, bindings: LogRecord, input: unknown[]): void {
  const { fields, message, errors, args } = routeArgs(input)
  const entry: LogRecord = { time: new Date().toISOString(), level: label, ...bindings, ...fields }
  if (message !== undefined) entry.message = message
  if (errors) entry.errors = errors
  if (args) entry.args = args
  sink.write(buildRecord(entry, als.getStore()))
}

/**
 * Build a `Logger` that writes levels at or above `minimum`, with `bindings`
 * on every line. Immutable: `child()` returns a new logger with merged bindings.
 *
 * @template T - The type of user-defined log fields.
 * @param {number} minimum - The minimum severity written.
 * @param {LogRecord} bindings - Fixed fields on every line.
 * @returns {Logger<T>} The Logger.
 */
function makeLogger<T extends LogFields = LogFields>(
  minimum: number,
  bindings: LogRecord,
): Logger<T> {
  const logger = {
    child: (more: Record<string, unknown>) => makeLogger<T>(minimum, { ...bindings, ...more }),
  } as Logger<T>
  for (const level of LEVELS) {
    const label = level.toUpperCase()
    logger[level] =
      LEVEL_VALUES[level] < minimum ? noop : (...args: unknown[]) => write(label, bindings, args)
  }
  return logger
}

/**
 * Create a Root Logger.
 *
 * Build it once per process or isolate and share it. `service`, `environment`
 * and `version` appear on every line; `bindings` add more fixed fields. Keep
 * both to per-process data: per-unit-of-work data belongs in Context Fields.
 *
 * @template T - The type of user-defined log fields.
 * @param {LoggerOptions} options - Logger Options. `level` defaults to `'info'`.
 * @param {Partial<T>} [bindings] - Extra per-process fields included on every log line.
 * @returns {Logger<T>} The Root Logger.
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
  return makeLogger<T>(levelValue(level ?? 'info'), {
    service,
    ...(environment ? { environment } : {}),
    ...(version ? { version } : {}),
    ...bindings,
  })
}

/**
 * Cached standalone loggers keyed by service name, shared by the whole isolate.
 * Safe only because nothing mutates them after creation.
 */
const _cache = new Map<string | symbol, Logger>()

/** Whether the outside-a-Logging-Context warning has been written in this isolate. */
let warnedOutsideContext = false

const OUTSIDE_CONTEXT_WARNING = 'setLoggerContext called outside a Logging Context; fields ignored'

/**
 * Default key when no service name is provided.
 */
const DEFAULT_KEY = Symbol('default')

/**
 * Get a logger for the current context.
 *
 * - **Inside a Logging Context** (`runWithLogger`, `useLogger`, Traced Sessions):
 *   returns the context's logger. `service` is ignored.
 * - **Outside a Logging Context**: returns a cached standalone logger (built with
 *   `createLogger`) tagged with `service`, or `'unknown'` when omitted.
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
    logger = createLogger({ service: service ?? 'unknown' })
    _cache.set(key, logger)
  }
  return logger as Logger<T>
}

/**
 * Add Context Fields to the current Logging Context.
 *
 * - **Inside a Logging Context**: fields appear on all subsequent log lines in
 *   this context and in Spans opened after this call (not in the outer context).
 * - **Outside a Logging Context**: the fields are ignored, and a single `WARN` line
 *   (naming the ignored keys, not their values) is written once per isolate.
 *   An isolate serves many requests at once, so there is nowhere safe to keep them.
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

  if (!warnedOutsideContext) {
    warnedOutsideContext = true
    getLogger().warn({ ignoredFields: Object.keys(fields) }, OUTSIDE_CONTEXT_WARNING)
  }
}

/**
 * Run a function within a Logging Context.
 *
 * The single way to open a Logging Context, in any runtime (Hono, RPC sessions,
 * scheduled handlers, queue consumers, Node.js). It continues the trace from
 * `traceparent` / `tracestate` when they are valid, otherwise starts a new root
 * trace, and always gives this work its own span ID.
 *
 * `logger` is a Root Logger: create it once per process or isolate and pass the
 * same instance to every context. It must carry only per-process data; put
 * per-unit-of-work data (`requestId`, `userId`, ...) in `fields`.
 *
 * @template T - The type of user-defined log fields.
 * @template R - The return type of `fn`.
 * @param {object} options - Context options.
 * @param {Logger<T>} options.logger - The Root Logger this context logs through.
 * @param {string | null} [options.traceparent] - Incoming W3C `traceparent` value.
 * @param {string | null} [options.tracestate] - Incoming W3C `tracestate` value.
 * @param {Partial<T>} [options.fields] - Initial Context Fields. Copied, never mutated.
 * @param {() => R} fn - The function to execute inside the Logging Context.
 * @returns {R} The return value of `fn`.
 *
 * @example
 * ```ts
 * const logger = createLogger({ service: 'worker' })
 * runWithLogger({ logger, traceparent: req.headers.get('traceparent') }, () => {
 *   getLogger().info('inside the logging context')
 * })
 * ```
 */
export function runWithLogger<T extends LogFields = LogFields, R = unknown>(
  options: {
    logger: Logger<T>
    traceparent?: string | null
    tracestate?: string | null
    fields?: Partial<T> | LogFields
  },
  fn: () => R,
): R {
  const store: ALSStore = {
    trace: resolveTrace(options.traceparent, options.tracestate),
    fields: { ...options.fields } as LogFields,
    logger: options.logger.child({}),
  }
  return als.run(store, fn)
}

/**
 * Run `fn` as a named Span nested inside the current Logging Context.
 *
 * The Span gets a new span ID whose parent is the current span ID, on the same
 * trace. Context Fields are copied in: fields set inside the Span stay inside it.
 * When the trace is sampled, a `span.end` line with timing and status is logged
 * once `fn` settles (sync or async). Errors are logged and rethrown.
 *
 * Outside a Logging Context, `fn` simply runs: no Span, no error.
 *
 * @template R - The return type of `fn`.
 * @param {string} operation - Operation name (e.g. `'db.query'`).
 * @param {() => R} fn - The work to time.
 * @returns {R} The return value of `fn`.
 *
 * @example
 * ```ts
 * const user = await withSpan('db.getUser', () => db.getUser(id))
 * ```
 */
export function withSpan<R>(operation: string, fn: () => R): R {
  const outer = als.getStore()
  if (!outer) return fn()

  const store: ALSStore = {
    trace: { ...outer.trace, spanId: generateSpanId(), parentSpanId: outer.trace.spanId },
    fields: { ...outer.fields },
    logger: outer.logger,
  }
  return als.run(store, () => recordSpan(operation, fn))
}

/**
 * Time `fn` as a Span covering the *current* Logging Context (no new span ID).
 *
 * Used by `withSpan()` after it opens a nested context, and by Traced Sessions,
 * whose whole Logging Context is the Span. Logs only when the trace is sampled.
 *
 * @internal Not exported from the package entry points.
 */
export function recordSpan<R>(operation: string, fn: () => R): R {
  const store = als.getStore()
  if (!store || (store.trace.traceFlags & 0x01) !== 0x01) return fn()

  const { logger } = store
  const startTime = Date.now()

  const emit = (status: SpanContext['status'], error?: unknown) => {
    const endTime = Date.now()
    const span: SpanContext = {
      operation,
      startTime,
      endTime,
      duration: endTime - startTime,
      status,
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    }
    if (status === 'ERROR') {
      logger.error({ span, err: error }, 'span.end %s', operation)
    } else {
      logger.info({ span }, 'span.end %s', operation)
    }
  }

  let result: R
  try {
    result = fn()
  } catch (err) {
    emit('ERROR', err)
    throw err
  }
  if (result instanceof Promise) {
    return result.then(
      (value) => {
        emit('OK')
        return value
      },
      (err) => {
        emit('ERROR', err)
        throw err
      },
    ) as R
  }
  emit('OK')
  return result
}

/**
 * Read the current Trace Context (IDs and flags).
 *
 * @returns {TraceContext | null} A copy of the current Trace Context, or `null` outside a Logging Context.
 *
 * @example
 * ```ts
 * const traceId = getTraceContext()?.traceId
 * ```
 */
export function getTraceContext(): TraceContext | null {
  const store = als.getStore()
  return store ? { ...store.trace } : null
}

/**
 * Get the current Trace Carrier, to pass the trace on over any transport.
 *
 * On the receiving side, continue it with `runWithLogger({ logger, ...carrier })`.
 *
 * @returns {TraceCarrier} `{ traceparent, tracestate? }`, or `{}` outside a Logging Context.
 *
 * @example
 * ```ts
 * await env.QUEUE.send({ ...payload, trace: getTraceCarrier() })
 * ```
 */
export function getTraceCarrier(): TraceCarrier {
  const store = als.getStore()
  return store ? toCarrier(store.trace) : {}
}

/**
 * A `fetch` wrapper that sends the current Trace Carrier as
 * `traceparent` / `tracestate` headers.
 *
 * Outside a Logging Context, behaves like regular `fetch()`.
 *
 * @param {RequestInfo | URL} input - The fetch URL or Request.
 * @param {RequestInit} [init] - Optional fetch init options. Never mutated.
 * @returns {Promise<Response>} The fetch response.
 */
export function tracedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const carrier = getTraceCarrier()
  if (!carrier.traceparent) return fetch(input, init)

  const headers = new Headers(init?.headers)
  injectCarrier(carrier, (name, value) => headers.set(name, value))
  return fetch(input, { ...init, headers })
}

/**
 * Replace the sink that receives finished records. Returns the previous sink.
 *
 * @internal Test seam, not exported from the package entry points.
 */
export function _setSink(next: Sink): Sink {
  const previous = sink
  sink = next
  return previous
}

/**
 * Redirect log output to an in-memory array of records, exactly as a runtime
 * sink would serialize them (round-tripped through JSON).
 *
 * @internal Test helper, not part of the public API.
 */
export function _captureEntries(): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = []
  sink = { write: (record) => entries.push(JSON.parse(stringifyRecord(record))) }
  return entries
}

/**
 * Redirect log output to an in-memory array of serialized JSON lines.
 *
 * @internal Test helper, not part of the public API.
 */
export function _captureLines(): string[] {
  const lines: string[] = []
  sink = { write: (record) => lines.push(stringifyRecord(record)) }
  return lines
}

/**
 * Reset isolate-level state (standalone logger cache, one-time warnings). Does not change the sink.
 *
 * Used internally by tests to clear state between runs.
 */
export function _reset(): void {
  _cache.clear()
  warnedOutsideContext = false
  _resetEnvWarnings()
}
