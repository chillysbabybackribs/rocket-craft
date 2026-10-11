import { readFileSync } from 'node:fs'
import { MAX_MESSAGE_IMAGES, MAX_MESSAGE_IMAGE_BYTES, isFileAttachment, type FileAttachment } from '../../shared/types.ts'
import type { ProviderAttachment, ProviderImage } from '../attachments.ts'

// What every adapter sends for a message's attachments. Images go as pixels where the provider
// takes them. A PDF or text file goes as text inside the message (a PDF's extracted text), within
// a budget, with the stored file's path so a model can read past the budget or open a scanned PDF
// with its own tools. Every provider receives files the same way, Antigravity included: no
// provider's native document input is relied on yet.

const FILE_CHARS = 60_000
const MESSAGE_FILE_CHARS = 120_000

type File = FileAttachment & { path: string; textPath?: string }

function describe(file: File): string {
  if (file.format === 'pdf') return `PDF${file.pages ? `, ${file.pages} ${file.pages === 1 ? 'page' : 'pages'}` : ''}`
  return `text${file.lines ? `, ${file.lines} ${file.lines === 1 ? 'line' : 'lines'}` : ''}`
}

/** Current attachments come first. Large histories retain readable paths without replaying unbounded pixels or text. */
export function attachmentInput(text: string, attachments: ProviderAttachment[] = [], includePixels = true): { text: string; images: ProviderImage[] } {
  let size = 0
  const images = attachments.filter((each): each is ProviderImage => !isFileAttachment(each))
  const selected = images.filter((image, index) => {
    if (!includePixels || index >= MAX_MESSAGE_IMAGES || size + image.size > MAX_MESSAGE_IMAGE_BYTES) return false
    size += image.size
    return true
  })
  let budget = MESSAGE_FILE_CHARS
  const bodies: string[] = []
  const manifest = attachments.map(each => {
    if (!isFileAttachment(each)) return `[Image attachment ${each.id}: ${JSON.stringify(each.name)}; file ${JSON.stringify(each.path)}${selected.includes(each as ProviderImage) ? '; included below' : '; read this file if needed'}]`
    const file = each as File
    const head = `[File attachment ${file.id}: ${JSON.stringify(file.name)}; ${describe(file)}; file ${JSON.stringify(file.path)}`
    if (file.format === 'pdf' && !file.chars) return `${head}; no text could be extracted (it may be scanned), so read the file if you can]`
    if (budget <= 0) return `${head}; read this file if needed]`
    let content: string
    try { content = readFileSync(file.textPath ?? file.path, 'utf8').replace(/\f/g, '\n').trim() } catch { return `${head}; the stored copy is missing, so ask for it again]` }
    const shown = content.slice(0, Math.min(FILE_CHARS, budget))
    budget -= shown.length
    const cut = shown.length < content.length ? `\n[Truncated at ${shown.length} of ${content.length} characters; read the file for the rest.]` : ''
    bodies.push(`<file name=${JSON.stringify(file.name)} attachment="${file.id}">\n${shown}${cut}\n</file>`)
    return `${head}; ${file.format === 'pdf' ? 'extracted text' : 'contents'} below]`
  }).join('\n')
  const parts = [text, manifest, ...bodies].filter(Boolean)
  return { text: parts.join('\n\n'), images: selected }
}

export function claudeImageContent(text: string, attachments: ProviderAttachment[] = []) {
  const input = attachmentInput(text, attachments)
  return [
    { type: 'text' as const, text: input.text },
    ...input.images.map(image => ({ type: 'image' as const, source: {
      type: 'base64' as const, media_type: image.mimeType, data: readFileSync(image.path).toString('base64')
    } }))
  ]
}

export function cursorImageContent(text: string, attachments: ProviderAttachment[] = []) {
  const input = attachmentInput(text, attachments)
  return [
    { type: 'text', text: input.text },
    ...input.images.map(image => ({ type: 'image', mimeType: image.mimeType, data: readFileSync(image.path).toString('base64') }))
  ]
}

export function codexImageContent(text: string, attachments: ProviderAttachment[] = []) {
  const input = attachmentInput(text, attachments)
  return [{ type: 'text', text: input.text }, ...input.images.map(image => ({ type: 'localImage', path: image.path }))]
}
