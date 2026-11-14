import { defaultLoggerFromEnv } from 'loggercf/workers'
export { useLogger } from 'loggercf/hono'

// Built at module scope from `env` (cloudflare:workers): NAME, LOG_LEVEL, ENVIRONMENT, VERSION.
// Also the isolate's Default Logger, for getLogger() outside a Logging Context.
export const logger = defaultLoggerFromEnv()
