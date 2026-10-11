import { test, expect, section } from './app'

// One column is the product: the add-beside button is gone, history changes which chat that
// column shows, and the only pane cannot be closed or joined by another.
test('the left column is one chat, switched from history, and never splits', async ({ rocket }) => {
  const { page } = rocket
  const panes = page.locator('.pane')
  const message = () => page.getByRole('textbox', { name: 'Message', exact: true })

  await test.step('There is one pane and no add-beside button', async () => {
    await expect(page.locator('.orch-shell')).toBeVisible()
    await expect(panes).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Add a chat beside this one' })).toHaveCount(0)
    await expect(page.getByTestId('orchestrator-chat')).toBeVisible()
  })

  await test.step('A turn streams into the left chat', async () => {
    await page.locator('.composer-folder').click()
    await message().fill('UI check: stream')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(panes.locator('.turn')).toHaveCount(1)
    await expect(panes.locator('.prose').last()).toContainText('Streaming from claude.')
    await rocket.release()
    await expect(panes.locator('.prose').last()).toContainText('The controlled response finished.')
    await rocket.capture('panes-one')
  })

  await test.step('History switching changes the left chat', async () => {
    const opened = await page.evaluate(() => window.rocketMap.act('chat.new', {}))
    expect(opened.ok, opened.ok ? '' : opened.error).toBe(true)
    await expect(panes).toHaveClass(/is-empty/)
    await message().fill('UI check: ask')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    // The question is not the first prose block; the pane as a whole carries the question text.
    await expect(panes).toContainText('Which database')
    await (await section(page, 'Chats')).click()
    await page.getByRole('menuitem', { name: 'UI check: stream' }).click()
    await expect(panes.locator('.prose').last()).toContainText('The controlled response finished.')
    await expect(panes).not.toContainText('Which database')
    await (await section(page, 'Chats')).click()
    await page.getByRole('menuitem', { name: 'UI check: ask' }).click()
    await expect(panes).toContainText('Which database')
    await rocket.capture('panes-history')
  })

  await test.step('The one column and its open chat survive a restart', async () => {
    await rocket.restart()
    const page = rocket.page
    await expect(page.locator('.pane')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Add a chat beside this one' })).toHaveCount(0)
    await expect(page.locator('.pane')).toContainText('Which database')
  })

  await test.step('The only pane stays when its tabs close, and the pane actions are gone', async () => {
    const page = rocket.page
    await page.getByRole('button', { name: 'Close tab: UI check: ask' }).click()
    await expect(page.locator('.pane')).toHaveCount(1)
    await expect(page.locator('.pane').locator('.prose').last()).toContainText('The controlled response finished.')
    await page.getByRole('button', { name: 'Close tab: UI check: stream' }).click()
    await expect(page.locator('.pane')).toHaveCount(1)
    await expect(page.locator('.pane')).toHaveClass(/is-empty/)
    await expect(page.getByRole('button', { name: 'Close this chat pane' })).toHaveCount(0)
    const added = await page.evaluate(() => window.rocketMap.act('pane.add', {}))
    expect(added.ok ? '' : added.error).toContain('There is no action')
    await expect(page.locator('.pane')).toHaveCount(1)
  })
})
