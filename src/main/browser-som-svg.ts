import type { SomMarker } from './browser-som-types.ts'

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

/** SVG layer for Set-of-Marks badges (no Electron). */
export function somSvg(markers: SomMarker[], width: number, height: number, scale: number): string {
  const badges = markers.map((marker) => {
    const x = marker.left * scale
    const y = marker.top * scale
    const label = escapeXml(marker.ref)
    const w = Math.max(28, label.length * 7 + 10)
    return `<g transform="translate(${x},${y})">`
      + `<rect x="0" y="0" width="${w}" height="18" rx="4" ry="4" fill="#dc2626" stroke="#fff" stroke-width="1.5"/>`
      + `<text x="5" y="13" font-family="system-ui,sans-serif" font-weight="700" font-size="11" fill="#fff">${label}</text>`
      + '</g>'
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${badges}</svg>`
}
