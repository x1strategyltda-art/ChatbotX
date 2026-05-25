import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Hoist mock function references so they are available inside vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockFindFirstMessenger,
  mockFindOrFail,
  mockListConversations,
  mockListMessages,
  mockUpsertContactAndMessage,
  mockSelect,
  mockUpdate,
} = vi.hoisted(() => ({
  mockFindFirstMessenger: vi.fn(),
  mockFindOrFail: vi.fn(),
  mockListConversations: vi.fn(),
  mockListMessages: vi.fn(),
  mockUpsertContactAndMessage: vi.fn(),
  mockSelect: vi.fn(),
  mockUpdate: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@chatbotx.io/database/client", () => ({
  db: {
    update: mockUpdate,
    select: mockSelect,
    query: {
      integrationMessengerModel: { findFirst: mockFindFirstMessenger },
      integrationWhatsappModel: { findFirst: vi.fn() },
    },
  },
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
  findOrFail: mockFindOrFail,
}))

vi.mock("@chatbotx.io/worker-config", () => ({
  IntegrationJobAction: {
    coexistWhatsappBuffer: "coexistWhatsappBuffer",
    coexistWhatsappFlush: "coexistWhatsappFlush",
    coexistMessengerSync: "coexistMessengerSync",
  },
  integrationQueue: { add: vi.fn() },
}))

vi.mock("@chatbotx.io/database/schema", () => ({
  whatsappCoexistStagingModel: {},
  integrationWhatsappModel: {},
  integrationMessengerModel: {},
  inboxModel: {},
  coexistSyncRunModel: { id: "id" },
}))

vi.mock("@chatbotx.io/integration-messenger/apis/sync", () => ({
  listConversations: mockListConversations,
  listMessages: mockListMessages,
}))

vi.mock("../src/integration/handlers/upsert-contact-message", () => ({
  upsertContactAndMessage: mockUpsertContactAndMessage,
  detectContactAndConversation: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Import handler after mocks
// ---------------------------------------------------------------------------

import { coexistMessengerSync } from "../src/integration/handlers/coexist-messenger-sync"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAGE_ID = "page-111"
const runId = "run-1"
const integrationId = "int-messenger-1"
const workspaceId = "ws-messenger-1"

const fakeIntegration = {
  id: integrationId,
  workspaceId,
  pageId: PAGE_ID,
  coexistEnabled: true,
  inboxId: "inbox-messenger-1",
  auth: {
    tokens: { accessToken: "access-token-abc" },
    metadata: { version: "v20.0" },
  },
}

const fakeInbox = {
  id: "inbox-messenger-1",
  workspaceId,
  channel: "messenger",
}

const customerParticipant = (id = "user-999") => ({
  id,
  name: "Bob Customer",
  email: "bob@example.com",
})

const makeConversation = (id: string, userId = "user-999") => ({
  id,
  participants: {
    data: [{ id: PAGE_ID, name: "My Page" }, customerParticipant(userId)],
  },
})

const makeMessage = (id: string, fromId = "user-999") => ({
  id,
  message: "Hey there!",
  from: { id: fromId, name: "Bob Customer" },
  created_time: "2024-01-01T10:00:00Z",
})

const defaultUpsertResult = () => ({
  contactInbox: { id: "ci-1", contactId: "contact-1" },
  conversation: { id: "conv-1" },
  message: { id: "msg-1" },
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Builds a chainable select stub that returns given rows from .limit(). */
const makeSelectChain = (rows: unknown[]) => {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
  }
  chain.from.mockReturnValue(chain)
  chain.where.mockReturnValue(chain)
  chain.limit.mockResolvedValue(rows)
  mockSelect.mockReturnValue(chain)
  return chain
}

/** Builds a chainable update stub. */
const makeUpdateChain = () => {
  const chain = { set: vi.fn(), where: vi.fn() }
  chain.set.mockReturnValue(chain)
  chain.where.mockResolvedValue(undefined)
  mockUpdate.mockReturnValue(chain)
  return chain
}

describe("coexistMessengerSync", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpsertContactAndMessage.mockResolvedValue(defaultUpsertResult())
    // Default: run row has no prior cursor (fresh run)
    makeSelectChain([{ lastCursor: null }])
    makeUpdateChain()
  })

  it("is a no-op when coexistEnabled === false", async () => {
    mockFindFirstMessenger.mockResolvedValue({
      ...fakeIntegration,
      coexistEnabled: false,
    })

    await coexistMessengerSync({ runId, integrationId, workspaceId })

    expect(mockListConversations).not.toHaveBeenCalled()
    expect(mockUpsertContactAndMessage).not.toHaveBeenCalled()
  })

  it("is a no-op when integration is not found", async () => {
    mockFindFirstMessenger.mockResolvedValue(null)

    await coexistMessengerSync({ runId, integrationId, workspaceId })

    expect(mockListConversations).not.toHaveBeenCalled()
    expect(mockUpsertContactAndMessage).not.toHaveBeenCalled()
  })

  it("is a no-op when access token is missing", async () => {
    mockFindFirstMessenger.mockResolvedValue({
      ...fakeIntegration,
      auth: { tokens: {}, metadata: {} },
    })

    await coexistMessengerSync({ runId, integrationId, workspaceId })

    expect(mockListConversations).not.toHaveBeenCalled()
  })

  it("fetches conversations and calls upsertContactAndMessage for each message", async () => {
    mockFindFirstMessenger.mockResolvedValue(fakeIntegration)
    mockFindOrFail.mockResolvedValue(fakeInbox)

    mockListConversations.mockResolvedValueOnce({
      data: [makeConversation("conv-abc", "user-999")],
      after: undefined,
    })
    mockListMessages.mockResolvedValueOnce({
      data: [makeMessage("msg-xyz", "user-999")],
      after: undefined,
    })

    await coexistMessengerSync({ runId, integrationId, workspaceId })

    expect(mockListConversations).toHaveBeenCalledOnce()
    expect(mockListMessages).toHaveBeenCalledOnce()
    expect(mockUpsertContactAndMessage).toHaveBeenCalledOnce()
    expect(mockUpsertContactAndMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        inbox: fakeInbox,
        integrationRow: fakeIntegration,
        contact: expect.objectContaining({ sourceId: "user-999" }),
        message: expect.objectContaining({ sourceId: "msg-xyz" }),
      }),
    )
  })

  it("paginates through multiple conversation pages", async () => {
    mockFindFirstMessenger.mockResolvedValue(fakeIntegration)
    mockFindOrFail.mockResolvedValue(fakeInbox)

    mockListConversations
      .mockResolvedValueOnce({
        data: [makeConversation("conv-page1", "user-1")],
        after: "cursor-page2",
      })
      .mockResolvedValueOnce({
        data: [makeConversation("conv-page2", "user-2")],
        after: undefined,
      })

    mockListMessages
      .mockResolvedValueOnce({
        data: [makeMessage("msg-1", "user-1")],
        after: undefined,
      })
      .mockResolvedValueOnce({
        data: [makeMessage("msg-2", "user-2")],
        after: undefined,
      })

    await coexistMessengerSync({ runId, integrationId, workspaceId })

    expect(mockListConversations).toHaveBeenCalledTimes(2)
    expect(mockListConversations).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ after: "cursor-page2" }),
    )
    expect(mockUpsertContactAndMessage).toHaveBeenCalledTimes(2)
  })

  it("paginates through multiple message pages within a conversation", async () => {
    mockFindFirstMessenger.mockResolvedValue(fakeIntegration)
    mockFindOrFail.mockResolvedValue(fakeInbox)

    mockListConversations.mockResolvedValueOnce({
      data: [makeConversation("conv-1", "user-1")],
      after: undefined,
    })

    mockListMessages
      .mockResolvedValueOnce({
        data: [makeMessage("msg-a", "user-1")],
        after: "msg-cursor-2",
      })
      .mockResolvedValueOnce({
        data: [makeMessage("msg-b", "user-1")],
        after: undefined,
      })

    await coexistMessengerSync({ runId, integrationId, workspaceId })

    expect(mockListMessages).toHaveBeenCalledTimes(2)
    expect(mockListMessages).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ after: "msg-cursor-2" }),
    )
    expect(mockUpsertContactAndMessage).toHaveBeenCalledTimes(2)
  })

  it("excludes the Page PSID — conversations with only the Page are skipped entirely", async () => {
    mockFindFirstMessenger.mockResolvedValue(fakeIntegration)
    mockFindOrFail.mockResolvedValue(fakeInbox)

    mockListConversations.mockResolvedValueOnce({
      data: [
        {
          id: "conv-page-only",
          participants: { data: [{ id: PAGE_ID, name: "My Page" }] },
        },
      ],
      after: undefined,
    })

    await coexistMessengerSync({ runId, integrationId, workspaceId })

    expect(mockListMessages).not.toHaveBeenCalled()
    expect(mockUpsertContactAndMessage).not.toHaveBeenCalled()
  })

  it("never uses the Page PSID as contact.sourceId", async () => {
    mockFindFirstMessenger.mockResolvedValue(fakeIntegration)
    mockFindOrFail.mockResolvedValue(fakeInbox)

    const customerId = "user-customer-789"
    mockListConversations.mockResolvedValueOnce({
      data: [makeConversation("conv-2", customerId)],
      after: undefined,
    })
    mockListMessages.mockResolvedValueOnce({
      data: [makeMessage("msg-m", customerId)],
      after: undefined,
    })

    await coexistMessengerSync({ runId, integrationId, workspaceId })

    for (const call of mockUpsertContactAndMessage.mock.calls) {
      const { contact } = call[0] as { contact: { sourceId: string } }
      expect(contact.sourceId).not.toBe(PAGE_ID)
    }
  })

  it("is idempotent — second run calls upsertContactAndMessage with identical sourceId keys", async () => {
    mockFindFirstMessenger.mockResolvedValue(fakeIntegration)
    mockFindOrFail.mockResolvedValue(fakeInbox)

    const conversation = makeConversation("conv-idem", "user-idem")
    const message = makeMessage("msg-idem", "user-idem")

    const setupMocks = () => {
      mockFindFirstMessenger.mockResolvedValue(fakeIntegration)
      mockFindOrFail.mockResolvedValue(fakeInbox)
      mockUpsertContactAndMessage.mockResolvedValue(defaultUpsertResult())
      mockListConversations.mockResolvedValueOnce({
        data: [conversation],
        after: undefined,
      })
      mockListMessages.mockResolvedValueOnce({
        data: [message],
        after: undefined,
      })
      // Re-wire CoexistSyncRun select chain + update chain after clearAllMocks
      makeSelectChain([{ lastCursor: null }])
      makeUpdateChain()
    }

    // Run 1
    setupMocks()
    await coexistMessengerSync({ runId, integrationId, workspaceId })
    const firstRunCalls = mockUpsertContactAndMessage.mock.calls.map(
      (c) => c[0],
    )

    vi.clearAllMocks()

    // Run 2 — same data
    setupMocks()
    await coexistMessengerSync({ runId, integrationId, workspaceId })
    const secondRunCalls = mockUpsertContactAndMessage.mock.calls.map(
      (c) => c[0],
    )

    expect(secondRunCalls).toHaveLength(firstRunCalls.length)
    for (let i = 0; i < firstRunCalls.length; i++) {
      expect(secondRunCalls[i]).toMatchObject({
        contact: { sourceId: firstRunCalls[i]?.contact.sourceId },
        message: { sourceId: firstRunCalls[i]?.message.sourceId },
      })
    }
  })

  it("skips messages without a text body (message field undefined)", async () => {
    mockFindFirstMessenger.mockResolvedValue(fakeIntegration)
    mockFindOrFail.mockResolvedValue(fakeInbox)

    mockListConversations.mockResolvedValueOnce({
      data: [makeConversation("conv-3", "user-3")],
      after: undefined,
    })

    // Message with no text body — handler should skip it
    mockListMessages.mockResolvedValueOnce({
      data: [
        {
          id: "msg-notext",
          from: { id: "user-3" },
          created_time: "2024-01-01T10:00:00Z",
        },
      ],
      after: undefined,
    })

    await coexistMessengerSync({ runId, integrationId, workspaceId })

    expect(mockUpsertContactAndMessage).not.toHaveBeenCalled()
  })

  it("persists lastCursor to DB after each conversation page with a next cursor", async () => {
    mockFindFirstMessenger.mockResolvedValue(fakeIntegration)
    mockFindOrFail.mockResolvedValue(fakeInbox)
    // beforeEach already wired select chain with { lastCursor: null }

    const updateResults: { set: ReturnType<typeof vi.fn> }[] = []
    mockUpdate.mockImplementation(() => {
      const chain = { set: vi.fn(), where: vi.fn() }
      chain.set.mockReturnValue(chain)
      chain.where.mockResolvedValue(undefined)
      updateResults.push(chain)
      return chain
    })

    mockListConversations
      .mockResolvedValueOnce({
        data: [makeConversation("conv-p1", "user-1")],
        after: "after-token-1",
      })
      .mockResolvedValueOnce({
        data: [makeConversation("conv-p2", "user-2")],
        after: undefined,
      })

    mockListMessages
      .mockResolvedValueOnce({
        data: [makeMessage("msg-1", "user-1")],
        after: undefined,
      })
      .mockResolvedValueOnce({
        data: [makeMessage("msg-2", "user-2")],
        after: undefined,
      })

    await coexistMessengerSync({ runId, integrationId, workspaceId })

    // At least one update set call must contain lastCursor
    const allSetCalls = updateResults.flatMap((chain) => chain.set.mock.calls)
    const cursorCall = allSetCalls.find(
      (args) => args[0] && "lastCursor" in (args[0] as object),
    )
    expect(cursorCall).toBeDefined()
    expect((cursorCall?.[0] as { lastCursor: string }).lastCursor).toBe(
      "after-token-1",
    )
  })

  it("resumes from lastCursor when run row has an existing cursor", async () => {
    mockFindFirstMessenger.mockResolvedValue(fakeIntegration)
    mockFindOrFail.mockResolvedValue(fakeInbox)
    // Simulate a prior partial run that stopped at "resume-cursor"
    makeSelectChain([{ lastCursor: "resume-cursor" }])

    mockListConversations.mockResolvedValueOnce({
      data: [makeConversation("conv-resume", "user-resume")],
      after: undefined,
    })
    mockListMessages.mockResolvedValueOnce({
      data: [makeMessage("msg-resume", "user-resume")],
      after: undefined,
    })

    await coexistMessengerSync({ runId, integrationId, workspaceId })

    // First listConversations call must use after="resume-cursor"
    expect(mockListConversations).toHaveBeenCalledWith(
      expect.objectContaining({ after: "resume-cursor" }),
    )
  })
})
