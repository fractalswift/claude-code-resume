import { Database } from "bun:sqlite"
import { Context, Effect, Layer } from "effect"
import { join } from "node:path"
import { homedir } from "node:os"
import type { Session } from "./types"
import { DbError } from "./errors"

const DB_PATH = join(homedir(), ".claude", "cs-sessions.db")

export interface SearchResult {
  session: Session
  snippets: string[]
}

function extractSnippets(highlighted: string, ctxBefore = 40, ctxAfter = 100): string[] {
  const OPEN = "\x01"
  const CLOSE = "\x02"
  const snippets: string[] = []
  let pos = 0
  while (pos < highlighted.length) {
    const matchStart = highlighted.indexOf(OPEN, pos)
    if (matchStart === -1) break
    const matchEnd = highlighted.indexOf(CLOSE, matchStart)
    if (matchEnd === -1) break
    const match = highlighted.slice(matchStart + 1, matchEnd)
    const ctxStart = Math.max(0, matchStart - ctxBefore)
    const ctxEnd = Math.min(highlighted.length, matchEnd + 1 + ctxAfter)
    const before = highlighted.slice(ctxStart, matchStart).replace(/[\x01\x02]/g, "")
    const after = highlighted.slice(matchEnd + 1, ctxEnd).replace(/[\x01\x02]/g, "")
    const prefix = ctxStart > 0 ? "…" : ""
    const suffix = ctxEnd < highlighted.length ? "…" : ""
    snippets.push(`${prefix}${before}»${match}«${after}${suffix}`)
    pos = matchEnd + 1
  }
  return snippets.slice(0, 20)
}

export interface Interface {
  readonly upsertSessions: (sessions: Session[]) => Effect.Effect<void, DbError>
  readonly getSessions: () => Effect.Effect<Session[], DbError>
  readonly getSessionMtimes: () => Effect.Effect<Map<string, { session: Session; mtime: number }>, DbError>
  readonly search: (query: string) => Effect.Effect<SearchResult[]>
}

export class Service extends Context.Service<Service, Interface>()("@cs/Db") {}

export const layer = (dbPath: string): Layer.Layer<Service, DbError> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* Effect.try({
        try: () => new Database(dbPath),
        catch: (e) => new DbError({ operation: "open", cause: e }),
      })

      yield* Effect.try({
        try: () => {
          db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY,
              displayName TEXT,
              repo TEXT,
              branch TEXT,
              workingDir TEXT,
              preview TEXT,
              startedAt TEXT,
              lastActive TEXT,
              hasBranches INTEGER NOT NULL DEFAULT 0,
              isBranch INTEGER NOT NULL DEFAULT 0,
              branchNumber INTEGER,
              forkedFromSessionId TEXT
            )
          `)
          const cols = (db.query("PRAGMA table_info(sessions)").all() as any[]).map((c) => c.name)
          if (!cols.includes("hasBranches"))         db.exec("ALTER TABLE sessions ADD COLUMN hasBranches INTEGER NOT NULL DEFAULT 0")
          if (!cols.includes("isBranch"))            db.exec("ALTER TABLE sessions ADD COLUMN isBranch INTEGER NOT NULL DEFAULT 0")
          if (!cols.includes("branchNumber"))        db.exec("ALTER TABLE sessions ADD COLUMN branchNumber INTEGER")
          if (!cols.includes("forkedFromSessionId")) db.exec("ALTER TABLE sessions ADD COLUMN forkedFromSessionId TEXT")
          if (!cols.includes("filePath"))            db.exec("ALTER TABLE sessions ADD COLUMN filePath TEXT")
          if (!cols.includes("fileMtime"))           db.exec("ALTER TABLE sessions ADD COLUMN fileMtime INTEGER")

          const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions_fts'").all() as any[])
          if (!tables.length) {
            db.exec(`CREATE VIRTUAL TABLE sessions_fts USING fts5(content, session_id UNINDEXED)`)
          }
        },
        catch: (e) => new DbError({ operation: "migrate", cause: e }),
      })

      return Service.of({
        upsertSessions: Effect.fn("Db.upsertSessions")(function* (sessions) {
          yield* Effect.try({
            try: () => {
              const stmt = db.prepare(`
                INSERT INTO sessions (id, displayName, repo, branch, workingDir, preview, startedAt, lastActive, hasBranches, isBranch, branchNumber, forkedFromSessionId, filePath, fileMtime)
                VALUES ($id, $displayName, $repo, $branch, $workingDir, $preview, $startedAt, $lastActive, $hasBranches, $isBranch, $branchNumber, $forkedFromSessionId, $filePath, $fileMtime)
                ON CONFLICT(id) DO UPDATE SET
                  displayName = excluded.displayName,
                  repo = excluded.repo,
                  branch = excluded.branch,
                  workingDir = excluded.workingDir,
                  preview = excluded.preview,
                  startedAt = excluded.startedAt,
                  lastActive = excluded.lastActive,
                  hasBranches = excluded.hasBranches,
                  isBranch = excluded.isBranch,
                  branchNumber = excluded.branchNumber,
                  forkedFromSessionId = excluded.forkedFromSessionId,
                  filePath = excluded.filePath,
                  fileMtime = excluded.fileMtime
              `)
              const ftsDelete = db.prepare(`DELETE FROM sessions_fts WHERE session_id = ?`)
              const ftsInsert = db.prepare(`INSERT INTO sessions_fts(session_id, content) VALUES (?, ?)`)
              db.transaction(() => {
                for (const s of sessions) {
                  stmt.run({
                    $id: s.id,
                    $displayName: s.displayName,
                    $repo: s.repo,
                    $branch: s.branch,
                    $workingDir: s.workingDir,
                    $preview: s.preview,
                    $startedAt: s.startedAt,
                    $lastActive: s.lastActive,
                    $hasBranches: s.hasBranches ? 1 : 0,
                    $isBranch: s.isBranch ? 1 : 0,
                    $branchNumber: s.branchNumber,
                    $forkedFromSessionId: s.forkedFromSessionId,
                    $filePath: s.filePath ?? null,
                    $fileMtime: s.fileMtime ?? null,
                  })
                  if (s.content != null) {
                    ftsDelete.run(s.id)
                    ftsInsert.run(s.id, s.content)
                  }
                }
              })()
            },
            catch: (e) => new DbError({ operation: "upsert", cause: e }),
          })
        }),

        getSessions: Effect.fn("Db.getSessions")(function* () {
          return yield* Effect.try({
            try: () => {
              const rows = db
                .query("SELECT * FROM sessions WHERE lastActive IS NOT NULL ORDER BY lastActive DESC")
                .all() as any[]
              return rows.map((r) => ({
                ...r,
                hasBranches: r.hasBranches === 1,
                isBranch: r.isBranch === 1,
              })) as Session[]
            },
            catch: (e) => new DbError({ operation: "query", cause: e }),
          })
        }),

        getSessionMtimes: Effect.fn("Db.getSessionMtimes")(function* () {
          return yield* Effect.try({
            try: () => {
              const rows = db
                .query("SELECT * FROM sessions WHERE filePath IS NOT NULL AND fileMtime IS NOT NULL")
                .all() as any[]
              const map = new Map<string, { session: Session; mtime: number }>()
              for (const r of rows) {
                const session: Session = {
                  ...r,
                  hasBranches: r.hasBranches === 1,
                  isBranch: r.isBranch === 1,
                }
                map.set(r.filePath as string, { session, mtime: r.fileMtime as number })
              }
              return map
            },
            catch: (e) => new DbError({ operation: "getSessionMtimes", cause: e }),
          })
        }),

        search: Effect.fn("Db.search")(function* (query: string) {
          return yield* Effect.try({
            try: () => {
              const terms = query.trim().split(/\s+/).filter(Boolean)
              if (!terms.length) return [] as SearchResult[]
              // Single word: prefix match. Multiple words: phrase prefix (exact word order).
              const ftsQuery = terms.length === 1
                ? `"${terms[0].replace(/"/g, "")}"*`
                : `"${query.trim().replace(/"/g, "")}"*`
              // highlight() must be called directly on the FTS table
              const ftsRows = db.query(`
                SELECT session_id, highlight(sessions_fts, 0, char(1), char(2)) as highlighted
                FROM sessions_fts WHERE sessions_fts MATCH ?
              `).all(ftsQuery) as { session_id: string; highlighted: string }[]
              if (!ftsRows.length) return [] as SearchResult[]
              const highlightMap = new Map(ftsRows.map((r) => [r.session_id, r.highlighted]))
              const placeholders = ftsRows.map(() => "?").join(",")
              const ids = ftsRows.map((r) => r.session_id)
              const sessionRows = db.query(
                `SELECT * FROM sessions WHERE id IN (${placeholders}) ORDER BY lastActive DESC`
              ).all(...ids) as any[]
              return sessionRows.map((r) => ({
                session: { ...r, hasBranches: r.hasBranches === 1, isBranch: r.isBranch === 1 } as Session,
                snippets: extractSnippets(highlightMap.get(r.id) ?? ""),
              })) as SearchResult[]
            },
            catch: () => [] as SearchResult[],
          }).pipe(Effect.orElseSucceed(() => [] as SearchResult[]))
        }),
      })
    }),
  )

export const defaultLayer = layer(DB_PATH)
export const testLayer = layer(":memory:")
