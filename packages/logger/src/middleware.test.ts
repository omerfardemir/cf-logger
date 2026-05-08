import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createLogger, _captureEntries, _reset, getLogger } from './logger'
import { useLogger } from './middleware'
import type { LogFields } from './types'

function setup() {
  const entries = _captureEntries()
  const logger = createLogger({ service: 'test-mw' })
  const app = new Hono()
  app.use(useLogger(logger))
  return { entries, app }
}

describe('useLogger lifecycle logging', () => {
  beforeEach(() => _reset())

  it('emits request.start and request.end on success', async () => {
    const { entries, app } = setup()
    app.get('/hello', (c) => c.text('ok'))

    const res = await app.request('/hello')
    expect(res.status).toBe(200)

    const start = entries.find((e) => e.message?.startsWith('request.start'))
    expect(start).toBeDefined()
    expect(start!.method).toBe('GET')
    expect(start!.path).toBe('/hello')
    expect(start!.requestId).toBeDefined()
    expect(start!.traceId).toBeDefined()

    const end = entries.find((e) => e.message?.startsWith('request.end'))
    expect(end).toBeDefined()
    expect(end!.method).toBe('GET')
    expect(end!.path).toBe('/hello')
    expect(end!.statusCode).toBe(200)
    expect(typeof end!.duration).toBe('number')
    expect(end!.duration).toBeGreaterThanOrEqual(0)
  })

  it('emits request.end even when handler throws', async () => {
    const { entries, app } = setup()
    app.get('/boom', () => {
      throw new Error('kaboom')
    })

    const res = await app.request('/boom')
    expect(res.status).toBe(500)

    const end = entries.find((e) => e.message?.startsWith('request.end'))
    expect(end).toBeDefined()
    expect(end!.statusCode).toBe(500)
    expect(typeof end!.duration).toBe('number')
  })

  it('includes correct method and path in lifecycle logs', async () => {
    const { entries, app } = setup()
    app.post('/users', (c) => c.json({ id: 1 }, 201))

    const res = await app.request('/users', { method: 'POST' })
    expect(res.status).toBe(201)

    const start = entries.find((e) => e.message?.startsWith('request.start'))
    expect(start!.method).toBe('POST')
    expect(start!.path).toBe('/users')

    const end = entries.find((e) => e.message?.startsWith('request.end'))
    expect(end!.statusCode).toBe(201)
  })

  it('sets response headers', async () => {
    const { app } = setup()
    app.get('/h', (c) => c.text('ok'))

    const res = await app.request('/h')
    expect(res.headers.get('X-Request-Id')).toBeDefined()
    expect(res.headers.get('X-Trace-Id')).toBeDefined()
    expect(res.headers.get('traceparent')).toBeDefined()
  })

  it('sets response headers even on error', async () => {
    const { app } = setup()
    app.get('/fail', () => {
      throw new Error('fail')
    })

    const res = await app.request('/fail')
    expect(res.status).toBe(500)
    expect(res.headers.get('X-Request-Id')).toBeDefined()
    expect(res.headers.get('X-Trace-Id')).toBeDefined()
    expect(res.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-\d{2}$/)
  })

  it('measures duration accurately', async () => {
    const { entries, app } = setup()
    app.get('/slow', async (c) => {
      await new Promise((r) => setTimeout(r, 50))
      return c.text('done')
    })

    await app.request('/slow')

    const end = entries.find((e) => e.message?.startsWith('request.end'))
    expect(end!.duration).toBeGreaterThanOrEqual(40)
  })

  it('creates per-request child logger with requestId binding', async () => {
    const { entries, app } = setup()
    let capturedLogger: unknown

    app.get('/child', (c) => {
      capturedLogger = c.get('logger' as never)
      ;(capturedLogger as any).info({}, 'from handler')
      return c.text('ok')
    })

    await app.request('/child')

    // The handler log should have requestId from child binding (not just ALS)
    const handlerLog = entries.find((e) => e.message === 'from handler')
    expect(handlerLog).toBeDefined()
    expect(handlerLog!.requestId).toBeDefined()
  })

  it('gives different logger instances to concurrent requests', async () => {
    const { app } = setup()
    const loggers: unknown[] = []

    app.get('/concurrent', (c) => {
      loggers.push(c.get('logger' as never))
      return c.text('ok')
    })

    await Promise.all([
      app.request('/concurrent'),
      app.request('/concurrent'),
    ])

    expect(loggers).toHaveLength(2)
    expect(loggers[0]).not.toBe(loggers[1])
  })
})
