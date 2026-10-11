// Coercions for provider payloads, which arrive as `unknown` and are never trusted to be shaped
// the way the last CLI version shaped them.

export function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)))
}

/** Keep the tail of long tool output: the end is where the result and the error are. */
export function clipOutput(text: string, max = 6_000): string {
  return text.length > max ? `…${text.slice(text.length - max)}` : text
}

export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function jsonPreview(value: unknown, max = 200): string {
  try {
    return oneLine(JSON.stringify(value) ?? '', max)
  } catch {
    return ''
  }
}
