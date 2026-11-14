// What a caller can reach on a Traced Session stub: the session's own RPC methods, never
// TracedSession's `traced`, `logger` or `env`. scripts/e2e-local.mjs checks GET /session-surface.

import { Hono } from 'hono'
import { getTraceContext } from 'loggercf'
import { tracedSession } from 'loggercf/workers'
import type { BindService, LoggedMathService, ServiceSession } from './types'

type Bindings = {
  BIND: ServiceSession<BindService>
  LOGGED: ServiceSession<LoggedMathService>
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
