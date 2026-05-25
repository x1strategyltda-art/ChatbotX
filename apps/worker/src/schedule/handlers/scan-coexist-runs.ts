import { db, sql } from "@chatbotx.io/database/client"
import { getChildLogger } from "@chatbotx.io/logger"
import {
  IntegrationJobAction,
  integrationQueue,
} from "@chatbotx.io/worker-config"

const log = getChildLogger("scan-coexist-runs")

const BATCH = 500
const MAX_ATTEMPTS = 5

type PickedRun = {
  id: string
  attempts: number
  channel: "whatsapp" | "messenger"
  integrationId: string
  workspaceId: string
}

export async function scanCoexistRuns(): Promise<void> {
  // Cap runs that have exhausted all retries → mark failed.
  await db.execute(sql`
    UPDATE "CoexistSyncRun"
    SET status = 'failed',
        "currentError" = 'Max scheduler retries exceeded',
        "finishedAt" = NOW(),
        "updatedAt" = NOW()
    WHERE attempts >= ${MAX_ATTEMPTS}
      AND status IN ('init', 'running')
  `)

  // Atomically pick eligible runs and increment attempts.
  const picked = await db.execute<PickedRun>(sql`
    UPDATE "CoexistSyncRun"
    SET attempts = attempts + 1,
        status = 'init',
        "updatedAt" = NOW()
    WHERE id IN (
      SELECT id FROM "CoexistSyncRun"
      WHERE (
        (status = 'init' AND "createdAt" < NOW() - INTERVAL '10 seconds')
        OR (status = 'running' AND "lastHeartbeatAt" < NOW() - INTERVAL '1 hour')
      )
      AND attempts < ${MAX_ATTEMPTS}
      ORDER BY "createdAt" ASC
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, attempts, channel, "integrationId", "workspaceId"
  `)

  if (picked.rows.length === 0) {
    return
  }

  log.info({ count: picked.rows.length }, "scanCoexistRuns: picked runs")

  for (const run of picked.rows) {
    try {
      if (run.channel === "whatsapp") {
        const integ = await db.query.integrationWhatsappModel.findFirst({
          where: { id: run.integrationId },
          columns: { phoneNumberId: true },
        })

        if (!integ?.phoneNumberId) {
          await db.execute(sql`
            UPDATE "CoexistSyncRun"
            SET status = 'failed',
                "currentError" = 'integration missing phoneNumberId',
                "finishedAt" = NOW(),
                "updatedAt" = NOW()
            WHERE id = ${run.id}
          `)
          log.warn(
            { runId: run.id },
            "scanCoexistRuns: missing phoneNumberId, marked failed",
          )
          continue
        }

        await integrationQueue.add(
          IntegrationJobAction.coexistWhatsappFlush,
          {
            type: IntegrationJobAction.coexistWhatsappFlush,
            data: { runId: run.id, phoneNumberId: integ.phoneNumberId },
          },
          {
            jobId: `coexist-run-${run.id}-${run.attempts}`,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: { count: 100 },
          },
        )
      } else {
        await integrationQueue.add(
          IntegrationJobAction.coexistMessengerSync,
          {
            type: IntegrationJobAction.coexistMessengerSync,
            data: {
              runId: run.id,
              integrationId: run.integrationId,
              workspaceId: run.workspaceId,
            },
          },
          {
            jobId: `coexist-run-${run.id}-${run.attempts}`,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: { count: 100 },
          },
        )
      }
    } catch (err) {
      log.error({ err, runId: run.id }, "scanCoexistRuns: enqueue failed")
    }
  }
}
