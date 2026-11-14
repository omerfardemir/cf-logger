import { describe, it, expect, beforeEach } from 'vitest'
import {
  createLogger,
  getLogger,
  runWithLogger,
  setDefaultLogger,
  _captureEntries,
  _reset,
  _setSink,
} from './logger'
import { serializeError, stringifyRecord } from './output'
import type { Logger } from './types'

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

/** A chain of `depth` nodes, each `{ l: next, r: next }`: two paths to every node below it. */
function dag(depth: number, leaf: unknown = { big: 1n }): unknown {
  let node = leaf
  for (let i = 0; i < depth; i++) node = { l: node, r: node }
  return node
}

/** An object whose `a` getter throws `thrown`. */
const throwing = (thrown: unknown = 1): Record<string, unknown> =>
  Object.defineProperty({}, 'a', {
    enumerable: true,
    get() {
      throw thrown
    },
  })

/** A revoked Proxy: every trap, `getPrototypeOf` included, throws. */
const revoked = () => {
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  return proxy
}
/** A Proxy whose `getPrototypeOf` trap throws (`instanceof`, `Array.isArray` on a revoked one). */
const noPrototype = () =>
  new Proxy(
    { b: 2 },
    {
      getPrototypeOf() {
        throw new Error('no prototype')
      },
    },
  )
const REVOKED = /^\[Unserializable: TypeError: .*revoked.*\]$/

/** How long `fn` takes, in milliseconds. */
const elapsed = (fn: () => void) => {
  const start = performance.now()
  fn()
  return performance.now() - start
}

/** One object with `keys` numeric keys. */
const wide = (keys: number) =>
  Object.fromEntries(Array.from({ length: keys }, (_, i) => [`k${i}`, i]))

/** Log `fields` once and return the written line, as the sink receives it. */
const lineFor = (fields: Record<string, unknown>) => {
  let line = ''
  _setSink({ write: (record) => (line = stringifyRecord(record)) })
  createLogger({ service: 'svc' }).info(fields, 'msg')
  return line
}

describe('shared references are not cycles, and stay linear', () => {
  beforeEach(() => _reset())

  it('a repeated, non-cyclic object is written again', () => {
    const entries = _captureEntries()
    const sh = { x: 1 }
    createLogger({ service: 'svc' }).info('m', { p: sh, q: sh })
    expect(entries[0]).toMatchObject({ p: { x: 1 }, q: { x: 1 } })
  })

  it('a real cycle is still "[Circular]"', () => {
    const entries = _captureEntries()
    const loop: Record<string, unknown> = { name: 'loop' }
    loop.self = loop
    createLogger({ service: 'svc' }).info('m', { loop })
    expect(entries[0].loop).toEqual({ name: 'loop', self: '[Circular]' })
  })

  it('%j with a deeply shared structure runs in well under 100 ms (depth 30)', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    const ms = elapsed(() => logger.info('v=%j', dag(30)))
    expect(ms).toBeLessThan(100)
    expect(entries[0].message).toBe('v=%j') // a BigInt inside: routed, not printed
    expect(entries[0].logError).toBeUndefined()
    expect(entries[0]).toHaveProperty('l')
  })

  it('a field or %j with a deeply shared structure runs in well under 100 ms (depth 30)', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    const ms = elapsed(() => {
      logger.info('m', { tree: dag(30, { n: 1 }) })
      logger.info('m %j', dag(30, { n: 1 }))
    })
    expect(ms).toBeLessThan(100)
    expect(JSON.stringify(entries)).toContain('"[Repeated]"')
    expect(entries.map((e) => e.logError)).toEqual([undefined, undefined])
  })

  for (const [keys, copies] of [
    [20_000, 1001],
    [2_000, 1500],
  ]) {
    it(`a ${keys}-key object shared ${copies} times: fast, and the line stays bounded`, () => {
      const shared = wide(keys)
      const once = JSON.stringify(shared).length
      let line = ''
      const ms = elapsed(
        () => (line = lineFor({ items: Array.from({ length: copies }, () => shared) })),
      )
      expect(ms).toBeLessThan(500)
      // One full copy, re-written values up to the budget, then `"[Repeated]"` for the rest.
      expect(line.length).toBeLessThan(once + 200_000 + copies * '"[Repeated]",'.length)
      const items = JSON.parse(line).items as unknown[]
      expect(items).toHaveLength(copies)
      expect(items[0]).toEqual(shared)
      expect(items.at(-1)).toBe('[Repeated]')
      expect(JSON.parse(line).logError).toBeUndefined()
    })
  }

  it('a repeat is written in full or not at all, never cut part way', () => {
    const shared = wide(6_000) // fits the budget once, not twice
    const items = JSON.parse(lineFor({ items: [shared, shared, shared, shared] })).items
    for (const item of items)
      expect(item === '[Repeated]' || Object.keys(item).length === 6_000).toBe(true)
    expect(items[1]).toEqual(shared)
    expect(items.at(-1)).toBe('[Repeated]')
  })

  it('a non-repeated large object is written in full', () => {
    const big = wide(50_000)
    const parsed = JSON.parse(lineFor({ big, other: wide(50_000) }))
    expect(parsed.big).toEqual(big)
    expect(parsed.other).toEqual(big)
  })

  it('a shared object with a long string counts its bytes too', () => {
    const shared = { s: 'x'.repeat(100_000) }
    const line = lineFor({ items: Array.from({ length: 50 }, () => shared) })
    expect(line.length).toBeLessThan(300_000)
    expect(JSON.parse(line).items.at(-1)).toBe('[Repeated]')
  })
})

describe('Map and Set', () => {
  beforeEach(() => _reset())

  it('a Map is [key, value] pairs and a Set an array, in fields and args', () => {
    const entries = _captureEntries()
    const map = new Map<unknown, unknown>([
      ['a', 1],
      [{ k: 1 }, new Set([2])],
    ])
    createLogger({ service: 'svc' }).info('m', { map, set: new Set(['x', 'y']) }, [map])
    expect(entries[0]).toMatchObject({
      map: [
        ['a', 1],
        [{ k: 1 }, [2]],
      ],
      set: ['x', 'y'],
      args: [
        [
          [
            ['a', 1],
            [{ k: 1 }, [2]],
          ],
        ],
      ],
    })
  })

  it('%j %o %O print a Map as pairs and a Set as an array', () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).info('%j %o %O', new Map([['a', 1]]), new Set([1]), {
      m: new Map(),
    })
    expect(entries[0].message).toBe('[["a",1]] [1] {"m":[]}')
  })
})

describe('placeholders keep values they cannot print', () => {
  beforeEach(() => _reset())

  it('%d %i %f with a non-numeric string: unprinted, appended as a word', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    logger.info('id=%d', 'abc')
    logger.info('id=%i', 'abc')
    logger.info('id=%f', 'abc')
    logger.info('n=%d', NaN)
    expect(entries.map((e) => e.message)).toEqual(['id=%d abc', 'id=%i abc', 'id=%f abc', 'n=NaN'])
  })

  it('%d %i print a BigInt exactly', () => {
    const entries = _captureEntries()
    const big = 123456789012345678901234567890n
    createLogger({ service: 'svc' }).info('%d %i', big, big)
    expect(entries[0].message).toBe(`${big} ${big}`)
  })

  it('a cyclic object under %j %o %O is routed with all its keys', () => {
    const entries = _captureEntries()
    const loop: Record<string, unknown> = { name: 'loop', n: 1 }
    loop.self = loop
    createLogger({ service: 'svc' }).info('v=%o', loop)
    expect(entries[0]).toMatchObject({
      message: 'v=%o',
      name: 'loop',
      n: 1,
      self: { name: 'loop', n: 1, self: '[Circular]' },
    })
  })
})

describe('errors that reference themselves', () => {
  beforeEach(() => _reset())

  it('an Error with e.self = e keeps err', () => {
    const entries = _captureEntries()
    const e = new Error('boom') as Error & { self?: unknown }
    e.self = e
    createLogger({ service: 'svc' }).error('failed', e)
    expect(entries[0]).toMatchObject({
      message: 'failed',
      err: { type: 'Error', message: 'boom', self: '[Circular]' },
    })
    expect(entries[0].logError).toBeUndefined()
  })

  it('serializeError never throws on a getter that throws', () => {
    const e = Object.defineProperty(new Error('boom'), 'code', {
      enumerable: true,
      get() {
        throw new Error('no code')
      },
    })
    expect(serializeError(e)).toMatchObject({
      message: 'boom',
      code: '[Unserializable: Error: no code]',
    })
  })
})

describe('one bad value does not cost the rest of the line', () => {
  beforeEach(() => _reset())

  it('a getter that throws: only that value is replaced; err and the message stay', () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).error('failed', new Error('boom'), throwing())
    expect(entries[0]).toMatchObject({
      level: 'ERROR',
      message: 'failed',
      err: { type: 'Error', message: 'boom' },
      a: '[Unserializable: 1]',
    })
    expect(entries[0].logError).toBeUndefined()
  })

  it('a nested toJSON that throws: only that value is replaced', () => {
    const entries = _captureEntries()
    const bad = {
      toJSON() {
        throw new TypeError('toJSON failed')
      },
    }
    createLogger({ service: 'svc' }).info('m %s', 'x', { ok: 1, deep: { bad, fine: 2 } })
    expect(entries[0]).toMatchObject({
      message: 'm x',
      ok: 1,
      deep: { bad: '[Unserializable: TypeError: toJSON failed]', fine: 2 },
    })
    expect(entries[0].logError).toBeUndefined()
  })

  it('a getter in a leading object or an args item is replaced too', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    logger.info(throwing(new Error('x')), 'm')
    logger.info('m', [throwing()])
    expect(entries[0]).toMatchObject({ message: 'm', a: '[Unserializable: Error: x]' })
    expect(entries[1]).toMatchObject({ message: 'm', args: [[{ a: '[Unserializable: 1]' }]] })
  })

  it('a revoked Proxy in a field, an args item or an Error: only that value is replaced', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    logger.info({ p: revoked(), a: 1 }, 'msg')
    logger.info('msg', [revoked()], { a: 1 })
    logger.info('msg', { p: revoked() }, { a: 1 }, [1])
    const err = Object.assign(new Error('boom'), { p: revoked() })
    logger.error('failed', err, { a: 1 })
    logger.error('caused', new Error('outer', { cause: revoked() }))

    expect(entries.map((e) => e.logError)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(entries[0]).toMatchObject({ message: 'msg', a: 1, p: expect.stringMatching(REVOKED) })
    expect(entries[1]).toMatchObject({ message: 'msg', a: 1 })
    expect((entries[1].args as unknown[][])[0][0]).toMatch(REVOKED)
    expect(entries[2]).toMatchObject({
      message: 'msg',
      a: 1,
      args: [[1]],
      p: expect.stringMatching(REVOKED),
    })
    expect(entries[3]).toMatchObject({
      message: 'failed',
      a: 1,
      err: { message: 'boom', p: expect.stringMatching(REVOKED) },
    })
    expect(entries[4]).toMatchObject({
      err: { message: 'outer', cause: expect.stringMatching(REVOKED) },
    })
  })

  it('a Proxy whose getPrototypeOf throws, as a field, an args item or in one', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    logger.info({ p: noPrototype(), a: 1 }, 'msg')
    logger.info('msg', noPrototype(), [noPrototype()], { a: 1 })
    expect(entries.map((e) => e.logError)).toEqual([undefined, undefined])
    expect(entries[0]).toMatchObject({ message: 'msg', a: 1 })
    expect(entries[0].p).toMatch(/^\[Unserializable: Error: no prototype\]$/)
    expect(entries[1]).toMatchObject({ message: 'msg', a: 1 })
    expect(JSON.stringify(entries[1].args)).toContain('[Unserializable: Error: no prototype]')
  })

  it('a revoked Proxy leading, or under %j and %s, is routed as a stand-in', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    logger.info(revoked(), 'msg %s', 'x', { a: 1 })
    logger.info('v=%j s=%s', revoked(), revoked(), { a: 1 })
    expect(entries.map((e) => e.logError)).toEqual([undefined, undefined])
    expect(entries[0]).toMatchObject({ message: 'msg x', a: 1 })
    expect(entries[0].args).toEqual([expect.stringMatching(REVOKED)])
    expect(entries[1]).toMatchObject({ message: 'v=%j s=%s', a: 1 })
    expect(entries[1].args).toEqual([
      expect.stringMatching(REVOKED),
      expect.stringMatching(REVOKED),
    ])
  })

  it('a revoked Proxy as a Context Field or a binding keeps the line', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' }).child({ bad: revoked(), b: 1 })
    runWithLogger({ logger, fields: { ctx: revoked(), r: 1 } }, () => getLogger().info('m %s', 'x'))
    expect(entries[0]).toMatchObject({ message: 'm x', b: 1, r: 1 })
    expect(entries[0].bad).toMatch(REVOKED)
    expect(entries[0].ctx).toMatch(REVOKED)
    expect(entries[0].logError).toBeUndefined()
  })

  it('the minimal line is the last resort: when writing the full line fails', () => {
    const entries = _captureEntries()
    const capture = _setSink({ write: () => {} }) // the capture sink installed above
    let calls = 0
    _setSink({
      write(record) {
        if (calls++ === 0) throw new Error('sink hiccup')
        capture.write(record)
      },
    })
    createLogger({ service: 'svc' }).info('m %s', 'x')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ level: 'INFO', service: 'svc', message: 'm %s' })
    expect(entries[0].logError).toBe('log call failed: Error: sink hiccup')
  })
})

describe('bindings that cannot be read', () => {
  beforeEach(() => _reset())

  it('.child() with a throwing getter does not throw, then or at a log call', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    let child: Logger | undefined
    expect(() => (child = logger.child(throwing()))).not.toThrow()
    expect(() => child!.info('x')).not.toThrow()
    expect(entries[0]).toMatchObject({ message: 'x', service: 'svc', a: '[Unserializable: 1]' })
  })

  it('createLogger bindings with a throwing getter do not throw', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' }, throwing() as Record<string, string>)
    logger.info('x')
    expect(entries[0]).toMatchObject({ message: 'x', a: '[Unserializable: 1]' })
  })

  it('getLogger().child() outside a Logging Context: the log call does not throw', () => {
    const entries = _captureEntries()
    const child = getLogger().child(throwing())
    expect(() => child.info('x')).not.toThrow()
    setDefaultLogger(createLogger({ service: 'orders' }))
    expect(() => child.info('y')).not.toThrow()
    expect(entries).toMatchObject([
      { service: 'unknown', message: 'x', a: '[Unserializable: 1]' },
      { service: 'orders', message: 'y', a: '[Unserializable: 1]' },
    ])
  })

  it('a default whose .child() throws: the forwarder still writes the line', () => {
    const entries = _captureEntries()
    const root = createLogger({ service: 'orders' })
    setDefaultLogger({
      ...root,
      child() {
        throw new Error('no child')
      },
    })
    expect(() => getLogger().child({ k: 1 }).info('x')).not.toThrow()
    expect(entries[0]).toMatchObject({ message: 'x', k: 1 })
  })
})

describe('the serializer', () => {
  it('never calls the record’s own toJSON', () => {
    const record = Object.assign(Object.create(null), {
      a: 1,
      toJSON: () => {
        throw new Error('x')
      },
    })
    expect(JSON.parse(stringifyRecord(record))).toEqual({ a: 1, toJSON: '[Function: toJSON]' })
  })

  it('keeps JSON’s own conversions: Date, NaN, undefined in arrays and objects', () => {
    const date = new Date(0)
    expect(stringifyRecord({ date, n: NaN, list: [undefined, 1], gone: undefined })).toBe(
      '{"date":"1970-01-01T00:00:00.000Z","n":null,"list":[null,1]}',
    )
  })

  it('a boxed BigInt is its digits, like a BigInt', () => {
    expect(stringifyRecord({ n: Object(10n), list: [Object(10n)] })).toBe(
      '{"n":"10","list":["10"]}',
    )
  })

  it('a toJSON whose result refers back to its object is "[Circular]" there', () => {
    const self = {
      toJSON() {
        return { x: this }
      },
    }
    expect(JSON.parse(stringifyRecord({ self }))).toEqual({ self: { x: '[Circular]' } })
  })

  it('a toJSON that returns its own object writes its keys, as JSON does', () => {
    const own = {
      a: 1,
      toJSON() {
        return this
      },
    }
    expect(JSON.parse(stringifyRecord({ own, again: own }))).toEqual({
      own: { a: 1, toJSON: '[Function: toJSON]' },
      again: { a: 1, toJSON: '[Function: toJSON]' },
    })
  })

  it('an own __proto__ key stays a key', () => {
    const record = JSON.parse('{"__proto__":{"x":1},"a":1}')
    expect(stringifyRecord(record)).toBe('{"__proto__":{"x":1},"a":1}')
  })
})

describe('inside a Logging Context', () => {
  beforeEach(() => _reset())

  it('a bad value keeps the trace IDs and Context Fields', () => {
    const entries = _captureEntries()
    runWithLogger(
      { logger: createLogger({ service: 'svc' }), traceparent: TRACEPARENT, fields: { r: 1 } },
      () => getLogger().warn('m', throwing()),
    )
    expect(entries[0]).toMatchObject({
      r: 1,
      a: '[Unserializable: 1]',
      traceId: '0af7651916cd43dd8448eb211c80319c',
    })
  })
})
