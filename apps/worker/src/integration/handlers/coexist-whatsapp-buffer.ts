import { createHash } from "node:crypto"
import { db } from "@chatbotx.io/database/client"
import {
  coexistSyncRunModel,
  whatsappCoexistStagingModel,
} from "@chatbotx.io/database/schema"
import { createId } from "@chatbotx.io/utils"
import {
  IntegrationJobAction,
  type IntegrationJobCoexistWhatsappBuffer,
  integrationQueue,
} from "@chatbotx.io/worker-config"
import { logger } from "../../lib/logger"

const hashPayload = (payload: unknown): string =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex")

/**
 * Buffers a raw WhatsApp Coexistence history payload into the staging table.
 *
 * The webhook always buffers — it never decides billing. If the integration
 * already has `coexistEnabled = true` (user confirmed the popup earlier), this
 * chains a flush immediately; otherwise the payload waits in staging until the
 * popup decision enqueues a flush.
 */
export const coexistWhatsappBuffer = async (
  data: IntegrationJobCoexistWhatsappBuffer["data"],
): Promise<void> => {
  const { phoneNumberId, payload } = data

  // Validate ownership BEFORE touching the staging table — otherwise a
  // spoofed or stale phoneNumberId would orphan rows that no flush can
  // ever drain (no integration row exists to gate them).
  const integration = await db.query.integrationWhatsappModel.findFirst({
    where: { phoneNumberId },
  })

  if (!integration) {
    logger.warn(
      { phoneNumberId },
      "[coexist] Dropped history payload for unknown WhatsApp integration",
    )
    return
  }

  // Idempotency: Meta retries webhook deliveries. (phoneNumberId, payloadHash)
  // is uniquely indexed, so duplicate deliveries collapse to one staging row.
  await db
    .insert(whatsappCoexistStagingModel)
    .values({
      id: createId(),
      phoneNumberId,
      payload,
      payloadHash: hashPayload(payload),
    })
    .onConflictDoNothing()

  if (integration.coexistEnabled) {
    // Create the run row here so the flush handler receives a pre-existing runId
    // and only needs to UPDATE it to 'running' on entry.
    const [run] = await db
      .insert(coexistSyncRunModel)
      .values({
        workspaceId: integration.workspaceId,
        integrationId: integration.id,
        channel: "whatsapp",
        status: "init",
        triggerSource: "buffer-chain",
      })
      .returning({ id: coexistSyncRunModel.id })

    if (!run) {
      logger.error(
        { phoneNumberId },
        "[coexist] Buffer: failed to create run row",
      )
      return
    }

    await integrationQueue.add(IntegrationJobAction.coexistWhatsappFlush, {
      type: IntegrationJobAction.coexistWhatsappFlush,
      data: { runId: run.id, phoneNumberId },
    })
  }
}
