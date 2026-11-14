import { WorkerEntrypoint } from 'cloudflare:workers'
import {
  TracedEntrypoint,
  TracedSession,
  tracedWorker,
  withLogging,
  type EnvMapping,
  type SessionInit,
} from 'loggercf/workers'
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

/** TracedMath's session: one method, its own Span name, so main's span checks stay unambiguous. */
class TracedMathSession extends TracedSession<Env> {
  async cube(n: number): Promise<number> {
    return this.traced(() => {
      const result = n * n * n
      this.logger.info({ n, result }, 'Cubed %d = %d', n, result)
      return result
    }, 'tracedMath.cube')
  }
}

/**
 * A hand-written TracedEntrypoint whose Env Mapping hook derives `version` from env. Its
 * hooks are keyed by symbols (`TracedEntrypoint.envMapping` and the rest), so a caller
 * holding the binding (main's TRACED) cannot read them or run the derive function.
 * Bound in dev/main-worker/wrangler.jsonc with `"entrypoint": "TracedMath"`.
 */
export class TracedMath extends TracedEntrypoint<Env> {
  protected override get [TracedEntrypoint.envMapping](): EnvMapping<Env> {
    return { version: (env) => `traced-${env.CF_VERSION_METADATA?.id}` }
  }

  fetch(): Response {
    return new Response(null, { status: 404 })
  }

  session(init: SessionInit): TracedMathSession {
    return new TracedMathSession(init, this[TracedEntrypoint.rootLogger], this.env)
  }
}
