import type { NotificationOutcome, OrchestratorNotification, OrchestratorNotificationTarget } from '../shared/types.ts'

export interface NotificationWindow {
  webContents: { send: (channel: string, target: OrchestratorNotificationTarget) => void }
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  isFocused(): boolean
  restore(): void
  show(): void
  focus(): void
}
export interface NativeNotice {
  on(event: 'click' | 'failed' | 'close', listener: (...args: unknown[]) => void): unknown
  removeAllListeners(): unknown
  show(): void
  close(): void
}

type Options = {
  window: () => NotificationWindow | null
  supported: () => boolean
  create: (notice: OrchestratorNotification) => NativeNotice
  diagnostic: (message: string) => void
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}
export function validateNotice(value: unknown): OrchestratorNotification {
  const notice = record(value)
  const target = record(notice.target)
  if (!bounded(notice.key, 256) || !bounded(notice.title, 256) || !bounded(notice.body, 2000)
    || !bounded(target.runId, 256) || !bounded(target.chatId, 256)
    || (target.kind !== 'run' && target.kind !== 'worker')
    || (target.kind === 'worker' && (!bounded(target.workerChatId, 256) || !bounded(target.taskId, 256)))) {
    throw new Error('Give a valid orchestration notification and destination.')
  }
  // Copy only protocol fields; caller objects never become native options.
  return { key: notice.key, title: notice.title, body: notice.body, target: target.kind === 'run'
    ? { kind: 'run', runId: target.runId, chatId: target.chatId }
    : { kind: 'worker', runId: target.runId, chatId: target.chatId, workerChatId: target.workerChatId as string, taskId: target.taskId as string } }
}

/** Main owns native references and focus. No chat data or provider work crosses this boundary. */
export class OrchestratorNotifications {
  private readonly keys = new Set<string>()
  private readonly active = new Set<NativeNotice>()
  private disposed = false
  constructor(private readonly options: Options) {}

  show(sender: unknown, payload: unknown): NotificationOutcome {
    const window = this.options.window()
    if (!window || sender !== window.webContents) throw new Error("Notifications are only available from Craft Studio's window.")
    const notice = validateNotice(payload)
    if (this.disposed || window.isDestroyed() || this.keys.has(notice.key)) return 'suppressed'
    // Foreground transitions are consumed too, so replay cannot alert after losing focus.
    this.keys.add(notice.key)
    if (window.isVisible() && !window.isMinimized() && window.isFocused()) return 'suppressed'
    let native: NativeNotice | undefined
    let failed = false
    let settled = false
    const release = () => {
      if (!native) return
      this.active.delete(native)
      native.removeAllListeners()
    }
    try {
      if (!this.options.supported()) return 'unsupported'
      native = this.options.create(notice)
      this.active.add(native)
      native.on('click', () => {
        const current = this.options.window()
        if (!current || current.isDestroyed()) return
        if (current.isMinimized()) current.restore()
        current.show()
        current.focus()
        current.webContents.send('rocket:orchestrator-notification-activate', notice.target)
      })
      native.on('failed', (...args) => {
        failed = true
        if (settled) this.options.diagnostic(`Native orchestration notification failed: ${args.map(String).join(' ')}`)
        release()
      })
      native.on('close', release)
      native.show()
      settled = true
      return failed ? 'failed' : 'shown'
    } catch (error) {
      release()
      this.options.diagnostic(`Native orchestration notification failed: ${String(error)}`)
      return 'failed'
    }
  }

  dispose(): void {
    this.disposed = true
    for (const native of this.active) {
      native.removeAllListeners()
      try { native.close() } catch { /* Shutdown must still release the remaining notices. */ }
    }
    this.active.clear()
    this.keys.clear()
  }
}
