import { oneLine, stringOf } from '../json.ts'
import type { Store } from '../store.ts'
import { textResult, type Tool } from './registry.ts'

// The project's memory: one tool. A note is kept per folder in the app's store and shown to
// every provider's sessions there (workspace.ts), so what one model worked out about a project
// is not worked out again by the next. Reading the notes is not a tool: they are already in the
// session's first message.

const NOTE_LIMIT = 600

const REMEMBER = `Save one fact about this project that will save a later session time: where something lives, how to build, run or test it, a decision and its reason, a pitfall. Every assistant in Craft Studio is shown these notes when it starts work in this folder.
Keep it to a sentence or two. Not for what the code plainly shows, and not for progress on the task in hand.
Pass replaces (a note id such as m4) to correct or retire an older note; with no note, that one is just removed.`

export function memoryTools(store: Store, homeOf: (cwd: string) => string = (cwd) => cwd): Tool[] {
  return [
    {
      name: 'remember',
      description: REMEMBER,
      inputSchema: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'The fact, in a sentence or two.' },
          replaces: { type: 'string', description: 'The id of a note this corrects or retires, such as m4.' }
        },
        additionalProperties: false
      },
      run: (args, context) => {
        // A worktree is deleted when its task ends, so a note goes under the main folder it was copied from.
        const chatCwd = context.chatId ? store.chat(context.chatId)?.cwd : undefined
        const cwd = chatCwd ? homeOf(chatCwd) : undefined
        if (!cwd) return { ...textResult('Craft Studio could not tell which chat this call came from, so the note has no folder to go with. Tell the user instead.'), isError: true }
        const text = oneLine(stringOf(args.note), NOTE_LIMIT)
        const replaces = stringOf(args.replaces).trim()
        if (!text && !replaces) return { ...textResult('Give the fact to save in `note`.'), isError: true }
        const said: string[] = []
        if (replaces) {
          const seq = /^m(\d+)$/.exec(replaces)
          said.push(seq && store.removeNote(cwd, Number(seq[1])) ? `Removed ${replaces}.` : `There is no note ${replaces} for this folder.`)
        }
        if (text) said.push(`Saved as m${store.addNote({ cwd, text, provider: context.provider, chatId: context.chatId }).seq}.`)
        return textResult(said.join(' '))
      }
    }
  ]
}
