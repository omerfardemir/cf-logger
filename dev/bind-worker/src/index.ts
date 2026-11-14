import { TracedSession, tracedWorker, withTrace } from 'loggercf/workers'
import { getLogger, type LogLevel } from 'loggercf'
import type { BindService, MathService, ServiceSession } from '../../services'
import { http } from './http'

interface Env {
  ENVIRONMENT: string
  RELEASE: string
  VERSION: string
  NAME: string
  LOG_LEVEL: LogLevel
  MATH: ServiceSession<MathService>
}

class BindSession extends TracedSession<Env> implements BindService {
  /** Simple operation single hop */
  async add(a: number, b: number): Promise<number> {
    return this.traced(() => {
      const result = a + b
      this.logger.info({ a, b, result }, 'Added %d + %d = %d', a, b, result)
      return result
    }, 'bind.add')
  }

  /** Multi-hop demo: bind-worker → math-worker (trace propagates automatically) */
  async multiHop(value: number): Promise<number> {
    // Outside this.traced(): logs through the Default Logger tracedWorker registered.
    getLogger().info({ value }, 'bind.multiHop received')
    return this.traced(async () => {
      this.logger.info({ value }, 'Starting multi-hop: will multiply then divide')

      // Hop 1: multiply via math-worker (trace propagates A → B → C)
      const multiplied = await withTrace(this.env.MATH, (s) => s.multiply(value, 3))
      this.logger.debug({ multiplied }, 'After multiply')

      // Hop 2: divide via math-worker (same trace continues)
      const divided = await withTrace(this.env.MATH, (s) => s.divide(multiplied, 2))
      this.logger.debug({ divided }, 'After divide')

      this.logger.info({ input: value, output: divided }, 'Multi-hop complete')
      return divided
    }, 'bind.multiHop')
  }

  /** Error demo: bind-worker -> math-worker division by zero */
  async divideByZero(value: number): Promise<number> {
    return this.traced(async () => {
      this.logger.info({ value }, 'Triggering downstream division by zero')
      return withTrace(this.env.MATH, (s) => s.divide(value, 0))
    }, 'bind.divideByZero')
  }
}

export default class extends tracedWorker(BindSession) {
  /** HTTP over the service binding: see ./http.ts. */
  fetch(request?: Request): Response | Promise<Response> {
    return http.fetch(request as Request)
  }
}
