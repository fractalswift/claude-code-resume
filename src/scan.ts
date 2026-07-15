import { readdir, access, stat } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { Context, Effect, Layer } from "effect"
import type { Session } from "./types"
import { ScanError } from "./errors"

const PROJECTS_DIR = join(homedir(), ".claude", "projects")
const MAX_CONTENT = 50_000

// --- Pure helpers ---

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim()
  if (Array.isArray(content)) {
    return (content as any[])
      .filter((b) => b?.type === "text")
      .map((b) => b.text ?? "")
      .join(" ")
      .trim()
  }
  return ""
}

function normalizeGitRemote(url: string): string {
  return url
    .replace(/^git@[^:]+:/, "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\.git$/, "")
    .trim()
}

function getDetachedHash(cwd: string): string | null {
  try {
    const result = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--short", "HEAD"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    if (result.exitCode !== 0) return null
    const hash = new TextDecoder().decode(result.stdout).trim()
    return hash ? `detached@${hash}` : null
  } catch {
    return null
  }
}

function resolveBranch(raw: string | null, cwd: string | null): string {
  // Proper branch name — use it directly
  if (raw && raw !== "HEAD") return raw

  // "HEAD" or absent: Claude writes "HEAD" for both detached HEAD and non-git dirs.
  // Try to get the commit hash — success means real detached HEAD, failure means no git.
  if (cwd) {
    const hash = getDetachedHash(cwd)
    if (hash) return hash // e.g. "detached@abc1234"
  }

  return "no branch"
}

function getGitRemote(cwd: string): string | null {
  try {
    const result = Bun.spawnSync(["git", "-C", cwd, "remote", "get-url", "origin"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    if (result.exitCode !== 0) return null
    const url = new TextDecoder().decode(result.stdout).trim()
    return url ? normalizeGitRemote(url) : null
  } catch {
    return null
  }
}

// --- Service ---

export interface Interface {
  readonly scan: (mtimeCache: Map<string, { session: Session; mtime: number }>) => Effect.Effect<Session[]>
}

export class Service extends Context.Service<Service, Interface>()("@cs/Scan") {}

const parseSession = (
  filePath: string,
  gitCache: Map<string, string | null>,
  fileMtime: number,
): Effect.Effect<Session | null, ScanError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => Bun.file(filePath).text(),
      catch: (e) => new ScanError({ path: filePath, cause: e }),
    })

    const sessionDir = filePath.replace(/\.jsonl$/, "")
    const hasBranches = yield* Effect.promise(() =>
      access(sessionDir + "/subagents").then(() => true).catch(() => false),
    )

    let sessionId: string | null = null
    let cwd: string | null = null
    let branch: string | null = null
    let preview: string | null = null
    let minTs: string | null = null
    let maxTs: string | null = null
    let customTitle: string | null = null
    let forkedFromSessionId: string | null = null
    let contentLen = 0
    const contentParts: string[] = []

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      let entry: Record<string, any>
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }

      if (entry.sessionId && !sessionId) sessionId = entry.sessionId
      if (entry.cwd && !cwd) cwd = entry.cwd
      if (entry.gitBranch && !branch) branch = entry.gitBranch
      if (entry.type === "custom-title" && entry.customTitle) customTitle = entry.customTitle
      if (entry.forkedFrom?.sessionId && !forkedFromSessionId) forkedFromSessionId = entry.forkedFrom.sessionId

      const ts: string | undefined = entry.timestamp
      if (ts) {
        if (!minTs || ts < minTs) minTs = ts
        if (!maxTs || ts > maxTs) maxTs = ts
      }

      if (!preview && entry.type === "user" && entry.origin?.kind === "human") {
        const text = extractText(entry.message?.content)
        // Skip trivial openers like "." that are just memory-read triggers
        if (text && text.length > 3) preview = text.slice(0, 400)
      }

      if (contentLen < MAX_CONTENT && (entry.type === "user" || entry.type === "assistant")) {
        const text = extractText(entry.message?.content)
        if (text) {
          const chunk = text.slice(0, MAX_CONTENT - contentLen)
          contentParts.push(chunk)
          contentLen += chunk.length
        }
      }
    }

    if (!sessionId) return null

    if (cwd && !gitCache.has(cwd)) {
      gitCache.set(cwd, getGitRemote(cwd))
    }
    const repo = cwd ? (gitCache.get(cwd) ?? null) : null

    const resolvedBranch = resolveBranch(branch, cwd)
    const displayName = branch
      ? resolvedBranch
      : cwd
      ? (cwd.split("/").pop() ?? "no branch")
      : "no branch"

    let isBranch = false
    let branchNumber: number | null = null
    if (customTitle) {
      const m = customTitle.match(/\(Branch(?: (\d+))?\)/)
      if (m) {
        isBranch = true
        branchNumber = m[1] ? parseInt(m[1], 10) : 1
      }
    }

    return {
      id: sessionId,
      displayName,
      repo,
      branch: resolvedBranch,
      workingDir: cwd,
      preview,
      startedAt: minTs,
      lastActive: maxTs,
      hasBranches,
      isBranch,
      branchNumber,
      forkedFromSessionId,
      content: contentLen > 0 ? contentParts.join(" ") : null,
      filePath,
      fileMtime,
    }
  })

export const layer = (projectsDir: string): Layer.Layer<Service> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of({
        scan: Effect.fn("Scan.scan")(function* (mtimeCache) {
          const projectDirs = yield* Effect.tryPromise({
            try: () => readdir(projectsDir, { withFileTypes: true }),
            catch: (e) => new ScanError({ path: projectsDir, cause: e }),
          }).pipe(
            Effect.map((entries) =>
              entries.filter((e) => e.isDirectory()).map((e) => join(projectsDir, e.name)),
            ),
            Effect.orElseSucceed(() => [] as string[]),
          )

          const gitCache = new Map<string, string | null>()
          const sessions: Session[] = []

          for (const dir of projectDirs) {
            const files = yield* Effect.tryPromise({
              try: () => readdir(dir, { withFileTypes: true }),
              catch: (e) => new ScanError({ path: dir, cause: e }),
            }).pipe(
              Effect.map((entries) =>
                entries
                  .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
                  .map((e) => join(dir, e.name)),
              ),
              Effect.orElseSucceed(() => [] as string[]),
            )

            for (const file of files) {
              const fileStat = yield* Effect.tryPromise({
                try: () => stat(file),
                catch: (e) => new ScanError({ path: file, cause: e }),
              }).pipe(Effect.orElseSucceed(() => null))

              if (!fileStat) continue

              const fileMtime = fileStat.mtimeMs
              const cached = mtimeCache.get(file)
              if (cached && cached.mtime === fileMtime) continue

              const session = yield* parseSession(file, gitCache, fileMtime).pipe(
                Effect.orElseSucceed(() => null),
              )
              if (session) sessions.push(session)
            }
          }

          return sessions
            .filter((s) => s.lastActive !== null)
            .sort((a, b) => (b.lastActive! > a.lastActive! ? 1 : -1))
        }),
      })
    }),
  )

export const defaultLayer = layer(PROJECTS_DIR)
export const testLayer = (projectsDir: string) => layer(projectsDir)
