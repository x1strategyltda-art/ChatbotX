import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Hoist mock function references so they are available inside vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockFindFirst,
  mockFindOrFail,
  mockSelect,
  mockUpdate,
  mockAndFn,
  mockEqFn,
  mockIsNullFn,
  mockUpsertContactAndMessage,
} = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockFindOrFail: vi.fn(),
  mockSelect: vi.fn(),
  mockUpdate: vi.fn(),
  mockAndFn: vi.fn((...args: unknown[]) => ({ __and: args })),
  mockEqFn: vi.fn((col: unknown, val: unknown) => ({ __eq: [col, val] })),
  mockIsNullFn: vi.fn((col: unknown) => ({ __isNull: col })),
  mockUpsertContactAndMessage: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@chatbotx.io/database/client", () => ({
  db: {
    update: mockUpdate,
    select: mockSelect,
    query: {
      integrationWhatsappModel: { findFirst: mockFindFirst },
      integrationMessengerModel: { findFirst: vi.fn() },
    },
  },
  and: mockAndFn,
  eq: mockEqFn,
  isNull: mockIsNullFn,
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
  whatsappCoexistStagingModel: {
    id: "id",
    phoneNumberId: "phoneNumberId",
    processedAt: "processedAt",
  },
  integrationWhatsappModel: {},
  inboxModel: {},
  coexistSyncRunModel: { id: "id" },
}))

vi.mock("../src/integration/handlers/upsert-contact-message", () => ({
  upsertContactAndMessage: mockUpsertContactAndMessage,
  detectContactAndConversation: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Import handler after mocks
// ---------------------------------------------------------------------------

import { coexistWhatsappFlush } from "../src/integration/handlers/coexist-whatsapp-flush"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const runId = "run-1"
const phoneNumberId = "phone-456"

const fakeIntegration = {
  id: "int-1",
  phoneNumberId,
  coexistEnabled: true,
  inboxId: "inbox-1",
}

const fakeInbox = {
  id: "inbox-1",
  workspaceId: "ws-1",
  channel: "whatsapp",
}

/** Minimal staged row with a valid WhatsApp history payload. */
const makeStagedRow = (id: string) => ({
  id,
  phoneNumberId,
  processedAt: null,
  payload: {
    contacts: [{ wa_id: "601234567890", profile: { name: "Alice" } }],
    history: [
      {
        threads: [
          {
            id: "601234567890",
            messages: [
              {
                id: `msg-${id}`,
                from: "601234567890",
                timestamp: "1700000000",
                type: "text",
                text: { body: "Hello" },
              },
            ],
          },
        ],
      },
    ],
  },
})

/** Builds a chainable Drizzle select stub returning the given rows.
 *
 * Production code uses cursor-paginated batches (`.limit(BATCH_SIZE)` after
 * `.where()`) and loops until an empty page is returned. The stub returns
 * `rows` on the first `.limit()` call and `[]` thereafter to terminate the
 * loop.
 */
const makeSelectChain = (rows: unknown[]) => {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
  }
  chain.from.mockReturnValue(chain)
  chain.where.mockReturnValue(chain)
  chain.limit.mockResolvedValueOnce(rows).mockResolvedValue([])
  mockSelect.mockReturnValue(chain)
  return chain
}

/** Builds a chainable Drizzle update stub. */
const makeUpdateChain = () => {
  const chain = {
    set: vi.fn(),
    where: vi.fn(),
  }
  chain.set.mockReturnValue(chain)
  chain.where.mockResolvedValue(undefined)
  mockUpdate.mockReturnValue(chain)
  return chain
}

const defaultUpsertResult = () => ({
  contactInbox: { id: "ci-1", contactId: "contact-1" },
  conversation: { id: "conv-1" },
  message: { id: "msg-1" },
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("coexistWhatsappFlush", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default update chain — tests that need fine-grained control override with
    // mockUpdate.mockImplementation() after this beforeEach.
    makeUpdateChain()
  })

  it("is a no-op when integration coexistEnabled === false", async () => {
    mockFindFirst.mockResolvedValue({
      ...fakeIntegration,
      coexistEnabled: false,
    })

    await coexistWhatsappFlush({ runId, phoneNumberId })

    expect(mockSelect).not.toHaveBeenCalled()
    expect(mockUpsertContactAndMessage).not.toHaveBeenCalled()
  })

  it("is a no-op when integration is not found", async () => {
    mockFindFirst.mockResolvedValue(null)

    await coexistWhatsappFlush({ runId, phoneNumberId })

    expect(mockSelect).not.toHaveBeenCalled()
    expect(mockUpsertContactAndMessage).not.toHaveBeenCalled()
  })

  it("UPDATE coexistSyncRunModel with status='running' on handler start", async () => {
    mockFindFirst.mockResolvedValue(fakeIntegration)
    mockFindOrFail.mockResolvedValue(fakeInbox)

    makeSelectChain([])
    mockUpdate.mockImplementation(() => {
      const chain = { set: vi.fn(), where: vi.fn() }
      chain.set.mockReturnValue(chain)
      chain.where.mockResolvedValue(undefined)
      return chain
    })

    await coexistWhatsappFlush({ runId, phoneNumberId })

    // First update call must be the status='running' open
    const firstSetCall =
      mockUpdate.mock.results[0]?.value?.set?.mock?.calls[0]?.[0]
    expect(firstSetCall).toMatchObject({ status: "running" })
    // Confirm no INSERT was made
    expect(mockUpdate).toHaveBeenCalled()
  })

  it("reads unprocessed rows, calls upsertContactAndMessage for each, then marks processedAt", async () => {
    mockFindFirst.mockResolvedValue(fakeIntegration)
    mockFindOrFail.mockResolvedValue(fakeInbox)

    const row = makeStagedRow("row-1")
    makeSelectChain([row])
    // Provide a reusable update chain (staging row update + sync run close update)
    mockUpdate.mockImplementation(() => {
      const chain = { set: vi.fn(), where: vi.fn() }
      chain.set.mockReturnValue(chain)
      chain.where.mockResolvedValue(undefined)
      return chain
    })

    mockUpsertContactAndMessage.mockResolvedValue(defaultUpsertResult())

    await coexistWhatsappFlush({ runId, phoneNumberId })

    // Should have called upsert at least once (one message in the staged row)
    expect(mockUpsertContactAndMessage).toHaveBeenCalled()
    expect(mockUpsertContactAndMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        inbox: fakeInbox,
        integrationRow: fakeIntegration,
        contact: expect.objectContaining({ sourceId: "601234567890" }),
        message: expect.objectContaining({ sourceId: "msg-row-1" }),
      }),
    )

    // At least one update call should set processedAt (staging row)
    expect(mockUpdate).toHaveBeenCalled()
    const allSetCalls = mockUpdate.mock.results.map(
      (r) => (r.value as { set: ReturnType<typeof vi.fn> }).set.mock.calls,
    )
    const processedAtCall = allSetCalls
      .flat()
      .find((args) => args[0] && "processedAt" in (args[0] as object))
    expect(processedAtCall).toBeDefined()
  })

  it("skips already-processed rows — only picks rows with processedAt IS NULL", async () => {
    mockFindFirst.mockResolvedValue(fakeIntegration)
    mockFindOrFail.mockResolvedValue(fakeInbox)

    // Second run: no unprocessed rows returned
    makeSelectChain([])
    mockUpdate.mockImplementation(() => {
      const chain = { set: vi.fn(), where: vi.fn() }
      chain.set.mockReturnValue(chain)
      chain.where.mockResolvedValue(undefined)
      return chain
    })

    await coexistWhatsappFlush({ runId, phoneNumberId })

    expect(mockUpsertContactAndMessage).not.toHaveBeenCalled()
    // The .where() clause on the select must use isNull
    expect(mockIsNullFn).toHaveBeenCalled()
  })

  it("processes multiple staged rows independently", async () => {
    mockFindFirst.mockResolvedValue(fakeIntegration)
    mockFindOrFail.mockResolvedValue(fakeInbox)

    const rows = [makeStagedRow("row-a"), makeStagedRow("row-b")]
    makeSelectChain(rows)

    // Provide a fresh update chain for each call (staging rows + sync run close)
    mockUpdate.mockImplementation(() => {
      const chain = { set: vi.fn(), where: vi.fn() }
      chain.set.mockReturnValue(chain)
      chain.where.mockResolvedValue(undefined)
      return chain
    })

    mockUpsertContactAndMessage.mockResolvedValue(defaultUpsertResult())

    await coexistWhatsappFlush({ runId, phoneNumberId })

    // 2 rows × 1 message each = 2 upsert calls
    expect(mockUpsertContactAndMessage).toHaveBeenCalledTimes(2)
    // 2 staging row updates + periodic heartbeat updates + 1 sync run close ≥ 2
    expect(mockUpdate).toHaveBeenCalled()
  })
})
