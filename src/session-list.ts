import {
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  StyledText,
  fg,
} from "@opentui/core"
import { EventEmitter } from "events"
import type { RenderContext } from "@opentui/core"
import type { Session } from "./types"
import { C } from "./colors"
import { timeAgo, truncPad } from "./format"

// ── Column widths ─────────────────────────────────────────────────────────
export const WHERE_LEN  = 20
export const BRANCH_LEN = 32
export const AGE_LEN    = 10

// Fixed chars before preview: ind(2) + 2sp + WHERE + 2sp + BRANCH + 2sp + AGE + 2sp = 72
const FIXED_COLS = 2 + 2 + WHERE_LEN + 2 + BRANCH_LEN + 2 + AGE_LEN + 2

export function calcPreviewLen(terminalWidth: number): number {
  return Math.max(20, (terminalWidth - 2) - FIXED_COLS)
}

// ── DisplayItem ───────────────────────────────────────────────────────────
export interface DisplayItem {
  session: Session
  isChild: boolean
  snippet?: string
  isSeparator?: boolean
}

// ── Header ────────────────────────────────────────────────────────────────
export function buildHeader(previewLen: number): string {
  const preview = truncPad("FIRST MESSAGE", previewLen)
  return `  ${truncPad("WHERE", WHERE_LEN)}  ${truncPad("   BRANCH", BRANCH_LEN)}  ${truncPad("LAST ACTIVE", AGE_LEN)}  ${preview}`
}

// ── Grouping ──────────────────────────────────────────────────────────────
export type SortMode = "date" | "where"
const newerFirst = (a: string, b: string) => (a > b ? -1 : a < b ? 1 : 0)

function whereValue(s: Session): string {
  return s.repo ?? s.workingDir?.split("/").pop() ?? "—"
}

export function groupSessions(
  sessions: Session[],
  byId: Map<string, Session>,
  sortMode: SortMode = "date",
): DisplayItem[] {
  const childrenOf = new Map<string, Session[]>()
  const roots: Session[] = []

  for (const s of sessions) {
    const parentId = s.isBranch ? s.forkedFromSessionId : null
    if (parentId && byId.has(parentId)) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, [])
      childrenOf.get(parentId)!.push(s)
    } else {
      roots.push(s)
    }
  }
  for (const children of childrenOf.values()) {
    children.sort((a, b) => newerFirst(a.lastActive ?? "", b.lastActive ?? ""))
  }

  const groups = roots.map((root) => {
    const children  = childrenOf.get(root.id) ?? []
    const members   = [root, ...children]
    const maxActive = members.reduce((m, s) => ((s.lastActive ?? "") > m ? s.lastActive ?? "" : m), "")
    return { maxActive, where: whereValue(root), members }
  })

  if (sortMode === "where") {
    const bestForWhere = new Map<string, string>()
    for (const g of groups) {
      const prev = bestForWhere.get(g.where) ?? ""
      if (g.maxActive > prev) bestForWhere.set(g.where, g.maxActive)
    }
    groups.sort((a, b) => {
      const c1 = newerFirst(bestForWhere.get(a.where)!, bestForWhere.get(b.where)!)
      if (c1 !== 0) return c1
      const c2 = a.where.localeCompare(b.where)
      if (c2 !== 0) return c2
      return newerFirst(a.maxActive, b.maxActive)
    })
  } else {
    groups.sort((a, b) => newerFirst(a.maxActive, b.maxActive))
  }

  const items: DisplayItem[] = []
  for (let g = 0; g < groups.length; g++) {
    if (g > 0 && sortMode === "where" && groups[g].where !== groups[g - 1].where) {
      items.push({ session: groups[g].members[0], isChild: false, isSeparator: true })
    }
    for (let i = 0; i < groups[g].members.length; i++) {
      items.push({ session: groups[g].members[i], isChild: i > 0 })
    }
  }
  return items
}

// ── Row rendering ─────────────────────────────────────────────────────────
function branchPrefix(s: Session, isChild: boolean): string {
  if (isChild)    return `  ⎇${s.branchNumber ?? ""} `
  if (s.isBranch) return `⎇${s.branchNumber ?? ""} `
  return "   "
}

type Chunk = ReturnType<ReturnType<typeof fg>>

function snippetToChunks(snippet: string, maxLen: number, isSelected: boolean): Chunk[] {
  const matchFg  = isSelected ? C.selectedFg : C.searchHl
  const normalFg = isSelected ? C.selectedFg : C.detailTextFg
  const parts    = snippet.split(/(»[^«]*«)/)
  const chunks: Chunk[] = []
  let remaining = maxLen

  for (const part of parts) {
    if (remaining <= 0) break
    if (part.startsWith("»") && part.endsWith("«")) {
      const text = part.slice(1, -1).slice(0, remaining)
      if (text) { chunks.push(fg(matchFg)(text)); remaining -= text.length }
    } else if (part) {
      const text = part.slice(0, remaining)
      if (text) { chunks.push(fg(normalFg)(text)); remaining -= text.length }
    }
  }
  if (remaining > 0) chunks.push(fg(normalFg)(" ".repeat(remaining)))
  return chunks
}

function buildStyledRow(item: DisplayItem, isSelected: boolean, previewLen: number): StyledText {
  const s      = item.session
  const mainFg = isSelected ? C.selectedFg : (item.isChild ? C.childFg : C.rowFg)
  const ind    = isSelected ? "▶ " : "  "
  const where  = truncPad(whereValue(s), WHERE_LEN)
  const branch = truncPad(branchPrefix(s, item.isChild) + (s.branch ?? s.displayName ?? "—"), BRANCH_LEN)
  const age    = truncPad(timeAgo(s.lastActive), AGE_LEN)
  const header = `${ind}  ${where}  ${branch}  ${age}  `

  if (item.snippet) {
    return new StyledText([fg(mainFg)(header), ...snippetToChunks(item.snippet, previewLen, isSelected)])
  }

  const preview = truncPad(s.preview ? `"${s.preview}"` : "—", previewLen)
  return new StyledText([fg(mainFg)(header + preview)])
}

// ── SessionList ───────────────────────────────────────────────────────────
interface RowEntry {
  box:  BoxRenderable
  text: TextRenderable
  item: DisplayItem
}

export enum SessionListEvents {
  SELECTION_CHANGED = "selectionChanged",
  ITEM_SELECTED     = "itemSelected",
}

export class SessionList extends EventEmitter {
  readonly scrollBox: ScrollBoxRenderable
  private rows: RowEntry[] = []
  private _selectedIndex = 0
  private _currentItems: DisplayItem[] = []
  private _previewLen: number

  constructor(private ctx: RenderContext, opts: {
    top: number; left: number; width: number; height: number; previewLen: number
  }) {
    super()
    this._previewLen = opts.previewLen
    this.scrollBox = new ScrollBoxRenderable(ctx, {
      id:       "session-scroll",
      position: "absolute",
      top:      opts.top,
      left:     opts.left,
      width:    opts.width,
      height:   opts.height,
      focusable: false,
      scrollbarOptions:         { visible: false },
      verticalScrollbarOptions: { visible: false },
    })
  }

  setItems(items: DisplayItem[]) {
    this._currentItems = items
    for (const { box } of this.rows) this.scrollBox.remove(box.id!)
    this.rows = []

    for (let i = 0; i < items.length; i++) {
      const entry = this.makeRow(`sr-${i}`, items[i], false)
      this.scrollBox.add(entry.box)
      this.rows.push(entry)
    }

    this._selectedIndex = 0
    if (this.rows[0]) {
      this.updateRow(this.rows[0], true)
      this.scrollBox.scrollTo(0)
    }
  }

  resize(width: number, height: number) {
    this._previewLen = calcPreviewLen(width)
    this.scrollBox.width  = width - 2
    this.scrollBox.height = height
    // Regenerate row content with new preview width
    for (let i = 0; i < this.rows.length; i++) {
      const entry = this.rows[i]
      if (entry.item.isSeparator) {
        entry.text.content = new StyledText([fg(C.sepFg)("  " + "─".repeat(Math.max(0, this._previewLen + FIXED_COLS - 2)))])
      } else {
        entry.text.content = buildStyledRow(entry.item, i === this._selectedIndex, this._previewLen)
      }
    }
  }

  private makeRow(id: string, item: DisplayItem, isSelected: boolean): RowEntry {
    const box = new BoxRenderable(this.ctx, {
      id,
      width:           "100%",
      height:          1,
      backgroundColor: (!item.isSeparator && isSelected) ? C.selectedBg : C.bg,
    })
    const text = new TextRenderable(this.ctx, {
      id:       `${id}-t`,
      width:    "100%",
      height:   1,
      content:  item.isSeparator
        ? new StyledText([fg(C.sepFg)("  " + "─".repeat(Math.max(0, this._previewLen + FIXED_COLS - 2)))])
        : buildStyledRow(item, isSelected, this._previewLen),
      bg:       C.bg,
      wrapMode: "none",
    })
    box.add(text)
    return { box, text, item }
  }

  private updateRow(entry: RowEntry, isSelected: boolean) {
    if (entry.item.isSeparator) return
    entry.box.backgroundColor = isSelected ? C.selectedBg : C.bg
    entry.text.content = buildStyledRow(entry.item, isSelected, this._previewLen)
  }

  setSelectedIndex(index: number, emit = true) {
    if (this.rows.length === 0) return
    index = Math.max(0, Math.min(index, this.rows.length - 1))
    // Skip over separator rows — prefer direction toward end, fall back toward start
    if (this.rows[index]?.item.isSeparator) {
      let fwd = index
      while (fwd < this.rows.length - 1 && this.rows[fwd]?.item.isSeparator) fwd++
      if (!this.rows[fwd]?.item.isSeparator) { index = fwd }
      else {
        let bwd = index
        while (bwd > 0 && this.rows[bwd]?.item.isSeparator) bwd--
        if (!this.rows[bwd]?.item.isSeparator) index = bwd
      }
    }
    const prev = this._selectedIndex
    this._selectedIndex = index
    if (this.rows[prev])                this.updateRow(this.rows[prev], false)
    if (this.rows[this._selectedIndex]) {
      this.updateRow(this.rows[this._selectedIndex], true)
      this.scrollBox.scrollChildIntoView(this.rows[this._selectedIndex].box.id!)
    }
    if (emit) this.emit(SessionListEvents.SELECTION_CHANGED, this._selectedIndex, this.rows[this._selectedIndex]?.item)
  }

  moveUp(steps = 1) {
    let idx = this._selectedIndex
    let moved = 0
    while (moved < steps && idx > 0) {
      idx--
      if (!this.rows[idx]?.item.isSeparator) moved++
    }
    this.setSelectedIndex(idx)
  }

  moveDown(steps = 1) {
    let idx = this._selectedIndex
    let moved = 0
    while (moved < steps && idx < this.rows.length - 1) {
      idx++
      if (!this.rows[idx]?.item.isSeparator) moved++
    }
    this.setSelectedIndex(idx)
  }

  selectCurrent() {
    const item = this.rows[this._selectedIndex]?.item
    if (item && !item.isSeparator) this.emit(SessionListEvents.ITEM_SELECTED, this._selectedIndex, item)
  }

  get selectedIndex() { return this._selectedIndex }
  get selectedItem()  { return this.rows[this._selectedIndex]?.item ?? null }
}
