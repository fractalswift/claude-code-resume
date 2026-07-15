export interface Session {
  id: string
  displayName: string
  repo: string | null
  branch: string | null
  workingDir: string | null
  preview: string | null
  startedAt: string | null
  lastActive: string | null
  hasBranches: boolean
  isBranch: boolean
  branchNumber: number | null
  forkedFromSessionId: string | null
  content?: string | null
  filePath?: string | null
  fileMtime?: number | null
}
