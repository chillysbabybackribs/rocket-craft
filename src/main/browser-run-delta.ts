type RequestRow = {
  id: string
  method: string
  url: string
  kind: string
  status: number | null
  mime: string
}

export function formatNetworkDelta(requests: RequestRow[], sinceSeq: number, max = 12): string | null {
  const fresh = requests.filter((request) => Number(request.id.slice(1)) > sinceSeq)
  if (!fresh.length) return null
  const shown = fresh.slice(-max)
  return `## Since script started (network)\n${shown.map((request) =>
    `${request.id} ${request.method} ${request.status ?? '…'} ${request.mime.replace(/^application\//, '') || request.kind} ${request.url}`
  ).join('\n')}${fresh.length > shown.length ? `\n[… ${fresh.length - shown.length} earlier requests omitted]` : ''}`
}

export function formatReadDelta(before: string, after: string, maxLines = 15): string | null {
  const prev = new Set(before.split('\n').map((line) => line.trim()).filter(Boolean))
  const added = after.split('\n').map((line) => line.trim()).filter((line) => line && !prev.has(line))
  if (!added.length) return null
  const shown = added.slice(0, maxLines)
  return `## Since script started (page)\n${shown.join('\n')}${added.length > shown.length ? `\n[… ${added.length - maxLines} more new lines]` : ''}`
}
