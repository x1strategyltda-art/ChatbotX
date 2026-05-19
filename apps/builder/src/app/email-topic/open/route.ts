import { emailTopicService } from "@chatbotx.io/business"
import { NextResponse } from "next/server"

const GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
)

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const topicId = searchParams.get("t")
  const workspaceId = searchParams.get("w")

  if (topicId && workspaceId) {
    await emailTopicService.incrementCounters({
      id: topicId,
      workspaceId,
      seens: 1,
    })
  }

  return new NextResponse(GIF, {
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  })
}
