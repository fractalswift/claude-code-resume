export function timeAgo(isoStr: string | null): string {
  if (!isoStr) return "—"
  const diff = Date.now() - new Date(isoStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

export function shortDate(isoStr: string | null): string {
  if (!isoStr) return "—"
  const d = new Date(isoStr)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function truncPad(str: string, len: number): string {
  if (str.length > len) return str.slice(0, len - 1) + "…"
  return str.padEnd(len)
}
