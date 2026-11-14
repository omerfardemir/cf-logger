import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import {
  createLogger,
  getLogger,
  runWithLogger,
  setDefaultLogger,
  setLoggerContext,
  _captureEntries,
  _reset,
} from './logger'
import { useLogger } from './middleware'
import * as core from './index'

describe('Default Logger', () => {
  beforeEach(() => _reset())

  it('without one, getLogger() outside a Logging Context is unchanged', () => {
    const entries = _captureEntries()
    getLogger().info('standalone')

    expect(entries[0]).toMatchObject({ service: 'unknown', message: 'standalone' })
    expect(entries[0]).not.toHaveProperty('environment')
    expect(entries[0]).not.toHaveProperty('version')
  })

  it('getLogger() outside a Logging Context logs through the registered default', () => {
    const entries = _captureEntries()
    const root = createLogger({
      service: 'orders',
      environment: 'production',
      version: '1.2.0',
    })
    setDefaultLogger(root)

    expect(getLogger()).toBe(root)
    getLogger().info('module scope')

    expect(entries[0]).toMatchObject({
      service: 'orders',
      environment: 'production',
      version: '1.2.0',
      message: 'module scope',
    })
  })

  it('getLogger(service) with an explicit name keeps its standalone logger', () => {
    const entries = _captureEntries()
    setDefaultLogger(createLogger({ service: 'orders', environment: 'production' }))

    getLogger('cron').info('named')

    expect(entries[0]).toMatchObject({ service: 'cron', message: 'named' })
    expect(entries[0]).not.toHaveProperty('environment')
  })

  it('inside a Logging Context, getLogger() still returns the context logger', () => {
    const entries = _captureEntries()
    setDefaultLogger(createLogger({ service: 'default-svc' }))

    runWithLogger(
      { logger: createLogger({ service: 'ctx-svc' }), fields: { requestId: 'r1' } },
      () => getLogger().info('inside'),
    )

    expect(entries[0]).toMatchObject({ service: 'ctx-svc', requestId: 'r1' })
    expect(entries[0].traceId).toBeDefined()
  })

  it('a later setDefaultLogger() replaces the default', () => {
    const first = createLogger({ service: 'first' })
    const second = createLogger({ service: 'second' })
    setDefaultLogger(first)
    setDefaultLogger(second)

    expect(getLogger()).toBe(second)
  })

  it('carries no Context Fields or trace IDs, even when registered inside a Logging Context', async () => {
    const entries = _captureEntries()
    const root = createLogger({ service: 'orders' })

    await runWithLogger({ logger: root, fields: { requestId: 'req-1' } }, async () => {
      setLoggerContext({ userId: 'u-1' })
      setDefaultLogger(getLogger()) // the context's logger, not a Root Logger
    })
    getLogger().info('after the request')

    const line = entries.find((e) => e.message === 'after the request')!
    expect(line).toMatchObject({ service: 'orders' })
    expect(line).not.toHaveProperty('requestId')
    expect(line).not.toHaveProperty('userId')
    expect(line).not.toHaveProperty('traceId')
    expect(line).not.toHaveProperty('spanId')
  })

  it('setLoggerContext outside a context warns through the default', () => {
    const entries = _captureEntries()
    setDefaultLogger(createLogger({ service: 'orders' }))

    setLoggerContext({ userId: 'u-1' })

    expect(entries[0]).toMatchObject({ level: 'WARN', service: 'orders' })
  })

  it('_reset() clears the default', () => {
    setDefaultLogger(createLogger({ service: 'orders' }))
    _reset()
    const entries = _captureEntries()
    getLogger().info('after reset')

    expect(entries[0]).toMatchObject({ service: 'unknown' })
  })

  it('is exported from the core entry', () => {
    expect(core.setDefaultLogger).toBe(setDefaultLogger)
  })
})

describe('useLogger registers its Root Logger as the Default Logger', () => {
  beforeEach(() => _reset())

  it('registers the Root Logger, so lines outside a request carry its service', async () => {
    const entries = _captureEntries()
    const root = createLogger({ service: 'api', environment: 'staging', version: '2.0.0' })
    const app = new Hono()
    app.use(useLogger(root))
    app.get('/', (c) => c.text('ok'))

    expect(getLogger()).toBe(root)

    await app.request('/', { headers: { 'X-Request-Id': 'req-abc' } })
    getLogger().info('outside the request')

    const line = entries.find((e) => e.message === 'outside the request')!
    expect(line).toMatchObject({ service: 'api', environment: 'staging', version: '2.0.0' })
    expect(line).not.toHaveProperty('requestId')
    expect(line).not.toHaveProperty('traceId')
  })

  it('first seen wins', () => {
    const first = createLogger({ service: 'first' })
    new Hono().use(useLogger(first))
    new Hono().use(useLogger(createLogger({ service: 'second' })))

    expect(getLogger()).toBe(first)
  })

  it('does not replace a default set with setDefaultLogger()', () => {
    const explicit = createLogger({ service: 'explicit' })
    setDefaultLogger(explicit)
    new Hono().use(useLogger(createLogger({ service: 'api' })))

    expect(getLogger()).toBe(explicit)
  })

  it('an explicit setDefaultLogger() replaces the registered one', () => {
    new Hono().use(useLogger(createLogger({ service: 'api' })))
    const explicit = createLogger({ service: 'explicit' })
    setDefaultLogger(explicit)

    expect(getLogger()).toBe(explicit)
  })

  it('does not register a logger returned by a factory', async () => {
    const entries = _captureEntries()
    const root = createLogger({ service: 'api' })
    const app = new Hono()
    app.use(useLogger(() => root))
    app.get('/', (c) => c.text('ok'))

    await app.request('/')
    getLogger().info('outside the request')

    expect(entries.find((e) => e.message === 'outside the request')).toMatchObject({
      service: 'unknown',
    })
  })
})
