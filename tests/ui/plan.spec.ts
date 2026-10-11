import { test, expect } from './app'

// A model's plan shows beside the chat, not in it: the turn's head line reads "Planning · 2 of 5"
// and the drawer opens by itself on the first plan. Closing it is remembered for the chat; the
// head line opens it again, and once the turn is over the line reads "Planned · 5 of 5".
test('a plan opens beside the chat, is counted in the head line, and remembers being closed', async ({ rocket }) => {
  const { page } = rocket
  const message = page.getByRole('textbox', { name: 'Message', exact: true })
  await page.locator('.composer-folder').click()
  await message.fill('UI check: plan')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  const drawer = page.getByRole('complementary', { name: 'Plan' })
  const head = page.locator('.turn-head .plan-toggle')
  await expect(head).toHaveText('Planning · 2 of 5')
  await expect(drawer).toBeVisible()
  await expect(drawer.locator('.gp-title')).toHaveText('UI check: plan')
  await expect(drawer.locator('.gp-count')).toHaveText('2 of 5')
  await expect(drawer.locator('.gp-line')).toHaveCount(5)
  await expect(drawer.locator('.gp-line.is-done')).toHaveCount(2)
  await expect(drawer.locator('.gp-line.is-now')).toHaveText('Scope the notes routes to the logged-in user')
  // The plan is not a row of the response: no tool line or step mentions it.
  await expect(page.locator('.turn .tool-label', { hasText: /plan|todo/i })).toHaveCount(0)
  await rocket.capture('plan-open')

  // The arrow closes it; the head line brings it back.
  await drawer.getByRole('button', { name: 'Hide the plan' }).click()
  await expect(drawer).toHaveCount(0)
  await rocket.capture('plan-closed')
  await head.click()
  await expect(drawer).toBeVisible()
  await head.click()
  await expect(drawer).toHaveCount(0)

  await rocket.release()
  await expect(head).toHaveText('Planned · 5 of 5')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  // Finished, the line still opens the plan, now all ticked.
  await head.click()
  await expect(drawer.locator('.gp-line.is-done')).toHaveCount(5)
  await expect(drawer.locator('.gp-line.is-now')).toHaveCount(0)
  await rocket.capture('plan-done')
})
