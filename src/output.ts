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

/**
 * Whether `value` is a plain object literal (`{}`, `Object.create(null)`),
 * as opposed to an array, a class instance, a `Date`, a `Map`...
 *
 * @param {unknown} value - Any value.
 * @returns {boolean} `true` when its prototype is `Object.prototype` or `null`.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * A function's `name`, or `''` when it has none or it is not a string.
 *
 * @param {{ name: unknown }} fn - The function.
 * @returns {string} Its name.
 * @throws When `name` cannot be read (a getter that throws, a revoked `Proxy`).
 */
export function functionName(fn: { name: unknown }): string {
  const name = fn.name
  return typeof name === 'string' ? name : ''
}

/**
 * How a function appears in a log line: `[Function: name]`, or
 * `[Function: anonymous]` when it has no name. Never throws: a function
 * whose `name` cannot be read is `unserializable()`.
 *
 * @param {{ name: unknown }} fn - The function.
 * @returns {string} Its text.
 */
export function functionText(fn: { name: unknown }): string {
  let name: string
  try {
    name = functionName(fn)
  } catch (thrown) {
    return unserializable(thrown)
  }
  return `[Function: ${name || 'anonymous'}]`
}

/**
 * Describe a thrown value, never throwing itself.
 *
 * @param {unknown} thrown - What a getter, a `toJSON` or the write path threw.
 * @returns {string} e.g. `TypeError: toJSON failed`, or `String(thrown)` for a non-Error.
 */
export function describeFailure(thrown: unknown): string {
  try {
    if (thrown instanceof Error) return `${thrown.name}: ${thrown.message}`
    return String(thrown)
  } catch {
    return 'unknown error'
  }
}

/**
 * What a value that cannot be read or serialized (a getter or a `toJSON`
 * that throws) is written as, in place of that one value.
 *
 * @param {unknown} thrown - What reading or serializing the value threw.
 * @returns {string} `[Unserializable: <reason>]`.
 */
export function unserializable(thrown: unknown): string {
  return `[Unserializable: ${describeFailure(thrown)}]`
}

/**
 * `object`'s own enumerable string-keyed entries, like `Object.entries()`,
 * except that a value whose getter throws is `unserializable()` instead.
 *
 * @param {object} object - Any object.
 * @returns {[string, unknown][]} Its entries, in key order.
 * @throws Only when its keys cannot be listed (a `Proxy` whose `ownKeys` trap throws).
 */
export function readEntries(object: object): [string, unknown][] {
  const entries: [string, unknown][] = []
  for (const key of Object.keys(object)) {
    let value: unknown
    try {
      value = (object as Record<string, unknown>)[key]
    } catch (thrown) {
      value = unserializable(thrown)
    }
    entries.push([key, value])
  }
  return entries
}

/**
 * A plain copy of logger bindings, never throwing: a binding whose getter
 * throws is `unserializable()`. Taken when the logger is built, so a log
 * call never runs the getters.
 *
 * @param {unknown} source - The bindings passed to `createLogger` or `.child()`.
 * @returns {LogRecord} The copy; `{}` for `undefined`, `null` or a primitive.
 */
export function copyBindings(source: unknown): LogRecord {
  if (typeof source !== 'object' || source === null) return {}
  try {
    return Object.fromEntries(readEntries(source))
  } catch (thrown) {
    // The keys cannot be listed. `buildRecord()` moves `args` to the line's `args`.
    return { args: unserializable(thrown) }
  }
}

/**
 * Whether `value` is an `Error`, never throwing: `instanceof` throws on a
 * revoked `Proxy`, or one whose `getPrototypeOf` trap throws.
 *
 * @param {unknown} value - Any value.
 * @returns {boolean} `true` for an `Error`; `false` for anything else, or when it can't be told.
 */
export function isError(value: unknown): value is Error {
  try {
    return value instanceof Error
  } catch {
    return false // the serializer writes it as `unserializable()`
  }
}

/**
 * An `Error`'s `message` as text, never throwing: a non-string `message` is
 * `String(message)`, and one that cannot be read is `unserializable()`.
 *
 * @param {Error} error - Any `Error`.
 * @returns {string} Its message.
 */
export function errorMessage(error: Error): string {
  try {
    const message: unknown = error.message
    return typeof message === 'string' ? message : String(message)
  } catch (thrown) {
    return unserializable(thrown)
  }
}

/** How many levels of `cause` (and of `Error`-valued properties) are serialized before the chain is cut off. */
const MAX_CAUSE_DEPTH = 5

/**
 * Read one property of an `Error`, never throwing.
 *
 * @param {() => unknown} get - Reads the property.
 * @returns {unknown} Its value, or `unserializable()` when the read throws.
 */
function read(get: () => unknown): unknown {
  try {
    return get()
  } catch (thrown) {
    return unserializable(thrown)
  }
}

/**
 * Whether `error` is an `AggregateError`, never throwing.
 *
 * @param {Error} error - An `Error`.
 * @returns {boolean} `true` for an `AggregateError`.
 */
function isAggregateError(error: Error): error is AggregateError {
  try {
    return typeof AggregateError === 'function' && error instanceof AggregateError
  } catch {
    return false
  }
}

/** One serialized `Error`, and how far up its `"[Circular]"`s point. */
interface SerializedError {
  /** The serialized copy. */
  out: LogRecord
  /** The shallowest depth a `"[Circular]"` inside it points to; `Infinity` when none does. */
  reach: number
  /**
   * When `reach` is above its own depth: the Errors it was nested in from
   * depth `reach` down, which its `"[Circular]"`s outside itself point to.
   */
  above?: Error[]
  /** What serializing it again writes at its own level (see `copyCost()`), once it has been worked out. */
  cost?: Cost
}

/**
 * The Errors one line has already serialized, by nesting depth. A repeated
 * reference to an `Error` at the same depth is the same serialized object,
 * so `stringifyRecord()` sees a repeat and its re-write budget applies. By
 * depth, so a copy built deep (its chain cut off sooner) is never reused
 * higher up, and `MAX_CAUSE_DEPTH` still bounds the nesting. A copy cut off
 * at an `Error` outside it is reused where the same Errors sit at those
 * depths above it. Anywhere else it may not be right, so it is serialized
 * again instead, while that fits `reserializeBudget`: `"[Circular]"` then
 * marks only a real loop. Past it, the copy is reused as is.
 */
export interface SerializedErrors {
  /** Each depth's copies. */
  byDepth: Map<Error, SerializedError>[]
  /** The Errors the one being serialized is nested in, by depth. */
  path: Error[]
  /**
   * What serializing Errors again may still write. A new copy is a new
   * object, which `stringifyRecord()` never sees as a repeat, so each one is
   * charged its values and characters, as a repeat would be: a graph of
   * Errors with cycles stays linear, and its line stays near the re-write
   * budget, however wide each `Error` is.
   */
  reserializeBudget: Budget
}

/**
 * An empty cache, for one line.
 *
 * @returns {SerializedErrors} The cache.
 */
export const newSerializedErrors = (): SerializedErrors => ({
  byDepth: [],
  path: [],
  reserializeBudget: newBudget(),
})

/** What writing something again costs, in values and in characters of keys and strings. */
interface Cost {
  /** Values. */
  values: number
  /** Characters. */
  chars: number
}

/**
 * What a copy of an `Error` writes at its own level: a value per key and
 * per `errors` item, and the characters of its keys and short texts (see
 * `textLength()`). A long one (see `LONG_STRING`) is left out: the line's
 * re-write budget already bounds it, as the same text. Nested Errors are
 * charged when they are serialized again themselves.
 *
 * @param {LogRecord} out - The copy.
 * @returns {Cost} Its cost.
 */
function copyCost(out: LogRecord): Cost {
  const cost: Cost = { values: 0, chars: 0 }
  const add = (value: unknown) => {
    cost.values++
    const length = textLength(value)
    if (length < LONG_STRING) cost.chars += length
  }
  for (const [key, value] of Object.entries(out)) {
    add(value)
    cost.chars += key.length
    if (key === 'errors' && Array.isArray(value)) for (const item of value) add(item)
  }
  return cost
}

/**
 * Spend `cost` from `budget`, when it fits.
 *
 * @param {Budget} budget - The budget. Mutated when `cost` fits.
 * @param {Cost} cost - What to spend.
 * @returns {boolean} Whether it fit, and was spent.
 */
function spend(budget: Budget, cost: Cost): boolean {
  if (cost.values > budget.values || cost.chars > budget.chars) return false
  budget.values -= cost.values
  budget.chars -= cost.chars
  return true
}

/**
 * Serialize an `Error` into a plain, JSON-safe object. Never throws.
 *
 * Shape: `{ type, message, stack, ...own enumerable props, errors?, cause? }`.
 * `cause`, every own property that is an `Error`, and an `AggregateError`'s
 * `errors` have the same shape, nested up to `MAX_CAUSE_DEPTH` levels. An
 * `Error` nested inside itself (`e.self = e`, a `cause` loop) is
 * `"[Circular]"` there. A property whose getter throws is `unserializable()`.
 * Each `Error` is serialized once per `cache` and depth (see
 * `SerializedErrors`), so a graph of Errors costs its size, not the number
 * of paths through it.
 *
 * @param {Error} error - The error to serialize.
 * @param {number} [depth] - Current nesting depth.
 * @param {Map<Error, number>} [ancestors] - The errors `error` is nested in, and their depths.
 * @param {SerializedErrors} [cache] - The Errors this line has already serialized.
 * @returns {LogRecord} The serialized error.
 */
export function serializeError(
  error: Error,
  depth = 0,
  ancestors: Map<Error, number> = new Map(),
  cache: SerializedErrors = newSerializedErrors(),
): LogRecord {
  return serializeErrorAt(error, depth, ancestors, cache).out
}

/**
 * `serializeError()`, with how far up the copy's `"[Circular]"`s point.
 *
 * @param {Error} error - The error to serialize.
 * @param {number} depth - Current nesting depth.
 * @param {Map<Error, number>} ancestors - The errors `error` is nested in, and their depths.
 * @param {SerializedErrors} cache - The Errors this line has already serialized.
 * @returns {SerializedError} The serialized error.
 */
function serializeErrorAt(
  error: Error,
  depth: number,
  ancestors: Map<Error, number>,
  cache: SerializedErrors,
): SerializedError {
  const { path } = cache
  const known = cache.byDepth[depth]?.get(error)
  if (known) {
    // Cut off only inside itself, or at the same Errors above it: right here too.
    const { reach, above } = known
    if (reach >= depth || above?.every((outer, i) => path[reach + i] === outer)) return known
    known.cost ??= copyCost(known.out)
    if (!spend(cache.reserializeBudget, known.cost)) return known
  }
  const entry: SerializedError = { out: {}, reach: Infinity }
  ;(cache.byDepth[depth] ??= new Map()).set(error, entry)
  const { out } = entry

  const nested = (value: unknown): unknown => {
    if (!isError(value)) return value
    const at = ancestors.get(value)
    if (at !== undefined) {
      // Before the cache: a cycle is never a repeat.
      entry.reach = Math.min(entry.reach, at)
      return '[Circular]'
    }
    if (depth >= MAX_CAUSE_DEPTH)
      return { type: 'Truncated', message: `cause chain deeper than ${MAX_CAUSE_DEPTH}` }
    const inner = serializeErrorAt(value, depth + 1, ancestors, cache)
    entry.reach = Math.min(entry.reach, inner.reach)
    return inner.out
  }
  ancestors.set(error, depth)
  path[depth] = error
  try {
    out.type = read(() => error.constructor?.name || error.name)
    out.message = read(() => error.message)
    out.stack = read(() => error.stack)
    let entries: [string, unknown][]
    try {
      entries = readEntries(error)
    } catch (thrown) {
      entries = [['props', unserializable(thrown)]]
    }
    for (const [key, value] of entries) {
      if (key in out || key === 'cause') continue
      out[key] = nested(value)
    }
    // Not enumerable, so not among the entries.
    if (!('errors' in out) && isAggregateError(error))
      out.errors = read(() => {
        const list: unknown = error.errors
        return Array.isArray(list) ? Array.from(list, nested) : list
      })
    const cause = read(() => error.cause)
    if (cause !== undefined) out.cause = nested(cause)
    if (entry.reach < depth) entry.above = path.slice(entry.reach, depth)
    return entry
  } finally {
    ancestors.delete(error)
  }
}

/**
 * Serialize `value` when it is an `Error`. Never throws.
 *
 * @param {unknown} value - Any value.
 * @param {SerializedErrors} cache - The Errors this line has already serialized.
 * @returns {unknown} `serializeError(value)` for an `Error`; anything else as is.
 */
const serializeIfError = (value: unknown, cache: SerializedErrors): unknown =>
  isError(value) ? serializeError(value, 0, new Map(), cache) : value

/**
 * `serializeIfError` on an overflow value and, one level down, on its items
 * or values. Never throws: an item that can't be inspected (a `Proxy` whose
 * traps throw) is `unserializable()`, and so is an item whose getter throws.
 *
 * @param {unknown} value - One item of `args`.
 * @param {SerializedErrors} cache - The Errors this line has already serialized.
 * @returns {unknown} The item, with Errors serialized at its top level and one level down.
 */
function serializeOverflowItem(value: unknown, cache: SerializedErrors): unknown {
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = []
      const length = value.length
      for (let i = 0; i < length; i++)
        out.push(
          serializeIfError(
            read(() => value[i]),
            cache,
          ),
        )
      return out
    }
    if (isPlainObject(value)) {
      const out: LogRecord = Object.create(null) // `value` may have an own `__proto__` key
      for (const [key, v] of readEntries(value)) out[key] = serializeIfError(v, cache)
      return out
    }
  } catch (thrown) {
    return unserializable(thrown)
  }
  return serializeIfError(value, cache)
}

/**
 * The Record Keys: loggercf writes them for every call, so logger bindings
 * and Context Fields cannot set them. `workersSink` picks the console method
 * from `level`, so a binding for it would change the line's severity.
 */
export const RECORD_KEYS = ['time', 'level', 'message', 'errors', 'args'] as const

/** The Trace Context's keys, which `applyTrace()` writes inside a Logging Context. */
export const TRACE_KEYS = ['traceId', 'spanId', 'parentSpanId'] as const

/** The Logger Options keys a Root Logger writes on every line. */
export const OPTION_KEYS = ['service', 'environment', 'version'] as const

/**
 * `source` without the Record Keys (`RECORD_KEYS`). Their defined values are pushed onto
 * `moved` as one object, so they land in `args` instead of being dropped.
 *
 * @param {LogRecord | undefined} source - Logger bindings or Context Fields. Never mutated.
 * @param {LogRecord[]} moved - Collects the values taken out, one object per source.
 * @returns {LogRecord | undefined} `source` itself when it has none of the keys, else a copy without them.
 */
export function takeRecordKeys(
  source: LogRecord | undefined,
  moved: LogRecord[],
): LogRecord | undefined {
  if (!source || !RECORD_KEYS.some((key) => Object.hasOwn(source, key))) return source
  const rest: LogRecord = { ...source }
  const taken: LogRecord = {}
  for (const key of RECORD_KEYS) {
    if (rest[key] !== undefined) taken[key] = rest[key]
    delete rest[key]
  }
  if (Object.keys(taken).length > 0) moved.push(taken)
  return rest
}

/**
 * Set the trace IDs on `record`, replacing any value already there. A
 * `parentSpanId` is removed on a root trace. Keys already in `record` keep
 * their position.
 *
 * @param {LogRecord} record - The line to stamp. Mutated.
 * @param {TraceContext} trace - The current Trace Context.
 */
export function applyTrace(record: LogRecord, trace: TraceContext): void {
  for (const key of TRACE_KEYS) {
    if (trace[key]) record[key] = trace[key]
    else delete record[key]
  }
}

/**
 * Where `routeArgs()` put the arguments of one log call. Nothing is
 * serialized yet: `buildRecord()` does that, so routed values go through the
 * same serializers as structured fields.
 */
export interface RoutedArgs {
  /** Top-level fields: `err` and the object arguments' keys, in call order. Routing has already moved their `MOVED_KEYS` to `args`. */
  fields: LogRecord
  /** The formatted message, when the call gave one. */
  message?: string
  /** Errors after the first, in call order. */
  errors?: Error[]
  /** Values with no better place (the Overflow), in call order. */
  args?: unknown[]
}

/**
 * One log call, ready to build: what the logger adds (`time`, `level`,
 * logger bindings) and where `routeArgs()` put the arguments.
 */
export interface RecordEntry extends RoutedArgs {
  /** ISO 8601 time of the call. */
  time: string
  /** The upper-case level label. */
  level: string
  /** The logger bindings (`createLogger` / `.child()`). */
  bindings: LogRecord
  /** The line's re-write budget, which the message's placeholders may have spent from. */
  budget?: Budget
}

/**
 * Build the final log record from a log call's entry and the current Logging Context.
 *
 * The Record Keys (`RECORD_KEYS`) and the trace IDs are always written by
 * loggercf. For the other keys, strongest first: fields passed at the log
 * call → logger bindings (`createLogger` / `.child()`) → Context Fields.
 * A binding or Context Field for one of the Record Keys (trace IDs
 * aside) moves to `args`, after the call's own `args`, bindings first, so it
 * is not dropped. `Error` values are serialized with `serializeError()`: at
 * the top level, in `errors`, and in `args` items (one level down, e.g.
 * `args: [{ err }]`), each `Error` once per line. Never mutates `entry`'s
 * values. `stringifyRecord()` of the result spends from `entry.budget`.
 *
 * @param {RecordEntry} entry - The call: time, level, bindings and the routed arguments.
 * @param {RecordContext} [context] - The current Logging Context, if any.
 * @returns {LogRecord} The record to hand to a `Sink`.
 */
export function buildRecord(entry: RecordEntry, context?: RecordContext): LogRecord {
  const moved: LogRecord[] = []
  const bindings = takeRecordKeys(entry.bindings, moved)
  const contextFields = takeRecordKeys(context?.fields, moved)
  const { time, level, message } = entry
  // `message` before the fields, so it is written in full and a field repeating it is the repeat.
  const record: LogRecord =
    message === undefined
      ? { time, level, ...contextFields, ...bindings, ...entry.fields }
      : { time, level, message, ...contextFields, ...bindings, ...entry.fields }
  if (entry.errors) record.errors = entry.errors
  const args = [...(entry.args ?? []), ...moved]
  if (args.length > 0) record.args = args

  const cache = newSerializedErrors()
  for (const [key, value] of Object.entries(record)) record[key] = serializeIfError(value, cache)
  if (Array.isArray(record.errors))
    record.errors = record.errors.map((error) => serializeIfError(error, cache))
  if (Array.isArray(record.args))
    record.args = record.args.map((item) => serializeOverflowItem(item, cache))

  if (context) applyTrace(record, context.trace)
  const { budget } = entry
  if (budget && (budget.values < MAX_REWRITTEN_VALUES || budget.chars < MAX_REWRITTEN_CHARS))
    lineBudgets.set(record, budget) // only when the message spent some of it
  return record
}

/**
 * How many values one line may write again inside repeats (objects it has
 * already written, a shared reference), before a repeat is `"[Repeated]"`.
 * Every value inside a repeat counts, at any depth, so the work and the line
 * stay bounded however wide or deeply shared the structure is.
 */
const MAX_REWRITTEN_VALUES = 10_000

/**
 * How many characters of keys and strings one line may write again inside
 * repeats, before a repeat is `"[Repeated]"`: a shared object holding a long
 * string costs its length, not one value, and so does the text of a
 * `BigInt`, a function or a symbol. A long string or text (see
 * `LONG_STRING`) written again outside a repeat costs its length too, in the
 * message and in the record.
 */
const MAX_REWRITTEN_CHARS = 64 * 1024

/**
 * From this length on, a string the line has already written is a repeat,
 * like a shared object: written again while it fits `MAX_REWRITTEN_CHARS`,
 * then `"[Repeated]"`. So is the text of a `BigInt`, a function or a symbol
 * (see `nonJSONText()`). Shorter ones repeat freely.
 */
const LONG_STRING = 1024

/**
 * What one line may still write again inside repeats. One per line, shared
 * by its message (its `%j` / `%o` / `%O` placeholders, and the long strings
 * it holds again) and the walk of its record.
 */
export interface Budget {
  /** Values left (see `MAX_REWRITTEN_VALUES`). */
  values: number
  /** Characters left (see `MAX_REWRITTEN_CHARS`). */
  chars: number
}

/**
 * A full budget, for one new line.
 *
 * @returns {Budget} The budget.
 */
export const newBudget = (): Budget => ({
  values: MAX_REWRITTEN_VALUES,
  chars: MAX_REWRITTEN_CHARS,
})

/** The budget each record from `buildRecord()` is written with, when its entry had one. */
const lineBudgets = new WeakMap<LogRecord, Budget>()

/**
 * What one message already holds, its `%j` / `%o` / `%O` placeholders and
 * its long words and `%s` texts, and the repeats its placeholders gave up on.
 */
interface Written {
  /** The objects its placeholders wrote, outside repeats. */
  objects: WeakSet<object>
  /** The long strings it holds, outside repeats. */
  strings: Set<string>
  /**
   * Repeats a placeholder gave up on because they didn't fit the budget,
   * with the budget that was left. Its budget is restored, so a later
   * placeholder with the same repeat and no more budget gives up at once,
   * instead of re-writing it again.
   */
  tooLarge: WeakMap<object, Budget>
}

/** Thrown by a strict walk: the value cannot be written as JSON as it is. */
const NOT_JSON = new Error('not JSON')

/** Thrown inside a repeat when the line's re-write budget runs out. */
const BUDGET_SPENT = new Error('re-write budget spent')

/** The state of one `toJSONValue()` walk. */
interface Walk {
  /** The long texts (see `walkText()`) this walk worked out, so a repeat is not worked out again. */
  texts: Map<unknown, string>
  /** `%j`: give up (throw `NOT_JSON`) wherever a lenient walk would write a stand-in. */
  strict: boolean
  /** The objects on the path to the current value: a real cycle. */
  ancestors: Set<object>
  /** Every object this walk wrote so far, outside repeats: a repeat. */
  seen: Set<object>
  /** Every long string this walk wrote so far, outside repeats. */
  strings: Set<string>
  /** What earlier walks of the same line wrote, which are repeats too. */
  earlier?: Written
  /** How many repeats the current value is nested in. */
  inRepeat: number
  /** The line's re-write budget. */
  budget: Budget
}

/**
 * Charge the walk's re-write budget for one value inside a repeat.
 *
 * @param {Walk} walk - The current walk, inside a repeat.
 * @param {string} key - The value's key in its parent.
 * @param {string | undefined} text - The value's text: a string, or its `nonJSONText()`.
 * @throws `BUDGET_SPENT` when the budget runs out.
 */
function charge(walk: Walk, key: string, text: string | undefined): void {
  walk.budget.values--
  walk.budget.chars -= key.length + textLength(text)
  if (walk.budget.values < 0 || walk.budget.chars < 0) throw BUDGET_SPENT
}

/**
 * Write a repeat, an object the line has already written, again, within the
 * re-write budget. A repeat is written in full or, once the budget is spent,
 * is `"[Repeated]"` as a whole: never cut part way.
 *
 * @param {object} object - The repeated object.
 * @param {() => unknown} write - Writes it (or its `toJSON` result).
 * @param {Walk} walk - The current walk.
 * @returns {unknown} Its JSON-ready value, or `"[Repeated]"`.
 * @throws `NOT_JSON` in a strict walk, instead of `"[Repeated]"`.
 */
function repeatToJSONValue(object: object, write: () => unknown, walk: Walk): unknown {
  if (walk.inRepeat > 0) return write() // the outer repeat is charged
  const { budget } = walk
  if (budget.values <= 0 || budget.chars <= 0) return standIn(walk, '[Repeated]')
  const failed = walk.earlier?.tooLarge.get(object)
  if (failed && budget.values <= failed.values && budget.chars <= failed.chars)
    return standIn(walk, '[Repeated]')
  const left = { ...budget }
  walk.inRepeat++
  try {
    return write()
  } catch (thrown) {
    if (thrown !== BUDGET_SPENT) throw thrown
    walk.earlier?.tooLarge.set(object, left)
    budget.values = 0
    return standIn(walk, '[Repeated]')
  } finally {
    walk.inRepeat--
  }
}

/**
 * Whether the line has already written `object`, outside repeats.
 *
 * @param {object} object - Any object.
 * @param {Walk} walk - The current walk.
 * @returns {boolean} `true` for a repeat.
 */
const isRepeat = (object: object, walk: Walk): boolean =>
  walk.seen.has(object) || walk.earlier?.objects.has(object) === true

/**
 * A string, or the text of a `BigInt`, a function or a symbol, outside
 * repeats: a long one the line has already written is a repeat, written
 * again while its length fits the budget.
 *
 * @param {string} value - The string or text.
 * @param {Walk} walk - The current walk, outside repeats.
 * @returns {string} `value`, or `"[Repeated]"`.
 * @throws `NOT_JSON` in a strict walk, instead of `"[Repeated]"`.
 */
function stringToJSONValue(value: string, walk: Walk): string {
  if (value.length < LONG_STRING) return value
  if (!walk.strings.has(value) && !walk.earlier?.strings.has(value)) {
    walk.strings.add(value)
    return value
  }
  return spend(walk.budget, { values: 0, chars: value.length })
    ? value
    : standIn(walk, '[Repeated]')
}

/**
 * The text a lenient walk writes for a value JSON cannot write as is.
 *
 * @param {Walk} walk - The current walk.
 * @param {string} text - The stand-in.
 * @returns {string} `text`.
 * @throws `NOT_JSON` in a strict walk.
 */
function standIn(walk: Walk, text: string): string {
  if (walk.strict) throw NOT_JSON
  return text
}

/**
 * `value` as JSON-ready data (plain objects, arrays, strings, numbers,
 * booleans, `null`), so `JSON.stringify` of the result never throws. It
 * follows `JSON.stringify`: `toJSON` is called, own enumerable string keys
 * are written, `undefined` is left out of objects and `null` in arrays, boxed
 * primitives are unwrapped. Beyond JSON: a `Map` is an array of
 * `[key, value]` pairs, a `Set` an array; a `BigInt` is its digits, a
 * function `[Function: name]`, a symbol `Symbol(description)` (boxed or
 * not); a real cycle is `"[Circular]"` (a `toJSON` result that refers back to
 * its object included); a repeated object (one with a `toJSON` included), or
 * a repeated long string, is written again within a budget per line (see `MAX_REWRITTEN_VALUES` and `MAX_REWRITTEN_CHARS`), then
 * is `"[Repeated]"`; a getter or a `toJSON` that throws is `unserializable()`
 * for that value only.
 *
 * @param {unknown} value - The value to convert.
 * @param {string} key - Its key in its parent, passed to `toJSON`.
 * @param {Walk} walk - The state of this walk.
 * @param {boolean} [useToJSON] - Whether to call `value.toJSON` (not on a `toJSON` result).
 * @returns {unknown} The JSON-ready value; `undefined` where JSON writes nothing.
 * @throws `NOT_JSON` in a strict walk, instead of any stand-in.
 */
function toJSONValue(value: unknown, key: string, walk: Walk, useToJSON = true): unknown {
  const text = typeof value === 'string' ? value : walkText(value, walk)
  if (walk.inRepeat > 0) charge(walk, key, text)
  if (text !== undefined) {
    if (text !== value) standIn(walk, text) // a strict walk gives up
    return walk.inRepeat > 0 ? text : stringToJSONValue(text, walk)
  }
  if (typeof value !== 'object' || value === null) return value
  const object = value

  if (walk.ancestors.has(object)) return standIn(walk, '[Circular]')

  if (useToJSON) {
    let toJSON: unknown
    try {
      toJSON = (object as { toJSON?: unknown }).toJSON
    } catch (thrown) {
      return standIn(walk, unserializable(thrown))
    }
    if (typeof toJSON === 'function') {
      // On the path while its result is written, so a result that refers back is a cycle.
      walk.ancestors.add(object)
      try {
        let replaced: unknown
        try {
          replaced = toJSON.call(object, key)
        } catch (thrown) {
          return standIn(walk, unserializable(thrown))
        }
        if (replaced !== object) {
          const write = () => toJSONValue(replaced, key, walk, false)
          // A `toJSON` may return a new object each time, so the object itself is what repeats.
          if (typeof replaced !== 'object' || replaced === null || walk.inRepeat > 0) return write()
          if (isRepeat(object, walk)) return repeatToJSONValue(object, write, walk)
          walk.seen.add(object)
          return write()
        }
      } finally {
        walk.ancestors.delete(object)
      }
    }
  }

  walk.ancestors.add(object)
  try {
    if (isRepeat(object, walk))
      return repeatToJSONValue(object, () => objectToJSONValue(object, walk), walk)
    if (walk.inRepeat === 0) walk.seen.add(object)
    return objectToJSONValue(object, walk)
  } finally {
    walk.ancestors.delete(object)
  }
}

/**
 * The text loggercf writes for a primitive JSON cannot write: a `BigInt`'s
 * digits, `[Function: name]`, `Symbol(description)`. Shared by the fast path
 * and the walk of `stringifyRecord()`. Never throws.
 *
 * @param {unknown} value - Any value.
 * @returns {string | undefined} Its text, or `undefined` for any other value.
 */
function nonJSONText(value: unknown): string | undefined {
  switch (typeof value) {
    case 'bigint':
    case 'symbol':
      return String(value)
    case 'function':
      return functionText(value)
  }
  return undefined
}

/**
 * How many characters `value` writes as text: a string's length, or that of
 * its `nonJSONText()`. What the budgets charge for a value, and what the
 * fast path counts. Never throws.
 *
 * @param {unknown} value - Any value.
 * @returns {number} Its length; `0` for a value written as anything but text.
 */
function textLength(value: unknown): number {
  return typeof value === 'string' ? value.length : (nonJSONText(value)?.length ?? 0)
}

/**
 * `nonJSONText()`, worked out once per walk for a long text: a `BigInt` of
 * many digits takes long to write, and a repeat of it is only charged.
 *
 * @param {unknown} value - Any value but a string.
 * @param {Walk} walk - The current walk.
 * @returns {string | undefined} Its text, or `undefined` for a value JSON can write.
 */
function walkText(value: unknown, walk: Walk): string | undefined {
  const type = typeof value
  if (type !== 'bigint' && type !== 'symbol' && type !== 'function') return undefined
  let text = walk.texts.get(value)
  if (text === undefined) {
    text = nonJSONText(value)!
    if (text.length >= LONG_STRING) walk.texts.set(value, text)
  }
  return text
}

/**
 * Each primitive JSON unwraps when boxed, plus `BigInt` (written as its
 * digits) and `Symbol` (written as `Symbol(description)`): its prototype, and
 * its `valueOf`, which throws unless its `this` really is that boxed
 * primitive, whatever its `Symbol.toStringTag` says, and never runs user code.
 */
const BOXES: readonly [object, (this: unknown) => unknown][] = [
  [Number.prototype, Number.prototype.valueOf],
  [String.prototype, String.prototype.valueOf],
  [Boolean.prototype, Boolean.prototype.valueOf],
  [BigInt.prototype, BigInt.prototype.valueOf],
  [Symbol.prototype, Symbol.prototype.valueOf],
]

/**
 * The primitive inside a boxed primitive (`new Number(1)`, `Object(1n)`),
 * told by its brand, as `JSON.stringify` tells it. Only an object that
 * inherits from that primitive's prototype is checked, since a failed check
 * throws, which is slow; a boxed primitive moved to another prototype
 * (`Object.setPrototypeOf`) is written as an object here. The fast path of
 * `stringifyRecord()` writes it as `JSON.stringify` does, through that
 * prototype's methods (`null` for a Number moved to `{}`).
 *
 * @param {object} object - Any object that is not a plain object or an array.
 * @returns {{ value: unknown } | undefined} The primitive, or `undefined` when `object` is not boxed.
 * @throws When its prototype cannot be read (a `Proxy` whose `getPrototypeOf` throws).
 */
function unbox(object: object): { value: unknown } | undefined {
  for (const [prototype, valueOf] of BOXES) {
    if (!Object.prototype.isPrototypeOf.call(prototype, object)) continue
    try {
      return { value: valueOf.call(object) }
    } catch {
      return undefined // a fake: `Object.create(Number.prototype)`
    }
  }
  return undefined
}

/**
 * The object part of `toJSONValue()`: its items or entries, each converted.
 *
 * @param {object} object - An object that is not a cycle.
 * @param {Walk} walk - The state of this walk.
 * @returns {unknown} An array, a plain object or an unwrapped primitive.
 */
function objectToJSONValue(object: object, walk: Walk): unknown {
  let items: ArrayLike<unknown> | undefined
  let keys: string[] | undefined
  let length = 0
  let boxed: { value: unknown } | undefined
  try {
    if (object instanceof Map) items = Array.from(object)
    else if (object instanceof Set) items = Array.from(object)
    else if (Array.isArray(object)) items = object
    else if (!isPlainObject(object)) boxed = unbox(object) // `new Number(1)`, as JSON writes it
    if (!items && !boxed) keys = Object.keys(object)
    length = items?.length ?? 0
  } catch (thrown) {
    return standIn(walk, unserializable(thrown))
  }

  if (boxed) return toJSONValue(boxed.value, '', walk) // `Object(1n)` as its digits

  if (items) {
    const out: unknown[] = []
    for (let i = 0; i < length; i++) {
      let item: unknown
      try {
        item = items[i]
      } catch (thrown) {
        item = standIn(walk, unserializable(thrown))
      }
      out.push(toJSONValue(item, String(i), walk) ?? null)
    }
    return out
  }

  const out: LogRecord = Object.create(null) // an own `__proto__` key stays a key
  for (const key of keys!) {
    let child: unknown
    try {
      child = (object as Record<string, unknown>)[key]
    } catch (thrown) {
      child = standIn(walk, unserializable(thrown))
    }
    const converted = toJSONValue(child, key, walk)
    if (converted !== undefined) out[key] = converted
  }
  return out
}

/**
 * A new walk.
 *
 * @param {boolean} strict - Whether to give up instead of writing a stand-in.
 * @param {Budget} budget - The line's re-write budget.
 * @param {Written} [earlier] - What earlier walks of the same line wrote.
 * @returns {Walk} Its state.
 */
const newWalk = (strict: boolean, budget: Budget, earlier?: Written): Walk => ({
  texts: new Map(),
  strict,
  ancestors: new Set(),
  seen: new Set(),
  strings: new Set(),
  earlier,
  inRepeat: 0,
  budget,
})

/** Thrown by `stringifyRecord()`'s fast path: the line needs the full walk. */
const NEEDS_WALK = new Error('needs walk')

/**
 * How many values the fast path writes before it hands the line to the
 * walk, which writes the same line but bounds every repeat by the budget.
 * A safety net: the fast path gives up on every repeat it can see, and on
 * every object reached through a getter, which it cannot tell from a
 * repeat. High enough that an ordinary large line stays on the fast path,
 * which writes it several times faster than the walk.
 */
const MAX_FAST_VALUES = 100_000

/**
 * How many characters of keys and strings the fast path writes before it
 * hands the line to the walk (see `MAX_FAST_VALUES`).
 */
const MAX_FAST_CHARS = 1024 * 1024

/**
 * Serialize a record to one JSON line. Never throws for a value in it: a
 * value JSON cannot write gets a stand-in (see `toJSONValue()`), and only
 * that value. The record's own `toJSON` key, if any, is written as a field,
 * never called. A record from `buildRecord()` spends from its line's
 * budget, which its message's placeholders may already have spent from.
 *
 * Most lines take a fast path: native `JSON.stringify`, which gives up on
 * the first object or long text seen twice (a repeat or a cycle, an object
 * whose `toJSON` was already called included), object a getter returns,
 * boxed symbol, or getter or `toJSON` that throws, and after
 * `MAX_FAST_VALUES` values or `MAX_FAST_CHARS` characters. Those lines are
 * written again by the `toJSONValue()` walk, so a getter (and a `toJSON`) on
 * them runs twice.
 *
 * @param {LogRecord} record - The record to serialize.
 * @returns {string} One JSON line.
 * @throws Only a `RangeError` for a value nested too deep for the stack, or a line too long for a string.
 */
export function stringifyRecord(record: LogRecord): string {
  if (typeof record.toJSON !== 'function') {
    const seen = new WeakSet<object>()
    let strings: Set<string> | undefined
    let values = 0
    let chars = 0
    try {
      return JSON.stringify(record, function (this: unknown, key: string, value: unknown) {
        if (++values > MAX_FAST_VALUES) throw NEEDS_WALK
        chars += key.length
        const text = typeof value === 'string' ? value : nonJSONText(value)
        if (text !== undefined) {
          chars += text.length
          if (chars > MAX_FAST_CHARS) throw NEEDS_WALK
          if (text.length >= LONG_STRING) {
            strings ??= new Set()
            if (strings.has(text)) throw NEEDS_WALK
            strings.add(text)
          }
          return text
        }
        if (chars > MAX_FAST_CHARS) throw NEEDS_WALK
        if (typeof value !== 'object' || value === null) return value
        if (seen.has(value)) throw NEEDS_WALK
        seen.add(value)
        // Read through the descriptor, so a getter does not run twice.
        const descriptor = Object.getOwnPropertyDescriptor(this, key)
        // A getter may return the same object every time: a repeat this path cannot see.
        if (descriptor?.get) throw NEEDS_WALK
        // A `toJSON` result: the object it was called on is what repeats, as in the walk.
        const own = descriptor?.value as unknown
        if (own !== value && typeof own === 'object' && own !== null) {
          if (seen.has(own)) throw NEEDS_WALK
          seen.add(own)
        }
        if (value instanceof Map || value instanceof Set) return Array.from(value)
        if (Object.getPrototypeOf(value) === Symbol.prototype) throw NEEDS_WALK // a boxed symbol: JSON writes `{}`
        return value
      })
    } catch {
      // A repeat, a cycle, or a value that throws: the walk handles each one on its own.
    }
  }
  const budget = lineBudgets.get(record) ?? newBudget()
  return JSON.stringify(toJSONValue(record, '', newWalk(false, budget), false))
}

/** What `formatMessage()` and `routeArgs()` print a message with. */
export interface MessagePrinter {
  /**
   * The JSON text a `%j`, `%o` or `%O` placeholder prints, or `undefined`
   * when its value cannot be printed as it is.
   */
  json(value: unknown): string | undefined
  /**
   * Whether `text` may go into the message, and if so record it as held
   * there and charge it: a long string (see `LONG_STRING`) the message
   * already holds is a repeat, put in again while its length fits the
   * Re-write Budget, which it then spends from. The caller puts `text` in
   * the message whenever this returns `true`.
   */
  admit(text: string): boolean
}

/**
 * The printer for one message. `json()` gives the text of a `%j`, `%o` or
 * `%O` placeholder, or `undefined` for anything that would need a stand-in in
 * `stringifyRecord()` (a `BigInt`, a function or a symbol inside, a cycle, a
 * repeat over the budget, a getter or a `toJSON` that throws), or a value
 * JSON writes nothing for. A `Map` prints as `[key, value]` pairs and a `Set`
 * as an array, as on the line. `admit()` admits a word or a `%s` text. What
 * the message already holds is a repeat for what comes after, and all of it
 * spends from `budget`; a placeholder that gives up prints nothing and spends
 * nothing, so what it saw is not a repeat.
 *
 * @param {Budget} budget - The line's re-write budget.
 * @returns {MessagePrinter} The printer.
 */
export function inlinePrinter(budget: Budget): MessagePrinter {
  let written: Written | undefined
  /** What the message holds so far, made on first use: most messages need none of it. */
  const held = (): Written =>
    (written ??= { objects: new WeakSet(), strings: new Set(), tooLarge: new WeakMap() })
  return {
    json(value) {
      const { values, chars } = budget
      const walk = newWalk(true, budget, held())
      let text: string | undefined
      try {
        text = JSON.stringify(toJSONValue(value, '', walk))
      } catch {
        text = undefined
      }
      if (text === undefined) {
        budget.values = values
        budget.chars = chars
        return undefined
      }
      for (const object of walk.seen) held().objects.add(object)
      for (const string of walk.strings) held().strings.add(string)
      return text
    },
    admit(text) {
      if (text.length < LONG_STRING) return true
      const { strings } = held()
      if (!strings.has(text)) {
        strings.add(text)
        return true
      }
      return spend(budget, { values: 0, chars: text.length })
    },
  }
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
