import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createLogger,
  runWithLogger,
  setLoggerContext,
  getTraceContext,
  _captureEntries,
  _setSink,
  _reset,
} from './logger'
import { nodeSink, workersSink, serializeError, stringifyRecord, type Sink } from './output'

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

class DbError extends Error {
  code = 'E_DB'
}

/** The same calls, inside a Logging Context, for comparing adapters. */
function logScenario() {
  const logger = createLogger({
    service: 'contract',
    level: 'trace',
    environment: 'test',
    version: '1.0.0',
  })
  runWithLogger({ logger, traceparent: TRACEPARENT, fields: { requestId: 'req-1' } }, () => {
    const log = logger.child({ component: 'db' })
    log.trace('trace line')
    log.debug({ n: 1 }, 'debug %d', 1)
    log.info({ user: 'u-1' }, 'info line')
    log.warn(new Error('bare warning'))
    log.error({ err: new DbError('query failed', { cause: new Error('socket closed') }) }, 'boom')
    log.fatal('fatal line')
  })
}

/** Run `fn` with `next` as the sink, capturing every console method call. */
function captureConsole(next: Sink, fn: () => void): Array<[method: string, line: string]> {
  const calls: Array<[string, string]> = []
  const methods = ['log', 'debug', 'info', 'warn', 'error'] as const
  const spies = methods.map((m) =>
    vi.spyOn(console, m).mockImplementation((line: string) => calls.push([m, line])),
  )
  const previous = _setSink(next)
  try {
    fn()
  } finally {
    _setSink(previous)
    for (const s of spies) s.mockRestore()
  }
  return calls
}

/** Strip what legitimately differs between two runs: time, the new span ID, stack positions. */
const normalize = (line: string) =>
  line
    .replace(/"time":"[^"]+"/, '"time":"<t>"')
    .replace(/"spanId":"[0-9a-f]+"/, '"spanId":"<span>"')
    .replace(/"stack":"(?:\\.|[^"\\])*"/g, '"stack":"<stack>"')

describe('runtime adapters', () => {
  beforeEach(() => _reset())

  it('Node and Workers write byte-identical lines (time aside) for the same calls', () => {
    const node = captureConsole(nodeSink, logScenario)
    const workers = captureConsole(workersSink, logScenario)

    expect(node).toHaveLength(6)
    expect(node.map(([, line]) => normalize(line))).toEqual(
      workers.map(([, line]) => normalize(line)),
    )
  })

  it('Node writes every level to console.log', () => {
    const node = captureConsole(nodeSink, logScenario)
    expect(new Set(node.map(([method]) => method))).toEqual(new Set(['log']))
  })

  it('Workers picks the console method by level', () => {
    const workers = captureConsole(workersSink, logScenario)
    expect(workers.map(([method]) => method)).toEqual([
      'debug',
      'debug',
      'info',
      'warn',
      'error',
      'error',
    ])
  })
})

describe('record shape', () => {
  beforeEach(() => _reset())

  it('starts with time and level, and has no pid or hostname', () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).info('hello')

    expect(Object.keys(entries[0]).slice(0, 2)).toEqual(['time', 'level'])
    expect(entries[0]).not.toHaveProperty('pid')
    expect(entries[0]).not.toHaveProperty('hostname')
    expect(entries[0]).toMatchObject({ level: 'INFO', service: 'svc', message: 'hello' })
  })

  it('precedence: trace IDs > log-call fields > logger bindings > Context Fields', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })
    let trace: ReturnType<typeof getTraceContext>

    runWithLogger(
      { logger, traceparent: TRACEPARENT, fields: { requestId: 'ctx', a: 'ctx' } },
      () => {
        trace = getTraceContext()
        setLoggerContext({ b: 'ctx' })
        logger
          .child({ a: 'binding', b: 'binding' })
          .info({ requestId: 'call', traceId: 'forged', parentSpanId: 'forged' }, 'm')
      },
    )

    expect(entries[0]).toMatchObject({
      requestId: 'call',
      a: 'binding',
      b: 'binding',
      traceId: trace!.traceId,
      spanId: trace!.spanId,
      parentSpanId: trace!.parentSpanId,
    })
  })

  it('a log call cannot invent a parentSpanId on a root trace', () => {
    const entries = _captureEntries()
    runWithLogger({ logger: createLogger({ service: 'svc' }) }, () => {
      createLogger({ service: 'svc' }).info({ parentSpanId: 'forged' }, 'm')
    })
    expect(entries[0]).not.toHaveProperty('parentSpanId')
  })

  it('never throws on circular values or BigInt', () => {
    const entries = _captureEntries()
    const loop: Record<string, unknown> = { name: 'loop' }
    loop.self = loop

    createLogger({ service: 'svc' }).info({ loop, big: 10n }, 'odd values')

    expect(entries[0]).toMatchObject({ loop: { name: 'loop', self: '[Circular]' }, big: '10' })
  })
})

describe('errors', () => {
  beforeEach(() => _reset())
  afterEach(() => vi.restoreAllMocks())

  it('keeps a bare Error passed as the first argument', () => {
    const entries = _captureEntries()
    const logger = createLogger({ service: 'svc' })

    logger.error(new Error('bare'))
    logger.warn(new Error('with message'), 'custom %s', 'text')

    expect(entries[0]).toMatchObject({ message: 'bare', err: { type: 'Error', message: 'bare' } })
    expect(typeof (entries[0].err as Record<string, unknown>).stack).toBe('string')
    expect(entries[1]).toMatchObject({ message: 'custom text', err: { message: 'with message' } })
  })

  it('serializes own props and nests cause', () => {
    const entries = _captureEntries()
    const err = new DbError('query failed', { cause: new Error('socket closed') })

    createLogger({ service: 'svc' }).error({ err }, 'boom')

    expect(entries[0].err).toMatchObject({
      type: 'DbError',
      message: 'query failed',
      code: 'E_DB',
      cause: { type: 'Error', message: 'socket closed' },
    })
  })

  it('serializes Error values under any top-level key', () => {
    const entries = _captureEntries()
    createLogger({ service: 'svc' }).warn({ reason: new TypeError('bad input') }, 'rejected')
    expect(entries[0].reason).toMatchObject({ type: 'TypeError', message: 'bad input' })
  })

  it('cuts off deep or circular cause chains', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    a.cause = b

    const serialized = serializeError(a)
    const line = stringifyRecord(serialized)

    let depth = 0
    let node = serialized
    while (node.cause && typeof node.cause === 'object') {
      node = node.cause as Record<string, unknown>
      depth++
    }
    expect(depth).toBe(6)
    expect(node.type).toBe('Truncated')
    expect(line.length).toBeGreaterThan(0)
  })
})
