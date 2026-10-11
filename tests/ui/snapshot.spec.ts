import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { UiSnapshot } from '../../src/shared/types'
import { test, expect, section } from './app'
import { assertOverlay, nativeViews } from './safeguards'

test('the shared snapshot tool captures native views without changing the UI and falls back explicitly', async ({ rocket }, info) => {
  const { page, app, profile } = rocket
  await (await section(page, 'Browser')).click()
  const message = page.getByRole('textbox', { name: 'Message', exact: true })
  await message.fill('An unsent draft stays here')
  await message.focus()
  const browser = await rocket.surface('browser')
  await expect(browser.getByRole('heading', { name: 'Craft Studio browser check' })).toBeVisible()
  const before = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { bounds: window.getBounds(), focus: window.webContents.focusedFrame?.url }
  })
  const state = JSON.parse(await readFile(join(profile, 'tool-channel.json'), 'utf8')) as { port: number; secret: string }
  const url = `http://127.0.0.1:${state.port}/mcp/${state.secret}/codex/snapshot-check`
  const call = async (method: string, params: unknown) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    expect(response.ok).toBe(true)
    return await response.json()
  }
  const listed = await call('tools/list', {})
  expect(listed.result.tools.some((tool: { name: string }) => tool.name === 'studio_ui_snapshot')).toBe(true)
  const snapshot = async () => {
    const response = await call('tools/call', { name: 'studio_ui_snapshot', arguments: {} })
    expect(response.result.isError).toBeUndefined()
    const content = response.result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>
    const metadata = JSON.parse(content[0].text!) as Omit<UiSnapshot, 'images'> & { images: Array<{ label: string; path: string }> }
    expect(content.some(block => block.type === 'image' && block.mimeType === 'image/jpeg' && block.data!.length > 100)).toBe(true)
    expect(content[0].text).not.toContain('base64')
    expect(metadata.shell.controls.some(control => control.name === 'Message')).toBe(true)
    expect(metadata.shell.panels.some(panel => panel.name === 'New chat')).toBe(true)
    expect(metadata.views.some(view => view.url.startsWith(rocket.origin))).toBe(true)
    expect(metadata.instance.mainBundleSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(await readFile(join(metadata.directory, 'snapshot.json'), 'utf8')).capture).toBe(metadata.capture)
    return metadata
  }
  const composed = await snapshot()
  expect(composed.capture).toBe('window')
  expect(composed.images).toHaveLength(1)
  await info.attach('Snapshot: composed window', { path: composed.images[0].path, contentType: 'image/png' })
  // A pixel near the bottom of the native browser view must contain the fixture's blue
  // background. A shell-only capture would show Craft Studio's dark background instead.
  const view = composed.views.find(view => view.url.startsWith(rocket.origin))!
  const pixel = await app.evaluate(({ nativeImage }, { path, bounds }) => {
    const image = nativeImage.createFromPath(path)
    const rgba = image.crop({ x: Math.round(bounds.x + 25), y: Math.round(bounds.y + bounds.height - 25), width: 1, height: 1 }).toBitmap()
    return [...rgba]
  }, { path: composed.images[0].path, bounds: view.bounds })
  // A visible X server's compositor may round a channel by one; the dark shell is far from it.
  const expected = [255, 243, 238]
  const drift = Math.max(...expected.map((value, index) => Math.abs(pixel[index]! - value)))
  expect(drift, `pixel ${pixel.slice(0, 3)} is the fixture's background ${expected}`).toBeLessThanOrEqual(2)
  const display = await app.evaluate(() => { const value = process.env.DISPLAY; delete process.env.DISPLAY; return value })
  try {
    const fallback = await snapshot()
    expect(fallback.capture).toBe('surfaces')
    expect(fallback.warnings.join(' ')).toContain('do not prove overlay stacking')
    expect(fallback.images.length).toBeGreaterThanOrEqual(2)
    expect(fallback.directory).not.toBe(composed.directory)
    for (const image of fallback.images) await info.attach(image.label, { path: image.path, contentType: 'image/png' })
  } finally {
    await app.evaluate((_electron, value) => { if (value === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = value }, display)
  }
  await expect(message).toHaveValue('An unsent draft stays here')
  await expect(message).toBeFocused()
  expect(await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { bounds: window.getBounds(), focus: window.webContents.focusedFrame?.url }
  })).toEqual(before)
  await page.getByRole('textbox', { name: 'Address', exact: true }).fill(new URL(rocket.origin).host)
  const suggestions = await rocket.surface('suggestions')
  await expect(suggestions.locator('body')).toContainText('UI page one')
  const nativeBrowser = (await nativeViews(app)).find(view => view.url.startsWith(rocket.origin))!
  await assertOverlay(app, nativeBrowser)
  const overlay = await snapshot()
  const dropdown = overlay.views.find(view => view.url.endsWith('/suggest.html'))!
  expect(dropdown).toBeDefined()
  expect(dropdown.z).toBeGreaterThan(overlay.views.find(view => view.url.startsWith(rocket.origin))!.z)
  expect(overlay.capture).toBe('window')
  await expect(page.getByRole('textbox', { name: 'Address', exact: true })).toBeFocused()
  await expect(suggestions.locator('body')).toContainText('UI page one')
  await info.attach('Snapshot: native dropdown overlay', { path: overlay.images[0].path, contentType: 'image/png' })
})
