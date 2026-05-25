import {
  type HandleRequestProps,
  type ReceivedMessageProps,
  SdkException,
} from "@chatbotx.io/sdk"
import type { OnMessageArgs, OnStatusArgs } from "whatsapp-api-js/emitters"
import { WhatsAppAPI as Middleware } from "whatsapp-api-js/middleware/next"
import type { GetParams } from "whatsapp-api-js/types"
import { DEFAULT_API_VERSION } from "../constants"
import type { WhatsappConfig } from "../schema"

/** One buffered Coexistence history slice keyed by its phone number. */
type CoexistPayload = { phoneNumberId: string; value: unknown }

/**
 * Scans a raw WhatsApp webhook body for Coexistence history payloads —
 * `value.history` (chat history backfill) or `value.smb_app_state_sync`
 * (contact backfill). These arrive over the ~6h window after onboarding and
 * are buffered to a staging table so no contact is billed before the user
 * confirms the post-connect popup. Parsing is defensive: the body shape is
 * loosely documented, so anything unexpected is silently ignored.
 */
export const extractCoexistPayloads = (rawBody: unknown): CoexistPayload[] => {
  if (typeof rawBody !== "object" || rawBody === null) {
    return []
  }
  const entries = (rawBody as { entry?: unknown }).entry
  if (!Array.isArray(entries)) {
    return []
  }

  const payloads: CoexistPayload[] = []
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown }).changes
    if (!Array.isArray(changes)) {
      continue
    }
    for (const change of changes) {
      const value = (change as { value?: unknown }).value
      if (typeof value !== "object" || value === null) {
        continue
      }
      const typed = value as {
        history?: unknown
        smb_app_state_sync?: unknown
        metadata?: { phone_number_id?: unknown }
      }
      const isCoexist =
        Array.isArray(typed.history) || Array.isArray(typed.smb_app_state_sync)
      const phoneNumberId = typed.metadata?.phone_number_id
      if (isCoexist && typeof phoneNumberId === "string") {
        payloads.push({ phoneNumberId, value })
      }
    }
  }
  return payloads
}

export const webhookHandler = async (
  props: HandleRequestProps<WhatsappConfig>,
) => {
  const { version = DEFAULT_API_VERSION } = props.config
  const middleware = new Middleware({
    token: "",
    appSecret: props.config.clientSecret as string,
    webhookVerifyToken: props.config.verifyToken as string,
    v: version as string,
    // biome-ignore lint/suspicious/noExplicitAny: safe pass value
    secure: false as any,
  })

  if (props.req.method === "GET") {
    const url = new URL(props.req.url)
    const params = Object.fromEntries(url.searchParams.entries()) as GetParams
    return await middleware.get(params)
  }

  if (props.req.method === "POST") {
    try {
      // Capture coexist payloads from the body BEFORE the middleware consumes
      // it (body stream is one-shot). We do NOT enqueue yet — staging writes
      // happen only after handle_post() verifies the HMAC signature, so an
      // unauthenticated attacker cannot flood the staging table.
      let coexistPayloads: CoexistPayload[] = []
      try {
        const rawBody = await props.req.clone().json()
        coexistPayloads = extractCoexistPayloads(rawBody)
      } catch {
        // Body was not JSON — ignore and continue.
      }

      let hmacVerified = false

      const result = await new Promise<
        | { type: "message"; data: OnMessageArgs }
        | { type: "status"; data: OnStatusArgs }
        | null
      >((resolve, reject) => {
        middleware.on.message = (args: OnMessageArgs) => {
          resolve({ type: "message", data: args })
        }
        middleware.on.sent = () => {
          resolve(null)
        }
        middleware.on.status = (args: OnStatusArgs) => {
          resolve({ type: "status", data: args })
        }
        middleware
          .handle_post(props.req)
          .then((rs) => {
            if (rs === 200) {
              hmacVerified = true
            } else {
              reject(new SdkException("Failed to handle webhook"))
            }
          })
          .catch(reject)

        setTimeout(() => {
          resolve(null)
        }, 300)
      })

      if (hmacVerified && coexistPayloads.length > 0) {
        for (const { phoneNumberId, value } of coexistPayloads) {
          await props.queue?.add("coexistWhatsappBuffer", {
            type: "coexistWhatsappBuffer",
            data: { phoneNumberId, payload: value },
          })
        }
      }

      if (result?.type === "message" && result.data.message) {
        await props.queue?.add("incomingMessage", {
          type: "incomingMessage",
          data: {
            integrationType: "whatsapp",
            integrationIdentifier: result.data.phoneID,
            payload: result.data,
          } as ReceivedMessageProps,
        })
      }

      if (result?.type === "status") {
        const statusData = result.data

        if (
          statusData.status === "delivered" ||
          statusData.status === "failed" ||
          statusData.status === "read"
        ) {
          await props.queue?.add("messageStatus", {
            type: "messageStatus",
            data: {
              integrationIdentifier: result.data.phoneID,
              integrationType: "whatsapp",
              payload: {
                phoneID: result.data.phoneID,
                phone: result.data.phone,
                messageId: statusData.id,
                status: statusData.status,
                timestamp: statusData.timestamp,
                error: result.data.error,
              },
            },
          })
        }
      }

      return "ok"
    } catch {
      throw new SdkException("Failed to handle webhook")
    }
  }

  throw SdkException.methodNotImplemented()
}
