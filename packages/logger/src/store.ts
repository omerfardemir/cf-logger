import { AsyncLocalStorage } from 'node:async_hooks'
import type { ALSStore } from './types'

/**
 * The single `AsyncLocalStorage` instance shared across the logger package.
 *
 * Stores per-request trace context, user fields, and the scoped logger.
 */
export const als = new AsyncLocalStorage<ALSStore>()
