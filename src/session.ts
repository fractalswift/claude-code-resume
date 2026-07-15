import { Effect, Duration } from "effect"
import { execFileSync } from "node:child_process"
import type { ResumeTarget } from "./ui"

const DIM   = "\x1b[2m"
const RESET = "\x1b[0m"

export const resumeSession = Effect.fn("resumeSession")(function* (target: ResumeTarget) {
  process.stdout.write("\x1b[2J\x1b[H")
  process.stdout.write(`${DIM}  Resuming session…${RESET}\n`)

  // Give opentui's native stdin thread time to fully stop after renderer.destroy().
  // Without this gap the native thread can still be reading stdin when claude starts,
  // causing dropped keypresses.
  yield* Effect.sleep(Duration.millis(80))

  // Restore terminal settings that opentui may have changed (raw mode, echo, etc.)
  yield* Effect.promise(() => Bun.$`stty sane`.quiet().nothrow())

  yield* Effect.try({
    try: () =>
      execFileSync("claude", ["--resume", target.sessionId], {
        cwd: target.cwd ?? process.cwd(),
        stdio: "inherit",
      }),
    catch: () => undefined,
  }).pipe(Effect.ignore)
})
