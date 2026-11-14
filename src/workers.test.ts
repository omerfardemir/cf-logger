import { describe, it, expect, vi, beforeEach } from 'vitest'

// The `env` that `import { env } from 'cloudflare:workers'` returns; tests set its vars.
const workersEnv = vi.hoisted((): Record<string, unknown> => ({}))

// Mock cloudflare:workers not available in Node/vitest
vi.mock('cloudflare:workers', () => ({
  env: workersEnv,
  RpcTarget: class RpcTarget {},
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown
    constructor(_ctx?: unknown, env?: unknown) {
      this.env = env
    }
  },
}))

import {
  TracedSession,
  tracedSession,
  withTrace,
  TracedEntrypoint,
  tracedWorker,
  loggerOptionsFromEnv,
  defaultLoggerFromEnv,
} from './workers'
import type { EnvMapping, SessionInit, TracedServiceBinding } from './workers'
import {
  runWithLogger,
  getTraceContext,
  getLogger,
  _reset,
  createLogger,
  setDefaultLogger,
  _captureEntries,
} from './logger'
import { resolveTrace, buildTraceparent } from './trace'

describe('Session Factory trace propagation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('tracedSession() sends one SessionInit: Trace Carrier plus fields', () => {
    let received: SessionInit | undefined
    const binding: TracedServiceBinding<object> = {
      session(init) {
        received = init
        return {}
      },
    }
    const context = {
      logger: createLogger({ service: 'caller' }),
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      tracestate: 'vendor=value',
    }

    let callerSpanId: string | undefined
    runWithLogger(context, () => {
      callerSpanId = getTraceContext()!.spanId
      tracedSession(binding, { requestId: 'req-1' })
    })

    expect(received).toEqual({
      traceparent: `00-11111111111111111111111111111111-${callerSpanId}-01`,
      tracestate: 'vendor=value',
      fields: { requestId: 'req-1' },
    })
  })

  it('Traced Session continues the carrier and its fields', () => {
    const entries = _captureEntries()

    class TestSession extends TracedSession {
      work() {
        return this.traced(() => {
          this.logger.info('working')
          return getTraceContext()
        })
      }
    }

    const session = new TestSession(
      {
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
        tracestate: 'vendor=value',
        fields: { requestId: 'req-1' },
      },
      createLogger({ service: 'receiver' }),
      {},
    )
    const trace = session.work()

    expect(trace).toMatchObject({
      traceId: '11111111111111111111111111111111',
      parentSpanId: '2222222222222222',
      tracestate: 'vendor=value',
    })
    expect(entries.find((e) => e.message === 'working')).toMatchObject({ requestId: 'req-1' })
  })

  it('TracedSession.traced() sets up ALS with correct trace context', () => {
    _captureEntries()

    const callerTrace = resolveTrace()
    const traceparent = buildTraceparent(callerTrace)

    class TestSession extends TracedSession {
      getTrace() {
        return this.traced(() => getTraceContext())
      }
    }

    const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
    const receivedTrace = session.getTrace()

    expect(receivedTrace).not.toBeNull()
    expect(receivedTrace!.traceId).toBe(callerTrace.traceId)
    expect(receivedTrace!.parentSpanId).toBe(callerTrace.spanId)
    expect(receivedTrace!.spanId).not.toBe(callerTrace.spanId)
  })

  it('tracedSession() extracts traceparent from current ALS context', () => {
    _captureEntries()

    const callerTrace = resolveTrace()
    const callerLogger = createLogger({ service: 'caller' })

    let receivedTraceparent: string | undefined
    const mockBinding = {
      session(init: SessionInit) {
        receivedTraceparent = init.traceparent
        return {}
      },
    }

    let callerContextTrace: ReturnType<typeof getTraceContext>
    runWithLogger({ logger: callerLogger, traceparent: buildTraceparent(callerTrace) }, () => {
      callerContextTrace = getTraceContext()
      tracedSession(mockBinding)
    })

    expect(receivedTraceparent).toBe(buildTraceparent(callerContextTrace!))
    expect(callerContextTrace!.traceId).toBe(callerTrace.traceId)
  })

  it('tracedSession() passes an empty carrier outside a Logging Context', () => {
    let receivedTraceparent: string | undefined
    const mockBinding = {
      session(init: SessionInit) {
        receivedTraceparent = init.traceparent
        return {}
      },
    }

    tracedSession(mockBinding)
    expect(receivedTraceparent).toBeUndefined()
  })

  it('propagates traceId end-to-end through session factory', () => {
    _captureEntries()

    const callerTrace = resolveTrace()
    const callerLogger = createLogger({ service: 'caller' })

    class TestSession extends TracedSession {
      getTrace() {
        return this.traced(() => getTraceContext())
      }
    }

    const mockBinding = {
      session(init: SessionInit) {
        return new TestSession(init, createLogger({ service: 'receiver' }), {})
      },
    }

    let receivedTrace: ReturnType<typeof getTraceContext>
    let callerContextTrace: ReturnType<typeof getTraceContext>

    runWithLogger({ logger: callerLogger, traceparent: buildTraceparent(callerTrace) }, () => {
      callerContextTrace = getTraceContext()
      const session = tracedSession(mockBinding)
      receivedTrace = session.getTrace()
    })

    expect(receivedTrace!).not.toBeNull()
    expect(receivedTrace!.traceId).toBe(callerTrace.traceId)
    expect(receivedTrace!.parentSpanId).toBe(callerContextTrace!.spanId)
    expect(receivedTrace!.spanId).not.toBe(callerContextTrace!.spanId)
  })

  it('isolates traces across concurrent sessions', async () => {
    _captureEntries()

    const traceA = resolveTrace()
    const traceB = resolveTrace()
    expect(traceA.traceId).not.toBe(traceB.traceId)

    class TestSession extends TracedSession {
      getTrace() {
        return this.traced(() => getTraceContext())
      }
    }

    const mockBinding = {
      session(init: SessionInit) {
        return new TestSession(init, createLogger({ service: 'receiver' }), {})
      },
    }

    const callerLogger = createLogger({ service: 'caller' })

    const [resultA, resultB] = await Promise.all([
      new Promise<ReturnType<typeof getTraceContext>>((resolve) => {
        runWithLogger({ logger: callerLogger, traceparent: buildTraceparent(traceA) }, () => {
          const session = tracedSession(mockBinding)
          resolve(session.getTrace())
        })
      }),
      new Promise<ReturnType<typeof getTraceContext>>((resolve) => {
        runWithLogger({ logger: callerLogger, traceparent: buildTraceparent(traceB) }, () => {
          const session = tracedSession(mockBinding)
          resolve(session.getTrace())
        })
      }),
    ])

    expect(resultA!.traceId).toBe(traceA.traceId)
    expect(resultB!.traceId).toBe(traceB.traceId)
    expect(resultA!.traceId).not.toBe(resultB!.traceId)
  })

  it('traced() logs include correct traceId', () => {
    const entries = _captureEntries()

    const callerTrace = resolveTrace()
    const traceparent = buildTraceparent(callerTrace)

    class TestSession extends TracedSession {
      doWork() {
        return this.traced(() => {
          getLogger('test-svc').info({ action: 'test' }, 'doing work')
        })
      }
    }

    const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
    session.doWork()

    const entry = entries.find((e) => e.message === 'doing work')
    expect(entry).toBeDefined()
    expect(entry!.traceId).toBe(callerTrace.traceId)
  })

  it('round-trips through W3C traceparent format', () => {
    const original = resolveTrace()
    const traceparent = buildTraceparent(original)
    const continued = resolveTrace(traceparent)

    expect(continued.traceId).toBe(original.traceId)
    expect(continued.parentSpanId).toBe(original.spanId)
    expect(continued.spanId).not.toBe(original.spanId)
  })

  describe('traced() span support', () => {
    it('does not emit span log when no operation name is provided', () => {
      const entries = _captureEntries()

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        doWork() {
          return this.traced(() => 42)
        }
      }

      const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
      const result = session.doWork()

      expect(result).toBe(42)
      const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))
      expect(spanEntry).toBeUndefined()
    })

    it('emits span log with OK status for sync operations', () => {
      const entries = _captureEntries()

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        doWork() {
          return this.traced(() => 42, 'test.doWork')
        }
      }

      const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
      const result = session.doWork()

      expect(result).toBe(42)
      const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))!
      expect(spanEntry).toBeDefined()

      const span = spanEntry.span as Record<string, unknown>
      expect(span.operation).toBe('test.doWork')
      expect(span.status).toBe('OK')
      expect(span.duration).toBeGreaterThanOrEqual(0)
      expect(span.startTime as number).toBeLessThanOrEqual(span.endTime as number)
      expect(span.error).toBeUndefined()
      // trace IDs are on the log line itself, not duplicated in span
      expect(span.traceId).toBeUndefined()
      expect(spanEntry.traceId).toBe(callerTrace.traceId)
    })

    it('emits span log with ERROR status when sync operation throws', () => {
      const entries = _captureEntries()

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        doWork() {
          return this.traced(() => {
            throw new Error('boom')
          }, 'test.fail')
        }
      }

      const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
      expect(() => session.doWork()).toThrow('boom')

      const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))!
      expect(spanEntry).toBeDefined()

      const span = spanEntry.span as Record<string, unknown>
      expect(span.operation).toBe('test.fail')
      expect(span.status).toBe('ERROR')
      expect(span.error).toBe('boom')
    })

    it('sync error span includes stack trace in err field', () => {
      const entries = _captureEntries()

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        doWork() {
          return this.traced(() => {
            throw new Error('stack test')
          }, 'test.stackSync')
        }
      }

      const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
      expect(() => session.doWork()).toThrow('stack test')

      const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))!
      expect(spanEntry).toBeDefined()

      const err = spanEntry.err as Record<string, unknown>
      expect(err).toBeDefined()
      expect(err.message).toBe('stack test')
      expect(err.type).toBe('Error')
      expect(typeof err.stack).toBe('string')
      expect((err.stack as string).length).toBeGreaterThan(0)
    })

    it('emits span log with OK status for async operations', async () => {
      const entries = _captureEntries()

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        async doWork() {
          return this.traced(async () => {
            return 99
          }, 'test.async')
        }
      }

      const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
      const result = await session.doWork()

      expect(result).toBe(99)
      const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))!
      expect(spanEntry).toBeDefined()

      const span = spanEntry.span as Record<string, unknown>
      expect(span.operation).toBe('test.async')
      expect(span.status).toBe('OK')
      // trace IDs are on the log line itself, not duplicated in span
      expect(span.traceId).toBeUndefined()
      expect(spanEntry.traceId).toBe(callerTrace.traceId)
    })

    it('emits span log with ERROR status when async operation rejects', async () => {
      const entries = _captureEntries()

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        async doWork() {
          return this.traced(async () => {
            throw new Error('async boom')
          }, 'test.asyncFail')
        }
      }

      const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
      await expect(session.doWork()).rejects.toThrow('async boom')

      const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))!
      expect(spanEntry).toBeDefined()

      const span = spanEntry.span as Record<string, unknown>
      expect(span.operation).toBe('test.asyncFail')
      expect(span.status).toBe('ERROR')
      expect(span.error).toBe('async boom')
    })

    it('async error span includes stack trace in err field', async () => {
      const entries = _captureEntries()

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        async doWork() {
          return this.traced(async () => {
            throw new Error('async stack test')
          }, 'test.stackAsync')
        }
      }

      const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
      await expect(session.doWork()).rejects.toThrow('async stack test')

      const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))!
      const err = spanEntry.err as Record<string, unknown>
      expect(err).toBeDefined()
      expect(err.message).toBe('async stack test')
      expect(err.type).toBe('Error')
      expect(typeof err.stack).toBe('string')
      expect((err.stack as string).length).toBeGreaterThan(0)
    })

    it('span does not duplicate trace IDs (they are on the log line)', () => {
      const entries = _captureEntries()

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        doWork() {
          return this.traced(() => 'ok', 'test.parent')
        }
      }

      const session = new TestSession({ traceparent }, createLogger({ service: 'test-svc' }), {})
      session.doWork()

      const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))!
      const span = spanEntry.span as Record<string, unknown>
      // trace IDs should be on the log line, not in the span object
      expect(span.traceId).toBeUndefined()
      expect(span.spanId).toBeUndefined()
      expect(span.parentSpanId).toBeUndefined()
      expect(spanEntry.traceId).toBe(callerTrace.traceId)
      expect(spanEntry.parentSpanId).toBe(callerTrace.spanId)
    })
  })

  it('withTrace() creates session and runs callback as one-liner', async () => {
    _captureEntries()

    const callerTrace = resolveTrace()
    const callerLogger = createLogger({ service: 'caller' })

    class TestSession extends TracedSession {
      async add(a: number, b: number) {
        return this.traced(() => {
          const trace = getTraceContext()
          expect(trace!.traceId).toBe(callerTrace.traceId)
          return a + b
        })
      }
    }

    const mockBinding = {
      session(init: SessionInit) {
        return new TestSession(init, createLogger({ service: 'receiver' }), {})
      },
    }

    const result = await runWithLogger(
      { logger: callerLogger, traceparent: buildTraceparent(callerTrace) },
      () => withTrace(mockBinding, (s) => s.add(5, 7)),
    )

    expect(result).toBe(12)
  })
})

describe('TracedEntrypoint', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('loggerOptions reads NAME and LOG_LEVEL from env', () => {
    const entrypoint = new TracedEntrypoint({} as any, { NAME: 'my-svc', LOG_LEVEL: 'warn' })

    const opts = (entrypoint as any).loggerOptions
    expect(opts.service).toBe('my-svc')
    expect(opts.level).toBe('warn')
  })

  it('loggerOptions defaults when env vars missing', () => {
    const entrypoint = new TracedEntrypoint({} as any, {})

    expect((entrypoint as any).loggerOptions).toStrictEqual({ service: 'unknown', level: 'info' })
  })

  it('re-exports loggerOptionsFromEnv', () => {
    expect(loggerOptionsFromEnv({ NAME: 'api' })).toStrictEqual({ service: 'api', level: 'info' })
  })

  it('envMapping override maps fields by name and by function', () => {
    interface Env {
      SERVICE: string
      RELEASE: string
      CF_VERSION_METADATA: { id: string }
    }

    class Entrypoint extends TracedEntrypoint<Env> {
      protected override get envMapping(): EnvMapping<Env> {
        return { service: 'SERVICE', version: (e) => e.CF_VERSION_METADATA.id }
      }
    }

    const entrypoint = new Entrypoint({} as any, {
      SERVICE: 'mapped-svc',
      RELEASE: 'unused',
      CF_VERSION_METADATA: { id: 'version-id' },
    })

    expect((entrypoint as any).loggerOptions).toStrictEqual({
      service: 'mapped-svc',
      level: 'info',
      version: 'version-id',
    })
  })

  it('a loggerOptions override still wins over envMapping', () => {
    class Entrypoint extends TracedEntrypoint {
      protected override get envMapping(): EnvMapping {
        return { service: 'SERVICE' }
      }
      protected override get loggerOptions() {
        return { service: 'custom', level: 'debug' as const }
      }
    }

    const entrypoint = new Entrypoint({} as any, { SERVICE: 'mapped' })
    expect((entrypoint as any).rootLogger).toBeDefined()
    expect((entrypoint as any).loggerOptions).toStrictEqual({ service: 'custom', level: 'debug' })
  })

  it('shares one Root Logger per isolate for the same Logger Options', () => {
    const env = { NAME: 'root-svc', LOG_LEVEL: 'info' }
    const a = new TracedEntrypoint({} as any, env)
    const b = new TracedEntrypoint({} as any, { ...env })
    const other = new TracedEntrypoint({} as any, { NAME: 'other-svc', LOG_LEVEL: 'info' })

    expect((a as any).rootLogger).toBe((b as any).rootLogger)
    expect((a as any).rootLogger).not.toBe((other as any).rootLogger)
  })

  it('Root Logger carries per-process fields from env', () => {
    const entries = _captureEntries()
    const entrypoint = new TracedEntrypoint({} as any, {
      NAME: 'env-svc',
      LOG_LEVEL: 'info',
      ENVIRONMENT: 'staging',
      VERSION: '2.0.0',
    })

    ;(entrypoint as any).rootLogger.info('hello')

    expect(entries[0]).toMatchObject({
      service: 'env-svc',
      environment: 'staging',
      version: '2.0.0',
    })
  })
})

describe('tracedWorker', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('creates entrypoint with session() that returns the session class', () => {
    _captureEntries()

    class TestSession extends TracedSession {
      getTrace() {
        return this.traced(() => getTraceContext())
      }
    }

    const Worker = tracedWorker(TestSession)
    const instance = new Worker(undefined, { NAME: 'test-svc', LOG_LEVEL: 'debug' })

    const callerTrace = resolveTrace()
    const session = instance.session({ traceparent: buildTraceparent(callerTrace) })
    const receivedTrace = session.getTrace()

    expect(receivedTrace).not.toBeNull()
    expect(receivedTrace!.traceId).toBe(callerTrace.traceId)
  })

  it('end-to-end: tracedSession + tracedWorker', async () => {
    _captureEntries()

    class TestSession extends TracedSession {
      async add(a: number, b: number) {
        return this.traced(() => {
          expect(getTraceContext()!.traceId).toBe(callerTrace.traceId)
          return a + b
        })
      }
    }

    const Worker = tracedWorker(TestSession)
    const binding = new Worker(undefined, { NAME: 'test-svc', LOG_LEVEL: 'debug' })

    const callerTrace = resolveTrace()
    const callerLogger = createLogger({ service: 'caller' })

    const result = await runWithLogger(
      { logger: callerLogger, traceparent: buildTraceparent(callerTrace) },
      () => withTrace(binding, (s) => s.add(3, 4)),
    )

    expect(result).toBe(7)
  })

  it('tracedWorker(SessionClass, { env }) maps fields by name and by function', () => {
    const entries = _captureEntries()

    interface Env {
      NAME: string
      RELEASE: string
      CF_VERSION_METADATA: { id: string; tag: string }
    }

    class TestSession extends TracedSession<Env> {
      hello() {
        return this.traced(() => this.logger.info('hello'))
      }
    }

    const Worker = tracedWorker(TestSession, {
      env: { environment: 'RELEASE', version: (e) => e.CF_VERSION_METADATA.tag },
    })
    const instance = new Worker(undefined, {
      NAME: 'mapped-worker',
      RELEASE: 'canary',
      VERSION: 'ignored',
      CF_VERSION_METADATA: { id: 'id-1', tag: 'tag-1' },
    })
    instance.session({}).hello()

    expect(entries[0]).toMatchObject({
      service: 'mapped-worker',
      environment: 'canary',
      version: 'tag-1',
    })
  })

  it('tracedWorker() without options reads the default vars', () => {
    const entries = _captureEntries()

    class TestSession extends TracedSession {
      hello() {
        return this.traced(() => this.logger.info('hello'))
      }
    }

    const instance = new (tracedWorker(TestSession))(undefined, { NAME: 'plain', VERSION: '3.0.0' })
    instance.session({}).hello()

    expect(entries[0]).toMatchObject({ service: 'plain', version: '3.0.0' })
    expect(entries[0]).not.toHaveProperty('environment')
  })

  it('session receives env and can access it for multi-hop RPC', () => {
    _captureEntries()

    interface TestEnv {
      OTHER_SERVICE: { session(init: SessionInit): unknown }
    }

    class TestSession extends TracedSession<TestEnv> {
      hasBinding() {
        return this.traced(() => {
          return this.env.OTHER_SERVICE !== undefined
        })
      }
    }

    const fakeEnv: TestEnv = { OTHER_SERVICE: { session: () => ({}) } }
    const Worker = tracedWorker(TestSession)
    const instance = new Worker(undefined, { NAME: 'svc', LOG_LEVEL: 'info', ...fakeEnv })

    const session = instance.session({ traceparent: buildTraceparent(resolveTrace()) })
    expect(session.hasBinding()).toBe(true)
  })
})

describe('traceFlags sampling', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('skips span logs when traceFlags sampled bit is 0', () => {
    const entries = _captureEntries()

    const callerTrace = resolveTrace()
    // Build unsampled traceparent (flags = 00)
    const unsampledTp = `00-${callerTrace.traceId}-${callerTrace.spanId}-00`

    class TestSession extends TracedSession {
      doWork() {
        return this.traced(() => {
          getLogger().info({}, 'inside traced')
          return 42
        }, 'test.operation')
      }
    }

    const session = new TestSession(
      { traceparent: unsampledTp },
      createLogger({ service: 'test-svc' }),
      {},
    )
    const result = session.doWork()
    expect(result).toBe(42)

    // Should have the business log but NO span.end log
    const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))
    expect(spanEntry).toBeUndefined()
    const businessLog = entries.find((e) => e.message === 'inside traced')
    expect(businessLog).toBeDefined()
  })

  it('emits span logs when traceFlags sampled bit is 1', () => {
    const entries = _captureEntries()

    const callerTrace = resolveTrace()
    // Build sampled traceparent (flags = 01)
    const sampledTp = `00-${callerTrace.traceId}-${callerTrace.spanId}-01`

    class TestSession extends TracedSession {
      doWork() {
        return this.traced(() => 42, 'test.operation')
      }
    }

    const session = new TestSession(
      { traceparent: sampledTp },
      createLogger({ service: 'test-svc' }),
      {},
    )
    const result = session.doWork()
    expect(result).toBe(42)

    const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))
    expect(spanEntry).toBeDefined()
  })
})

describe('Default Logger from the Workers helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
    for (const key of Object.keys(workersEnv)) delete workersEnv[key]
  })

  it('defaultLoggerFromEnv() builds the Root Logger from env and registers it', () => {
    const entries = _captureEntries()
    Object.assign(workersEnv, {
      NAME: 'cron-worker',
      LOG_LEVEL: 'debug',
      ENVIRONMENT: 'production',
      VERSION: '4.0.0',
    })

    const logger = defaultLoggerFromEnv()
    expect(getLogger()).toBe(logger)

    getLogger().debug('outside any Logging Context')
    expect(entries[0]).toMatchObject({
      level: 'DEBUG',
      service: 'cron-worker',
      environment: 'production',
      version: '4.0.0',
    })
    expect(entries[0]).not.toHaveProperty('traceId')
  })

  it('defaultLoggerFromEnv(mapping) reads vars through an Env Mapping', () => {
    const entries = _captureEntries()
    Object.assign(workersEnv, {
      SERVICE_NAME: 'mapped',
      CF_VERSION_METADATA: { id: 'v-id' },
    })

    defaultLoggerFromEnv<{ CF_VERSION_METADATA: { id: string } }>({
      service: 'SERVICE_NAME',
      version: (e) => e.CF_VERSION_METADATA.id,
    })
    getLogger().info('hello')

    expect(entries[0]).toMatchObject({ service: 'mapped', version: 'v-id' })
  })

  it('defaultLoggerFromEnv() returns the same Root Logger as TracedEntrypoint for the same env', () => {
    Object.assign(workersEnv, { NAME: 'shared' })
    const entrypoint = new TracedEntrypoint({} as any, { NAME: 'shared' })

    expect(defaultLoggerFromEnv()).toBe(defaultLoggerFromEnv())
    expect(defaultLoggerFromEnv()).toBe((entrypoint as any).rootLogger)
  })

  it('defaultLoggerFromEnv() does not replace a default set with setDefaultLogger()', () => {
    Object.assign(workersEnv, { NAME: 'from-env' })
    const explicit = createLogger({ service: 'explicit' })
    setDefaultLogger(explicit)

    const logger = defaultLoggerFromEnv()

    expect(logger).not.toBe(explicit)
    expect(getLogger()).toBe(explicit)
  })

  it('TracedEntrypoint registers its Root Logger when constructed', () => {
    const entries = _captureEntries()

    class Entrypoint extends TracedEntrypoint {
      scheduled() {
        getLogger().info('scheduled, outside a Logging Context')
      }
    }

    const entrypoint = new Entrypoint({} as any, {
      NAME: 'rpc-worker',
      ENVIRONMENT: 'staging',
      VERSION: '1.0.0',
    })
    entrypoint.scheduled()

    expect(getLogger()).toBe((entrypoint as any).rootLogger)
    expect(entries[0]).toMatchObject({
      service: 'rpc-worker',
      environment: 'staging',
      version: '1.0.0',
    })
    expect(entries[0]).not.toHaveProperty('traceId')
  })

  it('TracedEntrypoint registers an overridden rootLogger', () => {
    const custom = createLogger({ service: 'custom-root' })

    class Entrypoint extends TracedEntrypoint {
      protected override get rootLogger() {
        return custom
      }
    }

    const entrypoint = new Entrypoint({} as any, { NAME: 'ignored' })
    expect(getLogger()).toBe((entrypoint as any).rootLogger)
    expect(getLogger()).toBe(custom)
  })

  it('tracedWorker() registers its Root Logger; Context Fields never reach the default', () => {
    const entries = _captureEntries()

    class TestSession extends TracedSession {
      hello() {
        return this.traced(() => this.logger.info('inside'))
      }
    }

    const instance = new (tracedWorker(TestSession))(undefined, { NAME: 'bind' })
    instance.session({ fields: { requestId: 'req-1' } }).hello()
    getLogger().info('outside')

    expect(entries.find((e) => e.message === 'inside')).toMatchObject({ requestId: 'req-1' })
    const outside = entries.find((e) => e.message === 'outside')!
    expect(outside).toMatchObject({ service: 'bind' })
    expect(outside).not.toHaveProperty('requestId')
    expect(outside).not.toHaveProperty('traceId')
  })

  it('first seen wins, and setDefaultLogger() overrides a registered default', () => {
    const a = new TracedEntrypoint({} as any, { NAME: 'first' })
    const b = new TracedEntrypoint({} as any, { NAME: 'second' })
    const first = (a as any).rootLogger
    expect((b as any).rootLogger).not.toBe(first)

    expect(getLogger()).toBe(first)

    const explicit = createLogger({ service: 'explicit' })
    setDefaultLogger(explicit)
    const again = new TracedEntrypoint({} as any, { NAME: 'first' })
    expect((again as any).rootLogger).toBe(first)

    expect(getLogger()).toBe(explicit)
  })
})
