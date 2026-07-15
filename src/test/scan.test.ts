import { test, describe, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as Scan from "../scan"

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "cs-scan-test-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeSession(projectName: string, sessionId: string, lines: object[]) {
  const dir = join(tmpDir, projectName)
  await mkdir(dir, { recursive: true })
  await Bun.write(join(dir, `${sessionId}.jsonl`), lines.map(l => JSON.stringify(l)).join("\n"))
}

const runScan = (dir = tmpDir) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scan = yield* Scan.Service
      return yield* scan.scan(new Map())
    }).pipe(Effect.provide(Scan.testLayer(dir))),
  )

describe("ScanService", () => {
  test("returns [] when projects dir does not exist", async () => {
    expect(await runScan("/nonexistent/path/xyz")).toEqual([])
  })

  test("parses valid JSONL into a Session with correct fields", async () => {
    await writeSession("proj-a", "sess-001", [
      { sessionId: "sess-001", cwd: "/home/user/proj", gitBranch: "main", timestamp: "2024-01-01T10:00:00.000Z" },
      { type: "user", origin: { kind: "human" }, message: { content: "fix the login bug" }, timestamp: "2024-01-01T11:00:00.000Z" },
    ])
    const [s] = await runScan()
    expect(s!.id).toBe("sess-001")
    expect(s!.preview).toBe("fix the login bug")
    expect(s!.lastActive).toBe("2024-01-01T11:00:00.000Z")
    expect(s!.startedAt).toBe("2024-01-01T10:00:00.000Z")
  })

  test("skips lines with invalid JSON without crashing", async () => {
    const dir = join(tmpDir, "proj-b")
    await mkdir(dir, { recursive: true })
    await Bun.write(join(dir, "sess-002.jsonl"), [
      JSON.stringify({ sessionId: "sess-002", cwd: "/p", gitBranch: "main", timestamp: "2024-01-01T09:00:00.000Z" }),
      "NOT VALID JSON {{{{",
      JSON.stringify({ type: "user", origin: { kind: "human" }, message: { content: "hello world" }, timestamp: "2024-01-01T10:00:00.000Z" }),
    ].join("\n"))
    const [s] = await runScan()
    expect(s!.preview).toBe("hello world")
  })

  test("reads gitBranch into branch and displayName", async () => {
    await writeSession("proj-c", "sess-003", [
      { sessionId: "sess-003", cwd: "/home/user/proj", gitBranch: "feature/auth", timestamp: "2024-01-01T10:00:00.000Z" },
    ])
    const [s] = await runScan()
    expect(s!.branch).toBe("feature/auth")
    expect(s!.displayName).toBe("feature/auth")
  })

  test("falls back to cwd dirname when no gitBranch", async () => {
    await writeSession("proj-d", "sess-004", [
      { sessionId: "sess-004", cwd: "/home/user/my-project", timestamp: "2024-01-01T10:00:00.000Z" },
    ])
    const [s] = await runScan()
    expect(s!.displayName).toBe("my-project")
  })

  test("parses isBranch and branchNumber from customTitle '(Branch 3)'", async () => {
    await writeSession("proj-e", "sess-005", [
      { sessionId: "sess-005", cwd: "/p", timestamp: "2024-01-01T10:00:00.000Z" },
      { type: "custom-title", customTitle: "some work (Branch 3)", timestamp: "2024-01-01T10:01:00.000Z" },
    ])
    const [s] = await runScan()
    expect(s!.isBranch).toBe(true)
    expect(s!.branchNumber).toBe(3)
  })

  test("parses '(Branch)' without number as branchNumber=1", async () => {
    await writeSession("proj-f", "sess-006", [
      { sessionId: "sess-006", cwd: "/p", timestamp: "2024-01-01T10:00:00.000Z" },
      { type: "custom-title", customTitle: "work (Branch)", timestamp: "2024-01-01T10:01:00.000Z" },
    ])
    const [s] = await runScan()
    expect(s!.isBranch).toBe(true)
    expect(s!.branchNumber).toBe(1)
  })

  test("sorts sessions by lastActive descending", async () => {
    await writeSession("proj-g", "sess-007", [
      { sessionId: "sess-007", cwd: "/p", timestamp: "2024-01-01T08:00:00.000Z" },
    ])
    await writeSession("proj-g", "sess-008", [
      { sessionId: "sess-008", cwd: "/p", timestamp: "2024-01-02T08:00:00.000Z" },
    ])
    const result = await runScan()
    expect(result.map(s => s.id)).toEqual(["sess-008", "sess-007"])
  })

  test("skips sessions with no sessionId", async () => {
    await writeSession("proj-h", "sess-009", [
      { cwd: "/p", timestamp: "2024-01-01T10:00:00.000Z" },
    ])
    expect(await runScan()).toEqual([])
  })

  test("skips sessions with null lastActive", async () => {
    await writeSession("proj-i", "sess-010", [
      { sessionId: "sess-010", cwd: "/p" },
    ])
    expect(await runScan()).toEqual([])
  })
})
