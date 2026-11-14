// What a caller can reach over a service binding: on a Traced Session stub, the session's own
// RPC methods, never TracedSession's `traced`, `logger` or `env`; on an entrypoint, its own
// methods, never TracedEntrypoint's Env Mapping, Logger Options or Root Logger hooks.
// scripts/e2e-local.mjs checks GET /session-surface and GET /entrypoint-surface.

import { Hono } from 'hono'
import { getTraceContext } from 'loggercf'
import { tracedSession } from 'loggercf/workers'
import type { BindService, LoggedMathService, ServiceSession, TracedMathService } from './types'

type Bindings = {
  BIND: ServiceSession<BindService>
  LOGGED: ServiceSession<LoggedMathService>
  TRACED: ServiceSession<TracedMathService>
}

/** How one call through a session stub ended: its value, or the error's message. */
type Outcome = { ok: true; value: unknown } | { ok: false; error: string }

async function attempt(fn: () => unknown): Promise<Outcome> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Call `traced` and read `logger` and `env` through a session stub, the members
 * `TracedSession` has but JSRPC must not expose.
 */
async function hiddenMembers(session: object) {
  // The stub's type has none of these; reach them as an RPC caller could.
  const stub = session as Record<string, any>
  return {
    traced: await attempt(() => stub.traced(() => 'ran', 'probe')),
    logger: await attempt(() => stub.logger),
    env: await attempt(() => stub.env),
  }
}

export const sessionSurface = new Hono<{ Bindings: Bindings }>()

/** GET /session-surface tracedWorker's and withLogging's sessions: hidden members, then a method */
sessionSurface.get('/session-surface', async (c) => {
  const bind = tracedSession(c.env.BIND)
  const logged = tracedSession(c.env.LOGGED)
  const body = {
    bind: { ...(await hiddenMembers(bind)), add: await attempt(() => bind.add(2, 3)) },
    // LoggedMath's methods through session() are checked by GET /logged.
    logged: await hiddenMembers(logged),
    spanId: getTraceContext()?.spanId,
  }
  return c.json(body)
})

/**
 * Read `envMapping`, `loggerOptions` and `rootLogger` through an entrypoint's binding: the
 * names TracedEntrypoint's hooks had as prototype getters, which JSRPC exposed. Through
 * `envMapping` a caller could also run a derive function on input it chose.
 */
async function entrypointHooks(binding: object) {
  // The binding's type has none of these; reach them as an RPC caller could.
  const stub = binding as Record<string, any>
  return {
    envMapping: await attempt(async () => {
      const mapping = await stub.envMapping
      return { mapping, derived: await mapping?.version?.({ CF_VERSION_METADATA: { id: 'x' } }) }
    }),
    loggerOptions: await attempt(() => stub.loggerOptions),
    rootLogger: await attempt(() => stub.rootLogger),
  }
}

/**
 * GET /entrypoint-surface tracedWorker's (BIND) and a TracedEntrypoint subclass's (TRACED)
 * entrypoints: hidden hooks, then a TRACED session method logging through its Root Logger
 */
sessionSurface.get('/entrypoint-surface', async (c) => {
  const traced = tracedSession(c.env.TRACED)
  const body = {
    bind: await entrypointHooks(c.env.BIND),
    traced: { ...(await entrypointHooks(c.env.TRACED)), cube: await attempt(() => traced.cube(3)) },
    spanId: getTraceContext()?.spanId,
  }
  return c.json(body)
})
