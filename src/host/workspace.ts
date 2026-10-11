import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ProviderId } from '../shared/types.ts'
import { oneLine } from './json.ts'
import type { Note, Store } from './store.ts'

// What a session is told about the folder it works in, so it does not spend its first calls
// finding out: which files there are, and what earlier sessions (of any provider) wrote down
// about the project with the `remember` tool. It rides at the head of the first message of a
// new session. Later messages carry only notes saved since, by someone else.

const execFileAsync = promisify(execFile)

export const MAP_BUDGET_CHARS = 3_500
export const NOTES_BUDGET_CHARS = 4_000
const NAMES_PER_FOLDER = 60
const MAP_WAIT_MS = 500
const MAP_REUSE_MS = 30_000
const WALK_DEPTH = 3
const WALK_FILES = 3_000
const WALK_SKIP = new Set(['node_modules', 'dist', 'out', 'build', 'target', 'vendor', '__pycache__'])

/** The folder's files, relative to it: what git tracks or would track, or a shallow walk where there is no git. */
export async function listFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git', ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { timeout: 3_000, maxBuffer: 16_000_000 }
    )
    return stdout.split('\0').filter(Boolean)
  } catch {
    // Not a repository, or no git. A home folder is not a project; walking it would say nothing useful.
    if (cwd === homedir()) return []
    return walk(cwd)
  }
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (relative: string, depth: number): Promise<void> => {
    const entries = await readdir(join(root, relative), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (files.length >= WALK_FILES) return
      if (entry.name.startsWith('.') || WALK_SKIP.has(entry.name)) continue
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (depth < WALK_DEPTH) await visit(path, depth + 1)
      } else files.push(path)
    }
  }
  await visit('', 0)
  return files
}

/**
 * The files as one line per folder, within a budget. A small project is listed whole; a large
 * one keeps its upper folders listed and says only how many files lie deeper in each.
 */
export function renderMap(files: string[], budget = MAP_BUDGET_CHARS): string {
  if (files.length === 0) return ''
  const split = files.map((file) => {
    const parts = file.split('/')
    return { folders: parts.slice(0, -1), name: parts.at(-1)! }
  })
  const deepest = Math.max(...split.map((file) => file.folders.length))
  const render = (depth: number): string => {
    const folders = new Map<string, { names: string[]; deeper: number }>()
    for (const file of split) {
      const key = file.folders.slice(0, depth).join('/')
      let folder = folders.get(key)
      if (!folder) folders.set(key, folder = { names: [], deeper: 0 })
      if (file.folders.length <= depth) folder.names.push(file.name)
      else folder.deeper += 1
    }
    return [...folders].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, folder]) => {
      const shown = folder.names.sort().slice(0, NAMES_PER_FOLDER)
      const more = folder.names.length - shown.length
      const tail = [more > 0 ? `… ${more} more` : '', folder.deeper ? `(+${folder.deeper} deeper)` : ''].filter(Boolean)
      return `${key || '.'}/: ${[...shown, ...tail].join(shown.length ? ', ' : ' ').replace(/, \(/, ' (')}`
    }).join('\n')
  }
  for (let depth = deepest; depth >= 0; depth--) {
    const text = render(depth)
    if (text.length <= budget) return text
  }
  return `${render(0).slice(0, budget)}…`
}

/** The notes as lines a model can cite by id, newest kept when there are more than fit. */
export function renderNotes(notes: Note[], budget = NOTES_BUDGET_CHARS): string {
  const lines: string[] = []
  let used = 0
  for (const note of [...notes].reverse()) {
    const line = `- m${note.seq}: ${note.text}`
    if (used + line.length > budget && lines.length) break
    lines.unshift(line)
    used += line.length + 1
  }
  return lines.join('\n')
}

/**
 * The folder's map and notes for a new session; for a session already going, the notes others
 * have saved since it last heard. Null when there is nothing to say.
 */
export function workspaceContext(store: Store, homeOf: (cwd: string) => string = (cwd) => cwd): (chatId: string, provider: ProviderId, fresh: boolean) => Promise<string | null> {
  /** chat and provider → the newest note that session has been shown. */
  const told = new Map<string, number>()
  const maps = new Map<string, { at: number; text: Promise<string> }>()
  const mapOf = (cwd: string): Promise<string> => {
    const cached = maps.get(cwd)
    if (cached && Date.now() - cached.at < MAP_REUSE_MS) return cached.text
    const text = listFiles(cwd).then((files) => renderMap(files), () => '')
    maps.set(cwd, { at: Date.now(), text })
    return text
  }
  return async (chatId, provider, fresh) => {
    const cwd = store.chat(chatId)?.cwd
    if (!cwd) return null
    const key = `${chatId}:${provider}`
    // Notes belong to the project, so a worktree chat reads its main folder's.
    const notes = store.notes(homeOf(cwd))
    const since = told.get(key)
    told.set(key, notes.at(-1)?.seq ?? 0)
    if (!fresh) {
      // A session resumed after the app restarted saw the notes at its own start; it is owed only what is new from now.
      const news = since === undefined ? [] : notes.filter((note) => note.seq > since && !(note.chatId === chatId && note.provider === provider))
      return news.length ? `<workspace>\nNotes saved about this folder since your last turn:\n${renderNotes(news)}\n</workspace>` : null
    }
    // A turn never waits long on this: a folder slow to list is simply not mapped.
    const map = await Promise.race([mapOf(cwd), new Promise<string>((resolve) => setTimeout(() => resolve(''), MAP_WAIT_MS))])
    if (!map && !notes.length) return null
    const parts = [`<workspace>\nYou are working in ${oneLine(cwd, 300)}.`]
    if (map) parts.push(`Its files, one line per folder ("+N deeper" counts files in folders not listed), so you need not list them yourself:\n${map}`)
    if (notes.length) parts.push(`Notes earlier sessions saved about this folder (add to them with the remember tool):\n${renderNotes(notes)}`)
    return `${parts.join('\n\n')}\n</workspace>`
  }
}
