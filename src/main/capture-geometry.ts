// Pure helpers for screen capture, kept apart from Electron so they can be tested.

export type Rect = { x: number; y: number; width: number; height: number }

/**
 * A selection made over a display, in that display's DIP coordinates, as a rectangle of the
 * captured image's pixels. The image may be larger than the display's DIP size (device scale);
 * the result is clamped to the image and never empty.
 */
export function selectionToPixels(selection: Rect, display: { width: number; height: number }, image: { width: number; height: number }): Rect {
  const sx = image.width / display.width
  const sy = image.height / display.height
  const x = Math.max(0, Math.min(image.width - 1, Math.round(selection.x * sx)))
  const y = Math.max(0, Math.min(image.height - 1, Math.round(selection.y * sy)))
  const width = Math.max(1, Math.min(image.width - x, Math.round(selection.width * sx)))
  const height = Math.max(1, Math.min(image.height - y, Math.round(selection.height * sy)))
  return { x, y, width, height }
}

/** A file name for a capture: where it came from and when, safe for any file system. */
export function captureName(source: string, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const when = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`
  const label = source.replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Capture'
  return `${label} ${when}.png`
}
