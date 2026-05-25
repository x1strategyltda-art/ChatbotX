import { integer, pgTable, primaryKey, timestamp } from "drizzle-orm/pg-core"
import { bigintAsString, timestampConfig } from "../partials/shared"
import { workspaceModel } from "./workspace"

export const workspaceMacModel = pgTable(
  "WorkspaceMac",
  {
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    periodStart: timestamp(timestampConfig).notNull(),
    periodEnd: timestamp(timestampConfig).notNull(),
    macCount: integer().notNull().default(0),
    updatedAt: timestamp(timestampConfig).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.periodStart] })],
)
