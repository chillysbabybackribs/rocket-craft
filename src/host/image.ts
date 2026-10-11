import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostEvent, Item } from '../shared/types.ts'
import type { Hub } from './hub.ts'
import { messageOf } from './json.ts'
import type { Store } from './store.ts'

// Pictures for every provider. Codex makes pictures with its own image tool; the others cannot, so
// `generate_image` (tools/image.ts) lends them Codex's. One turn runs on Codex in a chat of its own,
// in a folder of its own under the profile: the chat never reaches the window, the chat list, the
// orchestrator or the teamwork commit, and it is deleted when the turn ends. The calling chat gets
// an image item of its own, the same one Codex's pictures make: dots while it is made, then the
// picture or the reason there is none. The picture is also copied out first, to a folder that is
// not the chat's, so the tool can answer with a path. The item is what puts it on the library's shelf.

/** A picture takes about 20 s; this is for a Codex that has hung, not a slow one. */
const TIMEOUT_MS = 5 * 60_000
/** Codex's image turns use its usage limits fast, and each one holds a process slot. */
const MAX_PARALLEL = 2
const SHAPES = { square: 'square', landscape: 'landscape, wider than it is tall', portrait: 'portrait, taller than it is wide' } as const

export type Aspect = keyof typeof SHAPES
export type PictureBrief = { prompt: string; aspect?: Aspect; references?: string[] }
export type MadePicture = { path: string; name: string; width: number; height: number; caption: string }

export type ImageHub = Pick<Hub, 'createChat' | 'send' | 'stop' | 'deleteChat' | 'turnItems' | 'waitForTurn' | 'addItem'>

type ImageItem = Extract<Item, { type: 'image' }>

/** What Codex is told: one picture, nothing else, so the turn stays short and cheap. */
export function imagePrompt(brief: PictureBrief): string {
  const lines = [
    'Make one picture with your image generation tool, then stop. Do not run commands, change files, or write more than one short sentence.',
    `Picture: ${brief.prompt.trim()}`,
    brief.aspect ? `Shape: ${SHAPES[brief.aspect]}.` : ''
  ]
  if (brief.references?.length) {
    lines.push('Look at these pictures first and make the new one from them, as the brief says:', ...brief.references.map((path) => `- ${path}`))
  }
  return lines.filter(Boolean).join('\n')
}

export class ImageRunner {
  /** Hidden chats whose turn is still running. */
  private readonly running = new Set<string>()
  /** Chats being deleted, whose last events still belong to no one else. */
  private readonly ending = new Set<string>()

  constructor(
    private readonly store: Store,
    private readonly hub: ImageHub,
    /** Where a picture's chat works: one folder per picture, deleted when it ends. */
    readonly root: string,
    /** Where finished pictures stay. */
    private readonly keep: string,
    /** Where Craft Studio stored a generated picture's bytes, by attachment id. */
    private readonly locate: (id: string) => string,
    private readonly warn: (message: string) => void = () => {}
  ) {
    mkdirSync(root, { recursive: true })
  }

  /** Whether a folder is a picture's. Its chat stays out of the chat list and the library. */
  owns(cwd: string): boolean {
    return cwd.startsWith(this.root + '/')
  }

  /** Pictures cut off by the last exit left their chats behind; nothing will finish them now. */
  async recover(): Promise<void> {
    for (const chat of this.store.listChats()) {
      if (this.owns(chat.cwd)) await this.hub.deleteChat(chat.id).catch(() => {})
    }
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (entry.isDirectory()) rmSync(join(this.root, entry.name), { recursive: true, force: true })
    }
  }

  /** Every host event goes through here first. True for a picture's own, which the window never sees. */
  observe(event: HostEvent): boolean {
    switch (event.type) {
      case 'chat': return this.owns(event.chat.cwd)
      case 'chatDeleted': case 'queue': return this.running.has(event.chatId) || this.ending.has(event.chatId)
      case 'delta': case 'item': return this.running.has(event.chatId)
      case 'turn': return this.running.has(event.turn.chatId)
      default: return false
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.running].map((chatId) => this.hub.stop(chatId).catch(() => {})))
  }

  /** Make one picture and keep it. `forChat` is the chat that asked, whose shelf it joins. */
  async generate(brief: PictureBrief, forChat: string | null): Promise<MadePicture> {
    if (!brief.prompt.trim()) throw new Error('Say what the picture should show, then ask again.')
    if (this.running.size >= MAX_PARALLEL) throw new Error('Craft Studio is already making two pictures. Wait for one to finish, then ask again.')
    const shown = forChat ? this.show(forChat, brief.prompt) : null
    const cwd = join(this.root, randomUUID())
    mkdirSync(cwd, { recursive: true })
    const chat = this.hub.createChat(cwd, 'Picture')
    this.running.add(chat.id)
    try {
      const turnId = this.hub.send(chat.id, 'codex', null, imagePrompt(brief))
      const turn = await this.hub.waitForTurn(chat.id, { turnId, timeoutMs: TIMEOUT_MS }).catch(async () => {
        await this.hub.stop(chat.id).catch(() => {})
        throw new Error(`Codex did not finish the picture in ${TIMEOUT_MS / 60_000} minutes. Try again, or ask for something simpler.`)
      })
      if (turn.status === 'failed') throw new Error(`Codex could not make the picture: ${turn.error?.replace(/\.?$/, '.') ?? 'it gave no reason.'} Check that Codex is signed in, then ask again.`)
      if (turn.status === 'interrupted') throw new Error('The picture was stopped before it was finished. Ask again to make it.')
      const pictures = this.hub.turnItems(chat.id, turn.id).filter((item): item is ImageItem => item.type === 'image')
      const done = pictures.find((item) => item.status === 'done' && item.image)
      if (!done?.image) {
        throw new Error(pictures.find((item) => item.error)?.error ?? 'Codex finished without making a picture. Reword the request, then ask again.')
      }
      mkdirSync(this.keep, { recursive: true })
      const path = join(this.keep, `${Date.now().toString(36)}-${done.image.name}`)
      await copyFile(this.locate(done.image.id), path)
      shown?.({ status: 'done', caption: done.caption, image: done.image })
      return { path, name: done.image.name, width: done.image.width, height: done.image.height, caption: done.caption }
    } catch (error) {
      shown?.({ status: 'failed', caption: brief.prompt, error: messageOf(error) })
      throw error
    } finally {
      await this.end(chat.id, cwd)
    }
  }

  /**
   * Put the picture in the asking chat's turn, as a placeholder at first. The returned function
   * settles it. Nothing is shown when that chat has no turn running (its turn was stopped).
   */
  private show(chatId: string, prompt: string): ((change: Partial<ImageItem> & Pick<ImageItem, 'status'>) => void) | null {
    const id = `genimg-${randomUUID()}`
    const put = (change: Partial<ImageItem> & Pick<ImageItem, 'status'>): string | null =>
      this.hub.addItem(chatId, (turnId) => ({ type: 'image', id: `${turnId}:${id}`, turnId, caption: prompt, ...change }))
    if (!put({ status: 'generating' })) return null
    return (change) => { put(change) }
  }

  private async end(chatId: string, cwd: string): Promise<void> {
    this.running.delete(chatId)
    this.ending.add(chatId)
    try {
      await this.hub.deleteChat(chatId)
    } catch (error) {
      this.warn(`A picture's chat could not be deleted: ${messageOf(error)}`)
    } finally {
      this.ending.delete(chatId)
    }
    rmSync(cwd, { recursive: true, force: true })
  }
}
