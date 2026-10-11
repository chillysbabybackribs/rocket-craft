import type { Locator, Page } from '@playwright/test'
import { test, expect } from './app'
import { craftControl, useFakeCraft } from './craft-fake'

// The shelf as docs/mockups/craft-shelf.html draws it, at the user's 1912 × 1068 window, against
// the fake app manager: one grid of all twelve apps in the agreed order, centred both ways in the
// right side without scrolling; Install turning indigo on a hovered card; the ⋯ menu opening
// inside the right side; the All / Installed switch; Remove from the menu; fewer columns as the
// right side narrows; and the same icons in the shelf cards and the app region.

const ORDER = ['photocraft', 'vectorcraft', 'filmcraft', 'lightcraft', 'effectcraft', 'designcraft', 'soundcraft', 'wordcraft', 'gridcraft', 'deckcraft', 'pdfcraft', 'cadcraft']

async function resize(page: Page, app: Parameters<typeof useFakeCraft>[0], width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => { BrowserWindow.getAllWindows()[0]!.setSize(size.width, size.height) }, { width, height })
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
}

/** How many columns the grid has: the distinct left edges of its cards. */
async function columns(grid: Locator): Promise<number> {
  return grid.locator('.shelf-card').evaluateAll((cards) => new Set(cards.map((card) => Math.round(card.getBoundingClientRect().left))).size)
}

test('the shelf matches the agreed mockup and its filter and menu work', async ({ rocket }) => {
  const { app, page } = rocket
  await useFakeCraft(app, page)
  await resize(page, app, 1912, 1068)
  const shelf = page.getByRole('region', { name: 'Apps shelf' })
  const grid = shelf.locator('.shelf-grid')
  const right = page.locator('.craft-right')

  await test.step('With nothing installed, the Installed filter says how to get an app', async () => {
    await expect(shelf.getByRole('button', { name: 'All 12' })).toHaveAttribute('aria-pressed', 'true')
    await shelf.getByRole('button', { name: 'Installed 0' }).click()
    await expect(shelf.locator('.shelf-card')).toHaveCount(0)
    await expect(shelf).toContainText('Nothing is installed yet.')
    await shelf.getByRole('button', { name: 'Show all apps' }).click()
    await expect(shelf.locator('.shelf-card')).toHaveCount(12)
  })

  await test.step('One grid of twelve, creative apps first, four columns, centred without scrolling', async () => {
    await shelf.getByRole('button', { name: 'Install PhotoCraft' }).click()
    await craftControl(page, 'finish', 'photocraft')
    await shelf.getByRole('button', { name: 'Install WordCraft' }).click()
    await craftControl(page, 'finish', 'wordcraft')
    await shelf.getByRole('button', { name: 'Install DeckCraft' }).click()
    await craftControl(page, 'progress', 'deckcraft', 0.62)
    await expect(shelf.getByRole('progressbar', { name: 'Installing DeckCraft' })).toHaveAttribute('aria-valuenow', '62')
    await expect(shelf.getByRole('article', { name: 'DeckCraft' })).toContainText('62%')
    expect(await grid.locator('.shelf-card').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-app')))).toEqual(ORDER)
    expect(await columns(grid)).toBe(4)
    const card = (await shelf.getByRole('article', { name: 'VectorCraft' }).boundingBox())!
    expect(card.height).toBeGreaterThanOrEqual(234)
    expect(card.height).toBeLessThanOrEqual(240)
    // Every card shows its icon, its download size when not installed, its "Like" name and one button.
    const photo = shelf.getByRole('article', { name: 'PhotoCraft' })
    await expect(photo.locator('.craft-icon[data-glyph="photocraft"] svg')).toHaveCount(1)
    await expect(photo.locator('.shelf-chip')).toHaveCount(0)
    await expect(photo).toContainText('Like Photoshop')
    await expect(shelf.getByRole('article', { name: 'VectorCraft' }).locator('.shelf-chip')).toHaveText('79 MB')
    await expect(shelf).toContainText('157 MB on disk')
    await expect(shelf.getByRole('button', { name: 'Installed 2' })).toBeVisible()
    const layout = await shelf.evaluate((region) => {
      const inner = region.querySelector('.shelf-inner')!.getBoundingClientRect()
      const box = region.getBoundingClientRect()
      return {
        left: inner.left - box.left, right: box.right - inner.right, top: inner.top - box.top, bottom: box.bottom - inner.bottom,
        width: inner.width, scrolls: region.scrollHeight > region.clientHeight
      }
    })
    expect(layout.scrolls).toBe(false)
    expect(layout.width).toBeLessThanOrEqual(1140)
    expect(Math.abs(layout.left - layout.right)).toBeLessThanOrEqual(2)
    expect(Math.abs(layout.top - layout.bottom)).toBeLessThanOrEqual(2)
  })

  await test.step('A hovered card lifts and its Install button turns indigo', async () => {
    const film = shelf.getByRole('article', { name: 'FilmCraft' })
    const install = film.getByRole('button', { name: 'Install FilmCraft' })
    const before = await install.evaluate((button) => getComputedStyle(button).backgroundColor)
    await film.hover({ position: { x: 120, y: 60 } })
    await expect.poll(() => install.evaluate((button) => getComputedStyle(button).backgroundColor)).toBe('rgb(113, 112, 255)')
    expect(before).not.toBe('rgb(113, 112, 255)')
    await page.waitForTimeout(250)
    await rocket.capture('shelf-1912-hover')
  })

  await test.step('The ⋯ menu opens inside the right side and Escape closes it', async () => {
    const more = shelf.getByRole('button', { name: 'More for PhotoCraft' })
    await more.click()
    const menu = shelf.getByRole('menu', { name: 'PhotoCraft actions' })
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Version 0.7.0')
    await expect(menu.getByRole('menuitem', { name: 'Remove' })).toBeFocused()
    const box = (await menu.boundingBox())!
    const region = (await shelf.boundingBox())!
    const card = (await shelf.getByRole('article', { name: 'PhotoCraft' }).boundingBox())!
    const rightBox = (await right.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(region.x)
    expect(box.x + box.width).toBeLessThanOrEqual(region.x + region.width)
    expect(box.y).toBeGreaterThanOrEqual(region.y)
    expect(box.y + box.height).toBeLessThanOrEqual(rightBox.y + rightBox.height)
    // It stays within its own card, so no other card is drawn over it.
    expect(box.y).toBeGreaterThanOrEqual(card.y)
    expect(box.y + box.height).toBeLessThanOrEqual(card.y + card.height)
    await rocket.capture('shelf-menu')
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(more).toBeFocused()
  })

  await test.step('Installed shows only the installed apps', async () => {
    const title = shelf.getByRole('heading', { name: 'Apps' })
    const before = (await title.boundingBox())!.y
    await shelf.getByRole('button', { name: 'Installed 2' }).click()
    await expect(shelf.getByRole('button', { name: 'Installed 2' })).toHaveAttribute('aria-pressed', 'true')
    expect(await grid.locator('.shelf-card').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-app')))).toEqual(['photocraft', 'wordcraft'])
    // The header stays where it was rather than jumping to the shorter grid's centre.
    expect(Math.abs((await title.boundingBox())!.y - before)).toBeLessThanOrEqual(1)
    await page.mouse.move(5, 500)
    await rocket.capture('shelf-installed-filter')
  })

  await test.step('Remove from the ⋯ menu takes a stopped app off the Installed filter', async () => {
    await shelf.getByRole('button', { name: 'More for WordCraft' }).click()
    await shelf.getByRole('menu', { name: 'WordCraft actions' }).getByRole('menuitem', { name: 'Remove' }).click()
    await expect(shelf.getByRole('article', { name: 'WordCraft' })).toHaveCount(0)
    await expect(shelf.getByRole('button', { name: 'Installed 1' })).toBeVisible()
    await shelf.getByRole('button', { name: 'All 12' }).click()
    await expect(shelf.getByRole('button', { name: 'Install WordCraft' })).toBeVisible()
  })

  await test.step('The grid drops to three columns, then two, as the right side narrows, and scrolls only then', async () => {
    await resize(page, app, 1300, 860)
    await expect.poll(() => columns(grid)).toBe(3)
    await resize(page, app, 960, 760)
    await expect.poll(() => columns(grid)).toBe(2)
    expect(await shelf.evaluate((region) => region.scrollHeight > region.clientHeight)).toBe(true)
    await rocket.capture('shelf-narrow')
    await resize(page, app, 1912, 1068)
    await expect.poll(() => columns(grid)).toBe(4)
  })

  await test.step('Opening an app from the shelf shows the same icon in its region', async () => {
    await craftControl(page, 'finish', 'deckcraft')
    await shelf.getByRole('button', { name: 'Open PhotoCraft' }).click()
    const region = page.getByRole('region', { name: 'PhotoCraft' })
    await expect(region).toContainText('Starting PhotoCraft…')
    await expect(region.locator('.craft-icon[data-glyph="photocraft"] svg')).toHaveCount(1)
    await page.mouse.move(5, 500)
    await rocket.capture('placeholder-and-region')
  })
})
