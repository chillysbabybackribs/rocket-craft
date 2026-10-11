import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test, expect } from './app'

// The real app manager behind the dock: install PhotoCraft from its GitHub release through the
// shelf, show it from the dock, and check that its native window is docked exactly over the app
// region. It downloads about 80 MB into a scratch apps folder, so it runs only when asked:
//
//   CRAFT_UI_REAL_APPS=1 CRAFT_NO_SANDBOX=1 npm run check:ui -- tests/ui/craft-real.spec.ts

const run = promisify(execFile)
// A path only: the installer makes it, and the worker that ran the test deletes it.
const apps = join(tmpdir(), `craft-ui-apps-${process.pid}`)
test.use({ rocketEnv: { CRAFT_APPS_DIR: apps } })
test.skip(process.env.CRAFT_UI_REAL_APPS !== '1', 'Downloads a real app; set CRAFT_UI_REAL_APPS=1 to run it.')
test.afterAll(async () => { await rm(apps, { recursive: true, force: true }) })

type Geometry = { x: number; y: number; width: number; height: number }

/** Every X window under Electron's, with its position relative to Electron's window. */
async function childWindows(xid: number): Promise<Array<Geometry & { id: string; name: string }>> {
  const { stdout } = await run('xwininfo', ['-tree', '-id', String(xid)])
  const rows: Array<Geometry & { id: string; name: string }> = []
  for (const line of stdout.split('\n')) {
    const match = /^\s+(0x[0-9a-f]+) (.*?):?\s+\(.*?\)\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/.exec(line) ?? /^\s+(0x[0-9a-f]+) (.*?)\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/.exec(line)
    if (match) rows.push({ id: match[1]!, name: match[2]!, width: Number(match[3]), height: Number(match[4]), x: Number(match[5]), y: Number(match[6]) })
  }
  return rows
}

test('a real PhotoCraft installs from the shelf and docks exactly over the app region', async ({ rocket }) => {
  test.setTimeout(300_000)
  const { app, page } = rocket
  const shelf = page.getByRole('region', { name: 'Apps shelf' })
  const dock = page.getByRole('navigation', { name: 'Apps dock' })

  await test.step('Install PhotoCraft from the shelf; the dock gets its icon', async () => {
    await expect(shelf.getByRole('article', { name: 'PhotoCraft' })).toBeVisible()
    await shelf.getByRole('button', { name: 'Install PhotoCraft' }).click()
    await expect(shelf.getByRole('progressbar', { name: 'Installing PhotoCraft' })).toBeVisible({ timeout: 30_000 })
    await rocket.capture('real-installing')
    await expect(dock.getByRole('button', { name: 'PhotoCraft', exact: true })).toBeVisible({ timeout: 240_000 })
    await expect(shelf.getByRole('button', { name: 'Open PhotoCraft' })).toBeVisible()
  })

  await test.step('Show it from the dock: the region replaces the shelf and the app window covers it', async () => {
    await dock.getByRole('button', { name: 'PhotoCraft', exact: true }).click()
    await expect(shelf).toHaveCount(0)
    const region = page.getByTestId('craft-app-region')
    await expect(region).toBeVisible()
    await expect(page.locator('.craft-app')).toHaveAttribute('data-run', /shown|working/, { timeout: 60_000 })
    await page.waitForTimeout(2_500)
    const box = (await region.boundingBox())!
    const scale = await page.evaluate(() => devicePixelRatio)
    const xid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getNativeWindowHandle().readUInt32LE(0))
    const children = await childWindows(xid)
    console.log(JSON.stringify({ region: box, scale, children }, null, 2))
    // The docked window is the child placed nearest the region; it must sit on the region's edges.
    const expected = { x: Math.round(box.x * scale), y: Math.round(box.y * scale), width: Math.round(box.width * scale), height: Math.round(box.height * scale) }
    const docked = children.filter((child) => child.width > 100 && child.height > 100)
      .sort((a, b) => Math.abs(a.x - expected.x) + Math.abs(a.y - expected.y) - Math.abs(b.x - expected.x) - Math.abs(b.y - expected.y))[0]
    expect(docked, 'a docked app window under Electron\'s').toBeTruthy()
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(docked![key] - expected[key]), `${key}: ${docked![key]} vs ${expected[key]}`).toBeLessThanOrEqual(2)
    await rocket.capture('real-photocraft-shown')
  })

  await test.step('The browser takes the side and the app is parked; Remove stops and deletes it', async () => {
    await dock.getByRole('button', { name: 'Browser', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Browser', exact: true })).toBeVisible()
    await page.waitForTimeout(1_000)
    await rocket.capture('real-browser-over-parked-app')
    await dock.getByRole('button', { name: 'Add apps' }).click()
    await shelf.getByRole('button', { name: 'Remove PhotoCraft' }).click()
    // It is still running, parked, so the shelf asks first.
    await shelf.getByRole('button', { name: 'Remove PhotoCraft now' }).click()
    await expect(dock.locator('[data-app="photocraft"]')).toHaveCount(0, { timeout: 30_000 })
  })
})
