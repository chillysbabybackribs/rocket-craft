// Resolve chat paths in main, where file URLs and filesystem access are available.
import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ChatLinkTarget } from '../shared/types.ts'

const PREVIEW_LIMIT = 2 * 1024 * 1024

export async function readChatLink(href: string, cwd: string): Promise<ChatLinkTarget> {
  if (/^https?:\/\//i.test(href)) return { kind: 'browser', url: new URL(href).href }
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^file:/i.test(href) && !/:\d+(?::\d+)?$/.test(href)) {
    throw new Error('This link type is not supported. Use an HTTP URL or a local file path.')
  }
  let local = href
  let fragment = ''
  if (/^file:/i.test(href)) {
    const url = new URL(href)
    fragment = url.hash
    local = fileURLToPath(url)
  } else {
    const hash = local.indexOf('#')
    if (hash !== -1) { fragment = local.slice(hash); local = local.slice(0, hash) }
    local = decodeURIComponent(local)
  }
  const position = local.match(/:(\d+)(?::\d+)?$/)
  const line = Number(position?.[1] ?? fragment.match(/^#L(\d+)/)?.[1]) || null
  if (position) local = local.slice(0, position.index)
  const path = resolve(cwd, local.startsWith('~/') ? resolve(homedir(), local.slice(2)) : local)
  let file
  try { file = await open(path, 'r') } catch {
    throw new Error(`Could not open ${path}. Check that the file exists and is readable.`)
  }
  try {
    const info = await file.stat()
    // A folder opens as a list of its entries, each a link that opens inside the app in turn,
    // rather than being handed to the system's file manager.
    if (info.isDirectory()) return { kind: 'artifact', path, text: await folderListing(path), markdown: true, line: null }
    if (!info.isFile()) throw new Error('This link is not a file or a folder. Choose a file to preview.')
    const extension = extname(path).toLowerCase()
    if (/^\.(html?|pdf|png|jpe?g|gif|webp|svg|avif|ico|mp4|webm|mp3|wav|ogg)$/.test(extension)) {
      return { kind: 'browser', url: pathToFileURL(path).href + fragment }
    }
    if (info.size > PREVIEW_LIMIT) throw new Error('This file is too large to preview. Open a file smaller than 2 MB.')
    const buffer = Buffer.alloc(PREVIEW_LIMIT + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > PREVIEW_LIMIT) throw new Error('This file is too large to preview. Open a file smaller than 2 MB.')
    const data = buffer.subarray(0, bytesRead)
    if (data.includes(0)) throw new Error('This binary file cannot be previewed. Choose a text, image, HTML, or PDF file.')
    return { kind: 'artifact', path, text: data.toString('utf8'), markdown: /\.(md|markdown)$/i.test(path), line }
  } finally { await file.close() }
}

const LISTING_LIMIT = 500

async function folderListing(path: string): Promise<string> {
  const entries = (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  const lines = entries.slice(0, LISTING_LIMIT).map((entry) => `- \`${join(path, entry.name)}${entry.isDirectory() ? '/' : ''}\``)
  if (entries.length > LISTING_LIMIT) lines.push(`- …and ${entries.length - LISTING_LIMIT} more`)
  return `# ${path}\n\n${lines.join('\n') || 'This folder is empty.'}\n`
}
