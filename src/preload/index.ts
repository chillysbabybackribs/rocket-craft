import { contextBridge, ipcRenderer } from 'electron'
import { homedir } from 'node:os'
import type { BrowserState, CraftBridge, CraftState, RocketBridge, SuggestionList, OrchestratorNotificationTarget } from '../shared/types.ts'
import { HOST_PORT_MESSAGE } from '../shared/types.ts'

// The renderer's only way out. Chat traffic does not go through here at all: main sends a
// MessagePort to the agent host, and this file forwards it into the page, which then talks to
// the host directly.

ipcRenderer.on(HOST_PORT_MESSAGE, (event) => {
  window.postMessage({ type: HOST_PORT_MESSAGE }, '*', event.ports)
})

function listen<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: unknown, value: T): void => listener(value)
  ipcRenderer.on(channel, handler)
  return () => { ipcRenderer.removeListener(channel, handler) }
}

const bridge: RocketBridge = {
  requestHostPort: () => ipcRenderer.send('rocket:request-host-port'),
  notifications: {
    show: notice => ipcRenderer.invoke('rocket:orchestrator-notification', notice),
    onActivate: listener => listen<OrchestratorNotificationTarget>('rocket:orchestrator-notification-activate', listener)
  },
  window: {
    minimize: () => ipcRenderer.send('rocket:window', 'minimize'),
    toggleMaximize: () => ipcRenderer.send('rocket:window', 'toggleMaximize'),
    close: () => ipcRenderer.send('rocket:window', 'close')
  },
  pickFolder: (current) => ipcRenderer.invoke('rocket:pick-folder', current),
  capture: {
    sources: () => ipcRenderer.invoke('rocket:capture-sources'),
    take: (request) => ipcRenderer.invoke('rocket:capture', request)
  },
  saveAttachmentAs: (name) => ipcRenderer.invoke('rocket:save-attachment-as', name),
  revealAttachment: (path) => ipcRenderer.invoke('rocket:reveal-attachment', path),
  openChatLink: (href, cwd) => ipcRenderer.invoke('rocket:chat-link', href, cwd),
  onOpen: (listener) => listen<{ href: string; cwd: string }>('rocket:open', listener),
  homeDir: homedir(),
  browser: {
    send: (command) => ipcRenderer.send('rocket:browser', command),
    onState: (listener) => listen<BrowserState>('rocket:browser-state', listener),
    onSuggestions: (listener) => listen<SuggestionList>('rocket:browser-suggestions', listener),
    onFocusAddress: (listener) => listen<void>('rocket:browser-focus-address', listener)
  }
}

contextBridge.exposeInMainWorld('rocket', bridge)

// The Craft apps (main's craft-studio.ts). A new listener first gets every app's current state, so
// the dock and the shelf never wait for the next change to draw.
const craft: CraftBridge = {
  catalog: () => ipcRenderer.invoke('craft:catalog'),
  install: (id) => ipcRenderer.invoke('craft:install', id),
  remove: (id) => ipcRenderer.invoke('craft:remove', id),
  show: (id, bounds, folder) => ipcRenderer.invoke('craft:show', id, bounds, folder ?? null),
  setBounds: (bounds) => ipcRenderer.invoke('craft:set-bounds', bounds),
  hide: () => ipcRenderer.invoke('craft:hide'),
  onState: (listener) => {
    const stop = listen<CraftState>('craft:state', listener)
    void ipcRenderer.invoke('craft:states').then((states: CraftState[]) => { for (const state of states) listener(state) }, () => {})
    return stop
  }
}

contextBridge.exposeInMainWorld('craft', craft)

// A press anywhere on the page takes the keyboard back from a docked app (the focus guard in
// craft-dock/x11-helper.ts). Capture phase, so nothing on the page can stop it first.
window.addEventListener('pointerdown', () => ipcRenderer.send('craft:pointerdown'), true)
