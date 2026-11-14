import { describe, it, expect, beforeEach } from 'vitest'
import { createLogger, _captureEntries, _reset } from './logger'

function namedFn() {}
const circular: Record<string, unknown> = { a: 1 }
circular.self = circular

/**
 * `printf` output pinned from pino 10's browser build (`quick-format-unescaped`),
 * recorded before loggercf replaced pino. Every argument here is consumed by a
 * placeholder, so nothing is left over: the message must stay byte-identical.
 */
const PINNED: Array<[template: string, args: unknown[], message: string]> = [
  ['plain', [], 'plain'],
  // `%%` is only collapsed when there are arguments, as with `console.log`.
  ['100%% done', [], '100%% done'],
  ['100%% done %s', ['x'], '100% done x'],
  ['%s', ['str'], 'str'],
  ['%s', [42], '42'],
  ['%s', [null], 'null'],
  ['%s', [undefined], 'undefined'],
  ['%s', [{ a: 1 }], '[object Object]'],
  ['%s', [[1, 2]], '1,2'],
  ['%s', [10n], '10'],
  ['%s', [true], 'true'],
  ['%d', [42], '42'],
  ['%d', ['42'], '42'],
  ['%d', [4.5], '4.5'],
  ['%d', ['abc'], 'NaN'],
  ['%d', [10n], '10'],
  ['%i', [4.9], '4'],
  ['%i', ['-4.9'], '-5'],
  ['%f', [1.5], '1.5'],
  ['%f', ['1.5'], '1.5'],
  ['%j', [{ a: 1 }], '{"a":1}'],
  ['%j', ['s'], "'s'"],
  ['%j', [namedFn], 'namedFn'],
  ['%j', [circular], '"[Circular]"'],
  ['%j', [null], 'null'],
  ['%o', [{ a: [1] }], '{"a":[1]}'],
  ['%O', [{ a: 1 }], '{"a":1}'],
  ['%o', ['s'], "'s'"],
  ['a %s b %d c %j', ['x', 2, { k: 'v' }], 'a x b 2 c {"k":"v"}'],
  ['%s%s', ['a', 'b'], 'ab'],
  ['%s and %s', ['only-one'], 'only-one and %s'],
  ['%% %s', ['x'], '% x'],
  ['%%%s', ['x'], '%x'],
]

describe('printf placeholders', () => {
  beforeEach(() => _reset())

  it.each(PINNED)('structured call: %j', (template, args, message) => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).info({ k: 1 }, template, ...args)
    expect(entries[0].message).toBe(message)
  })

  it.each(PINNED)('console-style call: %j', (template, args, message) => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).info(template, ...args)
    expect(entries[0].message).toBe(message)
  })

  it('formats the message after a leading Error', () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).error(new Error('e'), 'failed %s after %d tries', 'job', 3)
    expect(entries[0].message).toBe('failed job after 3 tries')
  })
})
