import { createContext, useContext } from 'react'
import { chatIdOf, useApp, viewOf, type ChatView } from './store.ts'

// Which pane a component is in. Everything inside the column (tabs, transcript, composer) reads
// its chat through this rather than through a global, so a worker's transcript on the board,
// drawn with `ShownChatContext`, is its own chat and not the orchestrator's drawn twice.

export const PaneContext = createContext(0)

/**
 * A chat shown outside the column, read-only: a worker's window on the orchestrator's board puts
 * the real transcript around the worker's chat with this, so it is the same transcript the chat
 * column draws.
 */
export const ShownChatContext = createContext<string | null | undefined>(undefined)

/**
 * A worker chat drawn on the orchestrator's board: the assignment its run sent it (to fold that
 * message away) and whether it is the small window, which drops what its own head already shows.
 */
export type WorkerShown = { task: string; turnId: string | null; compact: boolean }
export const WorkerShownContext = createContext<WorkerShown | null>(null)

export function usePane(): number {
  return useContext(PaneContext)
}

/** The chat this pane shows, or null on the new-chat screen. */
export function usePaneChatId(): string | null {
  const pane = usePane()
  const shown = useContext(ShownChatContext)
  return useApp((state) => (shown !== undefined ? shown : chatIdOf(state, pane)))
}

/** Something of this pane's chat view; an empty view on the new-chat screen. */
export function usePaneView<T>(select: (view: ChatView) => T): T {
  const pane = usePane()
  const shown = useContext(ShownChatContext)
  return useApp((state) => select(viewOf(state, shown !== undefined ? shown : chatIdOf(state, pane))))
}
