import { test, expect } from './app'

// The composer stays live while a turn runs. Words for the provider answering join its turn;
// words for another provider wait under it, can be taken back, and go out when it ends.
test('a message sent mid-turn joins the turn, or waits for it when another provider is picked', async ({ rocket }) => {
  const { page } = rocket
  const message = page.getByRole('textbox', { name: 'Message', exact: true })
  await page.locator('.composer-folder').click()
  await message.fill('UI check: stream')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.prose').last()).toContainText('Streaming from claude.')

  await expect(message).toHaveAttribute('placeholder', 'Add to this turn…')
  await message.fill('Keep the footer as it is')
  await expect(page.locator('.composer-hint')).toContainText('adds to this turn')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await message.press('Enter')
  // On its way until the model reads it; then it joins the turn where it was read.
  const onItsWay = page.locator('.steer.is-waiting').filter({ hasText: 'Keep the footer as it is' })
  await expect(onItsWay).toContainText('Claude reads this at its next step')
  await expect(onItsWay.getByRole('button')).toHaveCount(0)
  const added = page.locator('.turn .steer:not(.is-waiting)').filter({ hasText: 'Keep the footer as it is' })
  await expect(added).toHaveCount(0)
  await expect(page.locator('.turn')).toHaveCount(1)
  await expect(message).toHaveValue('')

  // Cursor is not the one answering, so its message waits for Claude's turn to end.
  await message.press('Control+3')
  await expect(message).toHaveAttribute('placeholder', 'Message to send when Claude finishes…')
  await message.fill('UI check: ask')
  await message.press('Enter')
  const waiting = page.locator('.steer.is-waiting').filter({ hasText: 'UI check: ask' })
  await expect(waiting).toContainText('Sends when Claude finishes')
  await rocket.capture('steer-waiting')

  // Taken back, it is in the composer again; sent again, it waits again.
  await waiting.getByRole('button', { name: 'Edit' }).click()
  await expect(waiting).toHaveCount(0)
  await expect(message).toHaveValue('UI check: ask')
  await message.press('Enter')
  await expect(waiting).toHaveCount(1)

  await rocket.release()
  await expect(page.locator('.turn')).toHaveCount(2)
  await expect(page.locator('.steer.is-waiting')).toHaveCount(0)
  await expect(added).toContainText('Added during the turn')
  await expect(page.locator('.turn').first()).toContainText('Carried on with the words added mid-turn.')
  await expect(page.getByRole('group', { name: 'Question from the model' })).toBeVisible()
  await rocket.capture('steer-sent')
})
