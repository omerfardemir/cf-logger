import { AsyncLocalStorage } from 'node:async_hooks'
import type { ALSStore } from './types'

/** The single ALS instance shared across the logger package */
export const als = new AsyncLocalStorage<ALSStore>()
