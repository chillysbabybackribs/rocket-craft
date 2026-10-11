import { Attachments, useImagePreview, useMenuRequest } from './Attachments.tsx'
import { AttachmentMenu } from './AttachmentMenu.tsx'
import { call } from '../host.ts'
import { createContext, Fragment, memo, useContext, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChatMarkdown } from './ChatMarkdown.tsx'
import { AlertCircle, Check, ChevronRight, FileDiff, FileText, Globe, PencilLine, Plug, Search, SquareTerminal, Wrench } from 'lucide-react'
import { citationMarks } from '../../../shared/sources.ts'
import { planItemId, providerLabel, type Item, type MessageDraft, type ToolKind, type Turn, type TurnSources } from '../../../shared/types.ts'
import { splitBlocks } from '../markdown-blocks.ts'
import { ShownChatContext, usePane, usePaneChatId, usePaneView, WorkerShownContext, type WorkerShown } from '../pane.ts'
import { answerQuestion, editQueued, loadOlder, loadOutput, openTurnChanges, peekItem, sendNow, togglePlan, useApp, useItem } from '../store.ts'
import { Bar, Counts } from './ChangesView.tsx'

/** The turn's sources record, for the marks on the links of its replies; null while it runs. */
const SourcesContext = createContext<TurnSources | null>(null)

/** Markdown is the expensive part of a row; text that has not changed parses once and never again. */
const Block = memo(function Block({ text, settled, marks }: { text: string; settled: boolean; marks?: Record<string, boolean> }) {
  return <ChatMarkdown text={text} settled={settled} marks={marks} />
})

/**
 * A reply still arriving is parsed block by block, so each batch of text re-parses only the
 * block it lands in (markdown-blocks.ts), and falls a frame behind rather than queueing when
 * even that is slow. Once settled it is parsed whole.
 */
const Prose = memo(function Prose({ text, streaming }: { text: string; streaming: boolean }) {
  const arriving = useDeferredValue(text)
  const blocks = streaming ? splitBlocks(arriving) : [text]
  const sources = useContext(SourcesContext)
  const marks = useMemo(() => citationMarks(sources), [sources])
  return (
    <div className="prose">
      {/* While it streams, only the last block can still change. */}
      {blocks.map((block, index) => <Block key={index} text={block} settled={!streaming || index < blocks.length - 1} marks={marks} />)}
    </div>
  )
})

const TOOL_ICONS: Record<ToolKind, typeof Wrench> = {
  command: SquareTerminal,
  edit: PencilLine,
  read: FileText,
  search: Search,
  web: Globe,
  mcp: Plug,
  other: Wrench
}

type ToolItem = Extract<Item, { type: 'tool' }>

/** One borderless line for a tool call: what it is, and nothing around it. */
function ToolLine({ item }: { item: ToolItem }) {
  const Icon = TOOL_ICONS[item.kind]
  return (
    <>
      <Icon size={13} className="tool-icon" />
      <span className="tool-label">{item.label}</span>
      {item.status === 'failed' && <span className="tool-failed">failed</span>}
    </>
  )
}

/**
 * A step in an opened summary: a tool line that opens its output, the reasoning text, or what
 * the model said along the way before its final reply.
 */
const Step = memo(function Step({ id }: { id: string }) {
  const item = useItem(id)
  const chatId = usePaneChatId()
  const [open, setOpen] = useState(false)
  if (!item) return null
  if (item.type === 'reasoning') return item.text.trim() ? <div className="reasoning-text">{item.text}</div> : null
  if (item.type === 'assistant') return item.text.trim() ? <Prose text={item.text} streaming={false} /> : null
  if (item.type !== 'tool') return null
  // A finished call's output comes when the step is first opened (`outputLength`).
  const expandable = item.output.trim().length > 0 || (item.outputLength ?? 0) > 0
  const toggle = (): void => {
    if (!open && chatId) void loadOutput(chatId, item.id)
    setOpen(!open)
  }
  return (
    <>
      <button type="button" className="tool-line" disabled={!expandable} aria-expanded={expandable ? open : undefined} onClick={toggle}>
        <ToolLine item={item} />
        {expandable && <ChevronRight size={12} className={`tool-chevron${open ? ' is-open' : ''}`} />}
      </button>
      {open && expandable && <pre className="tool-output">{item.output}</pre>}
    </>
  )
})

/** The one line of live work: the latest tool call, replaced by each new one. */
function CurrentTool({ id }: { id: string }) {
  const item = useItem(id)
  if (item?.type !== 'tool') return null
  return (
    <div className="activity-current">
      {/* Keyed by call, so each new call mounts fresh and rises into place. */}
      <div className="tool-line" key={id}>
        <ToolLine item={item} />
      </div>
    </div>
  )
}

/** Whether a run holds any reasoning text to show. */
function hasThought(ids: string[]): boolean {
  return ids.some((id) => {
    const item = peekItem(id)
    return item?.type === 'reasoning' && item.text.trim().length > 0
  })
}

/** How long the live thinking takes to fold away; the same figure is in `.thought-live`. */
const RETRACT_MS = 220

/** True while `on`, and for `ms` after it ends, so what it showed can animate out before unmounting. */
function useLingering(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(on)
  useEffect(() => {
    if (on) {
      setHeld(true)
      return
    }
    const timer = setTimeout(() => setHeld(false), ms)
    return () => clearTimeout(timer)
  }, [on, ms])
  return on || held
}

/**
 * The model's thinking as it arrives, shown whole: the window grows with the text, since each
 * thought replaces the one before it rather than adding to the page. It opens with the first
 * text and folds away when the work it belongs to is over: the reply starts, or the turn ends.
 */
function LiveThought({ id, open }: { id: string; open: boolean }) {
  const item = useItem(id)
  const box = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  // A new thought starts empty; the last one stays up until it has something to say.
  const shown = useRef('')
  const text = item?.type === 'reasoning' ? item.text.trim() : ''
  if (text) shown.current = text
  const visible = open && shown.current !== ''
  // The height is set from the text so that it can animate; a reflow when the column changes
  // width is followed too.
  useLayoutEffect(() => {
    const inner = box.current?.firstElementChild
    if (!visible || !inner) return
    const fit = (): void => setHeight(inner.getBoundingClientRect().height)
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [visible])
  return (
    <div ref={box} className={`thought-live${visible ? ' is-open' : ''}`} aria-hidden={!visible} style={{ height: visible ? height : 0 }}>
      <div>{shown.current}</div>
    </div>
  )
}

/**
 * The work of a turn. While it is live, it is one line showing the current tool over the thinking
 * as it arrives, the tool on top so it keeps its place while the text below it grows; otherwise
 * one summary line that opens the steps. Work that is only thinking has no line of its own: the
 * turn's head opens it.
 */
const Activity = memo(function Activity({ ids, live, thoughtsOpen }: { ids: string[]; live: boolean; thoughtsOpen: boolean }) {
  const [open, setOpen] = useState(false)
  const lingering = useLingering(live, RETRACT_MS)
  const steps = ids.map(peekItem)
  const tools = steps.filter((step): step is ToolItem => step?.type === 'tool')
  const thought = lingering ? steps.findLast((step) => step?.type === 'reasoning') : undefined
  const failed = tools.filter((tool) => tool.status === 'failed').length
  const current = tools.at(-1)
  const body = live
    ? current && <CurrentTool id={current.id} />
    : tools.length === 0
      ? thoughtsOpen && hasThought(ids) && <div className="activity-steps">{ids.map((id) => <Step key={id} id={id} />)}</div>
      : (
        <>
          <button type="button" className="activity-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
            <span>{`Worked · ${tools.length} ${tools.length === 1 ? 'step' : 'steps'}`}</span>
            {failed > 0 && <span className="activity-failed">{failed} failed</span>}
            <ChevronRight size={12} className={`tool-chevron${open ? ' is-open' : ''}`} />
          </button>
          {open && <div className="activity-steps">{ids.map((id) => <Step key={id} id={id} />)}</div>}
        </>
      )
  if (!thought && !body) return null
  return (
    <div className="activity">
      {body}
      {thought && <LiveThought key="thought" id={thought.id} open={live} />}
    </div>
  )
})

type QuestionItem = Extract<Item, { type: 'question' }>

/**
 * A question the model asked, with its answers as buttons. The model's own pick is marked, so
 * taking its word is one click; "Something else" opens a line for an answer in the user's words.
 * It never holds anything up: unanswered, it stays as it is, and the chat goes on around it. Once
 * answered it shows the choice and nothing to click.
 */
function QuestionCard({ item }: { item: QuestionItem }) {
  const pane = usePane()
  // A transcript on the worker board is read-only: an answer would go to the orchestrator's chat.
  const readOnly = useContext(ShownChatContext) !== undefined
  const [other, setOther] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (other !== null) input.current?.focus()
  }, [other])
  const answer = async (text: string): Promise<void> => {
    if (sending || !text.trim()) return
    setSending(true)
    await answerQuestion(pane, item.id, text.trim())
    setSending(false)
  }
  if (item.answer !== null || readOnly) {
    return (
      <div className="question is-answered">
        <div className="question-text">{item.text}</div>
        <div className="question-answer">{item.answer !== null ? <><Check size={13} /><span>{item.answer}</span></> : <span>Not answered</span>}</div>
      </div>
    )
  }
  return (
    <div className="question" role="group" aria-label="Question from the model">
      <div className="question-text">{item.text}</div>
      <div className="question-options">
        {item.options.map((option, index) => (
          <button
            type="button"
            key={option.label}
            className={`question-option${index === item.recommended ? ' is-recommended' : ''}`}
            disabled={sending}
            onClick={() => void answer(option.label)}
          >
            <span className="question-option-label">
              {option.label}
              {index === item.recommended && <span className="question-pick">Suggested</span>}
            </span>
            <span className="question-option-detail">{option.detail}</span>
          </button>
        ))}
      </div>
      {other === null
        ? <button type="button" className="question-other" disabled={sending} onClick={() => setOther('')}>Something else…</button>
        : (
          <input
            ref={input}
            className="question-input"
            value={other}
            placeholder="Your answer, then Enter"
            aria-label="Your answer"
            disabled={sending}
            onChange={(event) => setOther(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void answer(other)
              if (event.key === 'Escape') setOther(null)
            }}
          />
        )}
    </div>
  )
}

type ImageItem = Extract<Item, { type: 'image' }>

/** The placeholder's dots, 32 by 20, each delayed by its distance from the centre so a wave spreads out. */
const DOT_DELAYS = Array.from({ length: 32 * 20 }, (_, index) => {
  const col = index % 32
  const row = Math.floor(index / 32)
  return `${(Math.hypot((col - 15.5) / 1.6, row - 9.5) * 0.09).toFixed(2)}s`
})

/** The prompt a picture was made from, two lines until the reader asks for the rest. */
function Caption({ text }: { text: string }) {
  const box = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  useLayoutEffect(() => {
    const element = box.current
    if (!element || open) return
    const measure = (): void => setLong(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text, open])
  if (!text) return null
  return (
    <>
      <figcaption ref={box} className={`gen-caption${open ? ' is-open' : ''}`}>{text}</figcaption>
      {(long || open) && <button type="button" className="gen-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Less' : 'More'}</button>}
    </>
  )
}

/** A finished picture from Craft Studio's own copy: click for full size, right-click for the attachment menu. */
function MadeImage({ image, caption, arriving }: { image: NonNullable<ImageItem['image']>; caption: string; arriving: boolean }) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const preview = useImagePreview(image)
  const menu = useMenuRequest()
  useEffect(() => {
    let alive = true
    void call('attachment.read', { id: image.id }).then((value) => { if (alive) setSrc(value) }, (reason: Error) => { if (alive) setError(reason.message) })
    return () => { alive = false }
  }, [image.id])
  if (error) return <div className="gen-failed" role="alert"><AlertCircle size={13} /><span>{error}</span></div>
  return (
    <div className="gen-made" {...menu.handlers}>
      <button type="button" className="gen-frame gen-image" aria-label={`Open ${image.name} full size`} onClick={() => void preview.open()}>
        {src
          ? <img className={arriving ? 'is-arriving' : undefined} src={src} alt={caption || image.name} width={image.width} height={image.height} draggable={false} />
          : <span className="gen-loading" style={{ aspectRatio: `${image.width} / ${image.height}` }} />}
      </button>
      <AttachmentMenu attachment={image} onPreview={() => void preview.open()} className="is-generated" request={menu.request} />
      {preview.dialog}
    </div>
  )
}

/**
 * A picture a model made, where it was made in the reply (docs/mockups/generated-images.html):
 * a field of rippling dots while it comes, with no frame or words over it, then the picture coming into
 * focus, or a sentence saying why there is none. The prompt it was made from is the caption.
 */
function GeneratedImage({ item }: { item: ImageItem }) {
  // Only a picture seen arriving animates in; one already made when the chat opened just shows.
  const [sawWaiting] = useState(item.status === 'generating')
  return (
    <figure className="gen">
      {item.status === 'generating' && (
        <div className="gen-frame gen-pending" role="status" aria-label="Generating image">
          <div className="gen-field" aria-hidden>{DOT_DELAYS.map((delay, index) => <i key={index} style={{ animationDelay: delay }} />)}</div>
        </div>
      )}
      {item.status === 'failed' && (
        <div className="gen-failed" role="alert"><AlertCircle size={13} /><span>{item.error ?? 'The image could not be made. Ask for it again.'}</span></div>
      )}
      {item.status === 'done' && item.image && <MadeImage image={item.image} caption={item.caption} arriving={sawWaiting} />}
      <Caption text={item.caption} />
    </figure>
  )
}

function UserMessage({ text, attachments }: MessageDraft) {
  const prompt = text.trim() ? <div className="user-bubble"><ChatMarkdown text={text} /></div> : null
  if (!attachments?.length) return prompt
  return <div className="user-message"><Attachments attachments={attachments} />{prompt}</div>
}

const ItemRow = memo(function ItemRow({ id }: { id: string }) {
  const item = useItem(id)
  if (!item) return null
  switch (item.type) {
    case 'user':
      return <UserMessage text={item.text} attachments={item.attachments} />
    case 'assistant':
      return item.text.trim() ? <Prose text={item.text} streaming={item.streaming} /> : null
    case 'notice':
      return <p className={`notice is-${item.tone}`}>{item.text}</p>
    case 'question':
      return <QuestionCard item={item} />
    case 'image':
      return <GeneratedImage item={item} />
    default:
      return null
  }
})

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * The turn's plan, as its head line says it: "Planning · 2 of 5" while the turn runs, the count
 * moving as steps finish, and "Planned · 5 of 5" once it is over. It opens and closes the plan
 * beside the chat.
 */
function PlanLabel({ turn, running }: { turn: Turn; running: boolean }) {
  const plan = useItem(planItemId(turn.id))
  const chatId = usePaneChatId()
  const open = usePaneView((view) => view.planTurnId === turn.id)
  if (plan?.type !== 'plan') return null
  const done = plan.steps.filter((step) => step.status === 'done').length
  const text = <span className={running ? 'shimmer' : ''}>{running ? 'Planning' : 'Planned'} · {done} of {plan.steps.length}</span>
  return (
    <button type="button" className={`turn-head-toggle plan-toggle${open ? ' is-open' : ''}`} aria-pressed={open} title={open ? 'Hide the plan' : 'Show the plan'} onClick={() => { if (chatId) togglePlan(chatId, turn.id) }}>
      {text}
    </button>
  )
}

/**
 * The line every response starts with, above a divider: a shimmering "Thinking" and a running
 * clock while the turn works, and how long it took once it is over. Everything the model says
 * and does goes under the divider. When the turn has thinking to show, the line opens it; when
 * it keeps a plan, the line names the plan and opens that instead.
 */
function TurnHead({ turn, thoughts, plan, open, onToggle }: { turn: Turn; thoughts: boolean; plan: boolean; open: boolean; onToggle: () => void }) {
  const running = turn.status === 'running'
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [running])
  // A turn can be waiting rather than thinking, on background tasks it started; its head says so.
  const label = running ? <span className="shimmer">{turn.activity ?? 'Thinking'}</span> : thoughts && <span>Thought</span>
  return (
    <div className="turn-head" role={running ? 'status' : undefined}>
      {plan
        ? <PlanLabel turn={turn} running={running} />
        : thoughts
          ? (
            <button type="button" className="turn-head-toggle" aria-expanded={open} onClick={onToggle}>
              {label}
              <ChevronRight size={12} className={`tool-chevron${open ? ' is-open' : ''}`} />
            </button>
          )
          : label}
      {running
        ? <span className="turn-head-time">Working for {duration(now - turn.startedAt)}</span>
        : turn.endedAt !== null && <span className="turn-head-time">Worked for {duration(turn.endedAt - turn.startedAt)}</span>}
    </div>
  )
}

/**
 * A turn's response keeps one shape however long it works, each part replacing the last in its
 * place rather than piling up: a summary of the steps so far, then the model's latest words, and,
 * while it runs, the thinking and tool call under way. Notices and questions keep to the end.
 */
function stageOf(ids: string[], running: boolean): { reply: string | null; steps: string[]; live: string[]; notices: string[]; before: string[]; after: string[] } {
  const trailing = (id: string): boolean => {
    const type = peekItem(id)?.type
    return type === 'notice' || type === 'question'
  }
  // Pictures are part of the answer, not its steps: they stand before or after the reply, as made.
  const picture = (id: string): boolean => peekItem(id)?.type === 'image'
  const notices = ids.filter(trailing)
  const work = ids.filter((id) => !trailing(id) && !picture(id))
  const at = work.findLastIndex((id) => peekItem(id)?.type === 'assistant')
  const reply = at === -1 ? null : work[at]
  const pictures = ids.filter(picture)
  const before = reply === null ? pictures : pictures.filter((id) => ids.indexOf(id) < ids.indexOf(reply))
  const after = pictures.filter((id) => !before.includes(id))
  if (!running) return { reply, steps: work.filter((id) => id !== reply), live: [], notices, before, after }
  return { reply, steps: at === -1 ? [] : work.slice(0, at), live: work.slice(at + 1), notices, before, after }
}

/**
 * What the turn changed in the folder, in one line like the summary of its steps: the count, the
 * added and removed lines, and a bar of their balance. It opens the diff beside the chat.
 */
function ChangesLine({ turn }: { turn: Turn }) {
  const chatId = usePaneChatId()
  const open = useApp((state) => state.artifact?.kind === 'changes' && state.artifact.turnId === turn.id && state.artifact.chatId === chatId)
  const { changes } = turn
  if (!changes || changes.files === 0) return null
  return (
    <button type="button" className={`changes-line${open ? ' is-open' : ''}${changes.undone ? ' is-undone' : ''}`} aria-pressed={open} onClick={() => void openTurnChanges(chatId, turn.id)}>
      <FileDiff size={12} className="changes-icon" />
      <span>Changed {changes.files} {changes.files === 1 ? 'file' : 'files'}</span>
      <Counts added={changes.added} removed={changes.removed} />
      <Bar added={changes.added} removed={changes.removed} />
      {changes.undone && <span className="undone-tag">undone</span>}
    </button>
  )
}

/**
 * A turn's items cut where the user sent words into it while it ran: each part keeps the usual
 * shape, and only the last can still be live.
 */
function partsOf(ids: string[]): Array<{ steer: string | null; ids: string[] }> {
  const parts: Array<{ steer: string | null; ids: string[] }> = [{ steer: null, ids: [] }]
  for (const id of ids) {
    const item = peekItem(id)
    if (item?.type === 'user' && item.steer) parts.push({ steer: id, ids: [] })
    else parts.at(-1)!.ids.push(id)
  }
  return parts
}

/** One part of a turn's response: the summary of its steps, its latest words, and, if live, the work under way. */
function Stage({ ids, running, thoughtsOpen }: { ids: string[]; running: boolean; thoughtsOpen: boolean }) {
  const { reply, steps, live, before, after } = stageOf(ids, running)
  // One keyed list, so a picture that moves from after the reply to before it (when the final
  // reply arrives) is moved rather than mounted again. Pictures after the reply keep their place
  // around the work under way, in the order they came.
  const liveAt = live.length ? ids.indexOf(live[0]!) : Infinity
  const rows = [
    steps.length > 0 && <Activity key="steps" ids={steps} live={false} thoughtsOpen={thoughtsOpen} />,
    ...before.map((id) => <ItemRow key={id} id={id} />),
    reply && <ItemRow key={reply} id={reply} />,
    ...after.filter((id) => ids.indexOf(id) < liveAt).map((id) => <ItemRow key={id} id={id} />),
    live.length > 0 && <Activity key={`live:${live[0]}`} ids={live} live thoughtsOpen={false} />,
    ...after.filter((id) => ids.indexOf(id) > liveAt).map((id) => <ItemRow key={id} id={id} />)
  ]
  return <>{rows}</>
}

/** Whether a worker chat's message is the assignment the orchestration sent it. */
function isAssignment(worker: WorkerShown, turn: Turn, userId: string | undefined): boolean {
  if (turn.id === worker.turnId) return true
  const item = userId ? peekItem(userId) : undefined
  // A turn id is only known once the run starts it; before that, the message's own shape tells.
  return item?.type === 'user' && /^<rocket-orchestration>\s*$/m.test(item.text.split('\n', 1)[0]!) && item.text.includes(worker.task)
}

/**
 * The assignment a worker was sent is the same long boilerplate each time. A worker's small
 * window shows one line of it; its expanded view keeps the whole message behind a toggle.
 */
function AssignmentLead({ worker, userId }: { worker: WorkerShown; userId: string }) {
  const [open, setOpen] = useState(false)
  const lead = useRef<HTMLDivElement>(null)
  // Opened, the message would push the toggle above the view while the transcript keeps to the
  // bottom; its start is brought into view (the toggle is sticky for when it is short enough that
  // the transcript still counts as at the bottom and follows it there).
  // Only the transcript scrolls: scrollIntoView would move every scrollable box above it too.
  useLayoutEffect(() => {
    const element = lead.current
    const scroller = element?.closest('.transcript')
    if (!open || !element || !scroller) return
    scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8
  }, [open])
  if (worker.compact) return <AssignmentStrip task={worker.task} />
  return (
    <div className="assignment-lead" ref={lead}>
      <button type="button" className="assignment-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className={`tool-chevron${open ? ' is-open' : ''}`} />
        <span>{open ? 'Hide assignment' : 'Show assignment'}</span>
        {!open && <span className="assignment-first">{firstLine(worker.task)}</span>}
      </button>
      {open && <ItemRow id={userId} />}
    </div>
  )
}

function firstLine(text: string): string {
  return text.trim().split('\n', 1)[0]!.trim()
}

/** One line naming a worker's assignment; the whole of it is the tooltip. */
export function AssignmentStrip({ task }: { task: string }) {
  return (
    <div className="assignment-strip" title={task}>
      <span className="assignment-label">Assignment</span>
      <span className="assignment-first">{firstLine(task)}</span>
    </div>
  )
}

const TurnBlock = memo(function TurnBlock({ turn, ids, fill }: { turn: Turn; ids: string[]; fill: boolean }) {
  const worker = useContext(WorkerShownContext)
  // The plan is not a row of the response; the head line names it and it shows beside the chat.
  const planId = planItemId(turn.id)
  const [userId, ...rest] = ids.filter((id) => id !== planId)
  const running = turn.status === 'running'
  const parts = partsOf(rest)
  const [thoughtsOpen, setThoughtsOpen] = useState(false)
  // Thinking that stands alone, with no tool calls around it, is what the head opens.
  const { steps } = stageOf(parts[0]!.ids, running && parts.length === 1)
  const thoughts = hasThought(steps) && steps.every((id) => peekItem(id)?.type !== 'tool')
  return (
    <article className={`turn${fill ? ' is-fill' : ''}`} data-turn={turn.id}>
      {userId && (worker && isAssignment(worker, turn, userId) ? <AssignmentLead worker={worker} userId={userId} /> : <ItemRow id={userId} />)}
      <div className="answer">
        <SourcesContext.Provider value={turn.sources}>
        {/* A worker's small window has its status and clock in its own head. */}
        {!worker?.compact && <TurnHead turn={turn} thoughts={thoughts} plan={ids.includes(planId)} open={thoughtsOpen} onToggle={() => setThoughtsOpen(!thoughtsOpen)} />}
        {parts.map((part, index) => (
          <Fragment key={part.steer ?? 'first'}>
            {part.steer && (
              <div className="steer">
                <ItemRow id={part.steer} />
                <div className="steer-tag">Added during the turn</div>
              </div>
            )}
            <Stage ids={part.ids} running={running && index === parts.length - 1} thoughtsOpen={index === 0 && thoughtsOpen} />
          </Fragment>
        ))}
        {!running && <ChangesLine turn={turn} />}
        {parts.flatMap((part) => stageOf(part.ids, false).notices).map((id) => <ItemRow key={id} id={id} />)}
        {turn.status === 'interrupted' && <p className="notice is-info">Stopped</p>}
        {turn.status === 'failed' && <p className="notice is-error">{turn.error ?? 'This turn failed.'}</p>}
        </SourcesContext.Provider>
      </div>
    </article>
  )
})

const NO_ITEMS: string[] = []

/**
 * Messages waiting for the turn in flight to end, under it: dashed until they are sent, with a
 * way to send them now (stopping the turn) or take them back into the composer. Words sent into
 * the turn wait here too, until its model reads them and they join the turn at that point.
 */
function Waiting() {
  const pane = usePane()
  const queued = usePaneView((view) => view.queued)
  const answering = usePaneView((view) => view.turns.findLast((turn) => turn.status === 'running')?.provider ?? null)
  if (!queued.length) return null
  return (
    <>
      {queued.map((entry) => (
        <div key={entry.id} className="steer is-waiting">
          <UserMessage text={entry.text} attachments={entry.attachments} />
          {entry.taking ? (
            <div className="steer-status"><span>{providerLabel(entry.provider)} reads this at its next step</span></div>
          ) : (
            <div className="steer-status">
              <span>Sends when {answering ? providerLabel(answering) : 'the turn'} finishes</span>
              <span aria-hidden>·</span>
              <button type="button" onClick={() => sendNow(pane)}>Send now</button>
              <button type="button" onClick={() => editQueued(pane, entry.id)}>Edit</button>
            </div>
          )}
        </div>
      ))}
    </>
  )
}

/** Per chat, the turn last sent while the app has been open: the one laid out to fill the view. */
const sentTurns = new Map<string, string>()

/** How near the top, in screens, the reader gets before the turns above are fetched. */
const OLDER_MARGIN = 1.5

export function Transcript() {
  const turns = usePaneView((view) => view.turns)
  const turnItems = usePaneView((view) => view.turnItems)
  const hasOlder = usePaneView((view) => view.hasOlder)
  const chatId = usePaneChatId()
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  // How far the reader is from the bottom, so turns put in above them leave them where they were.
  const fromBottom = useRef(0)
  // The turn that was first when earlier turns went in above it, and where it stood in the view.
  // Turns that are skipped by `content-visibility` take their real height only once laid out, which
  // can happen frames after they go in and no scroll anchoring corrects for it (the reader ended
  // up thousands of pixels from where they were), so the turn is held in place for a moment, or until the reader moves.
  const held = useRef<{ id: string; top: number; until: number } | null>(null)
  // The turn just sent in this chat. It is made as tall as the view, so that scrolled to the
  // bottom its message sits at the top with the whole view beneath it free for the response.
  const [sentId, setSentId] = useState<string | null>(null)
  const firstId = turns[0]?.id ?? null
  const lastId = turns.at(-1)?.id ?? null
  const seen = useRef({ chatId, firstId, lastId })
  // A long chat opens with its newest turns; the ones above come as the reader nears the top.
  const older = useRef({ chatId, hasOlder })
  older.current = { chatId, hasOlder }
  const nearTop = (): void => {
    const element = scroller.current
    const { chatId, hasOlder } = older.current
    if (element && chatId && hasOlder && element.scrollTop < element.clientHeight * OLDER_MARGIN) void loadOlder(chatId)
  }

  // Stay at the bottom while the user is there; leave them alone once they scroll up.
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const measure = (): void => {
      const style = content.current ? getComputedStyle(content.current) : null
      const padding = style ? parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) : 0
      element.style.setProperty('--turn-fill', `${Math.max(0, element.clientHeight - padding)}px`)
    }
    measure()
    const onScroll = (): void => {
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
      fromBottom.current = element.scrollHeight - element.scrollTop
      nearTop()
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    const hold = (): void => {
      if (held.current && Date.now() > held.current.until) held.current = null
      const anchor = held.current && element.querySelector(`[data-turn="${held.current.id}"]`)
      if (anchor && held.current) element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - held.current.top
    }
    const release = (): void => { held.current = null }
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) element.addEventListener(type, release, { passive: true })
    const follow = (): void => {
      if (pinned.current) element.scrollTop = element.scrollHeight
      else hold()
      // Turns drawn for the first time take their real height without a scroll event, which
      // would leave the distance kept for anchoring stale.
      fromBottom.current = element.scrollHeight - element.scrollTop
    }
    // The fill turn's height follows the view's, so setting it resizes the content, and content
    // that starts to overflow brings a scrollbar that narrows the view: written inside the
    // callback, that is a loop the browser reports as an error (many worker windows hit it). So
    // the callback only scrolls, which resizes nothing, and the size waits for the next frame.
    let frame = 0
    const observer = new ResizeObserver(() => {
      follow()
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        measure()
        follow()
      })
    })
    observer.observe(element)
    if (content.current) observer.observe(content.current)
    return () => {
      cancelAnimationFrame(frame)
      element.removeEventListener('scroll', onScroll)
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) element.removeEventListener(type, release)
      observer.disconnect()
    }
  }, [])

  useLayoutEffect(() => {
    const before = seen.current
    seen.current = { chatId, firstId, lastId }
    const element = scroller.current
    // Earlier turns put in above: the reader stays on what they were reading.
    if (element && before.chatId === chatId && before.lastId === lastId && before.firstId !== firstId) {
      element.scrollTop = element.scrollHeight - fromBottom.current
      const first = before.firstId && element.querySelector(`[data-turn="${before.firstId}"]`)
      held.current = first ? { id: before.firstId!, top: first.getBoundingClientRect().top - element.getBoundingClientRect().top, until: Date.now() + 1500 } : null
      nearTop()
      return
    }
    // A turn added to the end of the chat on screen was just sent, and one still running was sent
    // not long ago. The chat remembers it, so the layout is the same on coming back from another tab.
    const last = turns.at(-1)
    const sent = before.chatId === chatId && before.lastId !== lastId
    if (chatId && last && (sent || last.status === 'running')) sentTurns.set(chatId, last.id)
    setSentId((chatId && sentTurns.get(chatId)) || null)
  }, [chatId, firstId, lastId])

  useLayoutEffect(() => {
    pinned.current = true
    const element = scroller.current
    if (!element) return
    element.scrollTop = element.scrollHeight
    fromBottom.current = element.clientHeight
    // A first page shorter than the view gives no scroll to start the next one.
    nearTop()
  }, [chatId, lastId, sentId])

  return (
    <div className="transcript" ref={scroller}>
      <div className="transcript-inner" ref={content}>
        {turns.map((turn) => (
          <TurnBlock key={turn.id} turn={turn} ids={turnItems[turn.id] ?? NO_ITEMS} fill={turn.id === sentId} />
        ))}
        <Waiting />
      </div>
    </div>
  )
}
