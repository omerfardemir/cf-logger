import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LoggerFactory, getLogger, setLoggerContext, _reset, _captureEntries } from './logger'
import { generateTraceId, generateSpanId, resolveTrace } from './trace'

describe('getLogger outside ALS context', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('returns a working logger without warnings', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const entries = _captureEntries()

    const logger = getLogger()
    logger.info({ foo: 'bar' }, 'standalone log')

    // No warnings this is a valid use case
    expect(console.warn).not.toHaveBeenCalled()

    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0].message).toBe('standalone log')
    expect(entries[0].foo).toBe('bar')
  })

  it('includes service field when name is provided', () => {
    const entries = _captureEntries()

    const logger = getLogger('auth-service')
    logger.info({}, 'with service')

    expect(entries[0].service).toBe('auth-service')
  })

  it('caches logger by service name', () => {
    _captureEntries()

    const a = getLogger('svc-a')
    const b = getLogger('svc-a')
    expect(a).toBe(b)

    const c = getLogger('svc-b')
    expect(c).not.toBe(a)
  })

  it('produces same JSON shape as ALS logger', () => {
    const entries = _captureEntries()

    // ALS logger
    const factory = new LoggerFactory({ service: 'shape-svc' })
    factory.runInContext(
      resolveTrace(undefined),
      () => { getLogger().info({ key: 'val' }, 'als log') },
    )

    // Standalone logger
    _reset()
    getLogger('shape-svc').info({ key: 'val' }, 'standalone log')

    expect(entries.length).toBe(2)

    for (const k of ['level', 'time', 'message'] as const) {
      expect(entries[0][k]).toBeDefined()
      expect(entries[1][k]).toBeDefined()
    }
    expect(typeof entries[0].level).toBe(typeof entries[1].level)
  })
})

describe('setLoggerContext outside ALS', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('stores fields as child bindings on the cached logger', () => {
    const entries = _captureEntries()

    getLogger('ctx-svc').info({}, 'before')
    setLoggerContext({ userId: 'user-42' })
    getLogger('ctx-svc').info({}, 'after')

    expect(entries.length).toBe(2)
    expect(entries[0].userId).toBeUndefined()
    expect(entries[1].userId).toBe('user-42')
  })
})

describe('setLoggerContext', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('makes fields visible on all log lines within the same request', () => {
    const entries = _captureEntries()

    const factory = new LoggerFactory({ service: 'ctx-svc' })

    factory.runInContext(
      resolveTrace(undefined),
      () => {
        const logger = getLogger()
        logger.info({}, 'before setLoggerContext')

        setLoggerContext({ userId: 'user-42' })
        logger.info({}, 'after setLoggerContext')

        // Even a child created BEFORE setLoggerContext sees the new field
        const child = logger.child({ component: 'db' })
        child.info({}, 'child after setLoggerContext')
      },
    )

    expect(entries.length).toBe(3)
    expect(entries[0].userId).toBeUndefined()
    expect(entries[1].userId).toBe('user-42')
    expect(entries[2].userId).toBe('user-42')
    expect(entries[2].component).toBe('db')
  })
})

describe('ALS context isolation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('concurrent contexts do not leak fields between each other', async () => {
    const entries = _captureEntries()

    const factory = new LoggerFactory({ service: 'iso-svc' })

    // Run two contexts concurrently
    await Promise.all([
      new Promise<void>((resolve) => {
        factory.runInContext(
          { traceId: 'aaaa'.repeat(8), spanId: 'bbbb'.repeat(4), traceFlags: 0 },
          () => {
            setLoggerContext({ userId: 'user-A' })
            getLogger().info({}, 'from context A')
            resolve()
          },
        )
      }),
      new Promise<void>((resolve) => {
        factory.runInContext(
          { traceId: 'cccc'.repeat(8), spanId: 'dddd'.repeat(4), traceFlags: 0 },
          () => {
            setLoggerContext({ userId: 'user-B' })
            getLogger().info({}, 'from context B')
            resolve()
          },
        )
      }),
    ])

    expect(entries.length).toBe(2)

    const entryA = entries.find((e) => e.message === 'from context A')!
    const entryB = entries.find((e) => e.message === 'from context B')!

    expect(entryA.userId).toBe('user-A')
    expect(entryA.traceId).toBe('aaaa'.repeat(8))

    expect(entryB.userId).toBe('user-B')
    expect(entryB.traceId).toBe('cccc'.repeat(8))
  })
})

describe('child logger', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('inherits ALS trace fields and adds its own bindings', () => {
    const entries = _captureEntries()

    const factory = new LoggerFactory({ service: 'child-svc' })

    factory.runInContext(
      resolveTrace(undefined),
      () => {
        const logger = getLogger()
        const child = logger.child({ component: 'cache' })

        child.info({}, 'child log')

        // Parent should NOT have the child's bindings
        logger.info({}, 'parent log')
      },
    )

    expect(entries.length).toBe(2)
    expect(entries[0].component).toBe('cache')
    expect(entries[0].traceId).toBeDefined()
    expect(entries[0].service).toBe('child-svc')
    expect(entries[1].component).toBeUndefined()
    expect(entries[1].traceId).toBe(entries[0].traceId)
  })
})
