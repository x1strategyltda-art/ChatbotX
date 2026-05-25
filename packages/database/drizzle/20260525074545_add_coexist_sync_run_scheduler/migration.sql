-- Hand-edited: replaced Drizzle's destructive DROP+CREATE TYPE with non-destructive RENAME VALUE
ALTER TYPE "coexistRunStatus" RENAME VALUE 'pending' TO 'init';--> statement-breakpoint
ALTER TABLE "CoexistSyncRun" ADD COLUMN "lastCursor" text;--> statement-breakpoint
DROP INDEX IF EXISTS "CoexistSyncRun_status_idx";--> statement-breakpoint
CREATE INDEX "CoexistSyncRun_active_idx" ON "CoexistSyncRun" USING btree ("status","lastHeartbeatAt") WHERE status IN ('init', 'running');
