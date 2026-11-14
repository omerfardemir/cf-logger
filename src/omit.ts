import type { ErrorSerializer } from './types'
import { describeFailure, isError, isPlainObject, readEntries } from './output'

/**
 * Whether `error` has an own property `key`, never throwing: one that can't
 * be told (a `Proxy` whose traps throw) counts as present, so it is left out.
 *
 * @param {Error} error - The `Error`.
 * @param {string} key - The key.
 * @returns {boolean} `true` when it is, or may be, an own property.
 */
function hasOwn(error: Error, key: string): boolean {
  try {
    return Object.hasOwn(error, key)
  } catch {
    return true
  }
}

/**
 * An `ErrorSerializer` that leaves the given own keys of every `Error` out of
 * the line, at any depth, and lists the ones it left out as `omitted`, so a
 * reader knows they were there. A key the `Error` doesn't have as an own
 * property (`type`, or one `serializer` added) is never left out. loggercf
 * has no list of its own: which keys hold user data or large payloads is the
 * application's call.
 *
 * With `serializer`, its result is what the keys are left out of, and the
 * `defaultSerialize` it is given leaves them out too, for any other `Error`
 * it serializes that way. When it throws, the `Error` is written in its
 * default shape, without the keys, and with `serializeErrorFailed`.
 *
 * @param {readonly string[]} keys - The own keys to leave out.
 * @param {ErrorSerializer} [serializer] - A serializer to wrap.
 * @returns {ErrorSerializer} The serializer, for `serializeError` in Logger Options.
 * @throws {TypeError} When `keys` is not an array of strings, or `serializer` is not a function.
 *
 * @example
 * ```ts
 * createLogger({ service, serializeError: omitErrorKeys(['requestBodyValues', 'responseBody']) })
 * // "err":{"type":"APICallError","message":"rate limited","stack":"…","omitted":["requestBodyValues","responseBody"]}
 * ```
 */
export function omitErrorKeys(
  keys: readonly string[],
  serializer?: ErrorSerializer,
): ErrorSerializer {
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === 'string'))
    throw new TypeError('omitErrorKeys: keys must be an array of strings')
  if (serializer !== undefined && typeof serializer !== 'function')
    throw new TypeError('omitErrorKeys: serializer must be a function')
  const omit = new Set(keys)

  /**
   * `out` without `error`'s own keys in `omit`.
   *
   * @param {Error} error - The `Error` `out` was written for.
   * @param {unknown} out - What it was written as.
   * @param {(e: Error) => Record<string, unknown>} defaultSerialize - The default shape, for an `Error` result.
   * @param {string} [failed] - Why `serializer` threw, if it did.
   * @returns {Record<string, unknown>} The copy, with `omitted` (and `serializeErrorFailed`).
   */
  const without = (
    error: Error,
    out: unknown,
    defaultSerialize: (e: Error) => Record<string, unknown>,
    failed?: string,
  ): Record<string, unknown> => {
    if (isError(out)) {
      error = out
      out = defaultSerialize(out)
    }
    if (!isPlainObject(out)) return out as Record<string, unknown>
    const copy: Record<string, unknown> = Object.create(null) // `out` may have an own `__proto__` key
    const omitted: string[] = []
    for (const [key, value] of readEntries(out)) {
      if (omit.has(key) && hasOwn(error, key)) omitted.push(key)
      else copy[key] = value
    }
    if (omitted.length > 0) copy.omitted = omitted
    if (failed !== undefined) copy.serializeErrorFailed = failed
    return copy
  }

  return (err, defaultSerialize) => {
    if (!serializer) return without(err, defaultSerialize(err), defaultSerialize)
    // `err` itself is left out of afterwards, so its `omitted` lists what this call removed.
    const omitting = (e: Error) =>
      e === err ? defaultSerialize(e) : without(e, defaultSerialize(e), defaultSerialize)
    try {
      return without(err, serializer(err, omitting), defaultSerialize)
    } catch (thrown) {
      return without(err, defaultSerialize(err), defaultSerialize, describeFailure(thrown))
    }
  }
}
