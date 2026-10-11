import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect, section } from './app'

// Hands-free reading (docs/mockups/reading-scroll.html): the page scrolls itself from the toolbar,
// the reader's own scrolling moves it without stopping it, and leaving the page ends it.
test('hands-free reading scrolls the page, follows the reader’s own scrolling and stops on leaving', async ({ rocket }) => {
  const { page, origin, profile } = rocket
  await (await section(page, 'Browser')).click()
  const browser = await rocket.surface('browser')
  await page.getByRole('textbox', { name: 'Address', exact: true }).fill(`${origin}/long`)
  await page.getByRole('textbox', { name: 'Address', exact: true }).press('Enter')
  await expect(browser).toHaveTitle('A long read')
  const scrollY = (): Promise<number> => browser.evaluate(() => window.scrollY)
  // Shortcuts are caught in main before the page sees them (before-input-event), which keys sent
  // over the DevTools protocol skip; these go in as the window's own input does.
  const key = (keyCode: string, modifiers: string[] = []): Promise<void> => rocket.app.evaluate(({ webContents }, [from, code, held]) => {
    const contents = webContents.getAllWebContents().find((each) => each.getURL().startsWith(from as string))!
    contents.sendInputEvent({ type: 'keyDown', keyCode: code as string, modifiers: held as Array<'alt'> })
    contents.sendInputEvent({ type: 'keyUp', keyCode: code as string, modifiers: held as Array<'alt'> })
  }, [origin, keyCode, modifiers] as const)

  await test.step('The button starts the page moving and opens the control', async () => {
    await page.getByRole('button', { name: 'Read hands-free', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await expect.poll(scrollY).toBeGreaterThan(20)
    await expect(page.locator('.reading-speed')).toHaveText('1×')
    await expect(page.locator('.reading-left')).toContainText('left')
  })

  await test.step('The slider sets the speed, up to 8×', async () => {
    await page.getByRole('slider', { name: 'Reading speed' }).focus()
    await page.keyboard.press('End')
    await expect(page.locator('.reading-speed')).toHaveText('8×')
    const before = await scrollY()
    await page.waitForTimeout(1000)
    expect(await scrollY() - before).toBeGreaterThan(150)
  })

  await test.step('Scrolling back with the wheel moves the page, and reading carries on from there', async () => {
    await expect.poll(scrollY).toBeGreaterThan(1200)
    await browser.mouse.move(300, 300)
    const before = await scrollY()
    await browser.mouse.wheel(0, -800)
    await expect.poll(scrollY).toBeLessThan(before - 300)
    const landed = await scrollY()
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await expect.poll(scrollY, { timeout: 3000 }).toBeGreaterThan(landed + 60)
  })

  await test.step('Pause holds the page; Space in the page carries on', async () => {
    await page.locator('.reading-readout').dblclick()
    await expect(page.locator('.reading-speed')).toHaveText('1×')
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Carry on', exact: true })).toBeVisible()
    const held = await scrollY()
    await page.waitForTimeout(600)
    expect(await scrollY()).toBe(held)
    // A click in the page would pause it; it is paused already, and it puts the keys in the page.
    await browser.locator('p').nth(3).click()
    await browser.keyboard.press('Space')
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    // Space carried on rather than paging down.
    expect(await scrollY() - held).toBeLessThan(200)
    await rocket.capture('reading')
  })

  await test.step('Esc stops it; Alt+S starts it from the page; leaving the page ends it', async () => {
    await key('Escape')
    await expect(page.getByRole('button', { name: 'Read hands-free', exact: true })).toBeVisible()
    await key('S', ['alt'])
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await key('Down', ['alt'])
    await expect(page.locator('.reading-speed')).toHaveText('1.1×')
    // Leave while reading is still running. The Address box is used rather than clicking the link:
    // a link on a scrolling page never holds still for Playwright's stability check, which fails
    // under load.
    await page.getByRole('textbox', { name: 'Address', exact: true }).fill(`${origin}/one`)
    await page.getByRole('textbox', { name: 'Address', exact: true }).press('Enter')
    await expect(browser).toHaveTitle('UI page one')
    await expect(page.getByRole('button', { name: 'Read hands-free', exact: true })).toBeVisible()
  })

  await test.step('The speed is kept for next time', async () => {
    await expect.poll(async () => JSON.parse(await readFile(join(profile, 'browser-tabs.json'), 'utf8')).readingSpeed).toBe(1.1)
  })
})

// The same reading in the panel beside the chat, here on a plan file a reply linked to.
test('hands-free reading scrolls a file in the panel, follows the reader and keeps one speed', async ({ rocket }) => {
  const { page, workspace } = rocket
  const sections = Array.from({ length: 30 }, (_, index) => `## Step ${index + 1}\n\nThe night train leaves at half past nine. The cabins are small, the sheets are real, and the blind has a gap at the bottom.\n`)
  await writeFile(join(workspace, 'reading-plan.md'), `# A long plan\n\n${sections.join('\n')}`)
  await page.locator('.composer-folder').click()
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('[Plan](reading-plan.md)\n\nUI check: stream')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.prose').last()).toContainText('Streaming from')
  await rocket.release()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: 'Plan', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Artifact preview' })
  await expect(panel.getByRole('heading', { name: 'A long plan' })).toBeVisible()
  const text = panel.locator('.artifact-content')
  const top = (): Promise<number> => text.evaluate((element) => element.scrollTop)

  await test.step('The header button starts the file moving', async () => {
    await panel.getByRole('button', { name: 'Read hands-free', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await expect.poll(top).toBeGreaterThan(20)
    await panel.getByRole('slider', { name: 'Reading speed' }).focus()
    await page.keyboard.press('End')
    await expect(panel.locator('.reading-speed')).toHaveText('8×')
  })

  await test.step('The wheel moves the file back, and reading carries on from there', async () => {
    await expect.poll(top).toBeGreaterThan(700)
    const box = (await text.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const before = await top()
    await page.mouse.wheel(0, -600)
    await expect.poll(top).toBeLessThan(before - 300)
    const landed = await top()
    await expect.poll(top, { timeout: 3000 }).toBeGreaterThan(landed + 60)
  })

  await test.step('A click pauses, Space carries on, Esc stops and Alt+S starts', async () => {
    await text.locator('p').nth(8).click()
    await expect(panel.getByRole('button', { name: 'Carry on', exact: true })).toBeVisible()
    await page.keyboard.press('Space')
    await expect(panel.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await rocket.capture('panel-reading')
    await page.keyboard.press('Escape')
    await expect(panel.getByRole('button', { name: 'Read hands-free', exact: true })).toBeVisible()
    await page.keyboard.press('Alt+s')
    await expect(panel.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  })

  await test.step('Another file starts at rest, at the speed last chosen', async () => {
    await page.getByRole('button', { name: 'Close artifact' }).click()
    await page.getByRole('link', { name: 'Plan', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Read hands-free', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Read hands-free', exact: true }).click()
    await expect(panel.locator('.reading-speed')).toHaveText('8×')
  })
})
