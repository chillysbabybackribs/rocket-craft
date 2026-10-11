import type { ReactElement } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, TriangleAlert } from 'lucide-react'
import { pageKey } from '../../../shared/sources.ts'
import { chatUrlTransform, remarkFileLinks } from '../chat-links.ts'
import { openChatLink } from '../store.ts'

const REMARK = [remarkGfm, remarkFileLinks]

// Parsing is most of what a transcript costs to show, and a chat shown again (another tab, another
// pane, the page above) shows text it has parsed before. `Markdown` is a plain function of its
// options, so what it returns is kept by folder and text and handed back as it was: React elements
// never change once made. A reply still streaming is not kept, or each half-written version would
// push out ones worth keeping.
const PARSED_MAX = 600
const parsed = new Map<string, ReactElement>()
const linksIn = new Map<string, Components>()

/**
 * Whether the turn opened a cited page, as a mark after the link: a tick, or a warning for a
 * page the model cited without reading. `marks` is by page key (shared/sources.ts); a link not
 * in it (a file, a page the record never saw) carries nothing.
 */
function SourceMark({ opened }: { opened: boolean }) {
  return opened
    ? <span className="source-mark is-opened" title="Opened this turn"><Check size={11} aria-label="opened this turn" /></span>
    : <span className="source-mark is-unopened" title="Not opened this turn: the model cited this page without reading it"><TriangleAlert size={11} aria-label="not opened this turn" /></span>
}

function componentsFor(cwd: string | undefined, marks: Record<string, boolean> | undefined): Components {
  const key = cwd ?? ''
  // With marks, the components are made for the one reply; without, they are shared by folder.
  let components = marks ? undefined : linksIn.get(key)
  if (!components) {
    components = {
      a: ({ href, children }) => {
        if (!href) return <span>{children}</span>
        const page = marks && pageKey(href)
        const opened = page ? marks[page] : undefined
        return (
          <a href={href} onClick={(event) => {
            event.preventDefault()
            void openChatLink(href, cwd)
          }} onAuxClick={(event) => {
            if (event.button !== 1) return
            event.preventDefault()
            void openChatLink(href, cwd)
          }}>{children}{opened !== undefined && <SourceMark opened={opened} />}</a>
        )
      }
    }
    if (!marks) linksIn.set(key, components)
  }
  return components
}

export function ChatMarkdown({ text, cwd, settled = true, marks }: { text: string; cwd?: string; settled?: boolean; marks?: Record<string, boolean> }) {
  // Marks arrive once, when the turn ends, so a reply shown before them is parsed once more with them.
  const key = `${cwd ?? ''}\n${marks ? JSON.stringify(marks) : ''}\n${text}`
  const kept = parsed.get(key)
  if (kept) {
    // Most recently shown last, so the oldest is the one let go.
    parsed.delete(key)
    parsed.set(key, kept)
    return kept
  }
  const tree = Markdown({ remarkPlugins: REMARK, urlTransform: chatUrlTransform, components: componentsFor(cwd, marks), children: text })
  if (settled) {
    parsed.set(key, tree)
    if (parsed.size > PARSED_MAX) parsed.delete(parsed.keys().next().value!)
  }
  return tree
}
