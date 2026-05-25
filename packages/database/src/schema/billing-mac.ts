import { integer, pgTable, primaryKey, timestamp } from "drizzle-orm/pg-core"
import { bigintAsString, timestampConfig } from "../partials/shared"

export const billingMacModel = pgTable(
  "BillingMac",
  {
    billingId: bigintAsString().notNull(),
    periodStart: timestamp(timestampConfig).notNull(),
    periodEnd: timestamp(timestampConfig).notNull(),
    macCount: integer().notNull().default(0),
    updatedAt: timestamp(timestampConfig).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.billingId, table.periodStart] })],
)
