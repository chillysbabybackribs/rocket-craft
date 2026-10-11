import { test, expect } from './app'

// The toolbar's Sections icon slides a drawer of section names out to the right. Customize
// renames, reorders, and keeps sections in the toolbar for good; the choice survives a restart.
// Menus opened from the toolbar stay inside the chat card, clear of the browser's native page.
test('the sections drawer opens, customizes, and keeps its choices after a restart', async ({ rocket }) => {
  const { page } = rocket
  const sections = page.getByRole('button', { name: 'Sections', exact: true })
  const browserTab = page.getByRole('button', { name: 'Browser', exact: true })

  await test.step('Closed, the drawer hides its names; open, they are there to click', async () => {
    await expect(sections).toBeVisible()
    await expect(sections).toHaveAttribute('aria-expanded', 'false')
    await expect(browserTab).toHaveCount(0)
    await sections.click()
    await expect(sections).toHaveAttribute('aria-expanded', 'true')
    await expect(browserTab).toBeVisible()
    await browserTab.click()
    await expect(page.getByRole('region', { name: 'Browser', exact: true })).toBeVisible()
    await expect(browserTab).toHaveAttribute('aria-pressed', 'true')
    await rocket.capture('toolbar-open')
  })

  await test.step('The Chats menu opens under its name and stays inside the chat card', async () => {
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
    const menu = page.getByRole('menu', { name: 'Chat history' })
    await expect(menu).toBeVisible()
    const box = (await menu.boundingBox())!
    const chat = (await page.locator('.chat').boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(chat.x + chat.width)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  await test.step('Customize renames Chats and keeps Browser in the toolbar', async () => {
    await page.getByRole('button', { name: 'Customize sections…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Customize sections' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox', { name: 'Name for Chats' }).fill('History')
    await expect(dialog).toContainText('was Chats')
    await dialog.locator('[data-section="browser"]').getByRole('radio', { name: 'Keep' }).click()
    await rocket.capture('toolbar-customize')
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'History (Chats)', exact: true })).toBeVisible()
    await sections.click()
    await expect(sections).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('button', { name: 'History (Chats)', exact: true })).toHaveCount(0)
    await expect(browserTab).toBeVisible()
    await rocket.capture('toolbar-kept')
  })

  await test.step('The choices survive a restart, and Restore Defaults clears them', async () => {
    await rocket.restart()
    const page = rocket.page
    const browserTab = page.getByRole('button', { name: 'Browser', exact: true })
    await expect(browserTab).toBeVisible()
    await page.getByRole('button', { name: 'Sections', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Customize Sections…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Customize sections' })
    await dialog.getByRole('button', { name: 'Restore Defaults', exact: true }).click()
    await expect(dialog.getByRole('textbox', { name: 'Name for Chats' })).toHaveValue('Chats')
    await page.keyboard.press('Escape')
    await expect(browserTab).toHaveCount(0)
  })
})
