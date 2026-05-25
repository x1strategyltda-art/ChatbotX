"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@chatbotx.io/ui/components/ui/dialog"
import { Loader2Icon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { toast } from "sonner"
import { client } from "@/lib/orpc/orpc"

type CoexistPopupProps = {
  channel: "whatsapp" | "messenger"
  integrationId: string
  workspaceId: string
  onDone: () => void
}

export function CoexistPopup({
  channel,
  integrationId,
  workspaceId,
  onDone,
}: CoexistPopupProps) {
  const t = useTranslations()
  const [pending, setPending] = useState<"enable" | "decline" | null>(null)

  const handleChoice = async (enabled: boolean) => {
    setPending(enabled ? "enable" : "decline")
    try {
      if (channel === "whatsapp") {
        await client.integrationWhatsappAPIs.setCoexistWhatsappAPI({
          workspaceId,
          integrationId,
          enabled,
        })
      } else {
        await client.integrationMessengerAPIs.setCoexistMessengerAPI({
          workspaceId,
          integrationId,
          enabled,
        })
      }
      onDone()
    } catch {
      toast.error(t("messages.unknownError"))
      setPending(null)
    }
  }

  const isPending = pending !== null

  return (
    <Dialog
      onOpenChange={() => {
        // Mandatory billing gate — user must pick explicitly, cannot dismiss
      }}
      open
    >
      <DialogContent
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{t("coexist.title")}</DialogTitle>
          <DialogDescription>
            {t(
              channel === "whatsapp"
                ? "coexist.descriptionWhatsapp"
                : "coexist.descriptionMessenger",
            )}
          </DialogDescription>
        </DialogHeader>

        <p className="text-muted-foreground text-xs">
          {t("coexist.billingNote")}
        </p>

        <DialogFooter>
          <Button
            disabled={isPending}
            onClick={() => handleChoice(false)}
            variant="outline"
          >
            {pending === "decline" && <Loader2Icon className="animate-spin" />}
            {t("coexist.decline")}
          </Button>
          <Button disabled={isPending} onClick={() => handleChoice(true)}>
            {pending === "enable" && <Loader2Icon className="animate-spin" />}
            {t("coexist.enable")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
