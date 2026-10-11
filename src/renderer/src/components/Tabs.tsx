import { Plus, X } from 'lucide-react'
import { usePane, usePaneChatId } from '../pane.ts'
import { act } from '../app-map.ts'
import { closeTab, paneAt, useApp } from '../store.ts'

// The open chats, as tabs standing on the composer's top edge. The selected tab is drawn as part
// of the composer: same fill, same outline, and no line between the two. A chat that has not
// been sent to yet has no id, so it shows as a "New chat" tab only while it is the one on screen.

export function Tabs() {
  const pane = usePane()
  const tabs = useApp((state) => paneAt(state, pane).tabs)
  const chats = useApp((state) => state.chats)
  const activeChatId = usePaneChatId()
  const running = useApp((state) => state.running)

  return (
    <div className="tabs" role="tablist" aria-label="Open chats">
      {tabs.map((id) => {
        const title = chats.find((chat) => chat.id === id)?.title ?? 'New chat'
        const active = id === activeChatId
        return (
          <div
            key={id}
            className={`tab${active ? ' is-active' : ''}`}
            title={title}
            onAuxClick={(event) => {
              if (event.button === 1) closeTab(id, pane)
            }}
          >
            <button type="button" role="tab" aria-selected={active} className="tab-main" onClick={() => void act('chat.open', { chatId: id, pane })}>
              {running.has(id) && <span className="live-dot" aria-label="Answering" />}
              <span className="tab-title">{title}</span>
            </button>
            <button type="button" className="tab-close" aria-label={`Close tab: ${title}`} onClick={() => closeTab(id, pane)}>
              <X size={12} />
            </button>
          </div>
        )
      })}
      {activeChatId === null && (
        <div className="tab is-active is-draft">
          <button type="button" role="tab" aria-selected className="tab-main">
            <span className="tab-title">New chat</span>
          </button>
        </div>
      )}
      <button
        type="button"
        className="tab-new"
        title="New chat"
        aria-label="New chat"
        disabled={activeChatId === null}
        onClick={() => void act('chat.new', { pane })}
      >
        <Plus size={14} />
      </button>
    </div>
  )
}
