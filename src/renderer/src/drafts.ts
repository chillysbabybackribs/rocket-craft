import { useSyncExternalStore } from 'react'
import { imageSize } from 'image-size'
import { MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_MESSAGE_ATTACHMENTS, MAX_MESSAGE_FILE_BYTES, MAX_MESSAGE_IMAGE_BYTES, isFileAttachment, type Attachment, type MessageDraft } from '../../shared/types.ts'
import { call } from './host.ts'

/** `fresh` is an attachment just copied in, highlighted for a moment; it is not saved. */
type Draft = MessageDraft & { attachments: Attachment[]; pending: number; sending: boolean; error: string | null; fresh?: string | null }
const empty: Draft = { text: '', attachments: [], pending: 0, sending: false, error: null }
const drafts = new Map<string, Draft>()
const listeners = new Set<() => void>()
const storageKey = 'rocket.image-drafts'
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, MessageDraft>
  for (const [key, value] of Object.entries(saved)) if (typeof value.text === 'string') drafts.set(key, { ...empty, ...value, attachments: value.attachments ?? [] })
} catch { /* A damaged draft must not prevent opening the chat. */ }

export function draftOf(key: string): Draft { return drafts.get(key) ?? empty }

export function collectAttachments(): void {
  void call('attachment.collect', { keepIds: [...drafts.values()].flatMap(draft => draft.attachments.map(each => each.id)) }).catch(() => {})
}

export function updateDraft(key: string, patch: Partial<Draft>): void {
  drafts.set(key, { ...draftOf(key), ...patch })
  try {
    localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries([...drafts].filter(([, d]) => d.text || d.attachments.length).map(([id, d]) => [id, { text: d.text, attachments: d.attachments }]))))
  } catch { /* The in-memory draft remains usable when browser storage is full. */ }
  for (const notify of listeners) notify()
}

export function useDraft(key: string): Draft {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => draftOf(key))
}

export function restoreDraft(key: string, message: string | MessageDraft): void {
  const restored = typeof message === 'string' ? { text: message } : message
  const current = draftOf(key)
  updateDraft(key, { text: [restored.text, current.text].filter(Boolean).join('\n\n'), attachments: [...restored.attachments ?? [], ...current.attachments] })
}

export const ATTACHMENT_DRAG_TYPE = 'application/x-rocket-attachment'
const LIMIT_ERROR = `Send at most ${MAX_MESSAGE_ATTACHMENTS} attachments in one message.`

/** The same per-message limits the host enforces, checked before any bytes are sent to it. */
function overLimit(attachments: Attachment[], adding: { size: number; file: boolean }): string | null {
  if (attachments.length >= MAX_MESSAGE_ATTACHMENTS) return LIMIT_ERROR
  const total = attachments.filter(each => isFileAttachment(each) === adding.file).reduce((sum, each) => sum + each.size, adding.size)
  if (!adding.file && total > MAX_MESSAGE_IMAGE_BYTES) return 'Send images totaling at most 20 MB in one message.'
  if (adding.file && total > MAX_MESSAGE_FILE_BYTES) return 'Send files totaling at most 50 MB in one message.'
  return null
}

/** Why an existing attachment cannot join a draft, or null when it can (already there counts as fine). */
export function attachmentProblem(key: string, attachment: Attachment): string | null {
  if (!attachment || typeof attachment.id !== 'string' || typeof attachment.name !== 'string' || !Number.isFinite(attachment.size) || attachment.size <= 0) {
    return 'This attachment could not be added. Choose the file again.'
  }
  const current = draftOf(key)
  if (current.sending) return 'That message is being sent. Try again in a moment.'
  if (current.attachments.some(each => each.id === attachment.id)) return null
  return overLimit(current.attachments, { size: attachment.size, file: isFileAttachment(attachment) })
}

/** Adds to the end of a draft, keeping its text and files; returns whether it was added now. */
export function addExistingAttachment(key: string, attachment: Attachment): boolean {
  const problem = attachmentProblem(key, attachment)
  if (problem) {
    if (!draftOf(key).sending) updateDraft(key, { error: problem })
    return false
  }
  const current = draftOf(key)
  if (current.attachments.some(each => each.id === attachment.id)) return false
  updateDraft(key, { attachments: [...current.attachments, attachment], error: null })
  return true
}

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

async function importImage(file: File, bytes: Uint8Array): Promise<Attachment> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Choose images smaller than 5 MB.')
  let dimensions: ReturnType<typeof imageSize>
  try { dimensions = imageSize(bytes) } catch { throw new Error('Choose a PNG, JPEG, WebP or GIF image.') }
  if (!['png', 'jpg', 'webp', 'gif'].includes(dimensions.type ?? '')) throw new Error('Choose a PNG, JPEG, WebP or GIF image.')
  if (!dimensions.width || !dimensions.height || dimensions.width > 8000 || dimensions.height > 8000 || dimensions.width * dimensions.height > 32_000_000) throw new Error('Choose an image up to 8000 pixels per side and 32 megapixels.')
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('This image could not be decoded. Choose another file.') })
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height))
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#202124'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not create an image preview.')), 'image/jpeg', 0.8))
  return call('attachment.import', { name: file.name || 'Pasted image.png', bytes, thumbnail: new Uint8Array(await blob.arrayBuffer()) })
}

/** An image by its label or its bytes becomes a thumbnail; anything else goes to the host, which accepts PDFs and text. */
function looksLikeImage(file: File, bytes: Uint8Array): boolean {
  if (IMAGE_MIMES.includes(file.type)) return true
  try { return ['png', 'jpg', 'webp', 'gif'].includes(imageSize(bytes).type ?? '') } catch { return false }
}

/** Uploads are serialized per draft so a tab switch cannot redirect an in-flight import. */
const uploads = new Map<string, Promise<void>>()
/** Resolves with what was added, so a caller can offer to take it back out. */
export function addDraftFiles(key: string, files: File[]): Promise<Attachment[]> {
  if (draftOf(key).sending) return Promise.resolve([])
  updateDraft(key, { pending: draftOf(key).pending + files.length, error: null })
  const added: Attachment[] = []
  const work = (uploads.get(key) ?? Promise.resolve()).then(async () => {
    for (const file of files) {
      try {
        const current = draftOf(key)
        if (current.attachments.length >= MAX_MESSAGE_ATTACHMENTS) throw new Error(LIMIT_ERROR)
        if (!file.size) throw new Error(`${file.name || 'This file'} is empty. Choose a file with something in it.`)
        if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name || 'This file'} is larger than 25 MB. Attach a smaller file or the part you need.`)
        const bytes = new Uint8Array(await file.arrayBuffer())
        const image = looksLikeImage(file, bytes)
        const limit = overLimit(current.attachments, { size: file.size, file: !image })
        if (limit) throw new Error(limit)
        const attachment = image ? await importImage(file, bytes) : await call('attachment.importFile', { name: file.name || 'Pasted text.txt', bytes })
        if (addExistingAttachment(key, attachment)) added.push(attachment)
      } catch (error) {
        updateDraft(key, { error: error instanceof Error ? error.message : 'Could not attach this file. Try again.' })
      } finally {
        updateDraft(key, { pending: Math.max(0, draftOf(key).pending - 1) })
      }
    }
  })
  uploads.set(key, work)
  void work.finally(() => { if (uploads.get(key) === work) uploads.delete(key) })
  return work.then(() => added)
}
