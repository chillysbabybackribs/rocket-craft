import type { Page } from 'playwright'
import { test, expect } from './app'

// After Goals left the app and Evals became Tools: the toolbar's drawer names the four sections
// that remain, saved preferences that still name goals or evals load and customize without error
// (evals as Tools, in its place), and the plan drawer
// keeps working in the split that the goal pane used to share (now the side pane).
test('the sections drawer lists four sections, and preferences naming goals still load', async ({ rocket }) => {
  const sections = rocket.page.getByRole('button', { name: 'Sections', exact: true })

  await test.step('The drawer lists exactly Chats, Library, Tools and Browser', async () => {
    await sections.click()
    await expect(sections).toHaveAttribute('aria-expanded', 'true')
    await expect(rocket.page.locator('.tb-drawer [data-section]')).toHaveText(['Chats', 'Library', 'Tools', 'Browser'])
    await rocket.capture('drawer-four-sections')
  })

  await test.step('Preferences saved while Goals existed load after a restart', async () => {
    await rocket.page.evaluate(() => {
      const prefs = JSON.parse(localStorage.getItem('rocket.prefs') ?? '{}')
      prefs.toolbar = { open: true, order: ['goals', 'browser', 'chats', 'library', 'evals'], kept: ['goals', 'library'], names: { goals: 'Aims', chats: 'History' } }
      prefs.goalWidth = 520
      localStorage.setItem('rocket.prefs', JSON.stringify(prefs))
    })
    await rocket.restart()
    const page = rocket.page
    await expect(page.getByRole('button', { name: 'Sections', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.toolbar [data-section="goals"]')).toHaveCount(0)
    await expect(page.locator('.toolbar [data-section]')).toHaveCount(4)
    await expect(page.locator('.tb-drawer [data-section]')).toHaveText(['Browser', 'History', 'Tools'])
    await expect(page.getByRole('button', { name: 'Library', exact: true })).toBeVisible()
    await rocket.capture('drawer-saved-goals')
  })

  await test.step('Customize opens with the four sections, and Restore Defaults clears the old choices', async () => {
    const page = rocket.page
    await page.getByRole('button', { name: 'Customize sections…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Customize sections' })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-section]')).toHaveCount(4)
    await expect(dialog.getByRole('textbox', { name: 'Name for Chats' })).toHaveValue('History')
    await rocket.capture('customize-saved-goals')
    await dialog.getByRole('button', { name: 'Restore Defaults', exact: true }).click()
    await expect(dialog.getByRole('textbox', { name: 'Name for Chats' })).toHaveValue('Chats')
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('rocket.prefs') ?? '{}').toolbar)
    expect(JSON.stringify(saved)).not.toContain('goals')
    expect(JSON.stringify(saved)).not.toContain('evals')
  })
})

test('the plan drawer opens in the side pane and resizes', async ({ rocket }, info) => {
  const { page } = rocket
  await page.locator('.composer-folder').click()
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('UI check: plan')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  const drawer = page.getByRole('complementary', { name: 'Plan' })
  // The split that holds the drawer: the side pane is its sibling of the conversation.
  const split = page.locator('.pane-split.is-split').filter({ has: drawer })
  const shown = async (): Promise<number> => (await drawer.boundingBox())!.width
  const splitWidth = async (): Promise<number> => (await split.boundingBox())!.width
  // The width the side track gets from styles.css `.pane-split.is-split`: the saved width, but no
  // more than leaves the conversation 300px and no less than 220px.
  const clamp = async (saved: number): Promise<number> => Math.min(saved, Math.max(220, (await splitWidth()) - 300))
  // The width Split hands the grid as --side-width, which is the saved preference.
  const preference = async (): Promise<number> => parseFloat(await split.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--side-width')))
  // Reads the saved preference from the page given, so a restarted window can be asked after the first one closes.
  const saved = (target: Page = page): Promise<number | undefined> => target.evaluate(() => JSON.parse(localStorage.getItem('rocket.prefs') ?? '{}').sideWidth)

  await test.step('The plan opens as the side pane of a split chat, clamped to the split', async () => {
    await expect(drawer).toBeVisible()
    await expect(drawer).toHaveClass(/\bside-pane\b/)
    await expect(page.locator('.app')).toHaveClass(/\bhas-side\b/)
    await expect(page.locator('.pane-split.is-split .split-chat')).toBeVisible()
    await expect(drawer.locator('.gp-line')).toHaveCount(5)
    // The fresh profile has no saved width, so the preference is the default 400px. The track
    // shows less when the split is narrow (the orchestrator's leader column beside the worker
    // board), so the expected shown width comes from the split's own box, within a pixel.
    expect(await preference()).toBe(400)
    expect(Math.abs((await shown()) - (await clamp(400)))).toBeLessThanOrEqual(1)
    // Beside the worker board the leader column is narrower than chat + 400px; record how much
    // of the side pane the board covers, for the report, without failing on it.
    const room = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect()
      const split = box('.pane-split'), side = box('.plan-drawer'), board = box('.orch-board-side')
      return { split: split && [split.left, split.right], side: side && [side.left, side.right], board: board && [board.left, board.right] }
    })
    info.annotations.push({ type: 'side-pane room beside the board', description: JSON.stringify(room) })
    await rocket.capture('plan-side-pane')
  })

  // The divider sets the saved preference, and the drawer never shows more than the clamp allows.
  // In a narrow split the clamp is below the 320px minimum, so a drag cannot make the shown width
  // grow or shrink: this checks what still holds there, not that the shell gives it room.
  await test.step('Dragging the divider saves the preference, the shown width stays within the clamp, and a restart restores it', async () => {
    const divider = page.getByRole('separator', { name: 'Resize the side pane' })
    const box = (await divider.boundingBox())!
    const y = box.y + box.height / 2
    await page.mouse.move(box.x + box.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(box.x - 40, y, { steps: 4 })
    await page.mouse.move(box.x - 80, y, { steps: 4 })
    await page.mouse.up()
    const dragged = await preference()
    const savedAfterDrag = await saved()
    info.annotations.push({ type: 'side-pane drag', description: `preference 400px → ${dragged}px, shown ${Math.round(await shown())}px, split ${Math.round(await splitWidth())}px` })
    // The drag moved the preference off its default and kept it at or above the 320px minimum.
    expect(dragged).not.toBe(400)
    expect(dragged).toBeGreaterThanOrEqual(320)
    expect(savedAfterDrag).toBe(dragged)
    // Whatever the preference, the shown width is the clamp and never more.
    expect(await shown()).toBeLessThanOrEqual((await clamp(dragged)) + 1)
    expect(Math.abs((await shown()) - (await clamp(dragged)))).toBeLessThanOrEqual(1)
    await rocket.capture('plan-side-pane-resized')
    await rocket.release()
    await expect(page.locator('.turn-head .plan-toggle')).toHaveText('Planned · 5 of 5')
    await rocket.restart()
    const after = rocket.page
    await after.locator('.turn-head .plan-toggle').click()
    const reopened = after.getByRole('complementary', { name: 'Plan' })
    await expect(reopened).toBeVisible()
    // The saved preference is the one the restarted split is given, and the shown width is its clamp.
    expect(await saved(after)).toBe(dragged)
    const restoredSplit = after.locator('.pane-split.is-split').filter({ has: reopened })
    expect(await restoredSplit.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--side-width'))).toBe(`${dragged}px`)
    const restoredClamp = Math.min(dragged, Math.max(220, (await restoredSplit.boundingBox())!.width - 300))
    expect(Math.abs((await reopened.boundingBox())!.width - restoredClamp)).toBeLessThanOrEqual(1)
  })
})
