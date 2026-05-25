import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Hoist mock function references so they are available inside vi.mock factories
// (vi.mock calls are hoisted to the top of the file by Vitest)
// ---------------------------------------------------------------------------

const {
  mockInsert,
  mockUpdate,
  mockSelect,
  mockFindOrFail,
  mockTransactionFn,
  mockFindFirstContactInbox,
  mockFindFirstConversation,
  mockEmitContactCreated,
  mockEmit,
  mockBuildContext,
  mockCreateId,
  mockLoggerWarn,
  mockLoggerError,
} = vi.hoisted(() => {
  const mockTransactionFn = vi.fn()
  const mockFindFirstContactInbox = vi.fn()
  return {
    mockInsert: vi.fn(),
    mockUpdate: vi.fn(),
    mockSelect: vi.fn(),
    mockFindOrFail: vi.fn(),
    mockTransactionFn,
    mockFindFirstContactInbox,
    mockFindFirstConversation: vi.fn(),
    mockEmitContactCreated: vi.fn(),
    mockEmit: vi.fn(),
    mockBuildContext: vi.fn(),
    mockCreateId: vi.fn(() => "generated-id"),
    mockLoggerWarn: vi.fn(),
    mockLoggerError: vi.fn(),
  }
})

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@chatbotx.io/database/client", () => {
  // tx mirrors the db API used inside the transaction callback
  const tx = {
    insert: mockInsert,
    update: mockUpdate,
    select: mockSelect,
    query: {
      contactInboxModel: { findFirst: mockFindFirstContactInbox },
      conversationModel: { findFirst: mockFindFirstConversation },
    },
  }
  // Default: run the callback with the tx object immediately
  mockTransactionFn.mockImplementation((cb: (tx: unknown) => unknown) => cb(tx))

  return {
    db: {
      insert: mockInsert,
      update: mockUpdate,
      select: mockSelect,
      transaction: mockTransactionFn,
      query: {
        contactInboxModel: { findFirst: mockFindFirstContactInbox },
        conversationModel: { findFirst: mockFindFirstConversation },
      },
    },
    and: vi.fn((...args: unknown[]) => ({ __and: args })),
    eq: vi.fn((col: unknown, val: unknown) => ({ __eq: [col, val] })),
    isNull: vi.fn((col: unknown) => ({ __isNull: col })),
    findOrFail: mockFindOrFail,
  }
})

vi.mock("@chatbotx.io/database/schema", () => ({
  contactModel: {
    $inferInsert: {},
    workspaceId: "workspaceId",
  },
  contactInboxModel: {
    id: "id",
    inboxId: "inboxId",
    sourceId: "sourceId",
    channel: "channel",
  },
  conversationModel: {
    id: "id",
    workspaceId: "workspaceId",
    contactId: "contactId",
  },
  messageModel: {
    contactInboxId: "contactInboxId",
    sourceId: "sourceId",
  },
  workspaceUsageModel: {},
}))

vi.mock("@chatbotx.io/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chatbotx.io/utils")>()
  return {
    ...actual,
    createId: mockCreateId,
  }
})

vi.mock("@chatbotx.io/events", () => ({
  emitContactCreated: mockEmitContactCreated,
}))

vi.mock("@chatbotx.io/event-bus", () => ({
  emit: mockEmit,
}))

vi.mock("@chatbotx.io/business", () => ({
  buildContext: mockBuildContext,
}))

vi.mock("../src/lib/logger", () => ({
  logger: {
    warn: mockLoggerWarn,
    error: mockLoggerError,
    info: vi.fn(),
  },
}))

vi.mock("../src/services/integrations", () => ({
  allIntegrations: {},
}))

// ---------------------------------------------------------------------------
// Import handlers after mocks are registered
// ---------------------------------------------------------------------------

import {
  detectContactAndConversation,
  upsertContactAndMessage,
} from "../src/integration/handlers/upsert-contact-message"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeInbox = {
  id: "inbox-1",
  workspaceId: "ws-1",
  channel: "whatsapp",
} as Parameters<typeof detectContactAndConversation>[0]["inbox"]

const fakeIntegrationRow = {
  id: "int-1",
  inboxId: "inbox-1",
}

const fakeContact = {
  sourceId: "wa-contact-111",
  firstName: "Alice",
  phoneNumber: "+1234567890",
}

const fakeMessage = {
  sourceId: "msg-source-999",
  messageType: "incoming" as const,
  text: "Hello",
  contentType: "text" as const,
  contentAttributes: {},
}

const fakeContactInbox = {
  id: "ci-1",
  contactId: "contact-1",
  inboxId: "inbox-1",
  sourceId: "wa-contact-111",
  source: "whatsapp",
  channel: "whatsapp",
}

const fakeConversation = {
  id: "conv-1",
  workspaceId: "ws-1",
  contactId: "contact-1",
}

const fakeContact_db = {
  id: "contact-1",
  workspaceId: "ws-1",
  firstName: "Alice",
  phoneNumber: "+1234567890",
  sourceId: "wa-contact-111",
  createdAt: new Date("2024-01-01"),
}

const fakeWorkspaceUsage = {
  workspaceId: "ws-1",
  contactsCount: 5,
  maxContacts: 100,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a chainable Drizzle insert stub.
 * Returns `.values().returning()` → resolves to the given rows.
 */
const _makeInsertChain = (rows: unknown[]) => {
  const chain = {
    values: vi.fn(),
    returning: vi.fn(),
    onConflictDoUpdate: vi.fn(),
  }
  chain.values.mockReturnValue(chain)
  chain.returning.mockResolvedValue(rows)
  chain.onConflictDoUpdate.mockReturnValue(chain)
  mockInsert.mockReturnValue(chain)
  return chain
}

// ---------------------------------------------------------------------------
// Tests: detectContactAndConversation
// ---------------------------------------------------------------------------

describe("detectContactAndConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Re-install transaction mock after clearAllMocks
    mockTransactionFn.mockImplementation((cb: (tx: unknown) => unknown) => {
      const tx = {
        insert: mockInsert,
        update: mockUpdate,
        select: mockSelect,
        query: {
          contactInboxModel: { findFirst: mockFindFirstContactInbox },
          conversationModel: { findFirst: mockFindFirstConversation },
        },
      }
      return cb(tx)
    })
  })

  it("returns existing contactInbox + conversation when ContactInbox already exists (no new insert)", async () => {
    mockFindFirstContactInbox.mockResolvedValue(fakeContactInbox)
    mockFindOrFail.mockResolvedValue(fakeConversation)

    const result = await detectContactAndConversation({
      inbox: fakeInbox,
      incomingContact: fakeContact,
      integrationRow: fakeIntegrationRow,
    })

    expect(result).not.toBeNull()
    expect(result?.contactInbox).toMatchObject({ id: "ci-1" })
    expect(result?.conversation).toMatchObject({ id: "conv-1" })
    // No insert should happen since contact already exists
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it("inserts new Contact + ContactInbox + Conversation when no ContactInbox exists", async () => {
    mockFindFirstContactInbox.mockResolvedValue(null)

    // workspaceUsage check
    mockFindOrFail.mockResolvedValue(fakeWorkspaceUsage)

    // Insert returns: contact → contactInbox → conversation
    mockInsert
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([fakeContact_db]),
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([fakeContact_db]),
          }),
        }),
      })
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([fakeContactInbox]),
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([fakeContactInbox]),
          }),
        }),
      })
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([fakeConversation]),
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([fakeConversation]),
          }),
        }),
      })

    mockEmitContactCreated.mockResolvedValue(undefined)
    mockEmit.mockResolvedValue(undefined)

    const result = await detectContactAndConversation({
      inbox: fakeInbox,
      incomingContact: fakeContact,
      integrationRow: fakeIntegrationRow,
    })

    expect(result).not.toBeNull()
    expect(mockInsert).toHaveBeenCalledTimes(3)
    expect(result?.contactInbox).toMatchObject({ id: "ci-1" })
    expect(result?.conversation).toMatchObject({ id: "conv-1" })
  })

  it("capMode 'skip' returns null + logs warning when contactsCount >= maxContacts", async () => {
    mockFindFirstContactInbox.mockResolvedValue(null)
    mockFindOrFail.mockResolvedValue({
      ...fakeWorkspaceUsage,
      contactsCount: 100,
      maxContacts: 100,
    })

    const result = await detectContactAndConversation({
      inbox: fakeInbox,
      incomingContact: fakeContact,
      integrationRow: fakeIntegrationRow,
      capMode: "skip",
    })

    expect(result).toBeNull()
    expect(mockLoggerWarn).toHaveBeenCalledOnce()
    // No contact/contactInbox/conversation inserted
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it("capMode 'throw' (default) throws when contactsCount >= maxContacts", async () => {
    mockFindFirstContactInbox.mockResolvedValue(null)
    mockFindOrFail.mockResolvedValue({
      ...fakeWorkspaceUsage,
      contactsCount: 100,
      maxContacts: 100,
    })

    await expect(
      detectContactAndConversation({
        inbox: fakeInbox,
        incomingContact: fakeContact,
        integrationRow: fakeIntegrationRow,
        capMode: "throw",
      }),
    ).rejects.toThrow("Max contacts reached")
  })

  it("emits contactCreated event when a new contact is inserted", async () => {
    mockFindFirstContactInbox.mockResolvedValue(null)
    mockFindOrFail.mockResolvedValue(fakeWorkspaceUsage)

    mockInsert
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([fakeContact_db]),
        }),
      })
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([fakeContactInbox]),
        }),
      })
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([fakeConversation]),
        }),
      })

    mockEmitContactCreated.mockResolvedValue(undefined)
    mockEmit.mockResolvedValue(undefined)

    await detectContactAndConversation({
      inbox: fakeInbox,
      incomingContact: fakeContact,
      integrationRow: fakeIntegrationRow,
    })

    expect(mockEmitContactCreated).toHaveBeenCalledOnce()
    expect(mockEmitContactCreated).toHaveBeenCalledWith(
      fakeContact_db.workspaceId,
      fakeContact_db.id,
      fakeContact_db.firstName,
      fakeContact_db.phoneNumber,
      undefined, // email
    )
  })

  it("does NOT emit contactCreated for an existing contact (no insert path)", async () => {
    mockFindFirstContactInbox.mockResolvedValue(fakeContactInbox)
    mockFindOrFail.mockResolvedValue(fakeConversation)

    await detectContactAndConversation({
      inbox: fakeInbox,
      incomingContact: fakeContact,
      integrationRow: fakeIntegrationRow,
    })

    expect(mockEmitContactCreated).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests: upsertContactAndMessage
// ---------------------------------------------------------------------------

describe("upsertContactAndMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Re-install transaction mock after clearAllMocks
    mockTransactionFn.mockImplementation((cb: (tx: unknown) => unknown) => {
      const tx = {
        insert: mockInsert,
        update: mockUpdate,
        select: mockSelect,
        query: {
          contactInboxModel: { findFirst: mockFindFirstContactInbox },
          conversationModel: { findFirst: mockFindFirstConversation },
        },
      }
      return cb(tx)
    })
  })

  /** Sets up mocks for the "existing contactInbox" fast path */
  const setupExistingContactPath = () => {
    mockFindFirstContactInbox.mockResolvedValue(fakeContactInbox)
    mockFindOrFail.mockResolvedValue(fakeConversation)
  }

  it("returns null when contact cap is exceeded (capMode: 'skip' is used internally)", async () => {
    // upsertContactAndMessage always calls detectContactAndConversation with capMode: "skip"
    mockFindFirstContactInbox.mockResolvedValue(null)
    mockFindOrFail.mockResolvedValue({
      ...fakeWorkspaceUsage,
      contactsCount: 100,
      maxContacts: 100,
    })

    const result = await upsertContactAndMessage({
      inbox: fakeInbox,
      integrationRow: fakeIntegrationRow,
      contact: fakeContact,
      message: fakeMessage,
    })

    expect(result).toBeNull()
    expect(mockLoggerWarn).toHaveBeenCalledOnce()
  })

  it("inserts message with onConflictDoUpdate for idempotency (same contactInboxId + sourceId)", async () => {
    setupExistingContactPath()

    const insertChain = {
      values: vi.fn(),
      onConflictDoUpdate: vi.fn(),
      returning: vi.fn(),
    }
    insertChain.values.mockReturnValue(insertChain)
    insertChain.onConflictDoUpdate.mockReturnValue(insertChain)
    insertChain.returning.mockResolvedValue([
      { id: "msg-1", sourceId: "msg-source-999" },
    ])
    mockInsert.mockReturnValue(insertChain)

    const result = await upsertContactAndMessage({
      inbox: fakeInbox,
      integrationRow: fakeIntegrationRow,
      contact: fakeContact,
      message: fakeMessage,
    })

    expect(result).not.toBeNull()
    expect(result?.message).toMatchObject({
      id: "msg-1",
      sourceId: "msg-source-999",
    })

    // onConflictDoUpdate must be called to provide idempotency
    expect(insertChain.onConflictDoUpdate).toHaveBeenCalledOnce()
    expect(insertChain.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.arrayContaining([expect.anything()]),
        set: expect.objectContaining({ updatedAt: expect.any(Date) }),
      }),
    )
  })

  it("returns contactInbox + conversation + null message when no message is passed", async () => {
    setupExistingContactPath()

    const result = await upsertContactAndMessage({
      inbox: fakeInbox,
      integrationRow: fakeIntegrationRow,
      contact: fakeContact,
      message: null,
    })

    expect(result).not.toBeNull()
    expect(result?.contactInbox).toMatchObject({ id: "ci-1" })
    expect(result?.conversation).toMatchObject({ id: "conv-1" })
    expect(result?.message).toBeNull()
    // No message insert should occur
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it("does NOT call broadcastToWorkspaceParty — this is a historical-sync-only handler", async () => {
    // upsertContactAndMessage explicitly skips realtime broadcast to avoid
    // flooding the inbox UI with Coexist history. There is no import of
    // broadcastToWorkspaceParty in this module — verify no party-socket
    // side-effects beyond emitContactCreated / analytics.
    setupExistingContactPath()

    const insertChain = {
      values: vi.fn(),
      onConflictDoUpdate: vi.fn(),
      returning: vi.fn(),
    }
    insertChain.values.mockReturnValue(insertChain)
    insertChain.onConflictDoUpdate.mockReturnValue(insertChain)
    insertChain.returning.mockResolvedValue([{ id: "msg-2" }])
    mockInsert.mockReturnValue(insertChain)

    await upsertContactAndMessage({
      inbox: fakeInbox,
      integrationRow: fakeIntegrationRow,
      contact: fakeContact,
      message: fakeMessage,
    })

    // The emit mock covers @chatbotx.io/event-bus (analytics) but NOT realtime
    // broadcast. Verify no realtime event was emitted.
    for (const call of mockEmit.mock.calls) {
      const eventName = call[0] as string
      expect(eventName).not.toContain("realtime")
      expect(eventName).not.toContain("broadcast")
    }
  })

  it("respects historical createdAt from the message when provided", async () => {
    setupExistingContactPath()

    const historicalDate = new Date("2023-06-15T08:00:00Z")
    const insertChain = {
      values: vi.fn(),
      onConflictDoUpdate: vi.fn(),
      returning: vi.fn(),
    }
    insertChain.values.mockReturnValue(insertChain)
    insertChain.onConflictDoUpdate.mockReturnValue(insertChain)
    insertChain.returning.mockResolvedValue([
      { id: "msg-hist", createdAt: historicalDate },
    ])
    mockInsert.mockReturnValue(insertChain)

    await upsertContactAndMessage({
      inbox: fakeInbox,
      integrationRow: fakeIntegrationRow,
      contact: fakeContact,
      message: { ...fakeMessage, createdAt: historicalDate },
    })

    // The values() call should include createdAt = historicalDate
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAt: historicalDate,
        updatedAt: historicalDate,
      }),
    )
  })

  it("marks outgoing messages with senderType 'user' and null senderId", async () => {
    setupExistingContactPath()

    const insertChain = {
      values: vi.fn(),
      onConflictDoUpdate: vi.fn(),
      returning: vi.fn(),
    }
    insertChain.values.mockReturnValue(insertChain)
    insertChain.onConflictDoUpdate.mockReturnValue(insertChain)
    insertChain.returning.mockResolvedValue([{ id: "msg-out" }])
    mockInsert.mockReturnValue(insertChain)

    await upsertContactAndMessage({
      inbox: fakeInbox,
      integrationRow: fakeIntegrationRow,
      contact: fakeContact,
      message: { ...fakeMessage, messageType: "outgoing" },
    })

    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ senderType: "user", senderId: null }),
    )
  })

  it("marks incoming messages with senderType 'contact' and contactId as senderId", async () => {
    setupExistingContactPath()

    const insertChain = {
      values: vi.fn(),
      onConflictDoUpdate: vi.fn(),
      returning: vi.fn(),
    }
    insertChain.values.mockReturnValue(insertChain)
    insertChain.onConflictDoUpdate.mockReturnValue(insertChain)
    insertChain.returning.mockResolvedValue([{ id: "msg-in" }])
    mockInsert.mockReturnValue(insertChain)

    await upsertContactAndMessage({
      inbox: fakeInbox,
      integrationRow: fakeIntegrationRow,
      contact: fakeContact,
      message: { ...fakeMessage, messageType: "incoming" },
    })

    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        senderType: "contact",
        senderId: fakeContactInbox.contactId,
      }),
    )
  })
})
