import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock cloudflare:workers — not available in Node/vitest
vi.mock('cloudflare:workers', () => ({
  RpcTarget: class RpcTarget {},
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown
    constructor(_ctx?: unknown, env?: unknown) { this.env = env }
  },
}))

import { TracedSession, tracedSession, withTrace, TracedEntrypoint, tracedWorker } from './workers'
import { runWithLogger, getTraceContext, getLogger, _reset } from './als'
import { createSimpleLogger } from './logger'
import { resolveTrace, buildTraceparent } from './trace'

describe('Session Factory trace propagation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('TracedSession.traced() sets up ALS with correct trace context', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const callerTrace = resolveTrace()
    const traceparent = buildTraceparent(callerTrace)

    class TestSession extends TracedSession {
      getTrace() {
        return this.traced(() => getTraceContext())
      }
    }

    const session = new TestSession(traceparent, { service: 'test-svc' }, {})
    const receivedTrace = session.getTrace()

    expect(receivedTrace).not.toBeNull()
    expect(receivedTrace!.traceId).toBe(callerTrace.traceId)
    expect(receivedTrace!.parentSpanId).toBe(callerTrace.spanId)
    expect(receivedTrace!.spanId).not.toBe(callerTrace.spanId)
  })

  it('tracedSession() extracts traceparent from current ALS context', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const callerTrace = resolveTrace()
    const callerLogger = createSimpleLogger({ service: 'caller' })

    let receivedTraceparent: string | undefined
    const mockBinding = {
      session(traceparent: string) {
        receivedTraceparent = traceparent
        return {}
      },
    }

    runWithLogger({ logger: callerLogger, trace: callerTrace }, () => {
      tracedSession(mockBinding)
    })

    expect(receivedTraceparent).toBe(buildTraceparent(callerTrace))
  })

  it('tracedSession() passes empty string when no ALS context', () => {
    let receivedTraceparent: string | undefined
    const mockBinding = {
      session(traceparent: string) {
        receivedTraceparent = traceparent
        return {}
      },
    }

    tracedSession(mockBinding)
    expect(receivedTraceparent).toBe('')
  })

  it('propagates traceId end-to-end through session factory', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const callerTrace = resolveTrace()
    const callerLogger = createSimpleLogger({ service: 'caller' })

    class TestSession extends TracedSession {
      getTrace() {
        return this.traced(() => getTraceContext())
      }
    }

    const mockBinding = {
      session(traceparent: string) {
        return new TestSession(traceparent, { service: 'receiver' }, {})
      },
    }

    let receivedTrace: ReturnType<typeof getTraceContext>

    runWithLogger({ logger: callerLogger, trace: callerTrace }, () => {
      const session = tracedSession(mockBinding)
      receivedTrace = session.getTrace()
    })

    expect(receivedTrace!).not.toBeNull()
    expect(receivedTrace!.traceId).toBe(callerTrace.traceId)
    expect(receivedTrace!.parentSpanId).toBe(callerTrace.spanId)
    expect(receivedTrace!.spanId).not.toBe(callerTrace.spanId)
  })

  it('isolates traces across concurrent sessions', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const traceA = resolveTrace()
    const traceB = resolveTrace()
    expect(traceA.traceId).not.toBe(traceB.traceId)

    class TestSession extends TracedSession {
      getTrace() {
        return this.traced(() => getTraceContext())
      }
    }

    const mockBinding = {
      session(traceparent: string) {
        return new TestSession(traceparent, { service: 'receiver' }, {})
      },
    }

    const callerLogger = createSimpleLogger({ service: 'caller' })

    const [resultA, resultB] = await Promise.all([
      new Promise<ReturnType<typeof getTraceContext>>((resolve) => {
        runWithLogger({ logger: callerLogger, trace: traceA }, () => {
          const session = tracedSession(mockBinding)
          resolve(session.getTrace())
        })
      }),
      new Promise<ReturnType<typeof getTraceContext>>((resolve) => {
        runWithLogger({ logger: callerLogger, trace: traceB }, () => {
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
    const logged: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(...args.map(String))
    })

    const callerTrace = resolveTrace()
    const traceparent = buildTraceparent(callerTrace)

    class TestSession extends TracedSession {
      doWork() {
        return this.traced(() => {
          getLogger('test-svc').info({ action: 'test' }, 'doing work')
        })
      }
    }

    const session = new TestSession(traceparent, { service: 'test-svc' }, {})
    session.doWork()

    const logLine = logged.find((l) => l.includes('doing work'))
    expect(logLine).toBeDefined()
    const entry = JSON.parse(logLine!)
    expect(entry.traceId).toBe(callerTrace.traceId)
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
      const logged: string[] = []
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logged.push(...args.map(String))
      })

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        doWork() {
          return this.traced(() => 42)
        }
      }

      const session = new TestSession(traceparent, { service: 'test-svc' }, {})
      const result = session.doWork()

      expect(result).toBe(42)
      const spanLog = logged.find((l) => l.includes('span.end'))
      expect(spanLog).toBeUndefined()
    })

    it('emits span log with OK status for sync operations', () => {
      const logged: string[] = []
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logged.push(...args.map(String))
      })

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        doWork() {
          return this.traced(() => 42, 'test.doWork')
        }
      }

      const session = new TestSession(traceparent, { service: 'test-svc' }, {})
      const result = session.doWork()

      expect(result).toBe(42)
      const spanLog = logged.find((l) => l.includes('span.end'))
      expect(spanLog).toBeDefined()

      const entry = JSON.parse(spanLog!)
      expect(entry.span.operation).toBe('test.doWork')
      expect(entry.span.status).toBe('OK')
      expect(entry.span.duration).toBeGreaterThanOrEqual(0)
      expect(entry.span.startTime).toBeLessThanOrEqual(entry.span.endTime)
      expect(entry.span.error).toBeUndefined()
      // trace IDs are on the log line itself, not duplicated in span
      expect(entry.span.traceId).toBeUndefined()
      expect(entry.traceId).toBe(callerTrace.traceId)
    })

    it('emits span log with ERROR status when sync operation throws', () => {
      const logged: string[] = []
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logged.push(...args.map(String))
      })

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        doWork() {
          return this.traced(() => { throw new Error('boom') }, 'test.fail')
        }
      }

      const session = new TestSession(traceparent, { service: 'test-svc' }, {})
      expect(() => session.doWork()).toThrow('boom')

      const spanLog = logged.find((l) => l.includes('span.end'))
      expect(spanLog).toBeDefined()

      const entry = JSON.parse(spanLog!)
      expect(entry.span.operation).toBe('test.fail')
      expect(entry.span.status).toBe('ERROR')
      expect(entry.span.error).toBe('boom')
    })

    it('emits span log with OK status for async operations', async () => {
      const logged: string[] = []
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logged.push(...args.map(String))
      })

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        async doWork() {
          return this.traced(async () => {
            return 99
          }, 'test.async')
        }
      }

      const session = new TestSession(traceparent, { service: 'test-svc' }, {})
      const result = await session.doWork()

      expect(result).toBe(99)
      const spanLog = logged.find((l) => l.includes('span.end'))
      expect(spanLog).toBeDefined()

      const entry = JSON.parse(spanLog!)
      expect(entry.span.operation).toBe('test.async')
      expect(entry.span.status).toBe('OK')
      // trace IDs are on the log line itself, not duplicated in span
      expect(entry.span.traceId).toBeUndefined()
      expect(entry.traceId).toBe(callerTrace.traceId)
    })

    it('emits span log with ERROR status when async operation rejects', async () => {
      const logged: string[] = []
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logged.push(...args.map(String))
      })

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        async doWork() {
          return this.traced(async () => {
            throw new Error('async boom')
          }, 'test.asyncFail')
        }
      }

      const session = new TestSession(traceparent, { service: 'test-svc' }, {})
      await expect(session.doWork()).rejects.toThrow('async boom')

      const spanLog = logged.find((l) => l.includes('span.end'))
      expect(spanLog).toBeDefined()

      const entry = JSON.parse(spanLog!)
      expect(entry.span.operation).toBe('test.asyncFail')
      expect(entry.span.status).toBe('ERROR')
      expect(entry.span.error).toBe('async boom')
    })

    it('span does not duplicate trace IDs (they are on the log line)', () => {
      const logged: string[] = []
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logged.push(...args.map(String))
      })

      const callerTrace = resolveTrace()
      const traceparent = buildTraceparent(callerTrace)

      class TestSession extends TracedSession {
        doWork() {
          return this.traced(() => 'ok', 'test.parent')
        }
      }

      const session = new TestSession(traceparent, { service: 'test-svc' }, {})
      session.doWork()

      const spanLog = logged.find((l) => l.includes('span.end'))
      const entry = JSON.parse(spanLog!)
      // trace IDs should be on the log line, not in the span object
      expect(entry.span.traceId).toBeUndefined()
      expect(entry.span.spanId).toBeUndefined()
      expect(entry.span.parentSpanId).toBeUndefined()
      expect(entry.traceId).toBe(callerTrace.traceId)
      expect(entry.parentSpanId).toBe(callerTrace.spanId)
    })
  })

  it('withTrace() creates session and runs callback as one-liner', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const callerTrace = resolveTrace()
    const callerLogger = createSimpleLogger({ service: 'caller' })

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
      session(traceparent: string) {
        return new TestSession(traceparent, { service: 'receiver' }, {})
      },
    }

    const result = await runWithLogger(
      { logger: callerLogger, trace: callerTrace },
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
    const entrypoint = new TracedEntrypoint(
      {} as any,
      { NAME: 'my-svc', LOG_LEVEL: 'warn' },
    )

    const opts = (entrypoint as any).loggerOptions
    expect(opts.service).toBe('my-svc')
    expect(opts.level).toBe('warn')
  })

  it('loggerOptions defaults when env vars missing', () => {
    const entrypoint = new TracedEntrypoint({} as any, {})

    const opts = (entrypoint as any).loggerOptions
    expect(opts.service).toBe('unknown')
    expect(opts.level).toBe('info')
  })
})

describe('tracedWorker', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
  })

  it('creates entrypoint with session() that returns the session class', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    class TestSession extends TracedSession {
      getTrace() {
        return this.traced(() => getTraceContext())
      }
    }

    const Worker = tracedWorker(TestSession)
    const instance = new Worker(undefined, { NAME: 'test-svc', LOG_LEVEL: 'debug' })

    const callerTrace = resolveTrace()
    const session = instance.session(buildTraceparent(callerTrace))
    const receivedTrace = session.getTrace()

    expect(receivedTrace).not.toBeNull()
    expect(receivedTrace!.traceId).toBe(callerTrace.traceId)
  })

  it('end-to-end: tracedSession + tracedWorker', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

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
    const callerLogger = createSimpleLogger({ service: 'caller' })

    const result = await runWithLogger(
      { logger: callerLogger, trace: callerTrace },
      () => withTrace(binding, (s) => s.add(3, 4)),
    )

    expect(result).toBe(7)
  })

  it('session receives env and can access it for multi-hop RPC', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    interface TestEnv { OTHER_SERVICE: { session(tp: string): unknown } }

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

    const session = instance.session(buildTraceparent(resolveTrace()))
    expect(session.hasBinding()).toBe(true)
  })
})
