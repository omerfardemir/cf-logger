/** Shared RPC service interfaces */

export interface ServiceSession<T> {
  session(traceparent: string, fields?: Record<string, unknown>): T;
}

/** bind-worker: math operations + multi-hop demo */
export interface BindService {
  add(a: number, b: number): Promise<number>;
  multiHop(value: number): Promise<number>;
}

/** math-worker: downstream worker called by bind-worker */
export interface MathService {
  multiply(a: number, b: number): Promise<number>;
  divide(a: number, b: number): Promise<number>;
}