// The parts of the `x11` package (node-x11 4.3.1, pure JavaScript, no dependencies) that the
// dock's X11 helper uses. The package ships no types; requests take a trailing Node-style
// callback, and a request without one reports failure as an `error` event on the client.
declare module 'x11' {
  export type XCallback<T> = (error: XError | null | undefined, value: T) => unknown
  export type XError = Error & { error?: number; badParam?: number; seq?: number }
  export type XEvent = {
    type: number
    name: string
    seq?: number
    wid: number
    parent?: number
    event?: number
    width?: number
    height?: number
    x?: number
    y?: number
    overrideRedirect?: boolean | number
    keycode?: number
    detail?: number
    mode?: number
    time?: number
    rawData?: Buffer
  }
  export type XClient = {
    AllocID(): number
    CreateWindow(id: number, parent: number, x: number, y: number, width: number, height: number, borderWidth: number, depth: number, klass: number, visual: number, values: Record<string, number>, callback?: XCallback<void>): void
    ChangeWindowAttributes(wid: number, values: Record<string, number>, callback?: XCallback<void>): void
    GetWindowAttributes(wid: number, callback: XCallback<{ mapState: number; overrideRedirect: number; klass: number }>): void
    GetGeometry(wid: number, callback: XCallback<{ xPos: number; yPos: number; width: number; height: number }>): void
    DestroyWindow(wid: number, callback?: XCallback<void>): void
    ReparentWindow(wid: number, parent: number, x: number, y: number, callback?: XCallback<void>): void
    MapWindow(wid: number, callback?: XCallback<void>): void
    UnmapWindow(wid: number, callback?: XCallback<void>): void
    ConfigureWindow(wid: number, values: Record<string, number>, callback?: XCallback<void>): void
    QueryTree(wid: number, callback: XCallback<{ root: number; parent: number; children: number[] }>): void
    InternAtom(onlyIfExists: boolean, name: string, callback: XCallback<number>): void
    GetProperty(del: number, wid: number, name: number, type: number, offset: number, length: number, callback: XCallback<{ type: number; format: number; data: Buffer }>): void
    SendEvent(destination: number, propagate: boolean | number, eventMask: number, event: Buffer, callback?: XCallback<void>): void
    GrabButton(wid: number, ownerEvents: boolean | number, mask: number, pointerMode: number, keyboardMode: number, confineTo: number, cursor: number, button: number, modifiers: number, callback?: XCallback<void>): void
    AllowEvents(mode: number, time: number, callback?: XCallback<void>): void
    GrabServer(callback?: XCallback<void>): void
    UngrabServer(callback?: XCallback<void>): void
    SetInputFocus(wid: number, revertTo: number, callback?: XCallback<void>): void
    GetInputFocus(callback: XCallback<{ focus: number; revertTo: number }>): void
    require(name: string, callback: XCallback<XExtension>): void
    sync(): Promise<void>
    terminate?(): void
    close?(callback?: () => void): void
    on(event: 'event', listener: (event: XEvent) => void): void
    on(event: 'error', listener: (error: XError) => void): void
    on(event: 'end' | 'close', listener: () => void): void
  }
  export type XExtension = {
    present?: boolean
    RedirectWindow(window: number, updateType: number): void
    UnredirectWindow(window: number, updateType: number): void
    QueryClientIds(specs: Array<{ client: number; mask: number }>, callback: XCallback<Array<{ client: number; mask: number; value: number[] }>>): void
    Redirect?: { Automatic: number; Manual: number }
    ClientIdMask?: { ClientXID: number; LocalClientPID: number }
  }
  export type XDisplay = { client: XClient; screen: Array<{ root: number }> }
  export function createClient(options: { display?: string }, callback: (error: XError | null | undefined, display: XDisplay) => void): XClient
  const x11: { createClient: typeof createClient }
  export default x11
}
