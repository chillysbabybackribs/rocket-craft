import { app, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import { readLiveEndpoint } from './live-port.ts'
import type { LiveUiConnection } from '../shared/types.ts'

// The lock-owning instance publishes its loopback port at startup. Main identifies its own surfaces by target id,
// so a model cannot accidentally drive a different app or a concealed tab with the same URL.
async function targetId(contents: WebContents): Promise<string> {
  const attached = contents.debugger.isAttached()
  if (!attached) contents.debugger.attach('1.3')
  try {
    const result = await contents.debugger.sendCommand('Target.getTargetInfo') as { targetInfo: { targetId: string } }
    return result.targetInfo.targetId
  } finally { if (!attached) contents.debugger.detach() }
}

export async function liveUiConnection(window: BrowserWindow): Promise<LiveUiConnection> {
  const endpoint = await readLiveEndpoint(app.getPath('userData'), process.pid)
  const surfaces: LiveUiConnection['surfaces'] = { shell: await targetId(window.webContents) }
  for (const view of window.contentView.children) {
    if (!(view instanceof WebContentsView) || !view.getVisible()) continue
    const kind = view.webContents.getURL().endsWith('/suggest.html') ? 'suggestions' : 'browser'
    surfaces[kind] = await targetId(view.webContents)
  }
  return { endpoint, pid: process.pid, surfaces }
}
