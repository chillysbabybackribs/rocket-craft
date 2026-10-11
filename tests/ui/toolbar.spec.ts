import { test, expect, section } from './app'

// Chats opens from an icon above the composer; Browser and Library are toggles in the right side
// header (docs/mockups/craft-studio.html). Rocket's Sections drawer, Customize and the Tools panel
// are gone, and preferences saved for them load harmlessly.
test('Chats sits on the composer, and Browser and Library toggle from the right header', async ({ rocket }) => {
  const { page } = rocket
  const nav = page.getByRole('navigation', { name: 'Right side' })

  await test.step('Chats is on the composer; the right header has Apps, Browser and Library', async () => {
    await expect(page.locator('.titlebar [data-section="chats"]')).toHaveCount(0)
    await expect(page.locator('.composer-shell [data-section="chats"]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Sections', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Tools', exact: true })).toHaveCount(0)
    await expect(nav.getByRole('button', { name: 'Apps', exact: true })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Browser', exact: true })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Library', exact: true })).toBeVisible()
  })

  await test.step('The Chats menu opens from the composer icon and stays inside the chat card', async () => {
    await (await section(page, 'Browser')).click()
    await expect(page.getByRole('region', { name: 'Browser', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Chats', exact: true }).click()
    const menu = page.getByRole('menu', { name: 'Chat history' })
    await expect(menu).toBeVisible()
    const box = (await menu.boundingBox())!
    const chat = (await page.locator('.chat').boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(chat.x + chat.width)
    await rocket.capture('toolbar-chats-menu')
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  await test.step('Browser and Library take the side in turn; toggling one off returns to the shelf', async () => {
    const browser = nav.getByRole('button', { name: 'Browser', exact: true })
    const library = nav.getByRole('button', { name: 'Library', exact: true })
    await expect(browser).toHaveAttribute('aria-pressed', 'true')
    await library.click()
    await expect(page.getByRole('complementary', { name: 'Library', exact: true })).toBeVisible()
    await expect(library).toHaveAttribute('aria-pressed', 'true')
    await expect(browser).toHaveAttribute('aria-pressed', 'false')
    await library.click()
    await expect(page.getByRole('region', { name: 'Apps shelf' })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Apps', exact: true })).toHaveAttribute('aria-pressed', 'true')
  })

  await test.step('Preferences saved for the old toolbar and side panels load, and the side is remembered', async () => {
    await page.evaluate(() => {
      const prefs = JSON.parse(localStorage.getItem('rocket.prefs') ?? '{}')
      Object.assign(prefs, { toolbar: { open: true, order: ['goals', 'tools', 'chats'], kept: ['tools'], names: { chats: 'History' } }, toolsOpen: true, browserOpen: true })
      localStorage.setItem('rocket.prefs', JSON.stringify(prefs))
    })
    await (await section(page, 'Library')).click()
    await rocket.restart()
    const page2 = rocket.page
    await expect(page2.locator('.composer-shell [data-section="chats"]')).toHaveCount(1)
    await expect(page2.getByRole('complementary', { name: 'Library', exact: true })).toBeVisible()
  })
})
