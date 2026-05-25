import { db, eq, findOrFail } from "@chatbotx.io/database/client"
import { coexistSyncRunModel, inboxModel } from "@chatbotx.io/database/schema"
import {
  listConversations,
  listMessages,
} from "@chatbotx.io/integration-messenger/apis/sync"
import type { IncomingContact } from "@chatbotx.io/sdk"
import type { IntegrationJobCoexistMessengerSync } from "@chatbotx.io/worker-config"
import pLimit from "p-limit"
import { z } from "zod"
import { logger } from "../../lib/logger"
import { upsertContactAndMessage } from "./upsert-contact-message"

const messengerAuthSchema = z
  .object({
    tokens: z.object({ accessToken: z.string() }).passthrough(),
    metadata: z
      .object({ version: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()

/** Caps concurrent Graph API calls to avoid tripping rate limits. */
const DEFAULT_CONCURRENCY = 5
const THROTTLED_CONCURRENCY = 2

/** How often to write progress back to CoexistSyncRun (in contacts processed). */
const HEARTBEAT_INTERVAL = 50

/** Maximum inline retry attempts on 429 / 5xx before propagating. */
const MAX_INLINE_RETRIES = 4

/** Returns true if the error is an HTTP status we should retry inline. */
function isRetryable(error: unknown): boolean {
  if (
    error != null &&
    typeof error === "object" &&
    "response" in error &&
    error.response != null &&
    typeof error.response === "object" &&
    "status" in error.response &&
    typeof error.response.status === "number"
  ) {
    const status = error.response.status
    return status === 429 || status >= 500
  }
  return false
}

/**
 * Wraps a Graph API call with inline retry on 429 / 5xx.
 * Preserves the pagination cursor across retries — unlike a BullMQ-level
 * retry which would restart the entire job from scratch.
 */
async function withInlineRetry<T>(
  fn: () => Promise<T>,
  onRateLimit: () => void,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_INLINE_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!isRetryable(error)) {
        throw error
      }
      // Signal 429 to caller so it can downshift concurrency
      const isRateLimit =
        error != null &&
        typeof error === "object" &&
        "response" in error &&
        (error as { response: { status: number } }).response.status === 429
      if (isRateLimit) {
        onRateLimit()
      }
      const delay = Math.min(2 ** attempt * 1000, 30_000)
      logger.warn(
        { attempt, delay },
        "[coexist] Messenger Graph rate-limited — retrying after delay",
      )
      await new Promise<void>((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

/**
 * Imports historical Messenger conversations + messages via the Graph API.
 * Gated by `coexistEnabled`. Fully paginates both conversations and messages;
 * idempotent via the `(contactInboxId, sourceId)` unique index so retries and
 * re-runs never duplicate rows.
 */
export const coexistMessengerSync = async (
  data: IntegrationJobCoexistMessengerSync["data"],
): Promise<void> => {
  const { runId, integrationId, workspaceId } = data

  const integration = await db.query.integrationMessengerModel.findFirst({
    where: { id: integrationId },
  })
  if (!integration) {
    logger.warn({ integrationId }, "[coexist] Messenger integration gone")
    return
  }
  // Consistency guard: job payload's workspaceId must match the row.
  // Catches any stray cross-workspace enqueue regression.
  if (integration.workspaceId !== workspaceId) {
    logger.warn(
      { integrationId, workspaceId, rowWorkspaceId: integration.workspaceId },
      "[coexist] Messenger sync workspaceId mismatch — refusing",
    )
    return
  }
  if (!integration.coexistEnabled) {
    logger.info(
      { integrationId },
      "[coexist] Messenger sync skipped — disabled",
    )
    return
  }

  const parsedAuth = messengerAuthSchema.safeParse(integration.auth)
  if (!parsedAuth.success) {
    logger.error(
      { integrationId, error: parsedAuth.error.message },
      "[coexist] Messenger auth jsonb failed validation",
    )
    return
  }
  const accessToken = parsedAuth.data.tokens.accessToken
  const version = parsedAuth.data.metadata?.version
  const { pageId } = integration

  const inbox = await findOrFail({
    table: inboxModel,
    where: { id: integration.inboxId },
    message: "Inbox not found",
  })

  // ── Mark run as running + read lastCursor for resume support ──────────────
  const [runRow] = await db
    .select({ lastCursor: coexistSyncRunModel.lastCursor })
    .from(coexistSyncRunModel)
    .where(eq(coexistSyncRunModel.id, runId))
    .limit(1)
  const resumeCursor: string | undefined = runRow?.lastCursor ?? undefined

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

  // ── Adaptive rate-limit state ─────────────────────────────────────────────
  let last429At: number | undefined
  let currentLimit = pLimit(DEFAULT_CONCURRENCY)

  const onRateLimit = () => {
    last429At = Date.now()
    // Immediately downshift for subsequent conversation batches
    currentLimit = pLimit(THROTTLED_CONCURRENCY)
    logger.warn(
      "[coexist] Messenger 429 detected — downshifting concurrency to 2",
    )
  }

  let imported = 0
  let skipped = 0
  let failed = 0
  let conversationCount = 0
  let contactsSinceHeartbeat = 0
  let pageNumber = 0

  let finalStatus: "succeeded" | "failed" | "partial" = "succeeded"
  let finalError: string | undefined

  const importMessage = async (
    contact: IncomingContact,
    sourceId: string,
    text: string,
    isOutgoing: boolean,
    createdAt: Date,
  ): Promise<void> => {
    try {
      const result = await upsertContactAndMessage({
        inbox,
        integrationRow: integration,
        contact,
        message: {
          sourceId,
          messageType: isOutgoing ? "outgoing" : "incoming",
          contentType: "text",
          text,
          createdAt,
        },
      })
      if (result) {
        imported += 1
      } else {
        skipped += 1
      }
    } catch (error) {
      failed += 1
      logger.error(error, "[coexist] Failed to import Messenger message")
    }

    contactsSinceHeartbeat += 1
    if (contactsSinceHeartbeat >= HEARTBEAT_INTERVAL) {
      contactsSinceHeartbeat = 0
      await updateRun({
        currentScan: conversationCount,
        importedCount: imported,
        skippedCount: skipped,
        failedCount: failed,
      })
    }
  }

  try {
    await updateRun({ currentStep: "listing conversations", currentScan: 0 })

    // resumeCursor allows the job to pick up from the last successfully
    // persisted page cursor when retried after failure.
    let conversationCursor: string | undefined = resumeCursor
    do {
      pageNumber += 1

      // Reset concurrency if no 429 in last 60 s
      if (last429At !== undefined && Date.now() - last429At > 60_000) {
        last429At = undefined
        currentLimit = pLimit(DEFAULT_CONCURRENCY)
        logger.info("[coexist] Messenger concurrency restored to 5")
      }

      const conversations = await withInlineRetry(
        () =>
          listConversations({
            pageId,
            accessToken,
            version,
            after: conversationCursor,
          }),
        onRateLimit,
      )

      await updateRun({
        currentStep: `page ${pageNumber} — ${conversations.data.length} conversations`,
        currentScan: conversationCount,
        importedCount: imported,
        skippedCount: skipped,
        failedCount: failed,
      })

      // Isolate per-conversation failures: a single bad thread should not kill
      // the whole sync. Each limit() task swallows its own error after logging.
      await Promise.all(
        conversations.data.map((conversation) =>
          currentLimit(async () => {
            try {
              const participant = conversation.participants?.data?.find(
                (entry) => entry.id !== pageId,
              )
              if (!participant) {
                return
              }
              const contact: IncomingContact = {
                sourceId: participant.id,
                firstName: participant.name,
                email: participant.email,
              }

              let messageCursor: string | undefined
              do {
                const messages = await withInlineRetry(
                  () =>
                    listMessages({
                      conversationId: conversation.id,
                      accessToken,
                      version,
                      after: messageCursor,
                    }),
                  onRateLimit,
                )
                for (const message of messages.data) {
                  if (!message.message) {
                    continue
                  }
                  await importMessage(
                    contact,
                    message.id,
                    message.message,
                    message.from?.id === pageId,
                    message.created_time
                      ? new Date(message.created_time)
                      : new Date(),
                  )
                }
                messageCursor = messages.after
              } while (messageCursor)
            } catch (error) {
              logger.error(
                { error, conversationId: conversation.id },
                "[coexist] Messenger conversation sync failed — skipping",
              )
            } finally {
              conversationCount += 1
            }
          }),
        ),
      )

      conversationCursor = conversations.after

      // Persist cursor so a retry can resume from this page boundary.
      if (conversationCursor) {
        await db
          .update(coexistSyncRunModel)
          .set({
            lastCursor: conversationCursor,
            lastHeartbeatAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(coexistSyncRunModel.id, runId))
      }
    } while (conversationCursor)

    if (failed > 0 && (imported > 0 || skipped > 0)) {
      finalStatus = "partial"
    } else if (failed > 0) {
      finalStatus = "failed"
    }
  } catch (error) {
    finalStatus = "failed"
    finalError =
      error instanceof Error
        ? error.message
        : "Unknown error during Messenger sync"
    logger.error(error, "[coexist] Messenger sync encountered fatal error")
  } finally {
    // ── Close sync run row ──────────────────────────────────────────────────
    await db
      .update(coexistSyncRunModel)
      .set({
        status: finalStatus,
        finishedAt: new Date(),
        lastHeartbeatAt: new Date(),
        currentScan: conversationCount,
        currentStep: "done",
        importedCount: imported,
        skippedCount: skipped,
        failedCount: failed,
        currentError: finalError ?? null,
      })
      .where(eq(coexistSyncRunModel.id, runId))
  }

  logger.info(
    {
      integrationId,
      imported,
      skipped,
      failed,
      conversations: conversationCount,
      runId,
    },
    "[coexist] Messenger sync complete",
  )
}
