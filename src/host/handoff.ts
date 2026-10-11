import { providerLabel, type Item, type Attachment, type ProviderId } from '../shared/types.ts'
import { oneLine } from './json.ts'

// What a provider is told about the turns it missed. When the user switches back to a provider,
// its own session is resumed, so it already holds everything up to its last turn; this builds
// the block for the turns since then, which other providers answered. The block rides at the
// head of the user's next message.
//
// Kept: every user message, what each turn concluded (its reply after its last tool call; the
// narration between calls is left out), the files the turn edited and read (each named once, so
// the model knows where the relevant code is without searching for it again), and one line per
// other tool call. The newest turns go whole; older ones keep their files and a shortened request
// and reply, since what they did is mostly on disk and the newest turns build on it. Left out:
// reasoning and tool output. Files other providers changed are on disk for the model to read.
//
// For Claude, Cursor and Antigravity the block becomes part of their session's history, read
// again with every later message, so what is cut here is saved many times over.

export type MissedTurn = {
  provider: ProviderId
  model: string | null
  status: string
  items: Item[]
}

export const HANDOFF_BUDGET_CHARS = 30_000
/** The newest turns are handed over whole; older ones are cut down to what they concluded. */
const RECENT_TURNS = 3
const OLDER_REPLY_CHARS = 1_200
const OLDER_USER_CHARS = 1_500
const MAX_ACTIONS_PER_TURN = 20
const MAX_FILES_PER_LINE = 30
const TAG = 'conversation_handoff'

/** `files` and `asked` are kept for older turns; `steps`, the other tool calls, only for the newest. */
type Block = { head: string; user: string; reply: string; files: string[]; steps: string[]; asked: string[] }

/**
 * The missed turns in both forms a provider can take them: `text`, one tagged block to put in
 * front of the user's message, and `messages`, the same turns as role-tagged history for a
 * provider that can append to its own history (Codex `thread/inject_items`).
 */
export type Handoff = {
  attachments?: Attachment[]
  turns: number
  text: string
  messages: Array<{ role: 'user' | 'assistant'; text: string }>
}

/** Null when there is nothing to hand over. */
export function buildHandoff(turns: MissedTurn[], budget = HANDOFF_BUDGET_CHARS, root: string | null = null): Handoff | null {
  const blocks = turns.map((turn) => blockOf(turn, root)).filter((block) => block.user || block.reply || actionsOf(block).length)
  if (blocks.length === 0) return null
  for (const block of blocks.slice(0, -RECENT_TURNS)) {
    block.steps = []
    block.user = elide(block.user, OLDER_USER_CHARS)
    block.reply = elide(block.reply, OLDER_REPLY_CHARS)
  }
  const dropped = fit(blocks, budget)
  const text = [
    `<${TAG}>`,
    'This conversation is shared between several assistants, and the user chooses one for each message.',
    'Since your last turn here, other assistants answered the turns below (oldest first).',
    'Treat them as earlier history of this same conversation. Any file changes they made are already on disk.',
    'The files they read and edited are named, so go straight to those rather than searching for them again.',
    ...(dropped ? [`The ${dropped} turns before these are left out to keep this short; ask the user if you need them.`] : []),
    '',
    blocks.map(render).join('\n\n'),
    `</${TAG}>`
  ].join('\n')
  const messages: Handoff['messages'] = []
  for (const block of blocks) {
    if (block.user) messages.push({ role: 'user', text: block.user })
    const answer = [`[${block.head.replace(/^### /, '')}]`]
    const actions = actionsOf(block)
    if (actions.length) answer.push(`Actions taken:\n${actions.join('\n')}`)
    if (block.reply) answer.push(block.reply)
    messages.push({ role: 'assistant', text: answer.join('\n\n') })
  }
  const attachments = turns.flatMap(turn => turn.items.flatMap(item => item.type === 'user' ? item.attachments ?? [] : []))
  return { turns: blocks.length, text, messages, ...(attachments.length ? { attachments } : {}) }
}

/** The user's own words, for showing a message that was sent with a handoff block in front. */
export function stripHandoff(text: string): string {
  return text.replace(new RegExp(`<${TAG}>[\\s\\S]*?</${TAG}>\\s*`, 'g'), '').trim()
}

export function withHandoff(handoff: Handoff | null, text: string): string {
  return handoff ? `${handoff.text}\n\n${text}` : text
}

/** `root` is the chat's folder; paths inside it are given relative to it. */
function blockOf(turn: MissedTurn, root: string | null): Block {
  const name = providerLabel(turn.provider) + (turn.model ? ` (${turn.model})` : '')
  const ending = turn.status === 'interrupted'
    ? ', stopped by the user before it finished'
    : turn.status === 'failed' ? ', which failed before finishing' : ''
  const user = turn.items.filter((item) => item.type === 'user').map((item) => [item.text, ...(item.attachments ?? []).map(each => `[${each.kind === 'file' ? 'File' : 'Image'}: ${each.name}; attachment ${each.id}]`)].filter(Boolean).join('\n')).join('\n\n')
  const reply = replyOf(turn.items)
  const tools = turn.items.filter((item) => item.type === 'tool')
  // Files are named once each however often they were touched; a file that was edited was also read.
  const isFile = (tool: (typeof tools)[number]): boolean => (tool.kind === 'edit' || tool.kind === 'read') && tool.status !== 'failed'
  const paths = (kind: 'edit' | 'read'): string[] => [...new Set(tools.filter((tool) => isFile(tool) && tool.kind === kind)
    .flatMap((tool) => tool.label.split(', '))
    .map((path) => oneLine(root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path, 160)))]
  const edited = paths('edit')
  const read = paths('read').filter((path) => !edited.includes(path))
  const files = (verb: string, list: string[]): string[] => (list.length
    ? [`- ${verb}: ${list.slice(0, MAX_FILES_PER_LINE).join(', ')}${list.length > MAX_FILES_PER_LINE ? ` (+${list.length - MAX_FILES_PER_LINE} more)` : ''}`]
    : [])
  const others = tools.filter((tool) => !isFile(tool))
  // A question the user has not answered is still open; one they have shows up in their next message.
  const asked = turn.items.filter((item) => item.type === 'question')
    .map((item) => `- asked the user: ${oneLine(item.text, 160)}${item.answer === null ? ' (no answer yet)' : ''}`)
  const steps = others.slice(0, MAX_ACTIONS_PER_TURN).map((tool) => `- ${tool.kind}: ${oneLine(tool.label, 160)}${tool.status === 'failed' ? ' (failed)' : ''}`)
  if (others.length > MAX_ACTIONS_PER_TURN) steps.push(`- …and ${others.length - MAX_ACTIONS_PER_TURN} more`)
  return { head: `### Turn answered by ${name}${ending}`, user, reply, files: [...files('edited', edited), ...files('read', read)], steps, asked }
}

/**
 * What a turn concluded: its text after its last tool call, or its last text when it ended on a
 * call. What it said between calls ("Now I'll check the tests") is narration and left out.
 */
function replyOf(items: Item[]): string {
  const texts = (from: Item[]): string[] => from.flatMap((item) => (item.type === 'assistant' && item.text.trim() ? [item.text.trim()] : []))
  const after = texts(items.slice(items.findLastIndex((item) => item.type === 'tool') + 1))
  return after.length ? after.join('\n\n') : texts(items).at(-1) ?? ''
}

function actionsOf(block: Block): string[] {
  return [...block.files, ...block.steps, ...block.asked]
}

function render(block: Block): string {
  const parts = [block.head]
  const actions = actionsOf(block)
  if (block.user) parts.push(`User:\n${block.user}`)
  if (actions.length) parts.push(`Actions taken:\n${actions.join('\n')}`)
  if (block.reply) parts.push(`Assistant:\n${block.reply}`)
  return parts.join('\n\n')
}

/**
 * Shrink to the budget, giving up the least useful text first: action lines of older turns, then
 * the middle of the longest replies, then, for a history too long to fit even cut down, the
 * oldest turns whole. The most recent turn is touched last. Each block's size is kept and only a
 * changed block is measured again, so a thousand-turn replay costs no more than reading it.
 * Returns how many of the oldest turns were left out.
 */
function fit(blocks: Block[], budget: number): number {
  const sizes = blocks.map((block) => render(block).length + 2)
  let total = sizes.reduce((sum, value) => sum + value, 0)
  const measure = (index: number): void => {
    const next = render(blocks[index]!).length + 2
    total += next - sizes[index]!
    sizes[index] = next
  }
  for (let i = 0; i < blocks.length - 1 && total > budget; i++) {
    Object.assign(blocks[i]!, { files: [], steps: [], asked: [] })
    measure(i)
  }
  for (let guard = 0; guard < 200 && total > budget; guard++) {
    const over = total - budget
    const older = blocks.slice(0, -1)
    const pool = older.some((block) => block.reply.length > 400) ? older : blocks
    const longest = pool.reduce((a, b) => (b.reply.length > a.reply.length ? b : a))
    if (longest.reply.length <= 400) {
      const text = blocks.reduce((a, b) => (b.user.length > a.user.length ? b : a))
      if (text.user.length <= 400) break
      text.user = elide(text.user, Math.max(400, text.user.length - over - 40))
      measure(blocks.indexOf(text))
      continue
    }
    longest.reply = elide(longest.reply, Math.max(400, longest.reply.length - over - 40))
    measure(blocks.indexOf(longest))
  }
  let dropped = 0
  while (total > budget && blocks.length > 1) {
    total -= sizes.shift()!
    blocks.shift()
    dropped++
  }
  return dropped
}

/** Keep the start and the end; the conclusion of a reply is usually at the end. */
function elide(text: string, keep: number): string {
  if (text.length <= keep) return text
  const head = Math.floor(keep * 0.4)
  const tail = keep - head
  return `${text.slice(0, head)}\n[…${text.length - keep} characters omitted…]\n${text.slice(text.length - tail)}`
}
