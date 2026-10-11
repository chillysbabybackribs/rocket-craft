import type { BrowserReading } from '../../shared/types.ts'
import { READING_BASE } from '../../shared/reading.ts'

// Hands-free reading for a file in the panel beside the chat: a plan, any Markdown or text, a PDF's
// pages, a picture, a turn's diff. It behaves as the browser's does (src/main/reading-scroll.ts,
// which runs inside a web page and so cannot share this code): the reader's own wheel, scrollbar
// and scroll keys move the text and reading carries on from there a moment later; a click in the
// text pauses; at the foot it says it is done. Here the scrolling box is the panel's
// `.artifact-content`, and every listener sits on the panel, so a re-render of what is inside
// loses none of them.

type State = 'off' | 'running' | 'paused' | 'end'

export class PanelReading {
  private state: State = 'off'
  private speed = 1
  private carry = 0
  private last = 0
  private heldUntil = 0
  private dragging = false
  private endSince = 0
  private frame = 0
  private told = 0
  private readonly off: Array<() => void> = []

  constructor(private readonly panel: HTMLElement, private readonly changed: (reading: BrowserReading | null) => void) {
    const on = <K extends keyof HTMLElementEventMap>(type: K, listener: (event: HTMLElementEventMap[K]) => void, target: HTMLElement | Window = panel): void => {
      target.addEventListener(type, listener as EventListener, { passive: true })
      this.off.push(() => target.removeEventListener(type, listener as EventListener))
    }
    on('wheel', (event) => { if (this.inText(event.target)) this.hold(event.deltaY < 0) })
    on('pointerdown', (event) => {
      if (this.state === 'off' || event.button !== 0 || !this.inText(event.target)) return
      // A press on the box's own scrollbar is the reader scrolling, not clicking.
      const box = this.box()
      if (box && event.clientX >= box.getBoundingClientRect().left + box.clientLeft + box.clientWidth) {
        this.dragging = true
        this.hold(false)
        return
      }
      this.pause()
    })
    on('pointerup', () => {
      if (!this.dragging) return
      this.dragging = false
      this.hold(true)
    }, window)
    // The ring and the time left follow the reader's own scrolling too, while paused. Scroll
    // events do not bubble, so the panel catches its box's on the way down.
    panel.addEventListener('scroll', this.onScroll, { capture: true, passive: true })
    this.off.push(() => panel.removeEventListener('scroll', this.onScroll, { capture: true }))
  }

  get on(): boolean {
    return this.state !== 'off'
  }

  setSpeed(speed: number): void {
    this.speed = speed
    this.tell(true)
  }

  /** Start from where the text is, or stop. */
  flip(): void {
    if (this.state === 'off') this.start()
    else this.stop()
  }

  start(): void {
    if (this.state === 'end') this.box()?.scrollTo({ top: 0, behavior: 'instant' })
    this.run()
  }

  toggle(): void {
    if (this.state === 'running') this.pause()
    else if (this.state !== 'off') this.start()
  }

  pause(): void {
    if (this.state !== 'running') return
    this.state = 'paused'
    this.tell(true)
  }

  stop(): void {
    this.state = 'off'
    this.tell(true)
  }

  /** The reader's own scroll keys: move as usual, then read on from there. */
  scrollKey(key: string): void {
    if (['ArrowUp', 'PageUp', 'Home'].includes(key)) this.hold(true)
    else if (['ArrowDown', 'PageDown', 'End', ' '].includes(key)) this.hold(false)
  }

  dispose(): void {
    cancelAnimationFrame(this.frame)
    for (const off of this.off) off()
    this.state = 'off'
  }

  private readonly onScroll = (event: Event): void => {
    if (this.state !== 'off' && event.target === this.box()) this.tell(false)
  }

  private box(): HTMLElement | null {
    return this.panel.querySelector<HTMLElement>('.artifact-content')
  }

  private inText(target: EventTarget | null): boolean {
    const box = this.box()
    return Boolean(box && target instanceof Node && box.contains(target))
  }

  private run(): void {
    this.state = 'running'
    this.carry = 0
    this.last = 0
    this.endSince = 0
    if (!this.frame) this.frame = requestAnimationFrame(this.tick)
    this.tell(true)
  }

  private hold(up: boolean): void {
    if (this.state === 'off') return
    this.heldUntil = performance.now() + 450
    this.carry = 0
    if (this.state === 'end' && up) this.run()
  }

  private readonly tick = (now: number): void => {
    this.frame = 0
    if (this.state !== 'running') return
    this.frame = requestAnimationFrame(this.tick)
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0
    this.last = now
    const box = this.box()
    if (!box || this.dragging || now < this.heldUntil) { this.carry = 0; return }
    if (box.scrollTop >= box.scrollHeight - box.clientHeight - 1) {
      // A PDF's pages or a picture may still be arriving; give them a moment before calling it done.
      if (!this.endSince) this.endSince = now
      else if (now - this.endSince > 1500) { this.state = 'end'; this.tell(true) }
      return
    }
    this.endSince = 0
    // Scroll positions move in whole pixels, so the slow speeds keep the remainder for next frame.
    this.carry += READING_BASE * this.speed * dt
    const step = Math.floor(this.carry)
    if (step) {
      this.carry -= step
      box.scrollBy({ top: step, behavior: 'instant' })
    }
    this.tell(false)
  }

  /** Tell the control, at once when the state changed, otherwise a few times a second. */
  private tell(now: boolean): void {
    if (this.state === 'off') {
      this.changed(null)
      return
    }
    const at = performance.now()
    if (!now && at - this.told < 250) return
    this.told = at
    const box = this.box()
    const room = box ? Math.max(0, box.scrollHeight - box.clientHeight) : 0
    const top = box?.scrollTop ?? 0
    this.changed({
      state: this.state,
      progress: room ? Math.round(Math.min(1, top / room) * 1000) / 1000 : 1,
      secondsLeft: Math.round(Math.max(0, room - top) / (READING_BASE * this.speed))
    })
  }
}
