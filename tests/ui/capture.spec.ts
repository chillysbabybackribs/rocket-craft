import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect, section } from './app'

// The composer's camera: capture, draw, add to the draft, send. Real captures through main
// (capturePage, desktopCapturer and the region window) on the check's private display.
test('captures of the browser page, a window and a region reach the draft with their drawing', async ({ rocket }) => {
  const { page, app } = rocket
  await page.locator('.composer-folder').click()
  await (await section(page, 'Browser')).click()
  await expect((await rocket.surface('browser')).getByRole('heading', { name: 'Craft Studio browser check' })).toBeVisible()
  const review = page.getByRole('dialog', { name: 'Review capture' })
  const layer = review.getByLabel('Drawing layer')
  const inked = () => layer.evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    let count = 0
    for (let i = 3; i < data.length; i += 4) if (data[i]) count++
    return count
  })
  const scribble = async (): Promise<void> => {
    const box = (await layer.boundingBox())!
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width * (0.2 + i * 0.05), box.y + box.height * (0.3 + (i % 2) * 0.1))
    await page.mouse.up()
  }

  // Browser page: draw, erase, clear, draw again, rename, add.
  await page.getByRole('button', { name: 'Capture', exact: true }).click()
  await page.getByRole('menuitem', { name: /Browser page/ }).click()
  await expect(review).toBeVisible()
  await expect(review.getByText(/^http:\/\/127\.0\.0\.1:\d+\/one$/)).toBeVisible()
  await scribble()
  expect(await inked()).toBeGreaterThan(50)
  await review.getByRole('button', { name: 'Clear' }).click()
  expect(await inked()).toBe(0)
  await scribble()
  const before = await inked()
  await review.getByRole('button', { name: 'Eraser' }).click()
  await scribble()
  expect(await inked()).toBeLessThan(before)
  await review.getByRole('button', { name: 'Red' }).click()
  await scribble()
  await review.getByLabel('Name').fill('test page')
  await rocket.capture('capture-review')
  await review.getByRole('button', { name: 'Add to draft' }).click()
  await expect(review).toHaveCount(0)
  await expect(page.locator('.is-draft .image-attachment')).toHaveCount(1)
  await expect(page.locator('.is-draft .image-name')).toHaveText('test page.png')
  await expect(page.locator('.attachment-notice')).toContainText('Nothing was sent')

  // Another app's window: the picker lists what desktopCapturer finds; cancelling a review changes nothing.
  await page.getByRole('button', { name: 'Capture', exact: true }).click()
  await page.getByRole('menuitem', { name: /Another app/ }).click()
  const picker = page.getByRole('dialog', { name: 'Capture a window or screen' })
  await expect(picker).toBeVisible()
  await expect(picker.getByText('Looking for windows…')).toHaveCount(0)
  const sources = picker.locator('.capture-source')
  if (await sources.count()) {
    await rocket.capture('capture-picker')
    await sources.first().click()
    await expect(review).toBeVisible()
    await review.getByRole('button', { name: 'Cancel', exact: true }).last().click()
  } else {
    await picker.getByRole('button', { name: 'Cancel', exact: true }).last().click()
  }
  await expect(page.locator('.is-draft .image-attachment')).toHaveCount(1)

  // A region: Craft Studio steps aside, a window over the frozen screen takes the drag.
  await page.getByRole('button', { name: 'Capture', exact: true }).click()
  const overlay = app.waitForEvent('window')
  await page.getByRole('menuitem', { name: /Select a region/ }).click()
  const region = await overlay
  await region.waitForLoadState()
  await region.mouse.move(100, 100)
  await region.mouse.down()
  await region.mouse.move(300, 220, { steps: 5 })
  await region.mouse.up()
  await expect(region.locator('#size')).toHaveText(/^\d+ × \d+ px$/)
  // Enter finishes the selection, and the region window closes while the key is still going down.
  await region.keyboard.press('Enter').catch(() => {})
  await expect(review).toBeVisible()
  await expect(review.getByText(/^\d+ × \d+ px/)).toHaveText(/^200 × 120 px/)
  await review.getByRole('button', { name: 'Add to draft' }).click()
  await expect(page.locator('.is-draft .image-attachment')).toHaveCount(2)

  // Sent, the provider receives both images; the drawing is in the first one's pixels.
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('What is on these?')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.prose').last()).toHaveText('Received 2 image(s).')
  const request = JSON.parse(await readFile(join(rocket.profile, 'ui-request.json'), 'utf8')) as { attachments: Array<{ name: string; path: string }> }
  expect(request.attachments.map((each) => each.name)).toEqual(['test page.png', expect.stringMatching(/^Region .*\.png$/)])
  const red = await app.evaluate(({ nativeImage }, path) => {
    const image = nativeImage.createFromPath(path)
    const bitmap = image.toBitmap()
    let count = 0
    for (let i = 0; i < bitmap.length; i += 4) if (bitmap[i + 2]! > 200 && bitmap[i + 1]! < 90 && bitmap[i]! < 90) count++
    return count
  }, request.attachments[0]!.path)
  expect(red).toBeGreaterThan(20)
  await rocket.capture('capture-sent')
})
