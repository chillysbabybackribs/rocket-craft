// Messages between main's dock (`craft-dock.ts`) and the X11 helper (`x11-helper.ts`), which runs in
// a process of its own. Requests carry an id and get one reply; events arrive on their own.

/** A rectangle in X pixels, relative to Electron's window. */
export type DeviceRect = { x: number; y: number; width: number; height: number }

export type HelperRequest = { id: number } & (
  /** Electron's window XID; watch the root for new top-levels and Electron for focus changes. */
  | { op: 'init'; electron: number }
  /**
   * A launch's process has started: catch its first real top-level the moment it is created. A
   * window belongs to the launch when its creator is `pid`, a process `pid` started, or any
   * process in the launch's systemd scope `unit` (an app may relaunch itself and exit).
   */
  | { op: 'expect'; launch: number; pid: number; unit: string | null }
  | { op: 'forget'; launch: number }
  /** Unredirect, fit at `rect`, raise; its shield follows. */
  | { op: 'show'; launch: number; rect: DeviceRect }
  /** Out of view, still mapped; redirected when a model may need its pixels. */
  | { op: 'park'; launch: number; rect: DeviceRect | null; redirect: boolean }
  | { op: 'redirect'; launch: number; on: boolean }
  /** A press on Electron's page: the keyboard goes back to Electron. */
  | { op: 'wantElectron' }
  | { op: 'state' }
)

export type HelperReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }

export type HelperEvent =
  | { event: 'captured'; launch: number; wid: number; how: 'early' | 'late'; ms: number; fresh: boolean }
  /** The app's window is gone (the app closed it or quit). */
  | { event: 'lost'; launch: number }
  | { event: 'log'; message: string }
  /** The helper cannot work at all (no X display). */
  | { event: 'fatal'; message: string }
