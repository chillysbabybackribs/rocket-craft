import { app, nativeImage, WebContentsView, type BrowserWindow, type NativeImage } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { UiSnapshot } from '../shared/types.ts'

// A renderer screenshot omits sibling native views. Capture the actual X11 window when
// possible, and otherwise return individually labelled surfaces rather than claim completeness.
const startedAt = new Date().toISOString()
const mainBundleSha256 = createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex')
const runFile = promisify(execFile)

// Read only rendered shell elements. Input values and the whole transcript are deliberately
// excluded: the image supplies visual context, while these names identify visible controls.
const SHELL = `(() => {
  const bounds = el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height} }
  const visible = el => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el)
    return el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && s.visibility !== 'hidden'
      && r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
  }
  const name = el => {
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim()
    return (el.getAttribute('aria-label') || labelled || el.labels?.[0]?.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || el.textContent || '').replace(/\\s+/g,' ').trim().slice(0,160)
  }
  const controls = [...document.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[role="tab"],[role="textbox"],[role="separator"]')].filter(visible)
  const panels = [...document.querySelectorAll('.pane,.artifact,.browser,.side-pane,.plan-drawer,[role="dialog"],[role="alertdialog"]')].filter(visible)
  return {
    panels: panels.map(el => ({name: name(el) || el.className, bounds: bounds(el)})),
    controls: controls.slice(0,100).map(el => ({role: el.getAttribute('role') || ({BUTTON:'button',A:'link',TEXTAREA:'textbox',INPUT:'input',SELECT:'combobox'}[el.tagName] || el.tagName.toLowerCase()),name:name(el),disabled:!!el.disabled || el.getAttribute('aria-disabled') === 'true',bounds:bounds(el),...(el.dataset.nav ? {nav: el.dataset.nav} : {})})),
    controlsTruncated: controls.length > 100
  }
})()`

export async function captureUiSnapshot(window: BrowserWindow): Promise<UiSnapshot> {
  if (window.isDestroyed()) throw new Error('Craft Studio’s window is closed. Open the app and try again.')
  const root = join(app.getPath('userData'), 'ui-snapshots')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, `${new Date().toISOString().replace(/[:.]/g, '-')}-`))
  const views = window.contentView.children.flatMap((view, z) => view instanceof WebContentsView && view.getVisible()
    ? [{ view, url: view.webContents.getURL(), bounds: view.getBounds(), z }] : [])
  const result: UiSnapshot = {
    capturedAt: new Date().toISOString(),
    instance: { pid: process.pid, startedAt, version: app.getVersion(), mainBundleSha256, rendererUrl: window.webContents.getURL() },
    window: { bounds: window.getBounds(), contentBounds: window.getContentBounds(), focused: window.isFocused(), minimized: window.isMinimized() },
    shell: await window.webContents.executeJavaScript(SHELL),
    views: views.map(({ view: _view, ...details }) => details),
    capture: 'surfaces', warnings: [], directory, images: []
  }
  const save = async (label: string, filename: string, image: NativeImage): Promise<void> => {
    if (image.isEmpty()) throw new Error(`${label} has no rendered image.`)
    const path = join(directory, filename)
    await writeFile(path, image.toPNG())
    // Keep the saved PNG at full resolution; bound only the image sent to the model.
    if (image.getSize().width > 1600) image = image.resize({ width: 1600, quality: 'good' })
    result.images.push({ label, path, mimeType: 'image/jpeg', base64: image.toJPEG(85).toString('base64') })
  }
  try {
    if (process.platform !== 'linux' || !process.env.DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') throw new Error('Whole-window capture requires an X11 display.')
    if (!window.isVisible() || window.isMinimized()) throw new Error('The window is hidden or minimized.')
    const id = window.getNativeWindowHandle().readUInt32LE(0)
    const path = join(directory, 'window.png')
    await runFile('import', ['-window', String(id), path], { timeout: 5_000 })
    await save('Craft Studio — composed window, including native views', 'window.png', nativeImage.createFromBuffer(await readFile(path)))
    result.capture = 'window'
  } catch (error) {
    result.warnings.push(`Whole-window capture unavailable: ${error instanceof Error ? error.message : String(error)} Separate surfaces do not prove overlay stacking or occlusion.`)
    await save('Craft Studio — app shell only; native views excluded', 'shell.png', await window.webContents.capturePage())
    for (const { view, url, z } of views) {
      try {
        await save(`Native view ${z}: ${url}`, `view-${z}.png`, await view.webContents.capturePage())
      } catch (error) {
        result.warnings.push(`Native view ${z} could not be captured: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  const { images, ...metadata } = result
  await writeFile(join(directory, 'snapshot.json'), JSON.stringify({ ...metadata, images: images.map(({ base64: _base64, ...image }) => image) }, null, 2))
  return result
}
