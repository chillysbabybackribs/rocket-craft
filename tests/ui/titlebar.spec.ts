import { test, expect, section } from './app'

// There is no rail: the window lights and the toolbar start the title strip, the usage notch hangs
// at its centre, and the chat card starts at the window's left edge. A ring's flyout opens below
// the notch and ends inside the chat card, clear of the browser's native page.
test('usage sits at the centre of the title strip and nothing but the chat uses the left edge', async ({ rocket }) => {
  const { page } = rocket
  const notch = page.getByLabel('Subscription usage', { exact: true })

  await test.step('The chat starts at the left edge; the lights and notch are in the strip', async () => {
    await expect(page.locator('.rail')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Hide the rail' })).toHaveCount(0)
    const chat = (await page.locator('.chat').boundingBox())!
    expect(chat.x).toBeLessThanOrEqual(12)
    const close = (await page.getByRole('button', { name: 'Close window' }).boundingBox())!
    expect(close.y + close.height).toBeLessThanOrEqual(chat.y)
    const box = (await notch.boundingBox())!
    const width = await page.evaluate(() => window.innerWidth)
    expect(box.y).toBe(0)
    expect(box.y + box.height).toBeLessThanOrEqual(chat.y)
    expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(2)
    await expect(notch.locator('.ring')).toHaveCount(4)
    await rocket.capture('titlebar-usage')
  })

  await test.step('With the sections drawer open, the toolbar and the notch never overlap', async () => {
    const sections = page.getByRole('button', { name: 'Sections', exact: true })
    await sections.click()
    await expect(sections).toHaveAttribute('aria-expanded', 'true')
    // The drawer slides open; measure once it has settled.
    await page.waitForTimeout(500)
    const dock = (await page.locator('.tb-dock').boundingBox())!
    expect(dock.x + dock.width).toBeLessThanOrEqual((await notch.boundingBox())!.x)
    await sections.click()
  })

  await test.step('With the browser open, a ring\'s flyout ends inside the chat card', async () => {
    await (await section(page, 'Browser')).click()
    await expect(page.getByRole('region', { name: 'Browser', exact: true })).toBeVisible()
    await page.getByRole('button', { name: /^Antigravity usage/ }).hover()
    const flyout = page.getByRole('group', { name: 'Antigravity usage', exact: true })
    await expect(flyout).toBeVisible()
    const box = (await flyout.boundingBox())!
    const chat = (await page.locator('.chat').boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(chat.x + chat.width)
    expect(box.y).toBeGreaterThanOrEqual((await notch.boundingBox())!.height)
    await rocket.capture('titlebar-usage-flyout')
  })
})
