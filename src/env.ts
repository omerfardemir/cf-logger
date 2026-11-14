import { createLogger } from './logger'
import type { LoggerOptions, LogLevel } from './types'

/**
 * Where one Logger Options field comes from: the name of an env var, or a
 * function that derives the value from env (e.g. from a `version_metadata` binding).
 *
 * A number is used as its string form (`"VERSION": 2` gives `'2'`). A missing
 * var, an empty string, any other non-string value, or `undefined` from the
 * function counts as absent.
 *
 * @template E - The worker or process environment type.
 */
export type EnvSource<E = unknown> = string | ((env: E) => string | undefined)

/**
 * Per-field override of the env vars `loggerOptionsFromEnv()` reads. Fields you
 * leave out keep their default var: `NAME`, `LOG_LEVEL`, `ENVIRONMENT`, `VERSION`.
 *
 * @template E - The worker or process environment type.
 *
 * @example
 * ```ts
 * const mapping: EnvMapping<Env> = {
 *   version: (env) => env.CF_VERSION_METADATA?.id, // or 'RELEASE' to read another var
 * }
 * ```
 */
export interface EnvMapping<E = unknown> {
  /** Source of `service`. Default `'NAME'`; falls back to `'unknown'` when absent. */
  service?: EnvSource<E>
  /** Source of `level`. Default `'LOG_LEVEL'`; falls back to `'info'` when absent or invalid. */
  level?: EnvSource<E>
  /** Source of `environment`. Default `'ENVIRONMENT'`; omitted when absent. */
  environment?: EnvSource<E>
  /** Source of `version`. Default `'VERSION'`; omitted when absent. */
  version?: EnvSource<E>
}

const DEFAULT_VARS = {
  service: 'NAME',
  level: 'LOG_LEVEL',
  environment: 'ENVIRONMENT',
  version: 'VERSION',
} as const

const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']

/** Whether the invalid-level warning has been written in this isolate. */
let warnedInvalidLevel = false

/**
 * Read one field from env through its source. Absent values become `undefined`.
 *
 * @template E - The environment type.
 * @param {E} env - The environment object.
 * @param {EnvSource<E>} source - Var name or derive function.
 * @returns {string | undefined} The non-empty string (or finite number as a string), or `undefined`.
 */
function read<E>(env: E, source: EnvSource<E>): string | undefined {
  const value: unknown =
    typeof source === 'function' ? source(env) : (env as Record<string, unknown> | null)?.[source]
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Validate a level, falling back to `'info'`. An invalid value writes one WARN per isolate.
 *
 * @param {string | undefined} value - The level read from env.
 * @param {string} levelVar - The var it was read from (or `'level'` for a function), named in the warning.
 * @param {LoggerOptions} options - The other Logger Options, so the warning carries `service` etc.
 * @returns {LogLevel} A valid level.
 */
function resolveLevel(
  value: string | undefined,
  levelVar: string,
  options: LoggerOptions,
): LogLevel {
  if (value === undefined) return 'info'
  if ((LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel
  if (!warnedInvalidLevel) {
    warnedInvalidLevel = true
    createLogger({ ...options, level: 'info' }).warn(
      { invalidLevel: value, validLevels: [...LOG_LEVELS] },
      `${levelVar} "${value}" is not a valid log level; using "info"`,
    )
  }
  return 'info'
}

/**
 * Build Logger Options from env.
 *
 * By default it reads `NAME`, `LOG_LEVEL`, `ENVIRONMENT` and `VERSION`. Pass a
 * mapping to read other var names or derive a field with a function. `service`
 * falls back to `'unknown'` and `level` to `'info'`; an absent `environment` or
 * `version` is left out, so log lines omit it. An invalid level falls back to
 * `'info'` and writes one WARN per isolate.
 *
 * @template E - The worker or process environment type.
 * @param {E} env - The worker or process environment object.
 * @param {EnvMapping<E>} [mapping] - Per-field var name or derive function.
 * @returns {LoggerOptions} Logger Options derived from env.
 *
 * @example
 * ```ts
 * loggerOptionsFromEnv(env) // NAME, LOG_LEVEL, ENVIRONMENT, VERSION
 * loggerOptionsFromEnv(env, { version: 'RELEASE' }) // read another var
 * loggerOptionsFromEnv(env, { version: (e) => e.CF_VERSION_METADATA?.id }) // derive it
 * ```
 */
export function loggerOptionsFromEnv<E = unknown>(
  env: E,
  mapping: EnvMapping<E> = {},
): LoggerOptions {
  const field = (key: keyof EnvMapping) => read(env, mapping[key] ?? DEFAULT_VARS[key])
  const environment = field('environment')
  const version = field('version')
  const options: LoggerOptions = {
    service: field('service') ?? 'unknown',
    ...(environment ? { environment } : {}),
    ...(version ? { version } : {}),
  }
  const levelSource = mapping.level ?? DEFAULT_VARS.level
  const levelVar = typeof levelSource === 'string' ? levelSource : 'level'
  return { ...options, level: resolveLevel(field('level'), levelVar, options) }
}

/**
 * Re-arm the one-time invalid-level warning.
 *
 * @internal Called by `_reset()` in tests; not part of the public API.
 */
export function _resetEnvWarnings(): void {
  warnedInvalidLevel = false
}
