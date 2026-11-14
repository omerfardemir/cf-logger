// Units of work outside HTTP: a cron run, queue messages, a Workflow and a Durable
// Object, each in its own Logging Context through the loggercf/workers helpers.
// scripts/e2e-local.mjs drives them through the routes below.

import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers'
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers'
import { Hono } from 'hono'
import { getLogger, getTraceCarrier, getTraceContext, type TraceCarrier } from 'loggercf'
import {
  tracedStep,
  withLogging,
  withQueueMessage,
  withScheduled,
  withWorkflow,
} from 'loggercf/workers'

/** A queue message: the payload plus the producer's Trace Carrier. */
export interface Job {
  job: string
  trace: TraceCarrier
}

/** The Workflow's params: the input plus the creator's Trace Carrier. */
interface ReportParams {
  n: number
  trace: TraceCarrier
}

/** Cron: one Logging Context per run, with cron and scheduledTime. */
export const scheduled = withScheduled(async (controller: ScheduledController, env: Env) => {
  getLogger().info({ worker: env.NAME }, 'cron tick')
})

/** Queue consumer: one Logging Context per message; this code decides ack/retry. */
export async function queue(batch: MessageBatch<Job>): Promise<void> {
  for (const message of batch.messages) {
    await withQueueMessage(batch, message, async () => {
      getLogger().info({ job: message.body.job }, 'queue job processed')
      message.ack()
    })
  }
}

/**
 * A Durable Object: fetch, RPC methods and alarm each run in a Logging Context.
 * Bound as ROOM in dev/main-worker/wrangler.jsonc. The class expression keeps the
 * name `Room` for the `durableObject` field; the type alias lets `wrangler types`
 * use the export as a type.
 */
export const Room = withLogging(
  class Room extends DurableObject<Env> {
    async join(user: string): Promise<string> {
      getLogger().info({ user }, 'Room join')
      await this.ctx.storage.setAlarm(Date.now())
      return `${user} joined`
    }

    async fail(): Promise<never> {
      throw new Error('Room failure')
    }

    fetch(): Response {
      getLogger().info('Room fetch')
      return new Response('room pong')
    }

    alarm(): void {
      getLogger().info('Room alarm')
    }
  },
  { spans: true },
)
export type Room = InstanceType<typeof Room>

/** A Workflow: `run` in a Logging Context, each step attempt a Span. Bound as REPORT. */
export const Report = withWorkflow(
  class Report extends WorkflowEntrypoint<Env, ReportParams> {
    async run(event: WorkflowEvent<ReportParams>, step: WorkflowStep): Promise<number> {
      getLogger().info('Report run')
      const doubled = await tracedStep(
        step,
        'double',
        { retries: { limit: 2, delay: 10 } },
        async (ctx) => {
          getLogger().info('Report doubling')
          // The first attempt fails, so the e2e sees an ERROR Span and a retry.
          if (ctx.attempt === 1) throw new Error('Report flaky')
          return event.payload.n * 2
        },
      )
      getLogger().info({ doubled }, 'Report done')
      return doubled
    }
  },
)
export type Report = InstanceType<typeof Report>

/** The routes that start each unit of work, carrying this request's trace. */
export const units = new Hono<{ Bindings: Env }>()

units.get('/durable-object', async (c) => {
  const room = c.env.ROOM.getByName('e2e-room')
  const joined = await room.join('ada')
  const { traceparent } = getTraceCarrier()
  const pong = await (
    await room.fetch('https://room/ping', { headers: traceparent ? { traceparent } : {} })
  ).text()
  let error: string | undefined
  try {
    await room.fail()
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  return c.json({ joined, pong, error, spanId: getTraceContext()?.spanId })
})

units.get('/queue', async (c) => {
  await c.env.JOBS.send({ job: 'e2e', trace: getTraceCarrier() })
  return c.json({ sent: true, spanId: getTraceContext()?.spanId })
})

units.get('/workflow', async (c) => {
  const instance = await c.env.REPORT.create({ params: { n: 21, trace: getTraceCarrier() } })
  return c.json({ instanceId: instance.id, spanId: getTraceContext()?.spanId })
})
