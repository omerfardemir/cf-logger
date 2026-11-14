import type { LogRecord } from './output'

/**
 * Record keys a log call's object arguments cannot set: their values for these
 * keys move to `args` instead, so a call can never overwrite loggercf's own
 * fields and nothing is dropped. `err` and `message` are the exceptions while
 * they are unset (see `routeArgs()`): `logger.error({ err }, 'msg')` is how a
 * structured call passes an error.
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'time',
  'level',
  'message',
  'service',
  'environment',
  'version',
  'traceId',
  'spanId',
  'parentSpanId',
  'err',
  'errors',
  'args',
])

/**
 * Where the arguments of one log call ended up. Nothing is serialized yet:
 * `buildRecord()` does that, so routed values go through the same serializers
 * as structured fields.
 */
export interface RoutedArgs {
  /** Top-level fields: `err` and the object arguments' keys, in call order. */
  fields: LogRecord
  /** The formatted message, when the call gave one. */
  message?: string
  /** Errors after the first, in call order. */
  errors?: Error[]
  /** Values with no better place (the overflow), in call order. */
  args?: unknown[]
}

/**
 * Whether `value` is a plain object literal (`{}`, `Object.create(null)`),
 * as opposed to an array, a class instance, a `Date`, a `Map`...
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Values `console.log('a', 'b', 3)` would print as words: appended to the message. */
function isPrimitive(
  value: unknown,
): value is string | number | boolean | bigint | null | undefined {
  return (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'symbol')
  )
}

/**
 * How a function appears in a log line: `[Function: name]`.
 *
 * @param {{ name: string }} fn - The function.
 * @returns {string} Its text.
 */
export function functionText(fn: { name: string }): string {
  return `[Function: ${fn.name || 'anonymous'}]`
}

/** Sentinel: the placeholder could not render its argument. */
const UNRENDERED = Symbol('unrendered')

/**
 * Whether `value` contains itself, as `JSON.stringify` sees it (own
 * enumerable values). Shared references that are not ancestors are not cycles.
 *
 * @param {unknown} value - The value to walk.
 * @param {object[]} [ancestors] - The objects on the path to `value`.
 * @returns {boolean} `true` for a real cycle.
 * @throws When reading a value throws (a getter): the caller handles it.
 */
function hasCycle(value: unknown, ancestors: object[] = []): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (ancestors.includes(value)) return true
  ancestors.push(value)
  try {
    return Object.values(value).some((child) => hasCycle(child, ancestors))
  } finally {
    ancestors.pop()
  }
}

/**
 * `JSON.stringify` for `%j`/`%o`/`%O`, never throwing. A real cycle is
 * `"[Circular]"`, as with pino. Anything else JSON cannot write (a `BigInt`,
 * a `toJSON` that throws, a symbol) is `UNRENDERED`, so it is routed instead.
 *
 * @param {unknown} value - The placeholder's argument.
 * @returns {string | typeof UNRENDERED} The JSON text, or `UNRENDERED`.
 */
function stringify(value: unknown): string | typeof UNRENDERED {
  try {
    return JSON.stringify(value) ?? UNRENDERED
  } catch {
    try {
      return hasCycle(value) ? '"[Circular]"' : UNRENDERED
    } catch {
      return UNRENDERED // a getter that throws: routing reports it
    }
  }
}

/**
 * Render one argument for placeholder `code`, or `UNRENDERED` when the
 * placeholder would not print it. `%s %d %i %f` never render an object or an
 * array (`[object Object]`, `NaN` would hide its fields), and `%j %o %O` never
 * render an `Error` (`{}` would hide its stack) or a value JSON cannot write,
 * so it is routed like a trailing argument instead.
 */
function render(code: string, value: unknown): string | typeof UNRENDERED {
  switch (code) {
    case 'd':
    case 'f':
      if (value == null || typeof value === 'symbol' || typeof value === 'object') return UNRENDERED
      return String(Number(value))
    case 'i':
      if (value == null || typeof value === 'symbol' || typeof value === 'object') return UNRENDERED
      return String(Math.floor(Number(value)))
    case 'j':
    case 'o':
    case 'O':
      if (value === undefined || value instanceof Error) return UNRENDERED
      if (typeof value === 'string') return `'${value}'`
      if (typeof value === 'function') return value.name || '<anonymous>'
      return stringify(value)
    case 's':
      if (typeof value === 'object' && value !== null) return UNRENDERED
      try {
        return String(value)
      } catch {
        return UNRENDERED // e.g. a function whose toString throws
      }
    default:
      return UNRENDERED // not a placeholder (`50% off`, `%c`)
  }
}

/**
 * Format `template` with `printf` placeholders (`%s %d %i %f %j %o %O %%`).
 *
 * Each `%` sequence takes the next argument in order. When it cannot print
 * that argument (`%d` with `null`, `%j` with `undefined`, `%s %d %i %f` with
 * an object or array, `%j %o %O` with an `Error` or a value JSON cannot write
 * other than a cycle, an unknown sequence such as `% ` or `%c`), the sequence
 * stays in the text and the argument is returned in `unprinted` instead.
 * `%%` becomes `%` only when there are arguments, like `console.log`.
 *
 * @param {string} template - The message template.
 * @param {readonly unknown[]} args - The arguments after the template.
 * @returns The formatted message, and every argument it did not print, in call order.
 */
export function formatMessage(
  template: string,
  args: readonly unknown[],
): { message: string; unprinted: unknown[] } {
  if (args.length === 0 || !template.includes('%'))
    return { message: template, unprinted: [...args] }

  const kept: unknown[] = []
  let message = ''
  let last = 0
  let next = 0
  for (let i = 0; i < template.length - 1; i++) {
    if (template[i] !== '%') continue
    const code = template[i + 1]
    if (code === '%') {
      message += template.slice(last, i) + '%'
      last = i + 2
      i++
      continue
    }
    if (next >= args.length) continue
    const value = args[next++]
    const text = render(code, value)
    if (text === UNRENDERED) {
      kept.push(value)
      continue
    }
    message += template.slice(last, i) + text
    last = i + 2
    i++
  }
  message += template.slice(last)
  return { message, unprinted: [...kept, ...args.slice(next)] }
}

/**
 * Route the arguments of one log call to their place in the record, so that
 * no argument is ever dropped. Pure: never mutates its input.
 *
 * 1. Leading argument: a `string` is the message template. An `Error` becomes
 *    `err`, and the message defaults to `err.message`. A plain object is
 *    merged (see below). A leading `undefined` or `null` means "no fields"
 *    (an `Error | undefined` that is unset) and writes nothing. Any other
 *    primitive goes to `args` and is the message as `String(value)`.
 *    Anything else (array, class instance...) goes to `args`. After an
 *    `Error`, a plain object, `undefined` / `null`, an array or a class
 *    instance, a `string` second argument is the template, and `undefined`
 *    means "no message".
 * 2. `printf` placeholders in the template take arguments in order
 *    (see `formatMessage()`).
 * 3. Every remaining argument, in order: the first `Error` becomes `err` if
 *    unset, later ones go to `errors`. A plain object is merged. A primitive
 *    is appended to the message after a space. Anything else (arrays, class
 *    instances, functions, symbols) goes to `args`.
 *
 * Merging a plain object, leading or not: its keys go to the top level, later
 * objects winning. `err` is set only when still unset. The other
 * `RESERVED_KEYS`, an `err` that is already set, an own `__proto__` key (from
 * `JSON.parse`) and a function-valued `toJSON` (as text, so it cannot replace
 * the line) move to `args` as one object per argument, so a call can never
 * overwrite loggercf's own fields.
 * The exception is `message`: when the call gives no other message, the first
 * object's string `message` becomes the message (`logger.info({ message })`).
 *
 * @param {readonly unknown[]} input - The arguments the log method received.
 * @returns {RoutedArgs} Where each argument goes.
 */
export function routeArgs(input: readonly unknown[]): RoutedArgs {
  // No prototype: an `err` or `__proto__` key can only ever be an own key.
  const fields: LogRecord = Object.create(null)
  const errors: Error[] = []
  const overflow: unknown[] = []
  const words: string[] = []
  let message: string | undefined
  let template: string | undefined
  let remaining = input.slice(1)

  if (input.length === 0) return { fields }

  /** An object's string `message`, used only if the call ends up with no other message. */
  let objectMessage: { value: string; holder: Record<string, unknown> } | undefined

  /** Set `err` if it is still unset. Returns whether it was set. */
  const setErr = (value: unknown) => {
    if (fields.err !== undefined) return false
    fields.err = value
    return true
  }
  const merge = (object: Record<string, unknown>) => {
    let moved: Record<string, unknown> | undefined
    for (const [key, value] of Object.entries(object)) {
      if (key === 'err' && setErr(value)) continue
      const isToJSON = key === 'toJSON' && typeof value === 'function'
      if (!RESERVED_KEYS.has(key) && key !== '__proto__' && !isToJSON) {
        fields[key] = value
        continue
      }
      moved ??= Object.create(null) as Record<string, unknown>
      moved[key] = isToJSON ? functionText(value) : value
      if (key === 'message' && typeof value === 'string') objectMessage ??= { value, holder: moved }
    }
    if (moved) overflow.push(moved)
  }
  const takeTemplate = () => {
    if (typeof remaining[0] === 'string') template = remaining.shift() as string
    else if (remaining.length > 0 && remaining[0] === undefined) remaining.shift()
  }

  const first = input[0]
  if (typeof first === 'string') {
    template = first
  } else if (first instanceof Error) {
    setErr(first)
    takeTemplate()
    if (template === undefined) message = first.message
  } else if (isPlainObject(first)) {
    merge(first)
    takeTemplate()
  } else if (first == null) {
    // No fields (an `Error | undefined` that is unset): nothing to write for it.
    takeTemplate()
  } else if (isPrimitive(first)) {
    overflow.push(first)
    message = String(first)
  } else {
    overflow.push(first)
    takeTemplate()
  }

  if (template !== undefined) {
    const formatted = formatMessage(template, remaining)
    message = formatted.message
    remaining = formatted.unprinted
  }

  for (const value of remaining) {
    if (value instanceof Error) {
      if (!setErr(value)) errors.push(value)
    } else if (isPlainObject(value)) {
      merge(value)
    } else if (isPrimitive(value)) {
      words.push(String(value))
    } else {
      overflow.push(value)
    }
  }

  if (words.length > 0)
    message = message === undefined ? words.join(' ') : [message, ...words].join(' ')

  if (message === undefined && objectMessage) {
    const { value, holder } = objectMessage
    message = value
    delete holder.message
    if (Object.keys(holder).length === 0) overflow.splice(overflow.indexOf(holder), 1)
  }

  const routed: RoutedArgs = { fields }
  if (message !== undefined) routed.message = message
  if (errors.length > 0) routed.errors = errors
  if (overflow.length > 0) routed.args = overflow
  return routed
}
