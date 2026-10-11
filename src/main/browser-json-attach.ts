/** Truncate JSON bodies appended to browser_read for CRM-style record APIs. */

export const JSON_ATTACH_LIMIT = 4_096

export function truncateJsonBody(text: string, limit = JSON_ATTACH_LIMIT): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 1)}…\n[… ${trimmed.length - limit + 1} more characters; use tab.body(requestId) for the full response]`
}

export function formatAttachedJson(requestId: string, body: string, limit = JSON_ATTACH_LIMIT): string {
  const clipped = truncateJsonBody(body, limit)
  return `## Attached JSON (from ${requestId})\n\`\`\`json\n${clipped}\n\`\`\``
}
