import { test, expect, sideNav } from './app'
import { craftCalls, craftControl, useFakeCraft, type FakeCall } from './craft-fake'

// The right side and its section header (docs/mockups/craft-studio.html), against a fake app
// manager: a first run opens on the shelf; an install's progress is on the card; showing an app
// reports its region's bounds to main; Browser and Library hide the app; Remove uninstalls it;
// and the app map shows installed apps but has no way to install one.

type Bounds = { x: number; y: number; width: number; height: number }

function last(calls: FakeCall[], method: string): FakeCall | undefined {
  return calls.filter((call) => call.method === method).at(-1)
}

test('the right side shows apps from the shelf, hands bounds to main, and switches with the header', async ({ rocket }) => {
  const { app, page } = rocket
  await useFakeCraft(app, page)
  const nav = sideNav(page)
  const shelf = page.getByRole('region', { name: 'Apps shelf' })

  await test.step('A first run shows the shelf and the Apps header control is on', async () => {
    await expect(shelf).toBeVisible()
    await expect(shelf.locator('.shelf-card')).toHaveCount(12)
    await expect(shelf.getByRole('article', { name: 'PhotoCraft' })).toContainText('Like Photoshop')
    await expect(shelf.getByRole('article', { name: 'PhotoCraft' })).toContainText('72 MB')
    await expect(shelf).toContainText('Nothing installed yet')
    await expect(nav.getByRole('button', { name: 'Apps', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(nav.getByRole('button', { name: 'Browser', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('.titlebar [data-section="chats"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Sections', exact: true })).toHaveCount(0)
    await rocket.capture('first-run-shelf')
  })

  await test.step('An install shows its progress on the card, then Open is available', async () => {
    await shelf.getByRole('button', { name: 'Install PhotoCraft' }).click()
    expect(last(await craftCalls(page), 'install')?.args).toEqual(['photocraft'])
    await craftControl(page, 'progress', 'photocraft', 0.62)
    await expect(shelf.getByRole('progressbar', { name: 'Installing PhotoCraft' })).toHaveAttribute('aria-valuenow', '62')
    await rocket.capture('installing')
    await craftControl(page, 'finish', 'photocraft')
    await expect(shelf.getByRole('button', { name: 'Open PhotoCraft' })).toBeVisible()
    await expect(shelf.getByRole('article', { name: 'PhotoCraft' }).locator('.shelf-chip')).toHaveCount(0)
    for (const [id, name] of [['gridcraft', 'GridCraft'], ['deckcraft', 'DeckCraft']] as const) {
      await shelf.getByRole('button', { name: `Install ${name}` }).click()
      await craftControl(page, 'finish', id)
      await expect(shelf.getByRole('button', { name: `Open ${name}` })).toBeVisible()
    }
    await expect(shelf).toContainText('159 MB on disk')
    await expect(shelf.getByRole('button', { name: 'Installed 3' })).toBeVisible()
  })

  await test.step('A failed install says why in a full sentence, with Retry', async () => {
    await shelf.getByRole('button', { name: 'Install FilmCraft' }).click()
    await craftControl(page, 'fail', 'filmcraft', 'FilmCraft could not be downloaded because the connection dropped. Check your connection and press Retry.')
    const card = shelf.getByRole('article', { name: 'FilmCraft' })
    await expect(card.getByRole('alert')).toHaveText('FilmCraft could not be downloaded because the connection dropped. Check your connection and press Retry.')
    await expect(card.getByRole('button', { name: 'Retry installing FilmCraft' })).toBeVisible()
  })

  let shownBounds!: Bounds
  await test.step('Showing an app puts its region on the right side and tells main where it is', async () => {
    await shelf.getByRole('button', { name: 'Open PhotoCraft' }).click()
    const region = page.getByTestId('craft-app-region')
    await expect(region).toBeVisible()
    await expect(page.getByRole('region', { name: 'PhotoCraft' })).toContainText('Starting PhotoCraft…')
    await expect.poll(async () => last(await craftCalls(page), 'show')?.args[0]).toBe('photocraft')
    shownBounds = last(await craftCalls(page), 'show')!.args[1] as Bounds
    const box = (await region.boundingBox())!
    const chat = (await page.locator('.orch-chat').boundingBox())!
    const right = (await page.locator('.craft-right').boundingBox())!
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    expect(Math.abs(shownBounds.x - box.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(shownBounds.y - box.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(shownBounds.width - box.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(shownBounds.height - box.height)).toBeLessThanOrEqual(1)
    expect(shownBounds.x).toBeGreaterThan(chat.x + chat.width)
    expect(shownBounds.y).toBeGreaterThanOrEqual(48)
    expect(shownBounds.y + shownBounds.height).toBeLessThanOrEqual(right.y + right.height)
    expect(shownBounds.x + shownBounds.width).toBeLessThanOrEqual(viewport.width)
    expect(shownBounds.width).toBeGreaterThan(400)
    expect(shownBounds.height).toBeGreaterThan(400)
    await craftControl(page, 'run', 'photocraft', 'shown')
    await expect(page.getByRole('region', { name: 'PhotoCraft' })).not.toContainText('Starting')
    await expect(nav.getByRole('button', { name: 'PhotoCraft', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(nav.getByRole('button', { name: 'Apps', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await craftControl(page, 'run', 'gridcraft', 'resting')
    await rocket.capture('app-shown')
  })

  await test.step('A window resize moves the app with its region', async () => {
    const before = (await craftCalls(page)).length
    await app.evaluate(({ BrowserWindow }) => { const [window] = BrowserWindow.getAllWindows(); window!.setSize(1300, 860) })
    await expect.poll(async () => (await craftCalls(page)).slice(before).some((call) => call.method === 'setBounds')).toBe(true)
    const region = (await page.getByTestId('craft-app-region').boundingBox())!
    const latest = last(await craftCalls(page), 'setBounds')!.args[0] as Bounds
    expect(Math.abs(latest.width - region.width)).toBeLessThanOrEqual(1)
    expect(latest.width).not.toBe(shownBounds.width)
  })

  await test.step('The browser takes the right side from the app, which is hidden, not closed', async () => {
    const before = (await craftCalls(page)).length
    await nav.getByRole('button', { name: 'Browser', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Browser' })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Browser', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(nav.getByRole('button', { name: 'PhotoCraft', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => (await craftCalls(page)).slice(before).map((call) => call.method)).toContain('hide')
    expect((await craftCalls(page)).slice(before).map((call) => call.method)).not.toContain('remove')
    await rocket.capture('browser-via-header')
  })

  await test.step('Toggling the browser off goes back to the app; the library hides it too', async () => {
    const before = (await craftCalls(page)).length
    await nav.getByRole('button', { name: 'Browser', exact: true }).click()
    await expect(page.getByTestId('craft-app-region')).toBeVisible()
    await expect.poll(async () => (await craftCalls(page)).slice(before).find((call) => call.method === 'show')?.args[0]).toBe('photocraft')
    const again = (await craftCalls(page)).length
    await nav.getByRole('button', { name: 'Library', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Library', exact: true })).toBeVisible()
    await expect.poll(async () => (await craftCalls(page)).slice(again).map((call) => call.method)).toContain('hide')
  })

  await test.step('The app map shows installed apps and the shelf, and cannot install', async () => {
    const result = await page.evaluate(async () => {
      const map = window.rocketMap
      return {
        shown: await map.act('app.show', { id: 'deckcraft' }),
        missing: await map.go('app', { id: 'vectorcraft' }),
        install: await map.act('app.install', { id: 'vectorcraft' }),
        shelf: await map.act('shelf.open')
      }
    })
    expect(result.shown.ok).toBe(true)
    expect(result.shown.where.place).toBe('app')
    expect(result.shown.where.craft?.shown).toBe('deckcraft')
    expect(result.missing.ok).toBe(false)
    expect(!result.missing.ok && result.missing.error).toContain('VectorCraft is not installed')
    expect(result.install.ok).toBe(false)
    expect(!result.install.ok && result.install.error).toContain('There is no action "app.install"')
    expect(result.shelf.where.side).toBe('shelf')
    expect(result.shelf.where.craft?.apps.find((entry) => entry.id === 'photocraft')?.installState).toBe('installed')
    await expect(shelf).toBeVisible()
    expect((await craftCalls(page)).filter((call) => call.method === 'install').map((call) => call.args[0])).toEqual(['photocraft', 'gridcraft', 'deckcraft', 'filmcraft'])
  })

  await test.step('Remove uninstalls from the shelf; a running one asks first', async () => {
    await craftControl(page, 'run', 'deckcraft', 'stopped')
    const removeFromMenu = async (name: string): Promise<void> => {
      await shelf.getByRole('button', { name: `More for ${name}` }).click()
      await shelf.getByRole('menu', { name: `${name} actions` }).getByRole('menuitem', { name: 'Remove' }).click()
    }
    await removeFromMenu('DeckCraft')
    await expect(shelf.getByRole('button', { name: 'Install DeckCraft' })).toBeVisible()
    await removeFromMenu('GridCraft')
    await expect(shelf.getByRole('article', { name: 'GridCraft' })).toContainText('unsaved work in it is lost')
    await shelf.getByRole('button', { name: 'Remove GridCraft now' }).click()
    await expect(shelf.getByRole('button', { name: 'Open PhotoCraft' })).toBeVisible()
    await expect(shelf.getByRole('button', { name: 'Install GridCraft' })).toBeVisible()
    expect((await craftCalls(page)).filter((call) => call.method === 'remove').map((call) => call.args[0])).toEqual(['deckcraft', 'gridcraft'])
  })
})
