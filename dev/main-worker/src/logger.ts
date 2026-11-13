import { createLogger, type LogLevel } from 'loggercf'
export { useLogger } from 'loggercf/hono'

export const logger = createLogger({
  service: process.env.NAME ?? 'pino-log-test',
  level: (process.env.LOG_LEVEL ?? 'debug') as LogLevel,
  environment: process.env.ENVIRONMENT,
  version: process.env.VERSION,
})
