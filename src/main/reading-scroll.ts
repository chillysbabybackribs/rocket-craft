import type { WebContents } from 'electron'
import type { BrowserReading } from '../shared/types.ts'
import { clampSpeed, READING_BASE } from '../shared/reading.ts'

// Hands-free reading: the page scrolls itself at a steady pace (docs/mockups/reading-scroll.html).
//
// The scrolling runs inside the page, in an isolated world of its own (the page's DOM, none of its
// JavaScript), because only there can it move every frame and see the reader's own wheel, keys and
// clicks as they happen. Main starts, pauses and stops it, and while a tab reads it asks the page
// for its progress a few times a second for the toolbar's ring and time left.
//
// What the page does on its own, so main never has to be asked:
// - The reader's own scrolling (wheel, trackpad, scrollbar, scroll keys) holds the scroll still
//   until a moment after it ends, then reading carries on from there. Setting the scroll position
//   every frame would otherwise cut a smooth wheel scroll short. Scrolling back up from the end
//   reads on.
// - Space pauses and carries on, in place of the page's own page-down, outside text fields.
// - A click in the page (a selection, a button, or a model's click) and typing in a field pause.
// - At the bottom it waits a few seconds for more to load, as feeds do, then says it is done.
// Leaving the page ends it with the document; main forgets the tab on navigation.

/** Any id but 0 (the page's) and 999 (Electron's preload world) would do. */
const WORLD = 1207

/** The page's half. Its source is sent to the page, so it must stand alone: nothing from outside its body. */
export function readerLib(base: number): void {
  const scope = globalThis as unknown as { __rocketReader?: unknown }
  if (scope.__rocketReader) return

  type State = 'off' | 'running' | 'paused' | 'end'
  let state: State = 'off'
  let speed = 1
  let carry = 0
  let last = 0
  let heldUntil = 0
  let dragging = false
  let waitingSince = 0
  let waitingHeight = 0
  let frame = 0
  let scroller: Element | null = null

  const root = (): Element => document.scrollingElement ?? document.documentElement
  // Most pages scroll the document; some apps scroll a box inside it instead. That box is the
  // nearest scrollable ancestor of whatever is in the middle of the view.
  const find = (): Element => {
    const top = root()
    if (top.scrollHeight - top.clientHeight > 1) return top
    let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2)
    while (el && el !== top) {
      const overflow = getComputedStyle(el).overflowY
      if (/(auto|scroll|overlay)/.test(overflow) && el.scrollHeight - el.clientHeight > 1) return el
      el = el.parentElement
    }
    return top
  }
  const target = (): Element => {
    if (!scroller || !scroller.isConnected) scroller = find()
    return scroller
  }
  const room = (el: Element): number => Math.max(0, el.scrollHeight - el.clientHeight)
  const editable = (el: EventTarget | null): boolean => el instanceof HTMLElement
    && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

  const tick = (now: number): void => {
    frame = 0
    if (state !== 'running') return
    frame = requestAnimationFrame(tick)
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0
    last = now
    if (dragging || now < heldUntil) { carry = 0; return }
    const el = target()
    if (el.scrollTop >= room(el) - 1) {
      // A feed loads more as you near its foot; give it time before calling the page done.
      if (!waitingSince) { waitingSince = now; waitingHeight = el.scrollHeight }
      else if (el.scrollHeight > waitingHeight + 1) waitingSince = 0
      else if (now - waitingSince > 3000) { waitingSince = 0; state = 'end' }
      return
    }
    waitingSince = 0
    // Scroll positions move in whole pixels, so the slow speeds keep the remainder for next frame.
    carry += base * speed * dt
    const step = Math.floor(carry)
    if (step) {
      carry -= step
      // 'instant' so a page's own `scroll-behavior: smooth` does not animate every step.
      el.scrollBy({ top: step, behavior: 'instant' })
    }
  }
  const run = (): void => {
    state = 'running'
    carry = 0
    last = 0
    waitingSince = 0
    if (!frame) frame = requestAnimationFrame(tick)
  }
  const hold = (up: boolean): void => {
    heldUntil = performance.now() + 450
    carry = 0
    if (state === 'end' && up) run()
  }
  const pause = (): void => { if (state === 'running') state = 'paused' }

  const listen = { capture: true, passive: true }
  addEventListener('wheel', (event) => {
    if (state === 'running' || state === 'end') hold(event.deltaY < 0)
  }, listen)
  addEventListener('keydown', (event) => {
    if (state === 'off' || event.altKey || event.ctrlKey || event.metaKey) return
    if (editable(event.target)) { pause(); return }
    if (event.key === ' ' && !event.shiftKey) {
      if (state === 'end') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (state === 'running') pause()
      else run()
      return
    }
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) hold(true)
    else if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) hold(false)
  }, { capture: true })
  addEventListener('pointerdown', (event) => {
    if (state === 'off' || event.button !== 0) return
    // A press on the scrolling box's own scrollbar is the reader scrolling, not clicking.
    const el = target()
    const box = el === root() ? { right: document.documentElement.clientWidth } : { right: el.getBoundingClientRect().left + el.clientLeft + el.clientWidth }
    if (event.clientX >= box.right) { dragging = true; hold(false); return }
    pause()
  }, listen)
  addEventListener('pointerup', () => {
    if (!dragging) return
    dragging = false
    hold(true)
  }, listen)
  addEventListener('focusin', (event) => { if (editable(event.target)) pause() }, listen)

  const status = (): { state: State; progress: number; secondsLeft: number } => {
    const el = target()
    const space = room(el)
    const left = Math.max(0, space - el.scrollTop)
    return { state, progress: space ? Math.min(1, el.scrollTop / space) : 1, secondsLeft: left / (base * speed) }
  }
  scope.__rocketReader = {
    start: (at: number) => {
      speed = at
      scroller = find()
      if (state === 'end') scroller.scrollTo({ top: 0, behavior: 'instant' })
      run()
      return status()
    },
    play: () => {
      if (state === 'end') target().scrollTo({ top: 0, behavior: 'instant' })
      if (state !== 'off') run()
      return status()
    },
    pause: () => { pause(); return status() },
    stop: () => { state = 'off'; return status() },
    speed: (at: number) => { speed = at; return status() },
    status
  }
}

const READER_LIB = `(${readerLib.toString()})(${READING_BASE})`

/** The page's answer as the toolbar shows it, or null when the page is not reading. */
export function readingOf(value: unknown): BrowserReading | null {
  if (!value || typeof value !== 'object') return null
  const { state, progress, secondsLeft } = value as Record<string, unknown>
  if (state !== 'running' && state !== 'paused' && state !== 'end') return null
  const fraction = typeof progress === 'number' && Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
  const seconds = typeof secondsLeft === 'number' && Number.isFinite(secondsLeft) ? Math.max(0, secondsLeft) : 0
  return { state, progress: Math.round(fraction * 1000) / 1000, secondsLeft: Math.round(seconds) }
}

function same(a: BrowserReading | null, b: BrowserReading | null): boolean {
  return a?.state === b?.state && a?.progress === b?.progress && a?.secondsLeft === b?.secondsLeft
}

/** Main's half: which tabs are reading, and the speed they all share. */
export class ReadingScroll {
  private readonly tabs = new Map<WebContents, BrowserReading>()
  private timer: NodeJS.Timeout | null = null
  private speedValue = 1
  /** Set this run, so the saved session's speed, read later, is older news. */
  private speedSet = false

  /** `current` is the tab on screen, the only one that can be reading rather than paused. */
  constructor(private readonly changed: () => void, private readonly current: () => WebContents | null) {}

  get speed(): number {
    return this.speedValue
  }

  of(contents: WebContents | null | undefined): BrowserReading | null {
    return (contents && this.tabs.get(contents)) ?? null
  }

  /** Start reading from where the page is, or stop it if it is reading. */
  async flip(contents: WebContents): Promise<void> {
    if (this.tabs.has(contents)) await this.stop(contents)
    else await this.start(contents)
  }

  async start(contents: WebContents): Promise<void> {
    this.record(contents, await this.call(contents, `start(${this.speedValue})`))
  }

  /** The play button: pause when reading, carry on when paused, read from the top at the end. */
  async toggle(contents: WebContents): Promise<void> {
    const reading = this.tabs.get(contents)
    if (!reading) return this.start(contents)
    this.record(contents, await this.call(contents, reading.state === 'running' ? 'pause()' : 'play()'))
  }

  async pause(contents: WebContents | null | undefined): Promise<void> {
    if (!contents || this.tabs.get(contents)?.state !== 'running') return
    this.record(contents, await this.call(contents, 'pause()'))
  }

  async stop(contents: WebContents): Promise<void> {
    if (!this.tabs.has(contents)) return
    await this.call(contents, 'stop()')
    this.record(contents, null)
  }

  /** One speed for every tab, kept for next time. The UI sends it, from the browser or the file panel. */
  setSpeed(speed: number): void {
    const next = clampSpeed(speed)
    this.speedSet = true
    if (next === this.speedValue) return
    this.speedValue = next
    for (const contents of this.tabs.keys()) void this.call(contents, `speed(${next})`).then((reading) => this.record(contents, reading))
    this.changed()
  }

  /** Restore the speed saved with the session, without telling anyone. */
  restoreSpeed(speed: unknown): void {
    if (typeof speed === 'number' && !this.speedSet) this.speedValue = clampSpeed(speed)
  }

  /** The page went away (navigation, crash, close), and its reading with it. */
  forget(contents: WebContents): void {
    if (!this.tabs.has(contents)) return
    this.record(contents, null)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.tabs.clear()
  }

  private async call(contents: WebContents, expression: string): Promise<BrowserReading | null> {
    if (contents.isDestroyed()) return null
    try {
      const code = `${READER_LIB};globalThis.__rocketReader.${expression}`
      return readingOf(await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]))
    } catch {
      // A page between documents, or gone: it is not reading.
      return null
    }
  }

  private record(contents: WebContents, reading: BrowserReading | null): void {
    const before = this.tabs.get(contents) ?? null
    if (reading) this.tabs.set(contents, reading)
    else this.tabs.delete(contents)
    if (this.tabs.size && !this.timer) this.timer = setInterval(() => void this.poll(), 250)
    if (!this.tabs.size && this.timer) { clearInterval(this.timer); this.timer = null }
    if (!same(before, reading)) this.changed()
  }

  // The page changes its own state (Space, a click, the end of the page), so the tab on screen is
  // asked how it is doing while it reads. Paused tabs elsewhere cannot change.
  private async poll(): Promise<void> {
    const contents = this.current()
    if (!contents || !this.tabs.has(contents)) return
    this.record(contents, await this.call(contents, 'status()'))
  }
}
