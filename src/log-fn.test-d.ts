// Type tests for the log methods. Not run by vitest: `pnpm typecheck` compiles
// this file, so a call that should compile and doesn't (or a `@ts-expect-error`
// that no longer errors) fails the build.
import type { LogFields, Logger } from './types'

interface AppFields extends LogFields {
  userId: string
  tenant?: string
}

export function callStyles(logger: Logger, typed: Logger<AppFields>, caught: unknown): void {
  const err = new Error('boom')

  // Console style.
  logger.info('x', { a: 1 })
  logger.error('x', err)
  logger.info('a', 'b', 3)
  logger.info('user %s signed in', 'ada', { plan: 'pro' })
  logger.error('failed', caught)
  logger.warn('plain')

  // Structured style.
  logger.info({ userId: 42 }, 'user signed in')
  logger.info({ a: 1 }, 'structured with extra', { b: 2 })
  logger.error(err)
  logger.error(err, 'failed %s', 'job')
  logger.error({ err: caught }, 'x')
  logger.info({ nested: { deep: [1, 2] }, when: new Date() })

  // An object whose type is an interface (no index signature) is accepted.
  const span: { operation: string; duration: number } = { operation: 'op', duration: 1 }
  logger.info({ span }, 'span.end %s', 'op')
  interface Payload {
    id: string
  }
  const payload: Payload = { id: 'p-1' }
  logger.info(payload, 'got payload')

  // Declared fields autocomplete and are checked; others are free.
  typed.info({ userId: 'u-1', extra: true }, 'typed')
  typed.info({ tenant: 'acme' })
  // @ts-expect-error userId is declared as a string
  typed.info({ userId: 42 }, 'wrong type')

  // @ts-expect-error the message after an object must be a string
  logger.info({ a: 1 }, 42)
  // @ts-expect-error the message after an Error must be a string
  logger.error(err, { a: 1 })
  // @ts-expect-error a log method needs a message, an Error or fields first
  logger.info(42)
}
