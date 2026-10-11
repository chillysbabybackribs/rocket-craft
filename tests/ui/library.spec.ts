import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect, section } from './app'
import { jpegBase64 } from '../fixtures/image'
import { pdfBytes } from '../fixtures/pdf'

// The library (docs/library-plan.md, slice 1): a chat's attachments and the files it opens are on
// the shelf with real previews, the filters and search narrow it, a card opens beside the chat and
// goes back, and the app map and library_list see the same shelf.
test('the library shelves a chat’s files, filters them, and opens one beside the chat', async ({ rocket }) => {
  const { page, workspace } = rocket
  await writeFile(join(workspace, 'plan.md'), '# Library plan\n\nShip the grid first, then the viewers.\n')
  await page.locator('.composer-folder').click()
  await page.locator('.image-file-input').setInputFiles([
    { name: 'onboarding-brief.pdf', mimeType: 'application/pdf', buffer: pdfBytes('Invite your first teammate') },
    { name: 'invite.ts', mimeType: 'text/plain', buffer: Buffer.from('export function inviteMember(email: string) {}\n') },
    { name: 'clipboard.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpegBase64, 'base64') }
  ])
  await expect(page.locator('.is-draft .file-attachment')).toHaveCount(2)
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Here is the [Plan](plan.md) and the brief.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.prose').last()).toHaveText('Received 1 image(s) and 2 file(s).')
  await page.getByRole('link', { name: 'Plan', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Artifact preview' })).toBeVisible()

  const library = page.getByRole('complementary', { name: 'Library', exact: true })
  await test.step('The toolbar opens the shelf: the attachments and the opened plan, with previews', async () => {
    await (await section(page, 'Library')).click()
    await expect(library).toBeVisible()
    await expect(library.locator('.lib-card')).toHaveCount(4)
    await expect(library.locator('.lib-count')).toHaveText('4 of 4')
    await expect(library.getByRole('button', { name: 'Open onboarding-brief.pdf' }).locator('.lib-thumb.is-page img')).toBeVisible()
    await expect(library.getByRole('button', { name: 'Open plan.md' }).locator('.lib-text-page')).toContainText('Library plan')
    await expect(library.getByRole('button', { name: 'Open clipboard.jpg' }).locator('.lib-thumb.is-cover img')).toBeVisible()
    await rocket.capture('library-grid')
  })

  await test.step('A filter shows its counts, narrows the grid and leaves a chip; search narrows too', async () => {
    await library.getByRole('button', { name: 'Kind', exact: true }).click()
    await expect(library.getByRole('option', { name: /^PDF/ })).toContainText('1')
    await rocket.capture('library-filter-menu')
    await library.getByRole('option', { name: /^PDF/ }).click()
    await expect(library.locator('.lib-card')).toHaveCount(1)
    await expect(library.locator('.lib-chip')).toContainText('PDF')
    await library.getByRole('button', { name: 'Clear filters', exact: true }).click()
    await expect(library.locator('.lib-card')).toHaveCount(4)
    await library.getByRole('textbox', { name: 'Search the library' }).fill('invite')
    await expect(library.locator('.lib-card')).toHaveCount(1)
    await expect(library.locator('.lib-name')).toHaveText('invite.ts')
    await library.getByRole('button', { name: 'Remove the search filter' }).click()
    await expect(library.locator('.lib-card')).toHaveCount(4)
  })

  await test.step('The list shows the same files', async () => {
    await library.getByRole('button', { name: 'List', exact: true }).click()
    await expect(library.locator('.lib-list tbody tr')).toHaveCount(4)
    await rocket.capture('library-list')
    await library.getByRole('button', { name: 'Grid', exact: true }).click()
  })

  await test.step('A card opens beside the chat, and Library goes back to the grid', async () => {
    await library.getByRole('button', { name: 'Open onboarding-brief.pdf' }).click()
    const file = page.getByRole('region', { name: 'Library file' })
    await expect(file.locator('.attachment-page')).toHaveCount(1)
    await rocket.capture('library-open-pdf')
    await file.getByRole('button', { name: 'Library', exact: true }).click()
    await expect(library.locator('.lib-card.is-selected .lib-name')).toHaveText('onboarding-brief.pdf')
  })

  await test.step('The app map and library_list see the same shelf', async () => {
    const went = await page.evaluate(() => window.rocketMap.go('library', { kind: 'markdown' }))
    expect(went.ok).toBe(true)
    expect(went.where.library).toMatchObject({ shown: 1, total: 4, filters: { kind: 'markdown' } })
    await expect(library.locator('.lib-card')).toHaveCount(1)
    const refused = await page.evaluate(() => window.rocketMap.go('library', { kind: 'spreadsheet' }))
    expect(refused.ok ? '' : refused.error).toContain('kind is one of')
    const cleared = await page.evaluate(() => window.rocketMap.act('library.clear'))
    expect(cleared.where.library?.shown).toBe(4)

    const state = JSON.parse(await readFile(join(rocket.profile, 'tool-channel.json'), 'utf8')) as { port: number; secret: string }
    const response = await fetch(`http://127.0.0.1:${state.port}/mcp/${state.secret}/claude/library-check`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'library_list', arguments: { kind: 'pdf' } } })
    })
    const payload = await response.json() as { result: { isError?: boolean; content: Array<{ text?: string }> } }
    expect(payload.result.isError).toBeFalsy()
    expect(payload.result.content[0]!.text).toMatch(/^1 of 4 files/)
    expect(payload.result.content[0]!.text).toContain('onboarding-brief.pdf')
  })
})
