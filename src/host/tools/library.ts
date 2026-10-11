import { filterEntries, formatSize, parseFilters, LIBRARY_ADDED, LIBRARY_KINDS, LIBRARY_SOURCES } from '../../shared/library.ts'
import { messageOf } from '../json.ts'
import type { Library } from '../library.ts'
import type { Store } from '../store.ts'
import { failureResult, textResult, type Tool } from './registry.ts'

// The library as a model reads it: the same entries and the same filters as the panel
// (src/shared/library.ts), so "the PDFs from this chat" is one answer for both. Showing the panel
// is the app map's job (`studio_ui_go library`); this tool only lists.

const LIMIT = 50
const LIMIT_MAX = 200

const DESCRIPTION = `List the files on Craft Studio's library shelf: attachments sent in chats, files a model downloaded with the browser, Markdown plans a turn wrote, and files opened from a chat. Newest first, each with its id, kind, where it came from, its chat and its path on disk (read a file with your own tools).
Filters are the panel's: source, kind, chat ("this" for the calling chat, or a chat id), added, and q (words in the name, origin, path or chat title). To show the user the shelf, call studio_ui_go with place library and the same filters.`

const choices = (options: ReadonlyArray<[string, string]>): string[] => options.map(([id]) => id)

export function libraryTools(library: Library, store: Store): Tool[] {
  return [
    {
      name: 'library_list',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: choices(LIBRARY_SOURCES) },
          kind: { type: 'string', enum: choices(LIBRARY_KINDS) },
          chat: { type: 'string', description: '"this" for the calling chat, or a chat id.' },
          added: { type: 'string', enum: choices(LIBRARY_ADDED) },
          q: { type: 'string', description: 'Words that must all appear in the name, origin, path or chat title.' },
          limit: { type: 'number', description: `Most entries to return. Default ${LIMIT}, at most ${LIMIT_MAX}.` }
        },
        additionalProperties: false
      },
      run: (args, context) => {
        let filters
        try {
          filters = parseFilters({ ...args, chat: args.chat === 'this' ? context.chatId ?? '' : args.chat })
        } catch (error) {
          return failureResult('LIBRARY_FILTER', messageOf(error))
        }
        if (args.chat === 'this' && !context.chatId) return failureResult('LIBRARY_CHAT', 'Craft Studio could not tell which chat this call came from. Leave chat out, or give a chat id.')
        const title = (chatId: string): string => store.chat(chatId)?.title ?? ''
        const all = library.list()
        const found = filterEntries(all, filters, title)
        const limit = Math.min(LIMIT_MAX, Math.max(1, Math.floor(Number(args.limit) || LIMIT)))
        if (!found.length) return textResult(all.length ? `No files match those filters; the shelf holds ${all.length}.` : 'The library is empty: no chat has attached, downloaded or written a file yet.')
        const lines = found.slice(0, limit).map((entry) => [
          entry.id,
          entry.name,
          entry.kind + (entry.pages ? ` · ${entry.pages} pages` : '') + (entry.width ? ` · ${entry.width}×${entry.height}` : ''),
          `${entry.source} · ${entry.origin}`,
          entry.chatId ? `chat "${title(entry.chatId) || entry.chatId}"${entry.chatId === context.chatId ? ' (this chat)' : ''}` : 'no chat',
          formatSize(entry.size),
          new Date(entry.addedAt).toISOString().slice(0, 16).replace('T', ' '),
          entry.missing ? `MISSING (was ${entry.path})` : entry.path
        ].join(' | '))
        const more = found.length > limit ? `\n…and ${found.length - limit} more; narrow the filters or raise limit.` : ''
        return textResult(`${found.length} of ${all.length} files. id | name | kind | source · origin | chat | size | added (UTC) | path\n${lines.join('\n')}${more}`)
      }
    }
  ]
}
