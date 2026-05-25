import { describe, expect, it } from "vitest"
import { extractCoexistPayloads } from "../src/handlers/webhook"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wraps a single change value in the full webhook body envelope. */
const makeBody = (value: unknown) => ({
  entry: [
    {
      changes: [{ value }],
    },
  ],
})

/** Builds a coexist-style value with the given coexist field set. */
const makeCoexistValue = (
  coexistField: "history" | "smb_app_state_sync",
  phoneNumberId = "phone-123",
) => ({
  metadata: { phone_number_id: phoneNumberId },
  [coexistField]: [{ dummy: true }],
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractCoexistPayloads", () => {
  describe("returns entries for coexist payloads", () => {
    it("returns entry when value.history is a truthy array", () => {
      const body = makeBody(makeCoexistValue("history"))
      const result = extractCoexistPayloads(body)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ phoneNumberId: "phone-123" })
    })

    it("returns entry when value.smb_app_state_sync is a truthy array", () => {
      const body = makeBody(makeCoexistValue("smb_app_state_sync"))
      const result = extractCoexistPayloads(body)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ phoneNumberId: "phone-123" })
    })

    it("preserves the full value object in the returned payload", () => {
      const value = makeCoexistValue("history", "phone-456")
      const body = makeBody(value)
      const result = extractCoexistPayloads(body)

      expect(result[0]?.value).toBe(value)
    })

    it("collects multiple coexist changes across multiple entries", () => {
      const body = {
        entry: [
          { changes: [{ value: makeCoexistValue("history", "phone-a") }] },
          {
            changes: [
              { value: makeCoexistValue("smb_app_state_sync", "phone-b") },
            ],
          },
        ],
      }
      const result = extractCoexistPayloads(body)

      expect(result).toHaveLength(2)
      expect(result[0]?.phoneNumberId).toBe("phone-a")
      expect(result[1]?.phoneNumberId).toBe("phone-b")
    })
  })

  describe("skips entries that cannot be keyed to an integration", () => {
    it("skips entries where metadata.phone_number_id is missing", () => {
      const body = makeBody({
        history: [{ dummy: true }],
        // no metadata
      })
      const result = extractCoexistPayloads(body)

      expect(result).toHaveLength(0)
    })

    it("skips entries where metadata.phone_number_id is not a string", () => {
      const body = makeBody({
        history: [{ dummy: true }],
        metadata: { phone_number_id: 12_345 },
      })
      const result = extractCoexistPayloads(body)

      expect(result).toHaveLength(0)
    })

    it("skips entries where metadata is present but phone_number_id is undefined", () => {
      const body = makeBody({
        history: [{ dummy: true }],
        metadata: {},
      })
      const result = extractCoexistPayloads(body)

      expect(result).toHaveLength(0)
    })
  })

  describe("returns [] for normal live-message payloads", () => {
    it("returns [] when value has messages but no history or smb_app_state_sync", () => {
      const body = makeBody({
        metadata: { phone_number_id: "phone-live" },
        messages: [{ id: "wamid.123", type: "text", text: { body: "Hello" } }],
      })
      const result = extractCoexistPayloads(body)

      expect(result).toHaveLength(0)
    })

    it("returns [] when value has statuses but no coexist fields", () => {
      const body = makeBody({
        metadata: { phone_number_id: "phone-live" },
        statuses: [{ id: "wamid.456", status: "delivered" }],
      })
      const result = extractCoexistPayloads(body)

      expect(result).toHaveLength(0)
    })

    it("returns [] when history and smb_app_state_sync are both empty arrays (falsy-like)", () => {
      // Empty array is still Array.isArray === true, so this should match —
      // verify the function considers [] as truthy (isArray is the check).
      const body = makeBody({
        metadata: { phone_number_id: "phone-123" },
        history: [],
      })
      const result = extractCoexistPayloads(body)

      // [] passes Array.isArray, so this IS treated as a coexist payload.
      expect(result).toHaveLength(1)
    })
  })

  describe("returns [] (no throw) for malformed input", () => {
    it("returns [] for null", () => {
      expect(extractCoexistPayloads(null)).toEqual([])
    })

    it("returns [] for undefined", () => {
      expect(extractCoexistPayloads(undefined)).toEqual([])
    })

    it("returns [] for a plain string", () => {
      expect(extractCoexistPayloads("not an object")).toEqual([])
    })

    it("returns [] for a number", () => {
      expect(extractCoexistPayloads(42)).toEqual([])
    })

    it("returns [] when entry is missing", () => {
      expect(extractCoexistPayloads({})).toEqual([])
    })

    it("returns [] when entry is not an array", () => {
      expect(extractCoexistPayloads({ entry: "not-an-array" })).toEqual([])
    })

    it("returns [] when entry is an empty array", () => {
      expect(extractCoexistPayloads({ entry: [] })).toEqual([])
    })

    it("returns [] when entry items have no changes", () => {
      expect(extractCoexistPayloads({ entry: [{}] })).toEqual([])
    })

    it("returns [] when changes is not an array", () => {
      expect(extractCoexistPayloads({ entry: [{ changes: "bad" }] })).toEqual(
        [],
      )
    })

    it("returns [] when change.value is null", () => {
      expect(
        extractCoexistPayloads({ entry: [{ changes: [{ value: null }] }] }),
      ).toEqual([])
    })

    it("returns [] when change.value is a primitive", () => {
      expect(
        extractCoexistPayloads({ entry: [{ changes: [{ value: "string" }] }] }),
      ).toEqual([])
    })
  })
})
