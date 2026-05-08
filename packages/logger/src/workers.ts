import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';
import type { LogFields, LoggerOptions, LogLevel } from './types';
import { LoggerFactory, getTraceContext, getLogger } from './logger';
import { buildTraceparent, resolveTrace } from './trace';

/**
 * Base class for traced RPC sessions.
 *
 * Stores `traceparent` in a private field (`#traceparent`) which is never sent
 * over the wire only prototype methods are exposed via JSRPC.
 * Subclass this with your RPC methods and wrap them with `this.traced()`.
 *
 * @template E - The worker environment type.
 *
 * @example
 * ```ts
 * class MySession extends TracedSession<Env> {
 *   async add(a: number, b: number) {
 *     return this.traced(() => {
 *       this.logger.info({ a, b }, 'adding')
 *       return a + b
 *     }, 'math.add')
 *   }
 * }
 *
 * export default tracedWorker(MySession)
 * ```
 */
export class TracedSession<E = unknown> extends RpcTarget {
  #traceparent: string;
  #loggerOptions: LoggerOptions;
  #fields: LogFields;
  #factory: LoggerFactory;
  /** Worker env instance property, never exposed over RPC. */
  protected env: E;

  /**
   * @param {string} traceparent - The W3C `traceparent` header value from the caller.
   * @param {LoggerOptions} loggerOptions - Logger configuration for this session.
   * @param {E} env - The worker environment bindings.
   * @param {LogFields} [fields] - Optional initial log fields.
   */
  constructor(traceparent: string, loggerOptions: LoggerOptions, env: E, fields?: LogFields) {
    super();
    this.#traceparent = traceparent;
    this.#loggerOptions = loggerOptions;
    this.#fields = fields ?? {};
    this.#factory = new LoggerFactory(loggerOptions);
    this.env = env;
  }

  /**
   * Run a function within the trace context carried by this session.
   *
   * Sets up ALS with logger + traceparent so `getLogger()`, `getTraceContext()`, etc. work.
   * When `operation` is provided, emits a structured span log with timing and status.
   *
   * @template R - The return type of `fn`.
   * @param {() => R} fn - The function to execute inside the trace context.
   * @param {string} [operation] - Operation name for span logging (e.g. `'bind.add'`).
   * @returns {R} The return value of `fn`.
   */
  protected traced<R>(fn: () => R, operation?: string): R {
    const trace = resolveTrace(this.#traceparent);
    const sampled = (trace.traceFlags & 0x01) === 0x01;

    if (!operation || !sampled) {
      return this.#factory.runInContext(trace, fn, this.#fields);
    }

    return this.#factory.runInContext(trace, () => {
      const startTime = Date.now();

      const emitSpan = (status: 'OK' | 'ERROR', error?: unknown) => {
        const endTime = Date.now();
        const span = {
          operation,
          startTime,
          endTime,
          duration: endTime - startTime,
          status,
          ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
        };
        if (status === 'ERROR') {
          getLogger(this.#loggerOptions.service).error({ span, err: error }, 'span.end %s', operation);
        } else {
          getLogger(this.#loggerOptions.service).info({ span }, 'span.end %s', operation);
        }
      };

      try {
        const result = fn();
        // Handle async functions
        if (result instanceof Promise) {
          return result.then(
            (v) => { emitSpan('OK'); return v; },
            (err) => { emitSpan('ERROR', err); throw err; },
          ) as R;
        }
        emitSpan('OK');
        return result;
      } catch (err) {
        emitSpan('ERROR', err);
        throw err;
      }
    });
  }

  /**
   * Logger scoped to the current trace context.
   *
   * Must be called inside `this.traced()` returns the ALS logger with
   * `traceId` / `spanId` attached.
   *
   * @returns {Logger} The request-scoped logger.
   */
  protected get logger() {
    return getLogger(this.#loggerOptions.service);
  }
}

/**
 * Extract `LoggerOptions` from env using the `NAME` / `LOG_LEVEL` convention.
 *
 * @param {unknown} env - The worker environment object.
 * @returns {LoggerOptions} Logger options derived from env vars.
 */
function envLoggerOptions(env: unknown): LoggerOptions {
  const e = env as Record<string, unknown>;
  return {
    service: (e.NAME as string) ?? 'unknown',
    level: ((e.LOG_LEVEL as string) ?? 'info') as LogLevel,
    environment: (e.ENVIRONMENT as string) ?? 'unknown',
    version: (e.VERSION as string) ?? 'unknown',
  };
}

/**
 * Base class for RPC worker entrypoints with automatic `loggerOptions` from env.
 *
 * Expects `env.NAME` and `env.LOG_LEVEL` by convention.
 * Override the `loggerOptions` getter for custom behavior.
 *
 * @template E - The worker environment type.
 *
 * @example
 * ```ts
 * export default class extends TracedEntrypoint<Env> {
 *   session(traceparent: string) {
 *     return new MySession(traceparent, this.loggerOptions, this.env)
 *   }
 * }
 * ```
 */
export class TracedEntrypoint<E = unknown> extends WorkerEntrypoint<E> {
  /**
   * Logger options derived from `env.NAME`, `env.LOG_LEVEL`, `env.ENVIRONMENT`, and `env.VERSION`.
   *
   * @returns {LoggerOptions} The logger options.
   */
  protected get loggerOptions(): LoggerOptions {
    return envLoggerOptions(this.env);
  }
}

/**
 * Create a `WorkerEntrypoint` class that auto-implements `session()` for
 * the given `TracedSession` subclass. Zero boilerplate.
 *
 * Expects `env.NAME` and `env.LOG_LEVEL` by convention.
 *
 * @template S - The `TracedSession` subclass.
 * @param {new (...args: any[]) => S} SessionClass - The session class to wrap.
 * @returns A `WorkerEntrypoint` class with `session()` and `fetch()` implemented.
 *
 * @example
 * ```ts
 * class BindSession extends TracedSession<Env> {
 *   async add(a: number, b: number) {
 *     return this.traced(() => a + b, 'bind.add')
 *   }
 * }
 *
 * // Zero-config entrypoint:
 * export default tracedWorker(BindSession)
 *
 * // Or extend if you need scheduled(), etc.:
 * export default class extends tracedWorker(BindSession) {
 *   scheduled() { /* ... *\/ }
 * }
 * ```
 */
export function tracedWorker<S extends TracedSession>(
  SessionClass: new (traceparent: string, options: LoggerOptions, env: any, fields?: LogFields) => S,
): {
  new (...args: any[]): {
    session(traceparent: string, fields?: LogFields): S;
    fetch(): Response | Promise<Response>;
  };
} {
  return class extends WorkerEntrypoint {
    /**
     * Cloudflare Workers entrypoints must include a `fetch` method.
     *
     * @returns {Response | Promise<Response>} A 404 response.
     */
    fetch(): Response | Promise<Response> {
      return new Response(null, { status: 404 });
    }

    session(traceparent: string, fields?: LogFields): S {
      return new SessionClass(traceparent, envLoggerOptions(this.env), this.env, fields);
    }
  } as any;
}

/**
 * Create a traced session from a service binding.
 *
 * Reads `traceparent` from the current ALS context and passes it to `binding.session()`.
 *
 * @template T - The session type returned by `binding.session()`.
 * @param {object} binding - The service binding with a `session()` method.
 * @param {LogFields} [fields] - Optional log fields to forward to the session.
 * @returns {T} A traced session stub.
 *
 * @example
 * ```ts
 * const session = tracedSession(c.env.BIND)
 * const result = await session.add(5, 7)
 *
 * // With `using` for auto-disposal:
 * using session = tracedSession(c.env.BIND)
 * const result = await session.add(5, 7)
 * ```
 */
export function tracedSession<T>(binding: {
  session(traceparent: string, fields?: LogFields): T;
}, fields?: LogFields): T {
  const trace = getTraceContext();
  const traceparent = trace ? buildTraceparent(trace) : '';
  return binding.session(traceparent, fields);
}

/**
 * Create a traced session, run the callback, and return the result.
 *
 * @template T - The session type returned by `binding.session()`.
 * @template R - The return type of `fn`.
 * @param {object} binding - The service binding with a `session()` method.
 * @param {(session: T) => Promise<R> | R} fn - Callback that receives the traced session.
 * @param {LogFields} [fields] - Optional log fields to forward to the session.
 * @returns {Promise<R>} The result of `fn`.
 *
 * @example
 * ```ts
 * const result = await withTrace(c.env.BIND, s => s.add(5, 7))
 *
 * // With propagated fields:
 * const result = await withTrace(c.env.BIND, s => s.add(5, 7), { requestId: 'abc' })
 * ```
 */
export async function withTrace<T, R>(
  binding: { session(traceparent: string, fields?: LogFields): T },
  fn: (session: T) => Promise<R> | R,
  fields?: LogFields,
): Promise<R> {
  const session = tracedSession(binding, fields);
  return fn(session);
}
