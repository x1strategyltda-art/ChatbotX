import { DEFAULT_API_VERSION } from "../constants"
import { rescue } from "../exception"
import { facebookGraphClient } from "../lib/http-client"

/** A Messenger participant as returned by the Graph conversations edge. */
export type MessengerParticipant = {
  id: string
  name?: string
  email?: string
}

/** A conversation thread between the Page and one or more participants. */
export type MessengerConversation = {
  id: string
  participants?: { data?: MessengerParticipant[] }
}

/** A single message inside a conversation thread. */
export type MessengerHistoryMessage = {
  id: string
  message?: string
  from?: MessengerParticipant
  created_time?: string
}

type GraphPage<T> = {
  data?: T[]
  paging?: { cursors?: { after?: string }; next?: string }
}

type PaginatedResult<T> = {
  data: T[]
  after?: string
}

const PAGE_LIMIT = 100

const nextCursor = (
  paging: GraphPage<unknown>["paging"],
): string | undefined => (paging?.next ? paging.cursors?.after : undefined)

/**
 * Lists conversation threads for a Page, one Graph page at a time. The caller
 * paginates by passing `after` until it comes back `undefined`.
 */
export const listConversations = (props: {
  pageId: string
  accessToken: string
  version?: string
  after?: string
}): Promise<PaginatedResult<MessengerConversation>> => {
  const { pageId, accessToken, version = DEFAULT_API_VERSION, after } = props
  const endpoint = `${version}/${pageId}/conversations`

  return rescue(endpoint, async () => {
    const response = await facebookGraphClient.get<
      GraphPage<MessengerConversation>
    >(endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
      searchParams: {
        fields: "id,participants",
        platform: "MESSENGER",
        limit: String(PAGE_LIMIT),
        ...(after ? { after } : {}),
      },
    })

    return { data: response.data ?? [], after: nextCursor(response.paging) }
  })
}

/**
 * Lists messages inside one conversation thread, one Graph page at a time.
 */
export const listMessages = (props: {
  conversationId: string
  accessToken: string
  version?: string
  after?: string
}): Promise<PaginatedResult<MessengerHistoryMessage>> => {
  const {
    conversationId,
    accessToken,
    version = DEFAULT_API_VERSION,
    after,
  } = props
  const endpoint = `${version}/${conversationId}/messages`

  return rescue(endpoint, async () => {
    const response = await facebookGraphClient.get<
      GraphPage<MessengerHistoryMessage>
    >(endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
      searchParams: {
        fields: "id,message,from,created_time",
        limit: String(PAGE_LIMIT),
        ...(after ? { after } : {}),
      },
    })

    return { data: response.data ?? [], after: nextCursor(response.paging) }
  })
}
