import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from './app'

test('chat links open browser tabs and local artifacts beside the conversation', async ({ rocket }) => {
  const { page, workspace, origin } = rocket
  await writeFile(join(workspace, 'notes with spaces.md'), '# File preview\n\n[Source](./source.ts:2)')
  await writeFile(join(workspace, 'source.ts'), 'const first = 1\nconst second = 2')
  await writeFile(join(workspace, 'preview.html'), '<!doctype html><title>Local artifact</title><h1>Local preview</h1>')
  await page.locator('.composer-folder').click()
  const local = pathToFileURL(join(workspace, 'preview.html')).href
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(`[Website](${origin}/two)\n\n[Notes](<notes with spaces.md>)\n\n[HTML](${local})\n\n\`source.ts:2\`\n\n[Missing](missing.txt)\n\nUI check: stream`)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.prose').last()).toContainText('Streaming from')
  await rocket.release()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: 'Website', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Browser', exact: true })).toBeVisible()
  await expect(page.locator('.btab.is-active')).toHaveText('UI page two')
  await expect(page.locator('.btab')).toHaveCount(2)
  await page.getByRole('link', { name: 'Notes', exact: true }).click()
  const artifact = page.getByRole('region', { name: 'Artifact preview' })
  await expect(artifact.getByRole('heading', { name: 'File preview' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Browser', exact: true })).toHaveCount(0)
  await artifact.getByRole('link', { name: 'Source' }).click()
  await expect(artifact.locator('.is-selected')).toContainText('const second = 2')
  await rocket.capture('chat-file-preview')
  await page.getByRole('button', { name: 'Close artifact' }).click()
  await expect(page.locator('.btab.is-active')).toHaveText('UI page two')
  await page.getByRole('link', { name: 'HTML', exact: true }).click()
  await expect(page.locator('.btab.is-active')).toHaveText('Local artifact')
  await page.getByRole('link', { name: 'source.ts:2', exact: true }).click()
  await expect(artifact.locator('.is-selected')).toContainText('const second = 2')
  await page.getByRole('link', { name: 'Missing', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Check that the file exists')
  await expect(artifact).toBeVisible()
})
