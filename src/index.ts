#!/usr/bin/env bun
import { Effect, Layer } from "effect"
import { writeFileSync } from "node:fs"
import * as Scan from "./scan"
import * as Db from "./db"
import { showUI } from "./ui"

const program = Effect.gen(function* () {
  const { scan } = yield* Scan.Service
  const { upsertSessions, getSessions, getSessionMtimes, search } = yield* Db.Service

  const mtimeCache = yield* getSessionMtimes()
  const changed = yield* scan(mtimeCache)
  if (changed.length > 0) yield* upsertSessions(changed)
  const sessions = yield* getSessions()

  const searchSessions = (query: string): Promise<import("./db").SearchResult[]> =>
    Effect.runPromise(search(query))

  const target = yield* Effect.promise(() => showUI(sessions, searchSessions))
  if (!target) return

  // Write result for the shell wrapper to pick up and exec claude.
  // The wrapper uses exec so the shell process is replaced by claude —
  // no competing stdin readers from our process.
  const outputFile = process.env.CS_OUTPUT_FILE
  yield* Effect.sync(() => {
    const line = `${target.sessionId}\t${target.cwd ?? ""}`
    if (outputFile) writeFileSync(outputFile, line)
    else process.stdout.write(line + "\n")
  })
})


const MainLayer = Layer.mergeAll(Scan.defaultLayer, Db.defaultLayer)

Effect.runPromise(program.pipe(Effect.provide(MainLayer))).catch((err) => {
  console.error("cs error:", err)
  process.exit(1)
})
