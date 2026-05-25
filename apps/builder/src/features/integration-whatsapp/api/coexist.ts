import { and, db, eq, sql } from "@chatbotx.io/database/client"
import {
  coexistSyncRunModel,
  integrationWhatsappModel,
} from "@chatbotx.io/database/schema"
import { z } from "zod"
import { workspaceAuthorizedMidddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"

const setCoexistWhatsappRequest = z.object({
  workspaceId: z.string(),
  integrationId: z.string(),
  enabled: z.boolean(),
})

export const integrationWhatsappCoexistAPIs = {
  setCoexistWhatsappAPI: authorizedAPI
    .route({
      method: "POST",
      path: "/workspaces/{workspaceId}/integrations/whatsapp/{integrationId}/coexist",
      summary: "Enable or disable WhatsApp coexist sync",
      tags: ["Integrations"],
    })
    .input(setCoexistWhatsappRequest)
    .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
    .handler(async ({ input }) => {
      const { workspaceId, integrationId, enabled } = input

      // Atomic UPDATE + RETURNING gates on workspaceId (tenancy) and yields
      // phoneNumberId in one round trip — no separate findFirst, no race
      // window between flag write and queue enqueue.
      const [updated] = await db
        .update(integrationWhatsappModel)
        .set({ coexistEnabled: enabled })
        .where(
          and(
            eq(integrationWhatsappModel.id, integrationId),
            eq(integrationWhatsappModel.workspaceId, workspaceId),
          ),
        )
        .returning({ phoneNumberId: integrationWhatsappModel.phoneNumberId })

      if (!updated) {
        return { success: false }
      }

      if (enabled) {
        await db.insert(coexistSyncRunModel).values({
          workspaceId: input.workspaceId,
          integrationId: input.integrationId,
          channel: "whatsapp",
          status: "init",
          triggerSource: "popup-enable",
        })
      } else {
        // Chunked DELETE: Postgres does not support LIMIT on DELETE directly;
        // use a ctid subquery to delete at most BATCH rows per iteration so
        // large staging tables cannot hold a long exclusive lock.
        const BATCH = 100
        for (;;) {
          const result = await db.execute(sql`
            DELETE FROM "WhatsappCoexistStaging"
            WHERE ctid IN (
              SELECT ctid FROM "WhatsappCoexistStaging"
              WHERE "phoneNumberId" = ${updated.phoneNumberId}
              LIMIT ${BATCH}
            )
          `)
          if ((result.rowCount ?? 0) < BATCH) {
            break
          }
        }
      }

      return { success: true }
    }),
}
