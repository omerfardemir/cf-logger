import { TracedSession, tracedWorker } from 'loggercf/workers'
import type { LogLevel } from 'loggercf'
import type { MathService } from '../../services'

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

export default tracedWorker(MathSession, {
  env: { version: (env) => env.CF_VERSION_METADATA?.tag || env.CF_VERSION_METADATA?.id },
})
