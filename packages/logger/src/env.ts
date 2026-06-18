import type { LoggerOptions, LogLevel } from './types'

/**
 * Extract `LoggerOptions` from env using the `NAME` / `LOG_LEVEL` convention.
 *
 * @param env - The worker or process environment object.
 * @returns Logger options derived from env vars.
 */
export function loggerOptionsFromEnv(env: unknown): LoggerOptions {
  const e = env as Record<string, unknown>
  return {
    service: (e.NAME as string) ?? 'unknown',
    level: ((e.LOG_LEVEL as string) ?? 'info') as LogLevel,
    environment: (e.ENVIRONMENT as string) ?? 'unknown',
    version: (e.VERSION as string) ?? 'unknown',
  }
}
