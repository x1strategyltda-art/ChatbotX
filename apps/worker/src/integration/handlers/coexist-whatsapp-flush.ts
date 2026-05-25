import { and, db, eq, findOrFail, isNull } from "@chatbotx.io/database/client"
import {
  coexistSyncRunModel,
  inboxModel,
  whatsappCoexistStagingModel,
} from "@chatbotx.io/database/schema"
import type { IncomingContact, IncomingMessage } from "@chatbotx.io/sdk"
import type { IntegrationJobCoexistWhatsappFlush } from "@chatbotx.io/worker-config"
import { z } from "zod"
import { logger } from "../../lib/logger"
import { upsertContactAndMessage } from "./upsert-contact-message"

/**
 * WhatsApp Coexistence webhook payloads are loosely documented. Schemas are
 * intentionally permissive (`.passthrough()`, optional fields) — unrecognized
 * shapes are skipped rather than crashing the flush job.
 */
const waProfileSchema = z.object({ name: z.string().optional() }).passthrough()

const waContactSchema = z
  .object({ wa_id: z.string(), profile: waProfileSchema.optional() })
  .passthrough()

const waMessageSchema = z
  .object({
    id: z.string(),
    from: z.string().optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    type: z.string().optional(),
    text: z.object({ body: z.string() }).passthrough().optional(),
  })
  .passthrough()

const waThreadSchema = z
  .object({
    id: z.string(),
    messages: z.array(waMessageSchema).optional(),
  })
  .passthrough()

const waHistoryEntrySchema = z
  .object({ threads: z.array(waThreadSchema).optional() })
  .passthrough()

const smbStateSyncEntrySchema = z
  .object({
    type: z.string().optional(),
    action: z.string().optional(),
    contact: z
      .object({
        phone_number: z.string().optional(),
        full_name: z.string().optional(),
        first_name: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

const waValueSchema = z
  .object({
    contacts: z.array(waContactSchema).optional(),
    history: z.array(waHistoryEntrySchema).optional(),
    smb_app_state_sync: z.array(smbStateSyncEntrySchema).optional(),
  })
  .passthrough()

type ContactWithMessage = {
  contact: IncomingContact
  message: (IncomingMessage & { createdAt?: Date }) | null
}

const toDate = (timestamp: string | number | undefined): Date => {
  if (timestamp === undefined) {
    return new Date()
  }
  const seconds = Number(timestamp)
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date()
}

/**
 * Extracts contacts + historical messages from one buffered `changes[].value`
 * slice. Group chats are not synced by WhatsApp Coexistence, so every thread
 * here is a 1:1 conversation keyed by the customer `wa_id`.
 */
const extractFromValue = (payload: unknown): ContactWithMessage[] => {
  const parsed = waValueSchema.safeParse(payload)
  if (!parsed.success) {
    logger.warn(
      { error: parsed.error.message },
      "[coexist] Unrecognized WhatsApp history payload — skipped",
    )
    return []
  }
  const value = parsed.data

  const nameByWaId = new Map<string, string>()
  for (const contact of value.contacts ?? []) {
    if (contact.profile?.name) {
      nameByWaId.set(contact.wa_id, contact.profile.name)
    }
  }

  const results: ContactWithMessage[] = []

  for (const entry of value.history ?? []) {
    for (const thread of entry.threads ?? []) {
      const customerWaId = thread.id
      const contact: IncomingContact = {
        sourceId: customerWaId,
        phoneNumber: customerWaId,
        firstName: nameByWaId.get(customerWaId),
      }

      const messages = thread.messages ?? []
      if (messages.length === 0) {
        results.push({ contact, message: null })
        continue
      }

      for (const message of messages) {
        const isOutgoing = message.from !== customerWaId
        // ContentType is constrained to "text" | "location" | "refLink"; the
        // [type] placeholder preserves a hint of the original media until
        // attachment ingestion is wired into the historical-sync path.
        const text =
          message.text?.body ?? (message.type ? `[${message.type}]` : "")
        results.push({
          contact,
          message: {
            sourceId: message.id,
            messageType: isOutgoing ? "outgoing" : "incoming",
            contentType: "text",
            text,
            createdAt: toDate(message.timestamp),
          },
        })
      }
    }
  }

  for (const entry of value.smb_app_state_sync ?? []) {
    if (entry.action === "remove" || !entry.contact?.phone_number) {
      continue
    }
    const phone = entry.contact.phone_number
    results.push({
      contact: {
        sourceId: phone,
        phoneNumber: phone,
        firstName: entry.contact.first_name ?? entry.contact.full_name,
      },
      message: null,
    })
  }

  return results
}

/** How many contacts to process between heartbeat/counter DB updates. */
const HEARTBEAT_INTERVAL = 50

/**
 * Drains buffered WhatsApp staging rows into Contact/ContactInbox/Message.
 * Gated by `coexistEnabled` — a no-op when the user has not confirmed the
 * popup. Idempotent: safe to re-run as more history arrives over the ~24h
 * window Meta uses to push it.
 */
export const coexistWhatsappFlush = async (
  data: IntegrationJobCoexistWhatsappFlush["data"],
): Promise<void> => {
  const { runId, phoneNumberId } = data

  const integration = await db.query.integrationWhatsappModel.findFirst({
    where: { phoneNumberId },
  })
  if (!integration) {
    logger.warn({ phoneNumberId }, "[coexist] Flush: WhatsApp integration gone")
    return
  }
  if (!integration.coexistEnabled) {
    logger.info(
      { phoneNumberId },
      "[coexist] Flush skipped — coexist disabled, payloads remain staged",
    )
    return
  }

  const inbox = await findOrFail({
    table: inboxModel,
    where: { id: integration.inboxId },
    message: "Inbox not found",
  })

  // ── Mark run as running (row was created by the scheduler/enqueuer) ───────
  await db
    .update(coexistSyncRunModel)
    .set({
      status: "running",
      startedAt: new Date(),
      lastHeartbeatAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(coexistSyncRunModel.id, runId))

  const updateRun = async (
    fields: Parameters<ReturnType<typeof db.update>["set"]>[0],
  ) => {
    await db
      .update(coexistSyncRunModel)
      .set({ ...fields, lastHeartbeatAt: new Date() })
      .where(eq(coexistSyncRunModel.id, runId))
  }

  const BATCH_SIZE = 100
  let imported = 0
  let skipped = 0
  let failed = 0
  let totalRows = 0
  let contactsSinceHeartbeat = 0
  let batchNumber = 0

  let finalStatus: "succeeded" | "failed" | "partial" = "succeeded"
  let finalError: string | undefined

  try {
    // Cursor-paginated batch load — avoids holding all staging rows in memory
    // for a large WhatsApp account.
    for (;;) {
      batchNumber += 1
      await updateRun({
        currentStep: `flushing batch ${batchNumber}`,
        currentScan: totalRows,
        importedCount: imported,
        skippedCount: skipped,
        failedCount: failed,
      })

      const stagedRows = await db
        .select()
        .from(whatsappCoexistStagingModel)
        .where(
          and(
            eq(whatsappCoexistStagingModel.phoneNumberId, phoneNumberId),
            isNull(whatsappCoexistStagingModel.processedAt),
          ),
        )
        .limit(BATCH_SIZE)

      if (stagedRows.length === 0) {
        break
      }
      totalRows += stagedRows.length

      for (const row of stagedRows) {
        const extracted = extractFromValue(row.payload)
        let rowHadError = false
        for (const { contact, message } of extracted) {
          try {
            const result = await upsertContactAndMessage({
              inbox,
              integrationRow: integration,
              contact,
              message,
            })
            if (result) {
              imported += 1
            } else {
              skipped += 1
            }
          } catch (error) {
            rowHadError = true
            failed += 1
            logger.error(
              error,
              "[coexist] Failed to import WhatsApp history record",
            )
          }

          contactsSinceHeartbeat += 1
          if (contactsSinceHeartbeat >= HEARTBEAT_INTERVAL) {
            contactsSinceHeartbeat = 0
            await updateRun({
              currentScan: totalRows,
              importedCount: imported,
              skippedCount: skipped,
              failedCount: failed,
            })
          }
        }

        // Only mark processedAt when every extracted record succeeded —
        // otherwise the row stays available for the next flush attempt.
        if (!rowHadError) {
          await db
            .update(whatsappCoexistStagingModel)
            .set({ processedAt: new Date() })
            .where(eq(whatsappCoexistStagingModel.id, row.id))
        }
      }

      if (stagedRows.length < BATCH_SIZE) {
        break
      }
    }

    if (failed > 0 && (imported > 0 || skipped > 0)) {
      finalStatus = "partial"
    } else if (failed > 0) {
      finalStatus = "failed"
    }
  } catch (error) {
    finalStatus = "failed"
    finalError =
      error instanceof Error ? error.message : "Unknown error during flush"
    logger.error(error, "[coexist] WhatsApp flush encountered fatal error")
  } finally {
    // ── Close sync run row ──────────────────────────────────────────────────
    await db
      .update(coexistSyncRunModel)
      .set({
        status: finalStatus,
        finishedAt: new Date(),
        lastHeartbeatAt: new Date(),
        currentScan: totalRows,
        currentStep: "done",
        importedCount: imported,
        skippedCount: skipped,
        failedCount: failed,
        currentError: finalError ?? null,
      })
      .where(eq(coexistSyncRunModel.id, runId))
  }

  logger.info(
    { phoneNumberId, imported, skipped, failed, rows: totalRows, runId },
    "[coexist] WhatsApp flush complete",
  )
}
