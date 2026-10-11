import { test, expect, section } from './app'

// A picture a model makes shows in the reply where it was made (docs/mockups/generated-images.html):
// rippling dots alone while it comes, then the picture from Craft Studio's own copy with
// its prompt as the caption, opening full size on click. A refused one is a sentence; Codex
// viewing a file is an ordinary step. The picture joins the library as "Made by a model".
test('a generated picture shows in the reply, opens full size, and is on the library shelf', async ({ rocket }) => {
  const { page } = rocket
  const message = page.getByRole('textbox', { name: 'Message', exact: true })
  await page.locator('.composer-folder').click()
  await message.fill('UI check: image')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  const pending = page.locator('.gen-pending')
  await expect(pending).toBeVisible()
  await expect(pending.locator('.gen-field i')).toHaveCount(640)
  // Only the dots: no label, clock or frame over them; screen readers still hear "Generating image".
  await expect(pending).toHaveAttribute('aria-label', 'Generating image')
  await expect(pending.locator('.gen-label')).toHaveCount(0)
  await expect(pending).toHaveCSS('border-top-width', '0px')
  await expect(page.locator('.gen-caption').first()).toContainText('A neon horizon over a desert city')
  await rocket.capture('generated-image-waiting')

  await rocket.release()
  const picture = page.locator('.gen-image img')
  await expect(picture).toBeVisible()
  await expect(picture).toHaveClass(/is-arriving/)
  await picture.evaluate((element) => { element.dataset.arrived = 'yes' })
  await expect(picture).toHaveJSProperty('naturalWidth', 1200)
  await expect(page.locator('.gen-pending')).toHaveCount(0)
  await expect(page.locator('.prose').last()).toHaveText(/^Here is the poster/)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  // The final reply moved the picture before it; it is still the element that arrived, not a new one.
  await expect(picture).toHaveAttribute('data-arrived', 'yes')
  await expect(page.locator('.gen-failed')).toHaveText('Codex has used up its image generation limit for now. Try again after 3:40 PM.')
  // The picture stands in the reply, before the words that followed it, not inside the steps.
  const order = await page.locator('.turn .answer').last().evaluate((answer) => {
    const at = (selector: string): number => [...answer.querySelectorAll('*')].indexOf(answer.querySelector(selector)!)
    return { summary: at('.activity-summary'), picture: at('.gen-image'), reply: at('.prose') }
  })
  expect(order.summary).toBeLessThan(order.picture)
  expect(order.picture).toBeLessThan(order.reply)
  await page.locator('.gen-more').first().click()
  await expect(page.locator('.gen-caption.is-open')).toHaveCount(1)
  await page.locator('.activity-summary').click()
  await expect(page.locator('.tool-label', { hasText: 'Viewed reference.png' })).toBeVisible()
  await rocket.capture('generated-image-made')

  await picture.click()
  const viewer = page.getByRole('dialog', { name: /Image preview: a-neon-horizon-over-a-desert-city/ })
  await expect(viewer.locator('img')).toBeVisible()
  await rocket.capture('generated-image-full-size')
  await viewer.getByRole('button', { name: 'Close image preview' }).click()

  const library = page.getByRole('complementary', { name: 'Library', exact: true })
  await (await section(page, 'Library')).click()
  await library.getByRole('button', { name: 'Source', exact: true }).click()
  await library.getByRole('option', { name: /^Made by a model/ }).click()
  await expect(library.locator('.lib-card')).toHaveCount(1)
  await expect(library.locator('.lib-name')).toHaveText(/^a-neon-horizon-over-a-desert-city/)
  await expect(library.locator('.lib-card')).toContainText(/Generated · (Claude|Codex|Cursor|Antigravity)/)
  await rocket.capture('generated-image-library')
})
