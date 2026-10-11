import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './app'

// A finished turn says what it changed in one line, and the line opens the diff beside the chat.
test('a turn\'s changes show as one line that opens the diff beside the chat', async ({ rocket }) => {
  const { page, workspace } = rocket
  const git = (...args: string[]): string => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim()
  await writeFile(join(workspace, 'notes.md'), '# notes-api\n\nA tiny API for plain notes.\n')
  git('init', '-q')
  git('-c', 'user.name=UI', '-c', 'user.email=ui@test', 'add', '-A')
  git('-c', 'user.name=UI', '-c', 'user.email=ui@test', 'commit', '-q', '-m', 'start')

  await page.locator('.composer-folder').click()
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('UI check: edit')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.prose').last()).toContainText('Added a login check')

  const line = page.locator('.changes-line')
  await expect(line).toContainText('Changed 2 files')
  await expect(line.locator('.counts .is-add')).toHaveText('+6')
  await expect(line.locator('.counts .is-del')).toHaveText('−1')
  await rocket.capture('changes-line')

  await line.click()
  const panel = page.getByRole('region', { name: 'Turn changes' })
  await expect(panel.getByRole('tab')).toHaveCount(2)
  await expect(panel.locator('.diff-file-head').first()).toContainText('auth.js')
  await expect(panel.locator('.diff-file-head').first().locator('.diff-kind')).toHaveText('new')
  await expect(panel.locator('.diff-line.is-del')).toHaveText(/plain notes/)
  await expect(panel.locator('.diff-line.is-add').filter({ hasText: 'notes with login' })).toHaveCount(1)
  await expect(line).toHaveAttribute('aria-pressed', 'true')
  await rocket.capture('changes-panel')

  // The panel's file strip jumps to a file; the browser is not shown while the diff is.
  await panel.getByRole('tab', { name: /notes\.md/ }).click()
  await expect(panel.getByRole('tab', { name: /notes\.md/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('region', { name: 'Browser', exact: true })).toHaveCount(0)

  // Undo asks once, naming the files, and Keep changes nothing.
  await panel.getByRole('button', { name: 'Undo this turn' }).click()
  const confirm = panel.getByRole('alertdialog', { name: 'Undo this turn' })
  await expect(confirm).toContainText('Put auth.js and notes.md back as they were before this turn?')
  await confirm.getByRole('button', { name: 'Keep' }).click()
  await expect(confirm).toHaveCount(0)
  assert.equal(existsSync(join(workspace, 'auth.js')), true)

  // Undo puts the files back, and the turn says so in the chat and the panel.
  await panel.getByRole('button', { name: 'Undo this turn' }).click()
  await confirm.getByRole('button', { name: 'Undo' }).click()
  await expect(panel.locator('.undo-note.is-done')).toHaveText('Undone')
  await expect(panel.locator('.undo-strip')).toContainText('These changes were undone')
  await expect(line.locator('.undone-tag')).toHaveText('undone')
  assert.equal(existsSync(join(workspace, 'auth.js')), false, 'the file the turn made is gone')
  assert.equal(await readFile(join(workspace, 'notes.md'), 'utf8'), '# notes-api\n\nA tiny API for plain notes.\n', 'the file is as it was')
  await rocket.capture('changes-undone')
  await page.getByRole('button', { name: 'Close artifact' }).click()
  await expect(panel).toHaveCount(0)
})
