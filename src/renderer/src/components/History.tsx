import { Trash2 } from 'lucide-react'
import type { Chat } from '../../../shared/types.ts'
import { act } from '../app-map.ts'
import { currentChatId, deleteChat, useApp } from '../store.ts'

// Every chat, newest first, in a menu that opens from the composer's Chats icon. Picking one
// opens it as a tab. The toolbar keeps the menu inside the chat card, so it never reaches the
// browser (a native view that would paint on top of it).

function groupOf(chat: Chat, now: number): string {
  const days = Math.floor((startOfDay(now) - startOfDay(chat.updatedAt)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'This week'
  return 'Earlier'
}

function startOfDay(time: number): number {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function HistoryMenu({ onPick }: { onPick: () => void }) {
  const chats = useApp((state) => state.chats)
  const activeChatId = useApp(currentChatId)
  const running = useApp((state) => state.running)
  const now = Date.now()
  const groups: Array<{ label: string; chats: Chat[] }> = []
  for (const chat of chats) {
    const label = groupOf(chat, now)
    const group = groups.at(-1)?.label === label ? groups.at(-1)! : groups[groups.push({ label, chats: [] }) - 1]!
    group.chats.push(chat)
  }

  return (
    <div className="history-menu" role="menu" aria-label="Chat history">
      {chats.length === 0 && <p className="history-empty">Your chats will appear here.</p>}
      {groups.map((group) => (
        <section key={group.label}>
          <h2 className="history-heading">{group.label}</h2>
          {group.chats.map((chat) => (
            <div key={chat.id} className={`chat-row${chat.id === activeChatId ? ' is-active' : ''}`}>
              <button
                type="button"
                role="menuitem"
                className="chat-row-main"
                onClick={() => {
                  void act('chat.open', { chatId: chat.id })
                  onPick()
                }}
              >
                {running.has(chat.id) && <span className="live-dot" aria-label="Answering" />}
                <span className="chat-row-title">{chat.title}</span>
              </button>
              <button
                type="button"
                className="chat-row-delete"
                aria-label={`Delete chat: ${chat.title}`}
                title="Delete chat"
                onClick={() => {
                  if (window.confirm(`Delete "${chat.title}"? This removes it from Craft Studio for good.`)) deleteChat(chat.id)
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}
