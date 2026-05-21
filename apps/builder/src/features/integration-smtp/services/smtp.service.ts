import { ChatbotXException } from "@chatbotx.io/business/errors"
import { db, eq, findOrFail } from "@chatbotx.io/database/client"
import { channelTypes, inboxStatuses } from "@chatbotx.io/database/partials"
import { inboxModel, integrationSmtpModel } from "@chatbotx.io/database/schema"
import type { SmtpAuthValue } from "@chatbotx.io/integration-smtp"
import { smtpHostMap } from "@chatbotx.io/integration-smtp"
import { createSmtpTransporter } from "@chatbotx.io/mail/transport"
import { createId } from "@chatbotx.io/utils"
import { getTranslations } from "next-intl/server"
import type { CreateSmtpRequest, UpdateSmtpRequest } from "../schemas/mutation"

export async function verifySmtpConnection(input: CreateSmtpRequest) {
  const t = await getTranslations()

  const { host, port } =
    input.provider === "other"
      ? { host: input.host, port: input.port }
      : smtpHostMap[input.provider]

  const transporter = createSmtpTransporter({
    host,
    port,
    username: input.username,
    password: input.password,
  })

  try {
    await transporter.verify()
  } catch {
    throw new ChatbotXException(t("smtp.errors.connectionFailed"))
  } finally {
    transporter.close()
  }
}

export async function createSmtp(
  workspaceId: string,
  input: CreateSmtpRequest,
) {
  const { fromAddress, ...rest } = input
  const { host, port } =
    input.provider === "other"
      ? { host: input.host, port: input.port }
      : smtpHostMap[input.provider]

  await verifySmtpConnection({ ...input, host, port })

  return db.transaction(async (tx) => {
    const smtpId = createId()
    const name = input.username
    const inbox = await tx
      .insert(inboxModel)
      .values({
        id: smtpId,
        workspaceId,
        channel: channelTypes.enum.smtp,
        name,
        sourceId: smtpId,
      })
      .returning()
      .then((result) => result[0])

    await tx.insert(integrationSmtpModel).values({
      id: smtpId,
      name,
      workspaceId,
      inboxId: inbox.id,
      fromAddress,
      auth: {
        authType: "custom" as const,
        ...rest,
        host,
        port,
      },
    })

    return inbox
  })
}

export async function updateSmtp(
  workspaceId: string,
  id: string,
  input: UpdateSmtpRequest,
) {
  const integration = await findOrFail({
    table: integrationSmtpModel,
    where: { id, workspaceId },
    message: "SMTP integration not found",
  })

  const { host, port } =
    input.provider === "other"
      ? { host: input.host, port: input.port }
      : smtpHostMap[input.provider]

  await verifySmtpConnection({ ...input, host, port })

  const updatedAuth: SmtpAuthValue = {
    authType: "custom",
    provider: input.provider,
    host,
    port,
    username: input.username,
    password: input.password,
  }

  return db
    .update(integrationSmtpModel)
    .set({
      auth: updatedAuth,
      name: input.username,
      fromAddress: input.fromAddress,
    })
    .where(eq(integrationSmtpModel.id, integration.id))
    .returning()
    .then((result) => result[0])
}

export async function deleteSmtp(workspaceId: string, id: string) {
  const integration = await findOrFail({
    table: integrationSmtpModel,
    where: {
      id,
      workspaceId,
    },
    message: "SMTP integration not found",
  })

  await db.transaction(async (tx) => {
    await tx
      .delete(integrationSmtpModel)
      .where(eq(integrationSmtpModel.id, integration.id))

    await tx
      .update(inboxModel)
      .set({ status: inboxStatuses.enum.disconnected })
      .where(eq(inboxModel.id, integration.inboxId))
  })
}
