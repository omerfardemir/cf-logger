import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LoggerFactory } from './logger'
import { getLogger, setLoggerContext, _reset } from './als'
import { generateTraceId, generateSpanId, resolveTrace } from './trace'

describe('getLogger outside ALS context', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('returns a working logger without warnings', () => {
    const logged: string[] = []
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(...args.map(String))
    })

    const logger = getLogger()
    logger.info({ foo: 'bar' }, 'standalone log')

    // No warnings — this is a valid use case
    expect(console.warn).not.toHaveBeenCalled()

    expect(logged.length).toBeGreaterThan(0)
    const entry = JSON.parse(logged[0])
    expect(entry.message).toBe('standalone log')
    expect(entry.foo).toBe('bar')
  })

  it('includes service field when name is provided', () => {
    const logged: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(...args.map(String))
    })

    const logger = getLogger('auth-service')
    logger.info({}, 'with service')

    const entry = JSON.parse(logged[0])
    expect(entry.service).toBe('auth-service')
  })

  it('caches logger by service name', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const a = getLogger('svc-a')
    const b = getLogger('svc-a')
    expect(a).toBe(b)

    const c = getLogger('svc-b')
    expect(c).not.toBe(a)
  })

  it('produces same JSON shape as ALS logger', () => {
    const logged: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(...args.map(String))
    })

    // ALS logger
    const factory = new LoggerFactory({ service: 'shape-svc' })
    factory.runInContext(
      resolveTrace(undefined),
      () => { getLogger().info({ key: 'val' }, 'als log') },
    )

    // Standalone logger
    _reset()
    getLogger('shape-svc').info({ key: 'val' }, 'standalone log')

    expect(logged.length).toBe(2)
    const alsEntry = JSON.parse(logged[0])
    const standaloneEntry = JSON.parse(logged[1])

    for (const k of ['level', 'time', 'message'] as const) {
      expect(alsEntry[k]).toBeDefined()
      expect(standaloneEntry[k]).toBeDefined()
    }
    expect(typeof alsEntry.level).toBe(typeof standaloneEntry.level)
  })
})

describe('setLoggerContext outside ALS', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('stores fields as child bindings on the cached logger', () => {
    const logged: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(...args.map(String))
    })

    getLogger('ctx-svc').info({}, 'before')
    setLoggerContext({ userId: 'user-42' })
    getLogger('ctx-svc').info({}, 'after')

    expect(logged.length).toBe(2)
    const before = JSON.parse(logged[0])
    expect(before.userId).toBeUndefined()

    const after = JSON.parse(logged[1])
    expect(after.userId).toBe('user-42')
  })
})

describe('setLoggerContext', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('makes fields visible on all log lines within the same request', () => {
    const logged: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(...args.map(String))
    })

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

    expect(logged.length).toBe(3)

    const before = JSON.parse(logged[0])
    expect(before.userId).toBeUndefined()

    const after = JSON.parse(logged[1])
    expect(after.userId).toBe('user-42')

    const childLog = JSON.parse(logged[2])
    expect(childLog.userId).toBe('user-42')
    expect(childLog.component).toBe('db')
  })
})

describe('ALS context isolation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('concurrent contexts do not leak fields between each other', async () => {
    const logged: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(...args.map(String))
    })

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

    expect(logged.length).toBe(2)

    const entryA = JSON.parse(logged.find((l) => l.includes('context A'))!)
    const entryB = JSON.parse(logged.find((l) => l.includes('context B'))!)

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
    const logged: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(...args.map(String))
    })

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

    expect(logged.length).toBe(2)

    const childEntry = JSON.parse(logged[0])
    expect(childEntry.component).toBe('cache')
    expect(childEntry.traceId).toBeDefined()
    expect(childEntry.service).toBe('child-svc')

    const parentEntry = JSON.parse(logged[1])
    expect(parentEntry.component).toBeUndefined()
    expect(parentEntry.traceId).toBe(childEntry.traceId)
  })
})
