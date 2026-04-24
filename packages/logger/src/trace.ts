import type { TraceContext } from './types'

/** 
 * Generate a random 16-byte trace ID as a 32-character hex string.
 * @returns A new trace ID.
 */
export function generateTraceId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Generate a new random span ID (16 hex chars).
 * @returns A new span ID string.
 */
export function generateSpanId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Trace header regular expression */
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

const ALL_ZERO_TRACE = '0'.repeat(32)
const ALL_ZERO_SPAN = '0'.repeat(16)

/**
 * Parse a W3C traceparent header string into a TraceContext.
 * Returns null if the header is invalid or contains all-zero IDs.
 * @see {@link https://www.w3.org/TR/trace-context/#traceparent-header} for details.
 * @param header The value of the traceparent header to parse.
 * @returns A TraceContext object or null if parsing fails.
 */
export function parseTraceparent(header: string): TraceContext | null {
  const match = header.match(TRACEPARENT_RE)
  if (!match) return null

  const [, traceId, spanId, flags] = match
  if (traceId === ALL_ZERO_TRACE || spanId === ALL_ZERO_SPAN) return null

  return {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16),
  }
}

/**
 * Build a W3C traceparent header string from a TraceContext.
 * @param trace The TraceContext to convert into a traceparent header.
 * @returns A traceparent header string.
 */
export function buildTraceparent(trace: TraceContext): string {
  const flags = trace.traceFlags.toString(16).padStart(2, '0')
  return `00-${trace.traceId}-${trace.spanId}-${flags}`
}

/**
 * Resolve a TraceContext from an incoming traceparent header.
 * Parses and continues the trace if valid, otherwise starts a new root trace.
 * Always generates a new spanId for the current service.
 * @param traceparent The incoming traceparent header value, if any.
 * @returns A TraceContext object representing the current trace state.
 */
export function resolveTrace(traceparent?: string | null): TraceContext {
  const parsed = traceparent ? parseTraceparent(traceparent) : null
  return {
    traceId: parsed?.traceId ?? generateTraceId(),
    spanId: generateSpanId(),
    ...(parsed?.spanId ? { parentSpanId: parsed.spanId } : {}),
    traceFlags: parsed?.traceFlags ?? 0,
  }
}
