CREATE TABLE "WhatsappCoexistStaging" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"phoneNumberId" text NOT NULL,
	"payload" jsonb NOT NULL,
	"processedAt" timestamp(6) with time zone
);
--> statement-breakpoint
ALTER TABLE "IntegrationMessenger" ADD COLUMN "coexistEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "IntegrationWhatsapp" ADD COLUMN "coexistEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "WhatsappCoexistStaging_phoneNumberId_idx" ON "WhatsappCoexistStaging" ("phoneNumberId");--> statement-breakpoint
