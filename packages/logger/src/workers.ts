import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';
import type { LogFields, LoggerOptions, LogLevel } from './types';
import { createLogger } from './logger';
import { runWithLogger, getTraceContext, getLogger } from './als';
import { buildTraceparent } from './trace';

/**
 * Base class for traced RPC sessions.
 *
 * Stores traceparent in a private field (`#traceparent`) which is never sent
 * over the wire, only prototype methods are exposed via JSRPC.
 * Subclass this with your RPC methods and wrap them with `this.traced()`.
 *
 * Usage (receiver):
 * ```ts
 * class MySession extends TracedSession {
 *   async add(a: number, b: number) {
 *     return this.traced(() => {
 *       getLogger().info({ a, b }, 'Adding')
 *       return a + b
 *     })
 *   }
 * }
 *
 * export default class extends WorkerEntrypoint<Env> {
 *   session(traceparent: string) {
 *     return new MySession(traceparent, {
 *       service: this.env.NAME,
 *       level: this.env.LOG_LEVEL,
 *     })
 *   }
 * }
 * ```
 */
export class TracedSession<E = unknown> extends RpcTarget {
  #traceparent: string;
  #loggerOptions: LoggerOptions;
  #fields: LogFields;
  /** Worker env — instance property, never exposed over RPC */
  protected env: E;

  constructor(traceparent: string, loggerOptions: LoggerOptions, env: E, fields?: LogFields) {
    super();
    this.#traceparent = traceparent;
    this.#loggerOptions = loggerOptions;
    this.#fields = fields ?? {};
    this.env = env;
  }

  /**
   * Run a function within the trace context carried by this session.
   * Sets up ALS with logger + traceparent so getLogger(), getTraceContext(), etc. work.
   *
   * When `operation` is provided, emits a structured span log with timing + status.
   */
  protected traced<R>(fn: () => R, operation?: string): R {
    const logger = createLogger(this.#loggerOptions);
    if (!operation) {
      return runWithLogger({ logger, traceparent: this.#traceparent, fields: this.#fields }, fn);
    }

    return runWithLogger({ logger, traceparent: this.#traceparent, fields: this.#fields }, () => {
      const startTime = Date.now();

      const emitSpan = (status: 'OK' | 'ERROR', error?: string) => {
        const endTime = Date.now();
        const span = {
          operation,
          startTime,
          endTime,
          duration: endTime - startTime,
          status,
          ...(error ? { error } : {}),
        };
        if (status === 'ERROR') {
          getLogger(this.#loggerOptions.service).error({ span }, 'span.end %s', operation);
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
            (err) => { emitSpan('ERROR', err instanceof Error ? err.message : String(err)); throw err; },
          ) as R;
        }
        emitSpan('OK');
        return result;
      } catch (err) {
        emitSpan('ERROR', err instanceof Error ? err.message : String(err));
        throw err;
      }
    });
  }

  /**
   * Logger scoped to the current trace context.
   * Must be called inside `this.traced()` — returns the ALS logger with traceId/spanId attached.
   */
  protected get logger() {
    return getLogger(this.#loggerOptions.service);
  }
}

/** Extract LoggerOptions from env using NAME/LOG_LEVEL convention */
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
 * Override `loggerOptions` getter for custom behavior.
 *
 * Usage:
 * ```ts
 * export default class extends TracedEntrypoint<Env> {
 *   session(traceparent: string) {
 *     return new MySession(traceparent, this.loggerOptions)
 *   }
 * }
 * ```
 */
export class TracedEntrypoint<E = unknown> extends WorkerEntrypoint<E> {
  protected get loggerOptions(): LoggerOptions {
    return envLoggerOptions(this.env);
  }
}

/**
 * Create a WorkerEntrypoint class that auto-implements `session()` for
 * the given TracedSession subclass. Zero boilerplate.
 *
 * Expects `env.NAME` and `env.LOG_LEVEL` by convention.
 *
 * Usage:
 * ```ts
 * class BindSession extends TracedSession {
 *   async add(a: number, b: number) {
 *     return this.traced(() => a + b)
 *   }
 * }
 *
 * // Zero-config entrypoint:
 * export default tracedWorker(BindSession)
 *
 * // Or extend if you need scheduled() etc:
 * export default class extends tracedWorker(BindSession) {
 *   scheduled() { ... }
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
    /** Cloudflare Workers always must include a fetch method */
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
 * Reads traceparent from the current ALS context and passes it to `binding.session()`.
 *
 * Usage (caller):
 * ```ts
 * const session = tracedSession(c.env.BIND)
 * const result = await session.add(5, 7)
 * ```
 *
 * With `using` for auto-disposal of the RPC stub:
 * ```ts
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
 * Creates a traced session, runs the callback, and returns the result.
 *
 * Usage:
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
