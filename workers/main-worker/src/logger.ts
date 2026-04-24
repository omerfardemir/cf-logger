import { createLogger, type LogLevel } from '@cf-logger/logger'
export { useLogger } from '@cf-logger/logger/hono'

export const logger = createLogger({
  service: process.env.NAME,
  level: process.env.LOG_LEVEL as LogLevel,
  environment: process.env.ENVIRONMENT,
  version: process.env.VERSION
})
