import { WorkerEntrypoint } from 'cloudflare:workers'
import { TracedSession, tracedWorker, withLogging } from 'loggercf/workers'
import { getLogger, type LogLevel } from 'loggercf'
import type { LoggedMathService, MathService } from '../../services'

interface Env {
  ENVIRONMENT: string
  CF_VERSION_METADATA: WorkerVersionMetadata
  NAME: string
  LOG_LEVEL: LogLevel
}

class MathSession extends TracedSession<Env> implements MathService {
  async multiply(a: number, b: number): Promise<number> {
    return this.traced(() => {
      const result = a * b
      this.logger.info({ a, b, result }, 'Multiplied %d × %d = %d', a, b, result)
      return result
    }, 'math.multiply')
  }

  async divide(a: number, b: number): Promise<number> {
    return this.traced(() => {
      if (b === 0) {
        this.logger.error({ a, b }, 'Division by zero attempted')
        throw new Error('Division by zero')
      }
      const result = a / b
      this.logger.info({ a, b, result }, 'Divided %d / %d = %d', a, b, result)
      return result
    }, 'math.divide')
  }
}

const envMapping = {
  version: (env: Env) => env.CF_VERSION_METADATA?.tag || env.CF_VERSION_METADATA?.id,
}

export default tracedWorker(MathSession, { env: envMapping })

/**
 * A plain WorkerEntrypoint, mid-migration: no `this.traced()` in its methods.
 * withLogging() gives every call a Logging Context, and `session: true` lets
 * migrated callers (`withTrace(env.LOGGED, ...)`) continue their trace.
 */
class LoggedMath extends WorkerEntrypoint<Env> implements LoggedMathService {
  async square(n: number): Promise<number> {
    const result = n * n
    getLogger().info({ n, result }, 'Squared %d = %d', n, result)
    return result
  }

  async fail(): Promise<never> {
    getLogger().warn('LoggedMath.fail is about to throw')
    throw new Error('LoggedMath failure')
  }

  fetch(request: Request): Response {
    getLogger().info({ path: new URL(request.url).pathname }, 'LoggedMath fetch')
    return new Response('pong')
  }
}

// Bound in dev/main-worker/wrangler.jsonc as LOGGED, with `"entrypoint": "LoggedMath"`.
const LoggedMathEntrypoint = withLogging(LoggedMath, {
  spans: true,
  session: true,
  env: envMapping,
})
export { LoggedMathEntrypoint as LoggedMath }
