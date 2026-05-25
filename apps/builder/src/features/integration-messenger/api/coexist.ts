import { and, db, eq } from "@chatbotx.io/database/client"
import {
  coexistSyncRunModel,
  integrationMessengerModel,
} from "@chatbotx.io/database/schema"
import { z } from "zod"
import { workspaceAuthorizedMidddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"

const setCoexistMessengerRequest = z.object({
  workspaceId: z.string(),
  integrationId: z.string(),
  enabled: z.boolean(),
})

export const integrationMessengerCoexistAPIs = {
  setCoexistMessengerAPI: authorizedAPI
    .route({
      method: "POST",
      path: "/workspaces/{workspaceId}/integrations/messenger/{integrationId}/coexist",
      summary: "Enable or disable Messenger coexist sync",
      tags: ["Integrations"],
    })
    .input(setCoexistMessengerRequest)
    .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
    .handler(async ({ input }) => {
      const { workspaceId, integrationId, enabled } = input

      // Tenancy-guarded UPDATE — returning() confirms the row belonged to
      // this workspace before we enqueue any sync.
      const [updated] = await db
        .update(integrationMessengerModel)
        .set({ coexistEnabled: enabled })
        .where(
          and(
            eq(integrationMessengerModel.id, integrationId),
            eq(integrationMessengerModel.workspaceId, workspaceId),
          ),
        )
        .returning({ id: integrationMessengerModel.id })

      if (!updated) {
        return { success: false }
      }

      if (enabled) {
        await db.insert(coexistSyncRunModel).values({
          workspaceId: input.workspaceId,
          integrationId: input.integrationId,
          channel: "messenger",
          status: "init",
          triggerSource: "popup-enable",
        })
      }

      return { success: true }
    }),
}
