import {
  type BuildContextIntegrationRow,
  buildContext,
} from "@chatbotx.io/business"
import { db, findOrFail } from "@chatbotx.io/database/client"
import {
  contactInboxModel,
  contactModel,
  conversationModel,
  messageModel,
  workspaceUsageModel,
} from "@chatbotx.io/database/schema"
import type {
  ContactInboxModel,
  ContactModel,
  ConversationModel,
  InboxModel,
  MessageModel,
} from "@chatbotx.io/database/types"
import { emit } from "@chatbotx.io/event-bus"
import { emitContactCreated } from "@chatbotx.io/events"
import type { IncomingContact, IncomingMessage } from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { logger } from "../../lib/logger"
import { allIntegrations } from "../../services/integrations"

/**
 * The subset of an `Integration<Channel>` row this module passes to
 * `buildContext`. Mirrors the structural fields `BuildContextIntegrationRow`
 * reads off the row — keeps the type assignable without a runtime cast.
 */
type IntegrationRowLike = {
  id: string
  inboxId: string
  integrationId?: string | null
  auth: unknown
  [x: string]: unknown
}

/** Controls behavior when the workspace contact cap is reached. */
type CapMode = "throw" | "skip"

const canGetUserProfileIfNeeded = (integrationType: string) =>
  integrationType === "messenger" ||
  integrationType === "zalo" ||
  integrationType === "telegram"

/**
 * Resolves (or creates) the ContactInbox + Conversation for an incoming
 * contact. Shared by the live webhook path (`received-message.ts`) and the
 * Coexist historical-sync handlers.
 *
 * `capMode: "skip"` returns `null` instead of throwing when the workspace
 * contact cap is reached — so a bulk history import logs and continues rather
 * than crashing the whole job.
 */
export const detectContactAndConversation = async (props: {
  inbox: InboxModel
  incomingContact: IncomingContact
  integrationRow: IntegrationRowLike
  capMode?: CapMode
}): Promise<{
  contactInbox: ContactInboxModel
  conversation: ConversationModel
} | null> => {
  const { incomingContact, inbox, integrationRow, capMode = "throw" } = props
  let contactData: typeof contactModel.$inferInsert = {
    ...incomingContact,
    workspaceId: inbox.workspaceId,
  }

  let capExceeded = false

  const result = await db.transaction(async (tx) => {
    let contactInbox: ContactInboxModel | null | undefined =
      await tx.query.contactInboxModel.findFirst({
        where: {
          inboxId: inbox.id,
          channel: inbox.channel,
          sourceId: incomingContact.sourceId,
        },
      })
    let conversation: ConversationModel | null | undefined = null
    let newContact: ContactModel | null | undefined = null

    if (contactInbox) {
      conversation = await findOrFail({
        table: conversationModel,
        where: {
          workspaceId: inbox.workspaceId,
          contactId: contactInbox.contactId,
        },
      })
      return { contactInbox, conversation, newContact }
    }

    if (canGetUserProfileIfNeeded(inbox.channel)) {
      const profileIntegration = allIntegrations[inbox.channel]
      if (profileIntegration) {
        const profileCtx = await buildContext({
          workspaceId: inbox.workspaceId,
          integrationType: inbox.channel,
          // Drizzle infers jsonb columns as `unknown`; `buildContext` narrows
          // internally and `makeAuthStore` re-reads the persisted shape.
          integration: integrationRow as BuildContextIntegrationRow,
        })
        const userProfile = await profileIntegration.runChannelHandler(
          "contact",
          "getProfile",
          {
            ctx: profileCtx,
            data: { sourceId: incomingContact.sourceId },
          },
        )
        contactData = { ...contactData, ...userProfile }
      }
    }

    const workspaceUsage = await findOrFail({
      table: workspaceUsageModel,
      where: { workspaceId: inbox.workspaceId },
      message: "Workspace usage not found",
    })
    if (workspaceUsage.contactsCount >= workspaceUsage.maxContacts) {
      if (capMode === "skip") {
        capExceeded = true
        return null
      }
      throw new Error("Max contacts reached")
    }

    newContact = await tx
      .insert(contactModel)
      .values({ id: createId(), ...contactData, lastActivityAt: new Date() })
      .returning()
      .then((rows) => rows[0])
    if (!newContact) {
      throw new Error("Contact not found")
    }

    contactInbox = await tx
      .insert(contactInboxModel)
      .values({
        id: createId(),
        inboxId: inbox.id,
        contactId: newContact.id,
        originalContactId: newContact.id,
        source: inbox.channel,
        sourceId: incomingContact.sourceId,
        channel: inbox.channel,
      })
      .returning()
      .then((rows) => rows[0])

    conversation = await tx
      .insert(conversationModel)
      .values({
        id: createId(),
        workspaceId: inbox.workspaceId,
        contactId: newContact.id,
      })
      .returning()
      .then((rows) => rows[0])

    if (!contactInbox) {
      throw new Error("Contact inbox not found")
    }
    if (!conversation) {
      throw new Error("Conversation not found")
    }

    return { contactInbox, conversation, newContact }
  })

  if (capExceeded || !result) {
    logger.warn(
      { sourceId: incomingContact.sourceId, inboxId: inbox.id },
      "[coexist] Workspace contact cap reached — skipping contact",
    )
    return null
  }

  const { contactInbox, conversation, newContact } = result

  if (newContact) {
    try {
      await emitContactCreated(
        newContact.workspaceId,
        newContact.id,
        newContact.firstName || undefined,
        newContact.phoneNumber || undefined,
        newContact.email || undefined,
      )
    } catch (error) {
      logger.error(error, "Failed to emit contactCreated event")
    }

    if (contactInbox.sourceId) {
      emit("analytics:dashboard", {
        eventType: "contact:created",
        workspaceId: newContact.workspaceId,
        contactId: contactInbox.id,
        occurredAt: newContact.createdAt,
        source: contactInbox.source,
        sourceId: contactInbox.sourceId,
        channel: contactInbox.channel,
        metadata: {
          triggerContext: {
            triggerSource: "worker",
            triggerHandler: "detectContactAndConversation",
            triggerType: "contact_created",
          },
        },
      }).catch((error) => {
        logger.error(error, "[coexist] Failed to emit contact:created")
      })
    }
  }

  return { contactInbox, conversation }
}

/**
 * Idempotently imports one historical contact + message into Contact /
 * ContactInbox / Message. Used only by the Coexist sync handlers — skips the
 * realtime broadcast (avoids flooding the inbox UI with history) and respects
 * the historical `createdAt` so imported messages keep their original time.
 *
 * Returns `null` when the contact was skipped (workspace cap reached).
 */
export const upsertContactAndMessage = async (props: {
  inbox: InboxModel
  integrationRow: IntegrationRowLike
  contact: IncomingContact
  message?: (IncomingMessage & { createdAt?: Date }) | null
}): Promise<{
  contactInbox: ContactInboxModel
  conversation: ConversationModel
  message: MessageModel | null
} | null> => {
  const { inbox, integrationRow, contact, message } = props

  const detected = await detectContactAndConversation({
    inbox,
    incomingContact: contact,
    integrationRow,
    capMode: "skip",
  })
  if (!detected) {
    return null
  }

  const { contactInbox, conversation } = detected

  if (!message) {
    return { contactInbox, conversation, message: null }
  }

  const createdAt = message.createdAt ?? new Date()
  const isOutgoing = message.messageType === "outgoing"

  const insertedMessage = await db
    .insert(messageModel)
    .values({
      id: createId(),
      conversationId: conversation.id,
      contactInboxId: contactInbox.id,
      senderType: isOutgoing ? "user" : "contact",
      workspaceId: inbox.workspaceId,
      sourceId: message.sourceId,
      senderId: isOutgoing ? null : contactInbox.contactId,
      messageType: message.messageType,
      text: message.text,
      contentType: message.contentType,
      contentAttributes: message.contentAttributes,
      createdAt,
      updatedAt: createdAt,
    })
    .onConflictDoUpdate({
      target: [messageModel.contactInboxId, messageModel.sourceId],
      set: { updatedAt: new Date() },
    })
    .returning()
    .then((rows) => rows[0] ?? null)

  return { contactInbox, conversation, message: insertedMessage }
}
