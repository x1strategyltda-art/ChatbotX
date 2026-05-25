// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

// ---- mock: database client -----------------------------------------------
// Chainable update builder: set → where → returning.
const dbUpdateBuilder = {
  set: vi.fn(),
  where: vi.fn(),
  returning: vi.fn(),
}
dbUpdateBuilder.set.mockReturnValue(dbUpdateBuilder)
dbUpdateBuilder.where.mockReturnValue(dbUpdateBuilder)
dbUpdateBuilder.returning.mockResolvedValue([{ phoneNumberId: "pn-42" }])

// db.execute is called in a loop for chunked delete; default returns 0 rows so loop exits.
const dbExecute = vi.fn(async () => ({ rowCount: 0 }))

// db.insert builder for CoexistSyncRun
const dbInsertBuilder = {
  values: vi.fn(async () => ({ rowCount: 1 })),
}

vi.mock("@chatbotx.io/database/client", () => ({
  db: {
    update: vi.fn(() => dbUpdateBuilder),
    execute: dbExecute,
    insert: vi.fn(() => dbInsertBuilder),
    query: {
      workspaceMemberModel: {
        findFirst: vi.fn(async () => ({
          workspace: { id: "ws-1" },
          workspaceId: "ws-1",
          userId: "user-1",
        })),
      },
    },
  },
  eq: vi.fn((_col: unknown, val: unknown) => ({ col: _col, val })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: [...strings],
      values,
    }),
    { raw: (s: string) => s },
  ),
}))

// ---- mock: schema stubs ---------------------------------------------------
vi.mock("@chatbotx.io/database/schema", () => ({
  integrationWhatsappModel: { id: "id", workspaceId: "workspaceId" },
  whatsappCoexistStagingModel: { phoneNumberId: "phoneNumberId" },
  coexistSyncRunModel: {},
  workspaceMemberModel: { workspaceId: "workspaceId", userId: "userId" },
}))

// ---- mock: worker queue (kept for completeness; should NOT be called on enable) ---
const mockQueueAdd = vi.fn<
  (name: string, data: unknown, opts?: unknown) => Promise<undefined>
>(async () => undefined)

vi.mock("@chatbotx.io/worker-config", () => ({
  IntegrationJobAction: {},
  integrationQueue: {
    add: mockQueueAdd,
  },
}))

// ---- mock: auth (prevent real Better-Auth init) --------------------------
vi.mock("@/lib/auth/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        session: { id: "sess-1" },
        user: { id: "user-1", email: "test@test.com", isAnonymous: false },
      })),
    },
  },
}))

// ---- mock: logger (prevent pino init) ------------------------------------
vi.mock("@chatbotx.io/logger", () => ({
  getChildLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}))

// ---- dynamic imports AFTER mocks -----------------------------------------
const { call } = await import("@orpc/server")
const { integrationWhatsappCoexistAPIs } = await import(
  "@/features/integration-whatsapp/api/coexist"
)
const { db } = await import("@chatbotx.io/database/client")
const dbInsertBuilderRef = dbInsertBuilder

const procedure = integrationWhatsappCoexistAPIs.setCoexistWhatsappAPI

// Stub initial context — authMiddleware reads headers for session.
// workspaceAuthorizedMidddleware reads db.query.workspaceMemberModel.findFirst
// which is already mocked above to return a valid member.
const stubContext = {
  headers: new Headers({ authorization: "Bearer test-token" }),
}

// ---- tests ---------------------------------------------------------------
describe("setCoexistWhatsappAPI", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Re-wire chainable builders after clearAllMocks resets return values.
    dbUpdateBuilder.set.mockReturnValue(dbUpdateBuilder)
    dbUpdateBuilder.where.mockReturnValue(dbUpdateBuilder)
    dbUpdateBuilder.returning.mockResolvedValue([{ phoneNumberId: "pn-42" }])
    dbExecute.mockResolvedValue({ rowCount: 0 })
    dbInsertBuilderRef.values.mockResolvedValue({ rowCount: 1 })
    ;(db.insert as ReturnType<typeof vi.fn>).mockReturnValue(dbInsertBuilderRef)
    ;(
      db.query.workspaceMemberModel.findFirst as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      workspace: { id: "ws-1" },
      workspaceId: "ws-1",
      userId: "user-1",
    })
  })

  test("enabled:true — flips coexistEnabled to true and inserts CoexistSyncRun init row", async () => {
    const result = await call(
      procedure,
      { workspaceId: "ws-1", integrationId: "int-1", enabled: true },
      { context: stubContext },
    )

    expect(result).toEqual({ success: true })

    // DB update was called
    expect(db.update).toHaveBeenCalledTimes(1)
    expect(dbUpdateBuilder.set).toHaveBeenCalledWith({ coexistEnabled: true })

    // No job enqueued — scheduler picks up the CoexistSyncRun row
    expect(mockQueueAdd).not.toHaveBeenCalled()

    // CoexistSyncRun insert was called with correct values
    expect(db.insert).toHaveBeenCalledTimes(1)
    expect(dbInsertBuilderRef.values).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        integrationId: "int-1",
        channel: "whatsapp",
        status: "init",
        triggerSource: "popup-enable",
      }),
    )
  })

  test("enabled:false — deletes staging rows and does NOT enqueue any job", async () => {
    const result = await call(
      procedure,
      { workspaceId: "ws-1", integrationId: "int-1", enabled: false },
      { context: stubContext },
    )

    expect(result).toEqual({ success: true })

    // DB update was called
    expect(db.update).toHaveBeenCalledTimes(1)
    expect(dbUpdateBuilder.set).toHaveBeenCalledWith({ coexistEnabled: false })

    // Chunked delete: at least one db.execute call (loop exits when rowCount < BATCH).
    expect(dbExecute).toHaveBeenCalled()

    // No job enqueued
    expect(mockQueueAdd).not.toHaveBeenCalled()
  })

  test("enabled:false — chunked delete iterates until rowCount < BATCH", async () => {
    // First call returns full batch (100), second returns partial (5) → loop exits.
    dbExecute
      .mockResolvedValueOnce({ rowCount: 100 })
      .mockResolvedValueOnce({ rowCount: 5 })

    await call(
      procedure,
      { workspaceId: "ws-1", integrationId: "int-1", enabled: false },
      { context: stubContext },
    )

    expect(dbExecute).toHaveBeenCalledTimes(2)
  })
})
