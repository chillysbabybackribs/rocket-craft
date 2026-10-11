import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { imageSize } from 'image-size'
import {
  MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_MESSAGE_ATTACHMENTS, MAX_MESSAGE_FILE_BYTES, MAX_MESSAGE_IMAGE_BYTES,
  isFileAttachment, type Attachment, type AttachmentPreview, type FileAttachment, type GeneratedImageSource, type ImageAttachment
} from '../shared/types.ts'
import { messageOf } from './json.ts'
import type { Store } from './store.ts'

// Attachments are copies the host owns: the original bytes, an image's thumbnail, and for a PDF
// its extracted text and rendered preview pages, all named after the attachment id. PDFs are read
// with poppler-utils (pdfinfo, pdftotext, pdftoppm), so no PDF parser runs in the app itself and
// nothing in an uploaded file is ever rendered as a page or executed.

export type ProviderAttachment = Attachment & { path: string; textPath?: string }
export type ProviderImage = ImageAttachment & { path: string }
const mimes = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as const
const run = promisify(execFile)
const PREVIEW_PAGES = 12
const PREVIEW_CHARS = 200_000

/** Inspect bytes before trusting names or browser MIME labels. Full decoding happens in the composer. */
export function inspectImage(bytes: Uint8Array, maxBytes = MAX_IMAGE_BYTES): { mimeType: ImageAttachment['mimeType']; width: number; height: number } {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > maxBytes) {
    throw new Error(`Choose an image smaller than ${Math.round(maxBytes / 1024 / 1024)} MB.`)
  }
  try {
    const { type, width, height } = imageSize(bytes)
    if (!type || !(type in mimes)) throw new Error('format')
    if (!width || !height || width > 8000 || height > 8000 || width * height > 32_000_000) throw new Error('dimensions')
    return { mimeType: mimes[type as keyof typeof mimes], width, height }
  } catch {
    throw new Error('Choose a valid PNG, JPEG, WebP or GIF image up to 8000 pixels per side and 32 megapixels.')
  }
}

/** UTF-8 without NUL bytes counts as text, whatever the file is called; anything else is refused. */
export function decodeText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '')
    return text.includes('\0') ? null : text
  } catch {
    return null
  }
}

export function validateAttachments(attachments: Attachment[]): void {
  if (attachments.length > MAX_MESSAGE_ATTACHMENTS) throw new Error(`Send at most ${MAX_MESSAGE_ATTACHMENTS} attachments in one message.`)
  const bytes = (files: boolean) => attachments.filter(each => isFileAttachment(each) === files).reduce((sum, each) => sum + each.size, 0)
  if (bytes(false) > MAX_MESSAGE_IMAGE_BYTES) throw new Error('Send images totaling at most 20 MB in one message.')
  if (bytes(true) > MAX_MESSAGE_FILE_BYTES) throw new Error('Send files totaling at most 50 MB in one message.')
}

/** A model's picture is not limited to what a message may carry; this only keeps a runaway file out. */
const MAX_GENERATED_BYTES = 50 * 1024 * 1024

/** A generated picture is named after the start of its prompt, which is what a person would call it. */
export function generatedName(caption: string, mimeType: ImageAttachment['mimeType']): string {
  const words = caption.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)
  let stem = ''
  for (const word of words) {
    if (stem && stem.length + word.length + 1 > 48) break
    stem = stem ? `${stem}-${word}` : word.slice(0, 48)
  }
  return `${stem || 'generated-image'}.${mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1]}`
}

const cleanName = (name: string, fallback: string): string => String(name).split(/[\\/]/).at(-1)!.replace(/[\x00-\x1f]/g, '').slice(0, 180) || fallback

/** The stored copy keeps a plain extension so a model reading it knows the language. */
const extensionOf = (file: FileAttachment): string => {
  if (file.format === 'pdf') return 'pdf'
  const ext = file.name.includes('.') ? file.name.split('.').at(-1)!.toLowerCase() : ''
  return /^[a-z0-9]{1,12}$/.test(ext) ? ext : 'txt'
}

/** poppler's tools, with errors a user can act on. */
async function poppler(tool: string, args: string[], name: string): Promise<string> {
  try {
    return (await run(tool, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string }
    if (failure.code === 'ENOENT') throw new Error('Craft Studio reads PDFs with poppler-utils. Install it (sudo apt install poppler-utils), then attach the PDF again.')
    if (/password/i.test(failure.stderr ?? '')) throw new Error(`${name} is password protected. Attach an unlocked copy to continue.`)
    throw new Error(`${name} could not be read as a PDF. It may be damaged; export it again and attach the new copy.`)
  }
}

/** The host owns attachment files. Caller-supplied ids are resolved through SQLite, never treated as paths. */
export class AttachmentStore {
  constructor(private readonly store: Store, private readonly directory: string) {}

  async import(name: string, bytes: Uint8Array, thumbnail: Uint8Array): Promise<ImageAttachment> {
    const info = inspectImage(bytes)
    const small = inspectImage(thumbnail)
    if (small.mimeType !== 'image/jpeg' || small.width > 320 || small.height > 320 || thumbnail.length > 150_000) {
      throw new Error('The image preview could not be saved. Try attaching the image again.')
    }
    const image: ImageAttachment = { ...info, id: randomUUID(), name: cleanName(name, 'Image'), size: bytes.length }
    await mkdir(this.directory, { recursive: true })
    try {
      await writeFile(this.path(image), bytes)
      await writeFile(this.path(image, true), thumbnail)
      this.store.saveAttachment(image)
      return image
    } catch (error) {
      await this.remove(image.id)
      throw error
    }
  }

  async importFile(name: string, bytes: Uint8Array): Promise<FileAttachment> {
    const label = cleanName(name, 'File')
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new Error(`${label} is empty. Choose a file with something in it.`)
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`${label} is larger than 25 MB. Attach a smaller file or the part you need.`)
    const id = randomUUID()
    const pdf = Buffer.from(bytes.subarray(0, 1024)).includes('%PDF-')
    const text = pdf ? null : decodeText(bytes)
    if (!pdf && text === null) throw new Error(`${label} is not an image, PDF or text file. Craft Studio can attach those; convert it to one of them first.`)
    const file: FileAttachment = pdf
      ? { kind: 'file', id, name: label, format: 'pdf', mimeType: 'application/pdf', size: bytes.length, chars: 0 }
      : { kind: 'file', id, name: label, format: 'text', mimeType: 'text/plain', size: bytes.length, chars: text!.length, lines: text!.split('\n').length - (text!.endsWith('\n') ? 1 : 0) }
    await mkdir(this.directory, { recursive: true })
    try {
      await writeFile(this.path(file), bytes)
      if (pdf) {
        const info = await poppler('pdfinfo', [this.path(file)], label)
        file.pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]) || undefined
        await poppler('pdftotext', ['-enc', 'UTF-8', this.path(file), this.textPath(file)], label)
        file.chars = (await readFile(this.textPath(file), 'utf8')).replace(/\f/g, '').trim().length
      }
      this.store.saveAttachment(file)
      return file
    } catch (error) {
      await this.remove(id)
      throw error
    }
  }

  /**
   * Keep Craft Studio's own copy of a picture a model made: from the provider's file, or its base64
   * bytes when the file cannot be read. The thumbnail is made here, since no composer made one;
   * without ImageMagick the picture is its own thumbnail.
   */
  async keepGenerated(source: GeneratedImageSource, caption: string): Promise<ImageAttachment> {
    let bytes: Buffer | null = null
    if (source.path && isAbsolute(source.path)) bytes = await readFile(source.path).catch(() => null)
    if (!bytes?.length && source.base64) bytes = Buffer.from(source.base64, 'base64')
    if (!bytes?.length) throw new Error('Craft Studio could not find the generated image to keep a copy. Ask for it again.')
    let info: ReturnType<typeof inspectImage>
    try {
      info = inspectImage(bytes, MAX_GENERATED_BYTES)
    } catch {
      throw new Error('The generated image is not a PNG, JPEG, WebP or GIF Craft Studio can keep, or it is too large. Ask for it again in one of those formats.')
    }
    const image: ImageAttachment = { kind: 'image', ...info, id: randomUUID(), name: generatedName(caption, info.mimeType), size: bytes.length }
    await mkdir(this.directory, { recursive: true })
    try {
      await writeFile(this.path(image), bytes)
      await run('convert', [`${this.path(image)}[0]`, '-auto-orient', '-thumbnail', '320x320>', '-quality', '82', this.path(image, true)], { timeout: 30_000 })
        .catch(() => {})
      this.store.saveAttachment(image)
      return image
    } catch (error) {
      await this.remove(image.id)
      throw new Error(`Craft Studio could not save the generated image (${messageOf(error)}). Check there is free disk space, then ask for it again.`)
    }
  }

  resolve(ids: string[]): ProviderAttachment[] {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Attach the files again.')
    return ids.map(id => {
      const attachment = this.store.attachment(id)
      if (!attachment) throw new Error(`An attachment is no longer available. Attach it again.`)
      if (!isFileAttachment(attachment)) return { ...attachment, path: this.path(attachment) }
      return { ...attachment, path: this.path(attachment), textPath: attachment.format === 'pdf' ? this.textPath(attachment) : this.path(attachment) }
    })
  }

  async read(id: string, thumbnail = false): Promise<string> {
    const [image] = this.resolve([id])
    if (isFileAttachment(image)) throw new Error('Only images have a picture to show. Open the file to preview it.')
    try {
      // A generated picture kept without ImageMagick has no thumbnail; the original stands in.
      const small = thumbnail ? await readFile(this.path(image, true)).catch(() => null) : null
      if (small) return `data:image/jpeg;base64,${small.toString('base64')}`
      return `data:${image.mimeType};base64,${(await readFile(this.path(image))).toString('base64')}`
    } catch {
      throw new Error('This image file is missing. Attach it again.')
    }
  }

  /** Text is shown as text; PDF pages are rendered once, on first preview, and kept beside the original. */
  async preview(id: string): Promise<AttachmentPreview> {
    const [file] = this.resolve([id])
    if (!isFileAttachment(file)) throw new Error('Images preview in place. Click the thumbnail to enlarge it.')
    try {
      if (file.format === 'text') {
        const text = await readFile(file.path, 'utf8')
        return { type: 'text', text: text.slice(0, PREVIEW_CHARS), truncated: text.length > PREVIEW_CHARS }
      }
      const folder = join(this.directory, `${file.id}.pages`)
      let names = await readdir(folder).catch(() => [] as string[])
      if (!names.length) {
        await mkdir(folder, { recursive: true })
        await poppler('pdftoppm', ['-jpeg', '-jpegopt', 'quality=80', '-scale-to', '1100', '-l', String(PREVIEW_PAGES), file.path, join(folder, 'page')], file.name)
        names = await readdir(folder)
      }
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      const pages = await Promise.all(names.map(async name => `data:image/jpeg;base64,${(await readFile(join(folder, name))).toString('base64')}`))
      return { type: 'pdf', pages, truncated: (file.pages ?? 0) > pages.length }
    } catch (error) {
      if (error instanceof Error && /poppler|password|could not be read/.test(error.message)) throw error
      throw new Error(`${file.name} is missing from Craft Studio's attachments folder. Attach it again.`)
    }
  }

  /** Save as: the stored original, byte for byte, at a path the user picked in the system dialog. */
  async export(id: string, destination: string): Promise<void> {
    const [attachment] = this.resolve([id])
    if (typeof destination !== 'string' || !isAbsolute(destination)) throw new Error('Choose where to save the file.')
    try {
      await copyFile(attachment.path, destination)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' && !(await readFile(attachment.path).then(() => true, () => false))) throw new Error(`${attachment.name} is missing from Craft Studio's attachments folder. Attach it again.`)
      throw new Error(`${attachment.name} could not be saved there${code ? ` (${code})` : ''}. Choose another folder.`)
    }
  }

  async collect(keepIds: string[]): Promise<void> {
    // A grace period covers interrupted imports and drafts still being restored after reconnect.
    for (const attachment of this.store.unusedAttachments(keepIds, Date.now() - 24 * 60 * 60 * 1000)) {
      await this.remove(attachment.id)
      this.store.deleteAttachment(attachment.id)
    }
  }

  /** Everything derived from an attachment shares its id as a prefix. */
  private async remove(id: string): Promise<void> {
    const names = await readdir(this.directory).catch(() => [] as string[])
    await Promise.all(names.filter(name => name.startsWith(`${id}.`)).map(name => rm(join(this.directory, name), { recursive: true, force: true })))
  }

  private path(attachment: Attachment, thumbnail = false): string {
    if (isFileAttachment(attachment)) return join(this.directory, `${attachment.id}.${extensionOf(attachment)}`)
    return join(this.directory, `${attachment.id}${thumbnail ? '.thumb.jpg' : `.${attachment.mimeType.split('/')[1]}`}`)
  }

  private textPath(file: FileAttachment): string {
    return join(this.directory, `${file.id}.extracted.txt`)
  }
}
