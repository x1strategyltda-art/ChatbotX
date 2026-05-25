import {
  broadcastToWorkspaceParty,
  buildContext,
  resolvePlatformSettings,
} from "@chatbotx.io/business"
import { getPublicFileUrl } from "@chatbotx.io/business/utils"
import { db } from "@chatbotx.io/database/client"
import type { IntegrationType } from "@chatbotx.io/database/partials"
import { attachmentModel, messageModel } from "@chatbotx.io/database/schema"
import type {
  ConversationModel,
  MessageModel,
} from "@chatbotx.io/database/types"
import { setWebhookExecutionContext } from "@chatbotx.io/events"
import { RealtimeEventType } from "@chatbotx.io/partysocket-config"
import { type IncomingAttachment, SdkException } from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import {
  IntegrationJobAction,
  type IntegrationJobReceiveMessage,
  integrationQueue,
} from "@chatbotx.io/worker-config"
import { logger } from "../../lib/logger"
import {
  allIntegrations,
  integrationService,
} from "../../services/integrations"
import { detectContactAndConversation } from "./upsert-contact-message"

export const receiveMessage = async (
  props: IntegrationJobReceiveMessage["data"],
): Promise<{
  message: MessageModel | null
  conversation: ConversationModel
  postbackAction: string | null
  quickReplyAction: string | null
  ref?: string | null
}> => {
  setWebhookExecutionContext({ source: "webhook" })

  const { integrationType, integrationIdentifier } = props

  if (!Object.hasOwn(allIntegrations, integrationType)) {
    throw new Error(`Unsupported integration: ${integrationType}`)
  }

  const dbIntegration =
    await integrationService.identifyInboxAndIntegrationAuthFromIdentifier(
      integrationType as IntegrationType,
      integrationIdentifier,
    )
  const { inbox, integrationRow } = dbIntegration
  const integration = allIntegrations[integrationType]
  if (!integration) {
    throw new SdkException(
      `No integration registered for channel: ${integrationType}`,
    )
  }
  const { storageUrl } = await resolvePlatformSettings({
    workspaceId: inbox.workspaceId,
  })
  const ctx = await buildContext({
    workspaceId: inbox.workspaceId,
    integrationType,
    integration: integrationRow,
  })

  const parsedMessage = await integration.runChannelHandler(
    "message",
    "receiveMessage",
    { ctx, data: props },
  )
  if (!parsedMessage) {
    throw new SdkException("Unable to parse received message")
  }

  const {
    message: incomingMessage,
    contact: incomingContact,
    postbackAction,
    quickReplyAction,
    ref,
  } = parsedMessage

  const detected = await detectContactAndConversation({
    incomingContact,
    inbox,
    integrationRow,
  })
  if (!detected) {
    throw new SdkException("Unable to resolve contact and conversation")
  }
  const { contactInbox, conversation } = detected

  let createdMessage: MessageModel | null = null
  if (incomingMessage) {
    const { newMessage, isNewMessage } = await db.transaction(async (tx) => {
      // Create message and attachments
      const now = new Date()
      const newMessage = await tx
        .insert(messageModel)
        .values({
          id: createId(),
          conversationId: conversation.id,
          contactInboxId: contactInbox.id,
          senderType:
            incomingMessage.messageType === "outgoing" ? "user" : "contact",
          workspaceId: inbox.workspaceId,
          sourceId: incomingMessage.sourceId,
          senderId:
            incomingMessage.messageType === "outgoing"
              ? null
              : contactInbox.contactId,
          messageType: incomingMessage.messageType,
          text: incomingMessage.text,
          contentType: incomingMessage.contentType,
          contentAttributes: incomingMessage.contentAttributes,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [messageModel.contactInboxId, messageModel.sourceId],
          set: {
            updatedAt: new Date(),
          },
        })
        .returning()
        .then((result) => result[0])

      const isNewMessage = newMessage.createdAt.getTime() === now.getTime()

      if (
        isNewMessage &&
        incomingMessage.attachments &&
        incomingMessage.attachments.length > 0
      ) {
        await tx.insert(attachmentModel).values(
          incomingMessage.attachments.map((attachment: IncomingAttachment) => ({
            id: createId(),
            ...attachment,
            messageId: newMessage.id,
            workspaceId: inbox.workspaceId,
            conversationId: conversation.id,
            url: getPublicFileUrl(attachment.originPath, storageUrl),
          })),
        )
      }

      try {
        broadcastToWorkspaceParty(inbox.workspaceId, {
          eventType: RealtimeEventType.messageCreated,
          data: newMessage,
        })
      } catch (error) {
        logger.warn(error, "Unable to emit realtime message")
      }

      return {
        newMessage,
        isNewMessage,
      }
    })

    if (isNewMessage) {
      // re-assign if is new message
      createdMessage = newMessage

      if (postbackAction) {
        await integrationQueue.add(IntegrationJobAction.runFlowPostback, {
          type: IntegrationJobAction.runFlowPostback,
          data: {
            conversationId: conversation,
            contactInboxId: contactInbox,
            action: postbackAction,
            ref,
            messageId: createdMessage?.id,
          },
        })
      }

      if (quickReplyAction) {
        await integrationQueue.add(IntegrationJobAction.runFlowQuickReply, {
          type: IntegrationJobAction.runFlowQuickReply,
          data: {
            conversationId: conversation,
            contactInboxId: contactInbox,
            action: quickReplyAction,
            ref,
            messageId: createdMessage?.id,
          },
        })
      }
    }
  }

  if (ref) {
    await integrationQueue.add(IntegrationJobAction.runRef, {
      type: IntegrationJobAction.runRef,
      data: {
        conversationId: conversation,
        contactInboxId: contactInbox,
        ref,
        messageId: createdMessage?.id,
      },
    })
  }

  return {
    message: createdMessage,
    conversation,
    postbackAction,
    quickReplyAction,
    ref,
  }
}
