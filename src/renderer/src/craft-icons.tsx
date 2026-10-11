import { AppWindow, Aperture, AudioWaveform, Clapperboard, DraftingCompass, FileSignature, FileText, Image, LayoutTemplate, PenTool, Presentation, Sheet, Sparkles, type LucideIcon } from 'lucide-react'
import type { CraftAppInfo } from './craft.ts'

// Craft Studio's own icon for each Craft app (docs/mockups/craft-icons.html, option B, agreed on
// 2026-10-11): a Lucide glyph for what the app does, in white on a squircle of the app's colour.
// The apps' own icons are not used, so nothing of their branding is shown. This is the one place
// app icons are drawn: the shelf's cards, the dock and the app region's starting placeholder.

const GLYPHS: Record<string, LucideIcon> = {
  photocraft: Image,
  vectorcraft: PenTool,
  filmcraft: Clapperboard,
  lightcraft: Aperture,
  effectcraft: Sparkles,
  designcraft: LayoutTemplate,
  soundcraft: AudioWaveform,
  wordcraft: FileText,
  gridcraft: Sheet,
  deckcraft: Presentation,
  pdfcraft: FileSignature,
  cadcraft: DraftingCompass
}

/** The glyph for an app; one the manifest gains later gets a plain window until it has its own. */
export function glyphOf(id: string): LucideIcon {
  return GLYPHS[id] ?? AppWindow
}

export function CraftIcon({ app, size = 30 }: { app: Pick<CraftAppInfo, 'id' | 'accent'>; size?: number }) {
  const Glyph = glyphOf(app.id)
  // Lucide's 1.75 stroke is drawn about 1px wide at the dock's 15px glyph and goes faint there, so
  // small icons get a slightly heavier line and a glyph a little over half the tile.
  const small = size < 40
  const glyph = Math.round(size * (small ? 0.54 : 0.5))
  return (
    <span
      className={`craft-icon${small ? ' is-small' : ''}`}
      data-glyph={app.id in GLYPHS ? app.id : 'default'}
      style={{ '--a': app.accent, width: size, height: size, borderRadius: Math.round(size * 0.27) } as React.CSSProperties}
      aria-hidden
    >
      <Glyph size={glyph} strokeWidth={small ? 2 : 1.75} />
    </span>
  )
}
