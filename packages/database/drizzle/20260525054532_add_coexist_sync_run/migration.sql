CREATE TYPE "coexistChannel" AS ENUM('whatsapp', 'messenger');--> statement-breakpoint
CREATE TYPE "coexistRunStatus" AS ENUM('pending', 'running', 'succeeded', 'failed', 'partial');--> statement-breakpoint
CREATE TABLE "CoexistSyncRun" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"integrationId" bigint NOT NULL,
	"channel" "coexistChannel" NOT NULL,
	"status" "coexistRunStatus" DEFAULT 'pending'::"coexistRunStatus" NOT NULL,
	"triggerSource" text NOT NULL,
	"startedAt" timestamp(6) with time zone,
	"finishedAt" timestamp(6) with time zone,
	"lastHeartbeatAt" timestamp(6) with time zone,
	"totalScan" integer DEFAULT 0 NOT NULL,
	"currentScan" integer DEFAULT 0 NOT NULL,
	"currentStep" text,
	"importedCount" integer DEFAULT 0 NOT NULL,
	"skippedCount" integer DEFAULT 0 NOT NULL,
	"failedCount" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"currentError" text
);
--> statement-breakpoint
CREATE INDEX "CoexistSyncRun_workspace_idx" ON "CoexistSyncRun" ("workspaceId");--> statement-breakpoint
CREATE INDEX "CoexistSyncRun_integration_idx" ON "CoexistSyncRun" ("integrationId");--> statement-breakpoint
CREATE INDEX "CoexistSyncRun_status_idx" ON "CoexistSyncRun" ("status");