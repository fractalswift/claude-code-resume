import { describe, expect } from "bun:test"
import { Effect } from "effect"
import * as Db from "../db"
import { testEffect } from "./lib/effect"
import type { Session } from "../types"

const it = testEffect(Db.testLayer)

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: "sess-001",
  displayName: "main",
  repo: "owner/repo",
  branch: "main",
  workingDir: "/home/user/project",
  preview: "fix the bug",
  startedAt: "2024-01-01T10:00:00.000Z",
  lastActive: "2024-01-01T11:00:00.000Z",
  hasBranches: false,
  isBranch: false,
  branchNumber: null,
  forkedFromSessionId: null,
  ...overrides,
})

describe("DbService", () => {
  it.effect("getSessions returns [] on fresh db", () =>
    Effect.gen(function* () {
      const db = yield* Db.Service
      expect(yield* db.getSessions()).toEqual([])
    }),
  )

  it.effect("upsertSessions inserts; getSessions retrieves in lastActive-desc order", () =>
    Effect.gen(function* () {
      const db = yield* Db.Service
      const s1 = makeSession({ id: "a", lastActive: "2024-01-01T10:00:00.000Z" })
      const s2 = makeSession({ id: "b", lastActive: "2024-01-02T10:00:00.000Z" })
      yield* db.upsertSessions([s1, s2])
      expect((yield* db.getSessions()).map(s => s.id)).toEqual(["b", "a"])
    }),
  )

  it.effect("upsertSessions updates existing session on id conflict", () =>
    Effect.gen(function* () {
      const db = yield* Db.Service
      yield* db.upsertSessions([makeSession({ preview: "first" })])
      yield* db.upsertSessions([makeSession({ preview: "updated" })])
      const result = yield* db.getSessions()
      expect(result).toHaveLength(1)
      expect(result[0]!.preview).toBe("updated")
    }),
  )

  it.effect("getSessions excludes rows with null lastActive", () =>
    Effect.gen(function* () {
      const db = yield* Db.Service
      yield* db.upsertSessions([makeSession({ lastActive: null })])
      expect(yield* db.getSessions()).toEqual([])
    }),
  )

  it.effect("hasBranches and isBranch booleans round-trip correctly", () =>
    Effect.gen(function* () {
      const db = yield* Db.Service
      yield* db.upsertSessions([makeSession({ hasBranches: true, isBranch: true, branchNumber: 2 })])
      const [s] = yield* db.getSessions()
      expect(s!.hasBranches).toBe(true)
      expect(s!.isBranch).toBe(true)
      expect(s!.branchNumber).toBe(2)
    }),
  )

  it.effect("upsertSessions([]) is a no-op", () =>
    Effect.gen(function* () {
      const db = yield* Db.Service
      yield* db.upsertSessions([])
      expect(yield* db.getSessions()).toEqual([])
    }),
  )
})
