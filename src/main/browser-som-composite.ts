import { nativeImage, type NativeImage } from 'electron'
import { somSvg } from './browser-som-svg.ts'
import type { SomMarker } from './browser-som-types.ts'

export type { SomMarker } from './browser-som-types.ts'

/** Draw Set-of-Marks badges on a screenshot; the live page is never modified. */
export function compositeSomMarkers(
  image: NativeImage,
  markers: SomMarker[],
  viewportWidth: number
): NativeImage {
  if (!markers.length || viewportWidth <= 0 || image.isEmpty()) return image
  const { width, height } = image.getSize()
  const scale = width / viewportWidth
  const svg = somSvg(markers, width, height, scale)
  const overlay = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
  if (overlay.isEmpty()) return image
  return blendOver(image, overlay)
}

function blendOver(base: NativeImage, overlay: NativeImage): NativeImage {
  const size = base.getSize()
  let top = overlay
  if (top.getSize().width !== size.width || top.getSize().height !== size.height) {
    top = top.resize({ width: size.width, height: size.height, quality: 'best' })
  }
  const b = base.toBitmap()
  const o = top.toBitmap()
  if (b.length !== o.length) return base
  for (let i = 0; i < b.length; i += 4) {
    const a = o[i + 3]! / 255
    if (a <= 0) continue
    b[i] = Math.round(o[i]! * a + b[i]! * (1 - a))
    b[i + 1] = Math.round(o[i + 1]! * a + b[i + 1]! * (1 - a))
    b[i + 2] = Math.round(o[i + 2]! * a + b[i + 2]! * (1 - a))
    b[i + 3] = 255
  }
  return nativeImage.createFromBitmap(b, { width: size.width, height: size.height })
}
