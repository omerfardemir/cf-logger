/** Shared RPC service interfaces */

import type { TracedServiceBinding } from 'cf-logger'

export type ServiceSession<T> = TracedServiceBinding<T>

/** bind-worker: math operations + multi-hop demo */
export interface BindService {
  add(a: number, b: number): Promise<number>
  multiHop(value: number): Promise<number>
  divideByZero(value: number): Promise<number>
}

/** math-worker: downstream worker called by bind-worker */
export interface MathService {
  multiply(a: number, b: number): Promise<number>
  divide(a: number, b: number): Promise<number>
}
