import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock cloudflare:workers not available in Node/vitest
vi.mock('cloudflare:workers', () => ({
  RpcTarget: class RpcTarget {},
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown
    constructor(_ctx?: unknown, env?: unknown) { this.env = env }
  },
}))

import { TracedSession, tracedSession, withTrace, TracedEntrypoint, tracedWorker } from './workers'
import { runWithLogger, getTraceContext, getLogger, _reset, createSimpleLogger, _captureEntries } from './logger'
import { resolveTrace, buildTraceparent } from './trace'

describe('Session Factory trace propagation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _reset()
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

    const session = new TestSession(traceparent, { service: 'test-svc' }, {})
    const receivedTrace = session.getTrace()

    expect(receivedTrace).not.toBeNull()
    expect(receivedTrace!.traceId).toBe(callerTrace.traceId)
    expect(receivedTrace!.parentSpanId).toBe(callerTrace.spanId)
    expect(receivedTrace!.spanId).not.toBe(callerTrace.spanId)
  })

  it('tracedSession() extracts traceparent from current ALS context', () => {
    _captureEntries()

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
    _captureEntries()

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

    const session = new TestSession(traceparent, { service: 'test-svc' }, {})
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

      const session = new TestSession(traceparent, { service: 'test-svc' }, {})
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

      const session = new TestSession(traceparent, { service: 'test-svc' }, {})
      const result = session.doWork()

      expect(result).toBe(42)
      const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))!
      expect(spanEntry).toBeDefined()

      const span = spanEntry.span as Record<string, unknown>
      expect(span.operation).toBe('test.doWork')
      expect(span.status).toBe('OK')
      expect(span.duration).toBeGreaterThanOrEqual(0)
      expect((span.startTime as number)).toBeLessThanOrEqual(span.endTime as number)
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
          return this.traced(() => { throw new Error('boom') }, 'test.fail')
        }
      }

      const session = new TestSession(traceparent, { service: 'test-svc' }, {})
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
          return this.traced(() => { throw new Error('stack test') }, 'test.stackSync')
        }
      }

      const session = new TestSession(traceparent, { service: 'test-svc' }, {})
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

      const session = new TestSession(traceparent, { service: 'test-svc' }, {})
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

      const session = new TestSession(traceparent, { service: 'test-svc' }, {})
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

      const session = new TestSession(traceparent, { service: 'test-svc' }, {})
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

      const session = new TestSession(traceparent, { service: 'test-svc' }, {})
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
    _captureEntries()

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
    const callerLogger = createSimpleLogger({ service: 'caller' })

    const result = await runWithLogger(
      { logger: callerLogger, trace: callerTrace },
      () => withTrace(binding, (s) => s.add(3, 4)),
    )

    expect(result).toBe(7)
  })

  it('session receives env and can access it for multi-hop RPC', () => {
    _captureEntries()

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

    const session = new TestSession(unsampledTp, { service: 'test-svc' }, {})
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

    const session = new TestSession(sampledTp, { service: 'test-svc' }, {})
    const result = session.doWork()
    expect(result).toBe(42)

    const spanEntry = entries.find((e) => (e.message as string)?.includes('span.end'))
    expect(spanEntry).toBeDefined()
  })
})
