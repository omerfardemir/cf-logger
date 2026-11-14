import { functionText, isPlainObject } from './route'
import type { LogFields, TraceContext } from './types'

/**
 * A finished log line, before serialization.
 */
export type LogRecord = Record<string, unknown>

/**
 * Where finished log records go. One adapter per runtime, plus an in-memory
 * one for tests. Internal: not part of the package interface.
 */
export interface Sink {
  write(record: LogRecord): void
}

/**
 * The parts of a Logging Context that appear on every log line.
 */
export interface RecordContext {
  trace: TraceContext
  fields: LogFields
}

/** How many `cause` levels are serialized before the chain is cut off. */
const MAX_CAUSE_DEPTH = 5

/**
 * Serialize an `Error` into a plain, JSON-safe object.
 *
 * Shape: `{ type, message, stack, ...own enumerable props, cause? }`, where
 * `cause` has the same shape when it is an `Error`, nested up to
 * `MAX_CAUSE_DEPTH` levels.
 *
 * @param {Error} error - The error to serialize.
 * @param {number} [depth] - Current `cause` depth.
 * @returns {LogRecord} The serialized error.
 */
export function serializeError(error: Error, depth = 0): LogRecord {
  const out: LogRecord = {
    type: error.constructor?.name || error.name,
    message: error.message,
    stack: error.stack,
  }
  for (const [key, value] of Object.entries(error)) {
    if (key in out || key === 'cause') continue
    out[key] = value instanceof Error ? serializeError(value, depth + 1) : value
  }
  if (error.cause !== undefined) {
    if (!(error.cause instanceof Error)) {
      out.cause = error.cause
    } else if (depth < MAX_CAUSE_DEPTH) {
      out.cause = serializeError(error.cause, depth + 1)
    } else {
      out.cause = { type: 'Truncated', message: `cause chain deeper than ${MAX_CAUSE_DEPTH}` }
    }
  }
  return out
}

/** Serialize `value` when it is an `Error`; anything else is returned as is. */
const serializeIfError = (value: unknown) =>
  value instanceof Error ? serializeError(value) : value

/** `serializeIfError` on an overflow value and, one level down, on its items or values. */
function serializeOverflowItem(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(serializeIfError)
  if (isPlainObject(value)) {
    const out: LogRecord = Object.create(null) // `value` may have an own `__proto__` key
    for (const [key, v] of Object.entries(value)) out[key] = serializeIfError(v)
    return out
  }
  return serializeIfError(value)
}

/**
 * Build the final log record from a log call's entry and the current Logging Context.
 *
 * Precedence, strongest first: trace IDs (protected) → fields passed at the log
 * call → logger bindings (`createLogger` / `.child()`) → Context Fields.
 * The logger has already merged the log-call fields (from `routeArgs()`) over
 * the bindings in `entry`. `Error` values are serialized with
 * `serializeError()`: at the top level, in `errors`, and in `args` items
 * (one level down, e.g. `args: [{ err }]`). Never mutates `entry`'s values.
 *
 * @param {LogRecord} entry - The logger's entry (time, level, bindings, call fields, message, errors, args).
 * @param {RecordContext} [context] - The current Logging Context, if any.
 * @returns {LogRecord} The record to hand to a `Sink`.
 */
export function buildRecord(entry: LogRecord, context?: RecordContext): LogRecord {
  const { time, level, ...rest } = entry
  const record: LogRecord = { time, level, ...context?.fields, ...rest }

  for (const [key, value] of Object.entries(record)) record[key] = serializeIfError(value)
  if (Array.isArray(record.errors)) record.errors = record.errors.map(serializeIfError)
  if (Array.isArray(record.args)) record.args = record.args.map(serializeOverflowItem)

  if (context) {
    const { traceId, spanId, parentSpanId } = context.trace
    record.traceId = traceId
    record.spanId = spanId
    if (parentSpanId) record.parentSpanId = parentSpanId
    else delete record.parentSpanId
  }
  return record
}

/**
 * `JSON.stringify` that never throws on circular references or `BigInt`, and
 * keeps values JSON would drop: a function as `[Function: name]`, a symbol as
 * `Symbol(description)`.
 *
 * @param {LogRecord} record - The record to serialize.
 * @returns {string} One JSON line.
 */
export function stringifyRecord(record: LogRecord): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(record, (_key, value: unknown) => {
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'function') return functionText(value)
    if (typeof value === 'symbol') return value.toString()
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
    }
    return value
  })
}

/**
 * Map level labels to `console` methods so Cloudflare assigns the right severity.
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
 * Node.js adapter: every level to `console.log` (stdout), one JSON line each.
 */
export const nodeSink: Sink = {
  write(record) {
    console.log(stringifyRecord(record))
  },
}

/**
 * Cloudflare Workers adapter: `console.<method>` chosen by level, one JSON line each.
 */
export const workersSink: Sink = {
  write(record) {
    const method = LEVEL_TO_CONSOLE[record.level as string] ?? 'info'
    console[method](stringifyRecord(record))
  },
}
