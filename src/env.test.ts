import { describe, it, expect, beforeEach } from 'vitest'
import { loggerOptionsFromEnv } from './env'
import { _captureEntries, _reset, createLogger } from './logger'

describe('loggerOptionsFromEnv', () => {
  beforeEach(() => {
    _reset()
  })

  it('reads NAME, LOG_LEVEL, ENVIRONMENT and VERSION by default', () => {
    expect(
      loggerOptionsFromEnv({
        NAME: 'api',
        LOG_LEVEL: 'debug',
        ENVIRONMENT: 'production',
        VERSION: '1.2.3',
      }),
    ).toStrictEqual({
      service: 'api',
      level: 'debug',
      environment: 'production',
      version: '1.2.3',
    })
  })

  it('omits absent environment and version; service falls back to unknown', () => {
    expect(loggerOptionsFromEnv({})).toStrictEqual({ service: 'unknown', level: 'info' })
  })

  it('treats empty strings and non-string values as absent', () => {
    expect(
      loggerOptionsFromEnv({ NAME: '', LOG_LEVEL: '', ENVIRONMENT: { stage: 'x' }, VERSION: null }),
    ).toStrictEqual({ service: 'unknown', level: 'info' })
  })

  it('uses a numeric var as its string form', () => {
    expect(loggerOptionsFromEnv({ NAME: 'api', VERSION: 2 })).toStrictEqual({
      service: 'api',
      level: 'info',
      version: '2',
    })
  })

  it('omits absent fields from every log line', () => {
    const entries = _captureEntries()
    createLogger(loggerOptionsFromEnv({ NAME: 'api' })).info('hello')

    expect(entries[0]).toMatchObject({ service: 'api' })
    expect(entries[0]).not.toHaveProperty('environment')
    expect(entries[0]).not.toHaveProperty('version')
  })

  it('reads a field from another var name', () => {
    expect(
      loggerOptionsFromEnv({ NAME: 'api', RELEASE: 'abc123' }, { version: 'RELEASE' }),
    ).toStrictEqual({ service: 'api', level: 'info', version: 'abc123' })
  })

  it('does not fall back to the default var when a field is mapped', () => {
    expect(loggerOptionsFromEnv({ VERSION: '1.0.0' }, { version: 'RELEASE' })).not.toHaveProperty(
      'version',
    )
  })

  it('derives a field with a function', () => {
    const env = {
      SERVICE_NAME: 'billing',
      CF_VERSION_METADATA: { id: 'v-1', tag: 'release-7', timestamp: '' },
    }

    expect(
      loggerOptionsFromEnv(env, {
        service: 'SERVICE_NAME',
        version: (e) => e.CF_VERSION_METADATA.tag || e.CF_VERSION_METADATA.id,
        environment: () => 'staging',
        level: () => 'warn',
      }),
    ).toStrictEqual({
      service: 'billing',
      level: 'warn',
      environment: 'staging',
      version: 'release-7',
    })
  })

  it('treats a function returning undefined as absent', () => {
    expect(
      loggerOptionsFromEnv({ NAME: 'api' }, { service: () => undefined, version: () => undefined }),
    ).toStrictEqual({ service: 'unknown', level: 'info' })
  })

  describe('LOG_LEVEL validation', () => {
    it('falls back to info for an invalid level and warns with the invalid and valid values', () => {
      const entries = _captureEntries()

      expect(loggerOptionsFromEnv({ NAME: 'api', LOG_LEVEL: 'verbose' }).level).toBe('info')

      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        level: 'WARN',
        service: 'api',
        invalidLevel: 'verbose',
        validLevels: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'],
      })
      expect(entries[0].message).toContain('LOG_LEVEL')
    })

    it('warns once per isolate, however often options are built', () => {
      const entries = _captureEntries()

      loggerOptionsFromEnv({ LOG_LEVEL: 'verbose' })
      loggerOptionsFromEnv({ LOG_LEVEL: 'verbose' })
      loggerOptionsFromEnv({ LOG_LEVEL: 'loud' })

      expect(entries).toHaveLength(1)
    })

    it('names the mapped var in the warning', () => {
      const entries = _captureEntries()

      loggerOptionsFromEnv({ LEVEL: 'verbose' }, { level: 'LEVEL' })

      expect(entries[0].message).toContain('LEVEL')
      expect(entries[0].message).not.toContain('LOG_LEVEL')
    })

    it('validates a level returned by a function', () => {
      const entries = _captureEntries()

      expect(loggerOptionsFromEnv({}, { level: () => 'loud' }).level).toBe('info')
      expect(entries).toHaveLength(1)
    })

    it('does not warn for valid or absent levels', () => {
      const entries = _captureEntries()

      for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']) {
        expect(loggerOptionsFromEnv({ LOG_LEVEL: level }).level).toBe(level)
      }
      loggerOptionsFromEnv({})

      expect(entries).toHaveLength(0)
    })

    it('rejects uppercase levels', () => {
      const entries = _captureEntries()

      expect(loggerOptionsFromEnv({ LOG_LEVEL: 'DEBUG' }).level).toBe('info')
      expect(entries).toHaveLength(1)
    })

    it('accepts "silent", as 0.0.1 did: the logger writes nothing, at any level, and no WARN', () => {
      const entries = _captureEntries()

      const options = loggerOptionsFromEnv({ NAME: 'api', LOG_LEVEL: 'silent' })
      expect(options).toStrictEqual({ service: 'api', level: 'silent' })
      const logger = createLogger(options)
      for (const log of [logger, logger.child({ part: 'x' })]) {
        log.trace('t')
        log.debug('d')
        log.info('i')
        log.warn('w')
        log.error(new Error('e'))
        log.fatal({ code: 1 }, 'f')
      }

      expect(entries).toHaveLength(0)
    })

    it('accepts "silent" from a mapped var or a function', () => {
      const entries = _captureEntries()

      expect(loggerOptionsFromEnv({ LEVEL: 'silent' }, { level: 'LEVEL' }).level).toBe('silent')
      expect(loggerOptionsFromEnv({}, { level: () => 'silent' }).level).toBe('silent')
      expect(entries).toHaveLength(0)
    })

    it('rejects uppercase "SILENT", like the other levels', () => {
      const entries = _captureEntries()

      expect(loggerOptionsFromEnv({ LOG_LEVEL: 'SILENT' }).level).toBe('info')
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ level: 'WARN', invalidLevel: 'SILENT' })
    })

    it('_reset() re-arms the warning', () => {
      const entries = _captureEntries()

      loggerOptionsFromEnv({ LOG_LEVEL: 'verbose' })
      _reset()
      loggerOptionsFromEnv({ LOG_LEVEL: 'verbose' })

      expect(entries).toHaveLength(2)
    })
  })
})
