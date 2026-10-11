import { app, BrowserWindow, desktopCapturer, screen, type Display, type NativeImage } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CaptureRequest, CaptureResult, CaptureSource } from '../shared/types.ts'
import type { BrowserPane } from './browser-pane.ts'
import { captureName, selectionToPixels, type Rect } from './capture-geometry.ts'

// Screen capture for the composer's camera (docs/mockups/screen-capture.html). Windows and
// screens come from desktopCapturer, which on X11 lists every window and screen and returns a
// window at its own size when the thumbnail asked for is at least that big (checked on this
// machine, Electron 44, 2026-10-06). Craft Studio finds itself in that list by getMediaSourceId(), so a
// capture of Craft Studio includes the native browser view, which webContents.capturePage would miss.
// With PipeWire (Wayland) desktopCapturer returns one source the user picks in the system dialog
// (desktopCapturer docs), so the picker then shows just that one.
//
// A region is chosen over a frozen picture of the screen in a window of its own, with Craft Studio out
// of the way, so it can cover other apps. The page in that window has no Node access and reports
// back through its title, the one channel it needs.

const PICKER_THUMB = { width: 400, height: 250 }
const REGION_PREFIX = 'rocket-region:'

export class ScreenCapture {
  /** What each id the picker last showed was, so a screen can be found by its display. */
  private listed = new Map<string, { kind: 'window' | 'screen'; display: string; name: string }>()

  constructor(private readonly window: BrowserWindow, private readonly browser: () => BrowserPane | null) {}

  async sources(): Promise<CaptureSource[]> {
    const own = this.window.getMediaSourceId()
    const found = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: PICKER_THUMB, fetchWindowIcons: true })
    const screens = found.filter((source) => source.id.startsWith('screen:'))
    this.listed = new Map(found.map((source) => [source.id, { kind: source.id.startsWith('screen:') ? 'screen' : 'window', display: source.display_id, name: source.name }]))
    return found
      .filter((source) => !source.thumbnail.isEmpty())
      .map((source) => {
        const kind = source.id.startsWith('screen:') ? 'screen' as const : 'window' as const
        const name = kind === 'screen' ? (screens.length > 1 ? `Screen ${screens.indexOf(source) + 1}` : 'Entire screen') : source.name
        return { id: source.id, kind, name, thumbnail: source.thumbnail.toDataURL(), icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null, own: source.id === own }
      })
      .sort((a, b) => (a.kind === b.kind ? Number(b.own) - Number(a.own) : a.kind === 'screen' ? -1 : 1))
  }

  async take(request: CaptureRequest): Promise<CaptureResult | null> {
    const at = new Date()
    switch (request.kind) {
      case 'page': {
        const tab = this.browser()?.agentActive()
        if (!tab) throw new Error('There is no browser page to capture. Open the browser and a page first.')
        const image = await tab.contents.capturePage()
        if (image.isEmpty()) throw new Error('The browser page has nothing drawn yet. Show the browser, let the page load, and try again.')
        let host = tab.contents.getTitle() || 'Browser page'
        try { host = new URL(tab.contents.getURL()).host || host } catch { /* keep the title */ }
        return result(image, tab.contents.getURL() || host, captureName(host, at))
      }
      case 'rocket': {
        const image = await this.full(this.window.getMediaSourceId()).catch(() => null)
        // Without Craft Studio in desktopCapturer's list (Wayland), the renderer alone is still useful.
        return result(image ?? await this.window.webContents.capturePage(), 'Craft Studio', captureName('Craft Studio', at))
      }
      case 'source': {
        // A screen is found again by its display, which outlives the id desktopCapturer gave it.
        const listed = this.listed.get(request.id)
        if (listed?.kind === 'screen' || request.id.startsWith('screen:')) {
          const display = screen.getAllDisplays().find((each) => String(each.id) === listed?.display) ?? this.pointerDisplay()
          return result(await this.screenImage(display), `Screen ${display.size.width} × ${display.size.height}`, captureName('Screen', at))
        }
        const image = await this.full(request.id)
        return result(image, listed?.name ?? 'Window', captureName(listed?.name ?? 'Window', at))
      }
      case 'screen': {
        const display = this.pointerDisplay()
        return result(await this.screenImage(display), `Screen ${display.size.width} × ${display.size.height}`, captureName('Screen', at))
      }
      case 'region':
        return this.region(at)
    }
  }

  /** A window or screen at its own resolution. */
  private async full(id: string): Promise<NativeImage> {
    const largest = screen.getAllDisplays().reduce((size, display) => ({
      width: Math.max(size.width, Math.round(display.size.width * display.scaleFactor)),
      height: Math.max(size.height, Math.round(display.size.height * display.scaleFactor))
    }), { width: 1, height: 1 })
    const source = (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: largest })).find((each) => each.id === id)
    if (!source) throw new Error('That window has closed. Open the capture menu again and pick another.')
    if (source.thumbnail.isEmpty()) throw new Error(`${source.name} has nothing to capture; it may be minimized. Restore it and try again.`)
    return source.thumbnail
  }

  private pointerDisplay(): Display {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  }

  private async screenImage(display: Display): Promise<NativeImage> {
    const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }
    const screens = (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })).filter((each) => !each.thumbnail.isEmpty())
    const source = screens.find((each) => each.display_id === String(display.id)) ?? (screens.length === 1 ? screens[0] : undefined)
    if (!source) throw new Error('This screen could not be captured. Try Another app\'s window instead.')
    return source.thumbnail
  }

  /** Craft Studio steps aside, the screen under the pointer is frozen, and the user drags a box over it. */
  private async region(at: Date): Promise<CaptureResult | null> {
    const display = this.pointerDisplay()
    const wasFocused = this.window.isFocused()
    this.window.hide()
    const folder = join(app.getPath('userData'), 'capture-tmp')
    try {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const image = await this.screenImage(display)
      await mkdir(folder, { recursive: true })
      const picture = join(folder, 'screen.png')
      await writeFile(picture, image.toPNG())
      await writeFile(join(folder, 'region.html'), regionPage(pathToFileURL(picture).href, image.getSize()))
      const selection = await this.chooseRegion(display, join(folder, 'region.html'))
      if (!selection) return null
      const crop = selectionToPixels(selection, display.bounds, image.getSize())
      return result(image.crop(crop), `Region of the screen`, captureName('Region', at))
    } finally {
      await rm(folder, { recursive: true, force: true })
      if (!this.window.isDestroyed()) {
        this.window.show()
        if (wasFocused) this.window.focus()
      }
    }
  }

  private chooseRegion(display: Display, page: string): Promise<Rect | null> {
    return new Promise((resolve) => {
      const { x, y, width, height } = display.bounds
      const overlay = new BrowserWindow({
        x, y, width, height, frame: false, resizable: false, movable: false, fullscreen: true, alwaysOnTop: true,
        skipTaskbar: true, backgroundColor: '#000000', show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
      overlay.setAlwaysOnTop(true, 'screen-saver')
      let settled = false
      const finish = (rect: Rect | null): void => {
        if (settled) return
        settled = true
        resolve(rect)
        if (!overlay.isDestroyed()) overlay.destroy()
      }
      overlay.webContents.on('page-title-updated', (_event, title) => {
        if (!title.startsWith(REGION_PREFIX)) return
        const rest = title.slice(REGION_PREFIX.length)
        try { finish(rest === 'cancel' ? null : JSON.parse(rest) as Rect) } catch { finish(null) }
      })
      overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      overlay.webContents.on('will-navigate', (event) => event.preventDefault())
      overlay.on('closed', () => finish(null))
      overlay.once('ready-to-show', () => { overlay.show(); overlay.focus() })
      void overlay.loadFile(page)
    })
  }
}

function result(image: NativeImage, from: string, name: string): CaptureResult {
  if (image.isEmpty()) throw new Error('The capture came back empty. Try again, or pick another window.')
  const { width, height } = image.getSize()
  return { png: new Uint8Array(image.toPNG()), width, height, from, name }
}

/** The region chooser: the frozen screen, dimmed, with a box to drag. Sizes shown are image pixels. */
function regionPage(picture: string, size: { width: number; height: number }): string {
  return `<!doctype html><meta charset="utf-8"><title>Select a region</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%;overflow:hidden;cursor:crosshair;user-select:none;font:13px system-ui,sans-serif}
img{position:fixed;inset:0;width:100%;height:100%}
#dim{position:fixed;inset:0;background:#0000008c}
#sel{position:fixed;display:none;border:1.5px solid #fff;box-shadow:0 0 0 99999px #0000008c;outline:1px dashed #7170ff;outline-offset:2px}
#size{position:absolute;left:0;top:-24px;background:#111;color:#fff;border:1px solid #333;border-radius:5px;padding:1px 6px;font-size:11px;white-space:nowrap}
#hint{position:fixed;left:50%;top:16px;transform:translateX(-50%);background:#151617f2;color:#ddd;border:1px solid #38393c;border-radius:20px;padding:6px 14px;pointer-events:none}
kbd{background:#2a2b2e;color:#fff;border-radius:4px;padding:1px 5px;margin:0 2px;font:11px system-ui}
#tools{position:fixed;display:none;gap:6px;background:#151617;border:1px solid #38393c;border-radius:8px;padding:4px;box-shadow:0 8px 24px #0009;cursor:default}
#tools button{font:12px system-ui;color:#eee;background:transparent;border:0;padding:6px 11px;border-radius:5px;cursor:pointer}
#tools button:hover{background:#ffffff14}#tools .primary{background:#7170ff;color:#fff}
</style>
<img src="${picture}" alt=""><div id="dim"></div><div id="sel"><span id="size"></span></div>
<div id="hint">Drag to select <kbd>Enter</kbd> capture <kbd>Esc</kbd> cancel</div>
<div id="tools"><button id="cancel">Cancel</button><button id="redo">Redraw</button><button id="ok" class="primary">Capture ↵</button></div>
<script>
const scale = ${size.width} / innerWidth, sel = document.getElementById('sel'), tools = document.getElementById('tools'), dim = document.getElementById('dim')
let start = null, box = null
const send = value => { document.title = '${REGION_PREFIX}' + value }
const draw = b => { box = b; dim.style.display = 'none'; Object.assign(sel.style, { display: 'block', left: b.x + 'px', top: b.y + 'px', width: b.width + 'px', height: b.height + 'px' }); document.getElementById('size').textContent = Math.round(b.width * scale) + ' × ' + Math.round(b.height * scale) + ' px' }
const reset = () => { box = null; sel.style.display = 'none'; tools.style.display = 'none'; dim.style.display = 'block' }
const done = () => { if (box && box.width > 4 && box.height > 4) send(JSON.stringify(box)) }
addEventListener('mousedown', e => { if (e.target.closest('#tools')) return; start = { x: e.clientX, y: e.clientY }; tools.style.display = 'none' })
addEventListener('mousemove', e => { if (!start) return; draw({ x: Math.min(e.clientX, start.x), y: Math.min(e.clientY, start.y), width: Math.abs(e.clientX - start.x), height: Math.abs(e.clientY - start.y) }) })
addEventListener('mouseup', () => { if (!start) return; start = null; if (!box || box.width < 5 || box.height < 5) return reset()
  tools.style.display = 'flex'; const below = box.y + box.height + 48 < innerHeight
  tools.style.left = Math.max(8, Math.min(box.x + box.width - tools.offsetWidth, innerWidth - tools.offsetWidth - 8)) + 'px'
  tools.style.top = (below ? box.y + box.height + 8 : Math.max(8, box.y - 44)) + 'px' })
addEventListener('keydown', e => { if (e.key === 'Escape') send('cancel'); if (e.key === 'Enter') done() })
document.getElementById('cancel').onclick = () => send('cancel')
document.getElementById('redo').onclick = reset
document.getElementById('ok').onclick = done
</script>`
}
