import {
  createCliRenderer,
  TextRenderable,
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  StyledText,
  fg,
  CliRenderEvents,
} from "@opentui/core"
import type { Session } from "./types"
import type { SearchResult } from "./db"
import { shortDate, truncPad } from "./format"
import { C } from "./colors"
import {
  SessionList,
  SessionListEvents,
  groupSessions,
  buildHeader,
  calcPreviewLen,
  SortMode,
  DisplayItem,
} from "./session-list"

// ── Detail helpers ────────────────────────────────────────────────────────
function buildDetailLines(s: Session, byId: Map<string, Session>): string[] {
  const dir     = s.workingDir ?? "—"
  const started = shortDate(s.startedAt)
  let forkInfo  = ""
  if (s.isBranch && s.forkedFromSessionId) {
    const parent = byId.get(s.forkedFromSessionId)
    const label  = parent
      ? (parent.branch ?? parent.displayName ?? parent.id.slice(0, 8))
      : s.forkedFromSessionId.slice(0, 8)
    forkInfo = `  ·  ⎇ branch of: ${label}`
  }
  return [
    `${dir}   started ${started}${forkInfo}`,
    s.preview ? `"${s.preview}"` : "—",
  ]
}

function wordWrap(text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) { lines.push(""); continue }
    let line = ""
    for (const word of words) {
      const w = word.length > maxWidth ? word.slice(0, maxWidth) : word
      if (!line) { line = w }
      else if (line.length + 1 + w.length <= maxWidth) { line += " " + w }
      else { lines.push(line); line = w }
    }
    if (line) lines.push(line)
  }
  return lines.length ? lines : ["—"]
}

function buildSnippetContent(lines: string[]): StyledText | string {
  if (!lines.some((l) => l.includes("»"))) return lines.join("\n")
  const chunks: ReturnType<ReturnType<typeof fg>>[] = []
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) chunks.push(fg(C.detailTextFg)("\n"))
    for (const part of lines[i].split(/(»[^«]*«)/)) {
      if (part.startsWith("»") && part.endsWith("«")) {
        chunks.push(fg(C.searchHl)(part.slice(1, -1)))
      } else if (part) {
        chunks.push(fg(C.detailTextFg)(part))
      }
    }
  }
  return new StyledText(chunks)
}

// ── Public interface ───────────────────────────────────────────────────────
export interface ResumeTarget {
  sessionId: string
  cwd: string | null
}

export async function showUI(
  sessions: Session[],
  searchSessions: (query: string) => Promise<SearchResult[]>,
): Promise<ResumeTarget | null> {
  const byId    = new Map(sessions.map((s) => [s.id, s]))
  let sortMode: SortMode = "date"

  process.stdout.write(
    "\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?1016l" +
    "\x1b[?1004l\x1b[?2004l\x1b[?25h"
  )
  const disableMouse = () => {
    process.stdout.write("\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?25h")
  }
  process.once("exit", disableMouse)

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    await new Promise<void>((resolve) => {
      const onData = () => {}
      process.stdin.resume()
      process.stdin.on("data", onData)
      setTimeout(() => { process.stdin.off("data", onData); process.stdin.pause(); resolve() }, 50)
    })
    process.stdin.setRawMode(false)
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
    backgroundColor: C.bg,
  })

  let W = renderer.width
  let H = renderer.height
  const DETAIL_H     = 12
  const PREVIEW_ROWS = DETAIL_H - 4

  // ── Sessions box (top panel) ──────────────────────────────────────────────
  const sessionsBox = new BoxRenderable(renderer, {
    id: "sessions-box",
    position: "absolute",
    top: 0, left: 0,
    width: W, height: H - DETAIL_H,
    backgroundColor: C.bg,
    border: true,
    borderStyle: "rounded",
    borderColor: C.border,
    title: " cs ",
    titleColor: C.borderBright,
    titleAlignment: "left",
    bottomTitle: `  ↑↓ navigate  ·  enter resume  ·  tab detail  ·  / search  ·  s sort: date  ·  q quit  ·  ${sessions.length} sessions  `,
    bottomTitleAlignment: "left",
  })
  renderer.root.add(sessionsBox)

  // ── Column headers ────────────────────────────────────────────────────────
  const headers = new TextRenderable(renderer, {
    id: "headers",
    position: "absolute",
    top: 1, left: 1,
    width: W - 2, height: 1,
    content: buildHeader(calcPreviewLen(W)),
    fg: C.headerFg,
    bg: C.bg,
  })
  renderer.root.add(headers)

  // ── Search bar ────────────────────────────────────────────────────────────
  const searchPrefix = new TextRenderable(renderer, {
    id: "search-prefix",
    position: "absolute",
    top: 2, left: 1,
    width: 4, height: 1,
    content: "  / ",
    fg: C.headerFg,
    bg: C.bg,
  })
  renderer.root.add(searchPrefix)

  const searchInput = new InputRenderable(renderer, {
    id: "search-input",
    position: "absolute",
    top: 2, left: 5,
    width: W - 7,
    placeholder: "search...",
    backgroundColor:        C.bg,
    focusedBackgroundColor: C.searchActiveBg,
    textColor:              C.rowFg,
    focusedTextColor:       C.selectedFg,
    placeholderColor:       C.headerFg,
  })
  renderer.root.add(searchInput)

  // ── Top separator ────────────────────────────────────────────────────────
  const sepTop = new TextRenderable(renderer, {
    id: "sep-top",
    position: "absolute",
    top: 3, left: 1,
    width: W - 2, height: 1,
    content: "─".repeat(W - 2),
    fg: C.sepFg,
    bg: C.bg,
  })
  renderer.root.add(sepTop)

  // ── Session list (custom, styled) ─────────────────────────────────────────
  const sessionList = new SessionList(renderer as any, {
    top:        4,
    left:       1,
    width:      W - 2,
    height:     H - DETAIL_H - 5,
    previewLen: calcPreviewLen(W),
  })
  renderer.root.add(sessionList.scrollBox)

  // ── Detail panel (bottom panel) ───────────────────────────────────────────
  const detailTop = H - DETAIL_H

  const detailBox = new BoxRenderable(renderer, {
    id: "detail-box",
    position: "absolute",
    top: detailTop, left: 0,
    width: W, height: DETAIL_H,
    backgroundColor: C.bg,
    border: true,
    borderStyle: "rounded",
    borderColor: C.border,
    focusedBorderColor: C.borderBright,
    title: " session ",
    titleColor: C.borderBright,
    titleAlignment: "left",
    bottomTitle: "  tab: focus  ",
    bottomTitleAlignment: "right",
  })
  renderer.root.add(detailBox)

  const detailPath = new TextRenderable(renderer, {
    id: "detail-path",
    position: "absolute",
    top: detailTop + 1, left: 2,
    width: W - 4, height: 1,
    content: "",
    fg: C.detailPathFg,
    bg: C.bg,
  })
  renderer.root.add(detailPath)

  const detailSep = new TextRenderable(renderer, {
    id: "detail-sep",
    position: "absolute",
    top: detailTop + 2, left: 1,
    width: W - 2, height: 1,
    content: "─".repeat(W - 2),
    fg: C.sepFg,
    bg: C.bg,
  })
  renderer.root.add(detailSep)

  const detailPreview = new TextRenderable(renderer, {
    id: "detail-preview",
    position: "absolute",
    top: detailTop + 3, left: 2,
    width: W - 4, height: PREVIEW_ROWS,
    content: "",
    fg: C.detailTextFg,
    bg: C.bg,
  })
  renderer.root.add(detailPreview)

  // ── Empty state (shown when list has no items) ────────────────────────────
  const listEmpty = new TextRenderable(renderer, {
    id: "list-empty",
    position: "absolute",
    top: 7, left: 5,
    width: 30, height: 1,
    content: "No results.",
    fg: C.headerFg,
    bg: C.bg,
    visible: false,
  })
  renderer.root.add(listEmpty)

  // ── State ─────────────────────────────────────────────────────────────────
  type FocusedPanel = "list" | "detail" | "search"
  let focusedPanel: FocusedPanel = "list"
  let previewScroll  = 0
  let previewLines: string[] = []
  let searchDebounce: ReturnType<typeof setTimeout> | null = null
  let skipNextInput = false
  const searchSnippetMap = new Map<string, string[]>()

  // ── Detail panel rendering ────────────────────────────────────────────────
  const renderPreview = () => {
    const visible      = previewLines.slice(previewScroll, previewScroll + PREVIEW_ROWS)
    const isSearchMode = searchInput.value.length > 0
    detailPreview.content = isSearchMode ? buildSnippetContent(visible) : visible.join("\n")

    const overflow = previewLines.length > PREVIEW_ROWS
    if (focusedPanel === "detail") {
      detailBox.bottomTitle = overflow
        ? `  ${previewScroll + 1}–${Math.min(previewScroll + PREVIEW_ROWS, previewLines.length)}/${previewLines.length}  ↑↓ scroll  ·  esc/tab: back  `
        : "  esc/tab: back  "
    } else {
      detailBox.bottomTitle = overflow ? `  tab: focus  ·  ${previewLines.length} lines  ` : "  tab: focus  "
    }
  }

  const setDetailSession = (s: Session) => {
    const lines    = buildDetailLines(s, byId)
    detailPath.content = lines[0] ?? ""
    const snippets = searchInput.value ? searchSnippetMap.get(s.id) : undefined
    previewLines   = snippets?.length ? snippets : wordWrap(lines[1] ?? "—", W - 6)
    previewScroll  = 0
    renderPreview()
  }

  // ── Focus helpers ─────────────────────────────────────────────────────────
  const updateSearchPrefix = () => {
    const hasQuery = searchInput.value.length > 0
    const focused  = focusedPanel === "search"
    searchPrefix.fg = focused ? C.searchFg : hasQuery ? C.rowFg : C.headerFg
    searchPrefix.bg = focused ? C.searchActiveBg : C.bg
  }

  const focusDetail = () => {
    focusedPanel = "detail"
    searchInput.blur()
    detailBox.borderColor = C.borderBright
    updateSearchPrefix()
    renderPreview()
  }

  const focusList = () => {
    focusedPanel = "list"
    searchInput.blur()
    detailBox.borderColor = C.border
    updateSearchPrefix()
    renderPreview()
  }

  const focusSearch = () => {
    focusedPanel = "search"
    skipNextInput = true  // discard the keypress that triggered focus (e.g. "/")
    searchInput.focus()
    detailBox.borderColor = C.border
    updateSearchPrefix()
  }

  const clearSearch = () => {
    searchInput.value = ""
    searchSnippetMap.clear()
    rebuildList()
    updateSearchPrefix()
  }

  if (sessions.length === 0) {
    const empty = new TextRenderable(renderer, {
      id: "empty",
      position: "absolute",
      top: 5, left: 3,
      width: W - 4, height: 1,
      content: "No sessions found in ~/.claude/projects/",
      fg: C.headerFg,
      bg: C.bg,
    })
    renderer.root.add(empty)
    renderer.start()
    return new Promise((resolve) => {
      renderer.keyInput.on("keypress", () => {
        process.off("exit", disableMouse)
        renderer.destroy()
        resolve(null)
      })
    })
  }

  // ── List management ───────────────────────────────────────────────────────
  const rebuildList = () => {
    const items = groupSessions(sessions, byId, sortMode)
    sessionList.setItems(items)
    listEmpty.visible = false
    if (items[0]) setDetailSession(items[0].session)
    const label = sortMode === "where" ? "where" : "date"
    sessionsBox.bottomTitle = `  ↑↓ navigate  ·  enter resume  ·  tab detail  ·  / search  ·  s sort: ${label}  ·  q quit  ·  ${sessions.length} sessions  `
  }

  const triggerSearch = () => {
    if (searchDebounce) clearTimeout(searchDebounce)
    if (!searchInput.value.trim()) {
      searchSnippetMap.clear()
      rebuildList()
      return
    }
    searchDebounce = setTimeout(async () => {
      const results = await searchSessions(searchInput.value)
      searchSnippetMap.clear()
      for (const r of results) searchSnippetMap.set(r.session.id, r.snippets)
      const items: DisplayItem[] = results.map((r) => ({
        session: r.session,
        isChild: false,
        snippet: r.snippets[0],
      }))
      sessionList.setItems(items)
      listEmpty.visible = items.length === 0
      if (items[0]) setDetailSession(items[0].session)
      sessionsBox.bottomTitle = `  ↑↓ navigate  ·  enter resume  ·  esc clear search  ·  ${results.length} results  `
    }, 150)
  }

  // Initial load
  rebuildList()

  // ── Resize handler ────────────────────────────────────────────────────────
  renderer.on(CliRenderEvents.RESIZE, () => {
    W = renderer.terminalWidth
    H = renderer.terminalHeight
    const previewLen = calcPreviewLen(W)

    sessionsBox.width  = W
    sessionsBox.height = H - DETAIL_H
    headers.width   = W - 2
    headers.content = buildHeader(previewLen)
    searchInput.width = W - 7
    sepTop.width    = W - 2
    sepTop.content  = "─".repeat(W - 2)

    sessionList.resize(W, H - DETAIL_H - 5)

    const dTop = H - DETAIL_H
    detailBox.top    = dTop;     detailBox.width  = W
    detailPath.top   = dTop + 1; detailPath.width = W - 4
    detailSep.top    = dTop + 2; detailSep.width  = W - 2
    detailSep.content = "─".repeat(W - 2)
    detailPreview.top  = dTop + 3; detailPreview.width = W - 4

    const item = sessionList.selectedItem
    if (item) setDetailSession(item.session)
  })

  renderer.start()

  // ── SessionList events ────────────────────────────────────────────────────
  sessionList.on(SessionListEvents.SELECTION_CHANGED, (_: number, item: DisplayItem) => {
    if (item) setDetailSession(item.session)
  })

  // ── InputRenderable events ────────────────────────────────────────────────
  searchInput.on(InputRenderableEvents.INPUT, () => {
    if (skipNextInput) {
      skipNextInput = false
      searchInput.value = ""
      return
    }
    updateSearchPrefix()
    triggerSearch()
  })
  searchInput.on(InputRenderableEvents.ENTER, () => focusList())

  return new Promise((resolve) => {
    sessionList.on(SessionListEvents.ITEM_SELECTED, (_: number, item: DisplayItem) => {
      if (searchDebounce) clearTimeout(searchDebounce)
      process.off("exit", disableMouse)
      renderer.destroy()
      resolve({ sessionId: item.session.id, cwd: item.session.workingDir })
    })

    renderer.keyInput.on("keypress", (key: any) => {
      // Tab cycles: list → detail → search → list
      if (key.name === "tab") {
        if (focusedPanel === "list") focusDetail()
        else if (focusedPanel === "detail") focusSearch()
        else if (focusedPanel === "search") focusList()
        return
      }

      // ── Detail panel ─────────────────────────────────────────────────────
      if (focusedPanel === "detail") {
        if (key.name === "up") {
          if (previewScroll > 0) { previewScroll--; renderPreview() }
        } else if (key.name === "down") {
          const max = Math.max(0, previewLines.length - PREVIEW_ROWS)
          if (previewScroll < max) { previewScroll++; renderPreview() }
        } else if (key.name === "escape") {
          focusList()
        }
        return
      }

      // ── Search panel ─────────────────────────────────────────────────────
      if (focusedPanel === "search") {
        if (key.name === "escape") { clearSearch(); focusList() }
        else if (key.name === "down") { focusList() }
        return
      }

      // ── List panel ────────────────────────────────────────────────────────
      if (key.name === "up")       { sessionList.moveUp();     return }
      if (key.name === "down")     { sessionList.moveDown();   return }
      if (key.name === "pageup")   { sessionList.moveUp(10);   return }
      if (key.name === "pagedown") { sessionList.moveDown(10); return }
      if (key.name === "return" || key.name === "enter") { sessionList.selectCurrent(); return }
      if (key.name === "/") { focusSearch(); return }
      if (key.name === "escape" && searchInput.value) { clearSearch(); return }
      if (key.name === "s" && !searchInput.value) {
        sortMode = sortMode === "date" ? "where" : "date"
        rebuildList()
        return
      }
      if (key.name === "q" || key.name === "escape") {
        if (searchDebounce) clearTimeout(searchDebounce)
        process.off("exit", disableMouse)
        renderer.destroy()
        resolve(null)
      }
    })
  })
}
