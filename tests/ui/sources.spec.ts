import { test, expect } from './app'

// A reply's links carry what the turn did: a tick on a page it opened, a warning on a page it
// cited without opening. The search in the turn is a query, so it is never a source.
test('each link in a reply is marked opened or not by what the turn fetched', async ({ rocket }) => {
  const { page } = rocket
  await page.locator('.composer-folder').click()
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('UI check: cite')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const reply = page.locator('.turn .prose').last()
  await expect(reply).toContainText('not verified')
  const opened = reply.locator('a', { hasText: 'the auth docs' }).locator('.source-mark')
  // cite() in src/host/ui-test.ts fetches the auth docs with page text, so hub.ts putItem's
  // webReadProblem gate records it as opened. An empty fetch would be refused as a source and
  // the mark would read unopened; that is why the fixture's fetch must carry real text.
  await expect(opened).toHaveClass(/is-opened/)
  await expect(opened).toHaveAttribute('title', 'Opened this turn')
  const unopened = reply.locator('a', { hasText: 'a blog post' }).locator('.source-mark')
  await expect(unopened).toHaveClass(/is-unopened/)
  await expect(unopened).toHaveAttribute('title', /Not opened this turn/)
  await expect(reply.locator('.source-mark')).toHaveCount(2)
  await rocket.capture('source-marks')
})
