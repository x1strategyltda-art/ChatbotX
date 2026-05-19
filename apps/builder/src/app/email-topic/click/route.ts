import { emailTopicService } from "@chatbotx.io/business"
import { NextResponse } from "next/server"

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const topicId = searchParams.get("t")
  const workspaceId = searchParams.get("w")
  const url = searchParams.get("url")

  if (topicId && workspaceId) {
    await emailTopicService.incrementCounters({
      id: topicId,
      workspaceId,
      clicks: 1,
    })
  }

  return NextResponse.redirect(url ?? "/", { status: 302 })
}
