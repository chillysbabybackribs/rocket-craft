import { addDraftFiles, ATTACHMENT_DRAG_TYPE, updateDraft } from './drafts.ts'
import './images.css'
import './library.css'
import { useEffect, useState } from 'react'
import { Images, X } from 'lucide-react'
import { PaneContext, usePane, usePaneChatId, usePaneView } from './pane.ts'
import { boardRun, currentChatId, dismissError, paneAt, useApp } from './store.ts'
import { ArtifactPanel } from './components/ArtifactPanel.tsx'
import { AttachmentNotice, copyTo } from './components/AttachmentMenu.tsx'
import { BrowserPanel } from './components/BrowserPanel.tsx'
import { CraftAppPanel } from './components/CraftAppPanel.tsx'
import { Dock } from './components/Dock.tsx'
import { Shelf } from './components/Shelf.tsx'
import './craft.css'
import { LibraryPanel } from './components/LibraryPanel.tsx'
import { Composer } from './components/Composer.tsx'
import { OrchestratorShell } from './components/OrchestratorShell.tsx'
import { PlanDrawer } from './components/PlanDrawer.tsx'
import { Split } from './components/Split.tsx'
import { TitleStrip } from './components/TitleStrip.tsx'
import { Transcript } from './components/Transcript.tsx'

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 5) return 'Still up?'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/** One pane of the chat card: a whole chat, or the new-chat screen. */
function ChatPane() {
  const pane = usePane()
  const chatId = usePaneChatId()
  const paneKey = useApp(state => paneAt(state, pane).key)
  const draftKey = chatId ?? `new:${paneKey}`
  // 'copy' while an attachment from another chat is dragged in; 'files' for files from outside Craft Studio.
  const [dropping, setDropping] = useState<false | 'copy' | 'files'>(false)
  const chat = useApp((state) => state.chats.find((entry) => entry.id === chatId) ?? null)
  const hasTurns = usePaneView((view) => view.turns.length > 0)
  // The turn whose plan is open beside the chat, with the message that started it for the title.
  const planTurn = usePaneView((view) => view.turns.find((turn) => turn.id === view.planTurnId) ?? null)
  const planUserId = usePaneView((view) => (view.planTurnId ? view.turnItems[view.planTurnId]?.[0] : undefined))
  const empty = !chat || !hasTurns

  let body: React.ReactNode
  if (empty) {
    body = (
      <div className="welcome">
        <h1 className="welcome-title">{greeting()}</h1>
        <Composer key={chatId ?? 'new'} placeholder="How can I help you today?" />
        <p className="welcome-hint">Pick a provider and model for each message. They all share the conversation.</p>
      </div>
    )
  } else {
    const composer = (
      <div className="composer-dock">
        <Composer key={chatId ?? 'new'} placeholder="Reply…" />
      </div>
    )
    body = planTurn
      ? (
        <Split side={<PlanDrawer turn={planTurn} userItemId={planUserId} />}>
          <Transcript />
          {composer}
        </Split>
      )
      : (
        <>
          <Transcript />
          {composer}
        </>
      )
  }
  return (
    <section data-pane-index={usePane()} className={`pane${empty ? ' is-empty' : ''}`} aria-label={chat?.title ?? 'New chat'}
      onDragOver={event => {
        if (event.dataTransfer.types.includes('Files') || event.dataTransfer.types.includes(ATTACHMENT_DRAG_TYPE)) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          setDropping(event.dataTransfer.types.includes(ATTACHMENT_DRAG_TYPE) ? 'copy' : 'files')
        }
      }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false) }}
      onDrop={event => {
        if (!event.dataTransfer.types.includes('Files') && !event.dataTransfer.types.includes(ATTACHMENT_DRAG_TYPE)) return
        event.preventDefault()
        setDropping(false)
        const existing = event.dataTransfer.getData(ATTACHMENT_DRAG_TYPE)
        if (existing) {
          try { copyTo(JSON.parse(existing), draftKey, chat?.title ?? 'the new chat') } catch { updateDraft(draftKey, { error: 'This attachment could not be added. Choose the file again.' }) }
        } else addDraftFiles(draftKey, Array.from(event.dataTransfer.files))
      }}>
      {body}
      {dropping && (
        <div className="image-drop-target">
          <Images size={30} />
          <strong>{dropping === 'copy' ? `Copy to ${chat?.title ?? 'this new chat'}` : 'Add files to this chat'}</strong>
          <span>{dropping === 'copy' ? 'Adds the attachment to this chat’s draft' : chat?.title ?? 'New chat'}</span>
          <small>{dropping === 'copy' ? 'Release to copy · nothing is sent' : 'Release to attach · send when you’re ready'}</small>
        </div>
      )}
    </section>
  )
}

/**
 * The chat card, as Craft Studio has it: one pane, the orchestrator's chat, in the left
 * column of the shell. Its key is kept so a reload of the pane list leaves the chat as it was.
 */
function ChatCard() {
  const pane = useApp((state) => state.panes[0]!)
  return (
    <main className="chat">
      <PaneContext.Provider key={pane.key} value={0}>
        <ChatPane />
      </PaneContext.Provider>
    </main>
  )
}

/**
 * The right side: one of an installed app, the shelf, the browser or the library, with the dock
 * under it. A file a link opened (or a run's progress view) shows over it until closed.
 */
function RightSide() {
  const artifact = useApp((state) => state.artifact !== null)
  const side = useApp((state) => state.side)
  let shown: React.ReactNode
  if (artifact) shown = <ArtifactPanel />
  else if (side.kind === 'app') shown = <CraftAppPanel key={side.id} id={side.id} />
  else if (side.kind === 'browser') shown = <BrowserPanel />
  else if (side.kind === 'library') shown = <LibraryPanel />
  else shown = <Shelf />
  return (
    <div className="craft-right">
      <div className="craft-region">{shown}</div>
      <Dock />
    </div>
  )
}

export function App() {
  useEffect(() => {
    // Files dropped outside a chat must not navigate the Electron shell away from the app.
    const preventNavigation = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes('Files') || event.dataTransfer?.types.includes(ATTACHMENT_DRAG_TYPE)) event.preventDefault()
    }
    window.addEventListener('dragover', preventNavigation)
    window.addEventListener('drop', preventNavigation)
    return () => {
      window.removeEventListener('dragover', preventNavigation)
      window.removeEventListener('drop', preventNavigation)
    }
  }, [])
  const hasRun = useApp((state) => boardRun(state) !== null)
  // The side of the column, when it has one: the chat column then takes a larger share.
  const split = useApp((state) => {
    const chatId = currentChatId(state)
    return chatId !== null && state.views[chatId]?.planTurnId != null
  })
  const error = useApp((state) => state.error)
  return (
    <div className={`app orch-app craft-layout${hasRun ? ' has-run' : ''}${split ? ' has-side' : ''}`}>
      <TitleStrip />
      <OrchestratorShell>
        <ChatCard />
      </OrchestratorShell>
      <RightSide />
      <AttachmentNotice />
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={dismissError}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
