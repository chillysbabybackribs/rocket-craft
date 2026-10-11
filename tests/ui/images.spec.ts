import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test, expect, section } from './app'
import { jpegBase64 } from '../fixtures/image'
import { pdfBytes } from '../fixtures/pdf'
import { finishWorker, leaderId } from './orch.ts'

const small = { name: 'clipboard.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpegBase64, 'base64') }

test('image uploads, queue editing, Stop and restart preserve the whole message', async ({ rocket }) => {
  let page = rocket.page
  await page.locator('.composer-folder').click()
  const choice = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Attach files', exact: true }).click()
  await (await choice).setFiles(resolve('tests/fixtures/photo.png'))
  await expect(page.locator('.is-draft .image-thumbnail img')).toHaveCount(1)
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Compare this screen')
  await rocket.capture('images-draft')
  await rocket.restart()
  page = rocket.page
  await expect(page.locator('.is-draft .image-thumbnail img')).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Compare this screen')
  await (await section(page, 'Browser')).click()
  await page.getByRole('button', { name: 'Preview photo.png' }).click()
  await expect(page.locator('dialog[open] > img')).toBeVisible()
  await rocket.capture('images-preview-with-browser')
  await page.keyboard.press('Escape')
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await (await section(page, 'Browser')).click()
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('UI check: stream')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.prose')).toContainText('Streaming from claude.')
  await expect(page.locator('.user-message > .image-attachments .image-thumbnail')).toHaveCount(1)
  await expect(page.locator('.user-bubble .image-thumbnail')).toHaveCount(0)
  await expect(page.locator('.user-message > .user-bubble')).toHaveText('UI check: stream')
  await rocket.capture('images-separate-prompt')
  await page.locator('.image-file-input').setInputFiles(small)
  await expect(page.locator('.is-draft .image-thumbnail')).toHaveCount(1)
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this reference too')
  await page.getByRole('button', { name: 'Send when the turn ends', exact: true }).click()
  await expect(page.locator('.steer.is-waiting .image-thumbnail')).toHaveCount(1)
  await page.locator('.steer.is-waiting').getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Keep this reference too')
  await expect(page.locator('.is-draft .image-thumbnail')).toHaveCount(1)
  await page.getByRole('button', { name: 'Send when the turn ends', exact: true }).click()
  await expect(page.locator('.steer.is-waiting .image-thumbnail')).toHaveCount(1)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.locator('.steer.is-waiting')).toHaveCount(0)
  await expect(page.locator('.is-draft .image-thumbnail')).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Keep this reference too')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  // Image-only messages need no invented user text.
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.prose').last()).toHaveText('Received 1 image(s).')
  await rocket.restart()
  page = rocket.page
  await expect(page.locator('.user-message > .image-attachments .image-thumbnail img')).toHaveCount(2)
  await page.getByRole('button', { name: 'Preview clipboard.jpg' }).click()
  await expect(page.locator('dialog[open] > img')).toBeVisible()
  await page.keyboard.press('Escape')
  const request = JSON.parse(await readFile(join(rocket.profile, 'ui-request.json'), 'utf8'))
  expect(request.attachments[0].name).toBe('clipboard.jpg')
  expect(await readFile(request.attachments[0].path)).toEqual(small.buffer)
  await rocket.capture('images-sent-after-restart')
})

// Drops belong to the orchestrator pane. The expanded worker's reply box is text only
// (OrchestratorShell WorkerReply); a drag over it must not attach the file to the left chat.
test('paste and drop target the orchestrator pane, reject invalid files and retain unsupported drafts', async ({ rocket }) => {
  const { page } = rocket
  await page.locator('.composer-folder').click()
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('UI check: good evening')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.prose').last()).toHaveText('Good evening.')
  const worker = await finishWorker(page, rocket.profile, await leaderId(page), 'Watch a drop on the orchestrator')
  await page.evaluate((chatId) => window.rocketMap.act('worker.expand', { chatId }), worker.chatId)
  const leader = page.locator('.pane')
  const expanded = page.getByTestId('worker-expanded')
  await expect(expanded).toBeVisible()
  const data = await page.evaluateHandle(base64 => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'dropped.jpg', { type: 'image/jpeg' }))
    return transfer
  }, jpegBase64)
  await expanded.dispatchEvent('dragover', { dataTransfer: data })
  await expect(expanded.locator('.image-drop-target')).toHaveCount(0)
  await expect(leader.locator('.is-draft .image-thumbnail')).toHaveCount(0)
  await leader.dispatchEvent('dragover', { dataTransfer: data })
  await expect(leader.locator('.image-drop-target')).toBeVisible()
  await expect(expanded.locator('.image-drop-target')).toHaveCount(0)
  await rocket.capture('images-drop-orchestrator')
  await leader.dispatchEvent('drop', { dataTransfer: data })
  await expect(leader.locator('.is-draft .image-thumbnail')).toHaveCount(1)
  await expect(expanded.locator('.is-draft .image-thumbnail')).toHaveCount(0)
  await leader.getByRole('textbox', { name: 'Message', exact: true }).evaluate((input, base64) => {
    const clipboardData = new DataTransfer()
    clipboardData.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'pasted.jpg', { type: 'image/jpeg' }))
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, jpegBase64)
  await expect(leader.locator('.is-draft .image-thumbnail')).toHaveCount(2)
  await leader.locator('.image-file-input').setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('not an image') })
  await expect(leader.getByRole('alert')).toContainText('Choose a PNG')
  await leader.getByRole('textbox', { name: 'Message', exact: true }).press('Control+4')
  // Clear the import error, leaving the provider limitation visible.
  await leader.getByRole('button', { name: 'Remove pasted.jpg' }).click()
  await leader.getByRole('button', { name: 'Remove dropped.jpg' }).click()
  await leader.locator('.image-file-input').setInputFiles(small)
  await expect(leader.getByRole('alert')).toContainText('Antigravity cannot receive images')
  await expect(leader.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await leader.getByRole('textbox', { name: 'Message', exact: true }).press('Control+2')
  await expect(leader.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await rocket.capture('images-orchestrator-draft')
})

test('queued images survive shutdown and can be sent after reopening', async ({ rocket }) => {
  let page = rocket.page
  await page.locator('.composer-folder').click()
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('UI check: stream')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.prose')).toContainText('Streaming from claude.')
  await page.locator('.image-file-input').setInputFiles(small)
  await expect(page.locator('.is-draft .image-thumbnail')).toHaveCount(1)
  await page.getByRole('button', { name: 'Send when the turn ends', exact: true }).click()
  await expect(page.locator('.steer.is-waiting .image-thumbnail')).toHaveCount(1)
  await rocket.restart()
  page = rocket.page
  await expect(page.locator('.steer.is-waiting .image-thumbnail')).toHaveCount(1)
  await page.locator('.steer.is-waiting').getByRole('button', { name: 'Send now' }).click()
  await expect(page.locator('.steer.is-waiting')).toHaveCount(0)
  await expect(page.locator('.prose').last()).toHaveText('Received 1 image(s).')
})

test('PDF and code files attach beside images, preview in the side panel, and reach the provider as text after restart', async ({ rocket }) => {
  let page = rocket.page
  await page.locator('.composer-folder').click()
  const code = { name: 'invite.ts', mimeType: 'video/mp2t', buffer: Buffer.from('export async function inviteMember(email: string) {\n  return fetch(`/api/invites/${email}`)\n}\n') }
  await page.locator('.image-file-input').setInputFiles([{ name: 'onboarding-brief.pdf', mimeType: 'application/pdf', buffer: pdfBytes('Invite your first teammate') }, code, small])
  await expect(page.locator('.is-draft .file-attachment')).toHaveCount(2)
  await expect(page.locator('.is-draft .image-thumbnail img')).toHaveCount(1)
  await expect(page.locator('.is-draft .file-copy small').first()).toHaveText(/^PDF · 1 page · \d/)
  await page.getByRole('button', { name: 'Preview onboarding-brief.pdf' }).click()
  await expect(page.getByRole('region', { name: 'File preview' }).locator('.attachment-page')).toHaveCount(1)
  await page.getByRole('button', { name: 'Preview invite.ts' }).click()
  await expect(page.locator('.attachment-text')).toContainText('inviteMember')
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Does this implementation cover the brief?')
  await rocket.capture('files-draft-preview')
  await page.locator('.image-file-input').setInputFiles({ name: 'archive.zip', mimeType: 'application/zip', buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe]) })
  await expect(page.getByRole('alert')).toContainText('archive.zip is not an image, PDF or text file')
  await expect(page.locator('.is-draft .file-attachment')).toHaveCount(2)
  await page.getByRole('button', { name: 'Close artifact' }).click()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.prose').last()).toHaveText('Received 1 image(s) and 2 file(s).')
  await expect(page.locator('.user-message > .image-attachments .file-attachment')).toHaveCount(2)
  await expect(page.locator('.user-message > .user-bubble')).toHaveText('Does this implementation cover the brief?')
  const request = JSON.parse(await readFile(join(rocket.profile, 'ui-request.json'), 'utf8'))
  expect(request.attachments.map((each: { kind: string }) => each.kind)).toEqual(['file', 'file', 'image'])
  expect(request.input).toContain('Invite your first teammate')
  expect(request.input).toContain('export async function inviteMember')
  await rocket.restart()
  page = rocket.page
  await expect(page.locator('.user-message > .image-attachments .file-attachment')).toHaveCount(2)
  await page.getByRole('button', { name: 'Preview onboarding-brief.pdf' }).click()
  await expect(page.locator('.attachment-page')).toHaveCount(1)
  await rocket.capture('files-sent-after-restart')
  // Antigravity takes files as text, so a file-only draft can be sent to it.
  await page.getByRole('button', { name: 'Close artifact' }).click()
  await page.locator('.image-file-input').setInputFiles(code)
  await page.getByRole('textbox', { name: 'Message', exact: true }).press('Control+4')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

// Copy to another chat is the worker chat on the board: the menu lists it under Recent, and a
// drag from its expanded transcript lands on the orchestrator pane. The worker reply box does not
// accept a drop; the copy is that chat's draft, shown when history opens it on the left.
test('an attachment is copied to a worker chat by menu or drag, saved, revealed, and outlives its source chat', async ({ rocket }) => {
  let page = rocket.page
  await page.locator('.composer-folder').click()
  const brief = pdfBytes('Invite your first teammate')
  await page.locator('.image-file-input').setInputFiles({ name: 'onboarding-brief.pdf', mimeType: 'application/pdf', buffer: brief })
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Here is the brief')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.prose').last()).toHaveText('Received 1 file(s).')
  const leader = await leaderId(page)
  const worker = await finishWorker(page, rocket.profile, leader, 'Reuse the onboarding brief')
  const source = page.locator('.pane')
  const sent = source.locator('.user-message .file-attachment')
  const notice = page.locator('.attachment-notice')
  const openWorker = async () => {
    const shown = await page.evaluate((chatId) => window.rocketMap.act('chat.open', { chatId }), worker.chatId)
    expect(shown.ok, shown.ok ? '' : shown.error).toBe(true)
  }
  const openLeader = async () => {
    const shown = await page.evaluate((chatId) => window.rocketMap.act('chat.open', { chatId }), leader)
    expect(shown.ok, shown.ok ? '' : shown.error).toBe(true)
  }

  // The ⋯ menu lists this pane as This chat and the worker under Recent. There is no New chat row.
  await sent.hover()
  await source.getByRole('button', { name: 'More for onboarding-brief.pdf' }).click()
  await expect(page.getByRole('menu', { name: 'onboarding-brief.pdf' })).toBeVisible()
  await rocket.capture('reuse-menu')
  await page.getByRole('menuitem', { name: 'Copy to chat' }).click()
  await expect(page.locator('.attachment-chat').filter({ hasText: 'This chat' })).toHaveCount(1)
  await expect(page.locator('.attachment-chat').filter({ hasText: 'Pane 2' })).toHaveCount(0)
  await expect(page.locator('.attachment-chat').filter({ hasText: 'New chat' })).toHaveCount(0)
  await rocket.capture('reuse-picker')
  // The host retitles the worker from its assignment prompt, so the row is the one recent chat.
  const workerChat = () => page.locator('.attachment-chat').filter({ hasNotText: 'This chat' })
  await expect(workerChat()).toHaveCount(1)
  await workerChat().click()
  await expect(notice).toContainText('Copied onboarding-brief.pdf')
  await notice.getByRole('button', { name: 'Undo' }).click()
  await expect(notice).toContainText('Undone')
  await openWorker()
  await expect(page.locator('.pane .is-draft .file-attachment')).toHaveCount(0)

  // Copying keeps the destination's text, which lives in that chat's draft.
  await page.locator('.pane').getByRole('textbox', { name: 'Message', exact: true }).fill('Use the same brief here')
  await openLeader()
  await sent.hover()
  await source.getByRole('button', { name: 'More for onboarding-brief.pdf' }).click()
  await page.getByRole('menuitem', { name: 'Copy to chat' }).click()
  await workerChat().click()
  await openWorker()
  const draft = page.locator('.pane .is-draft .file-attachment')
  await expect(draft).toHaveCount(1)
  await expect(page.locator('.pane').getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Use the same brief here')
  await rocket.capture('reuse-copied')
  // Right-click opens the same menu; copying again says it is already there.
  await openLeader()
  await sent.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy to chat' }).click()
  await workerChat().click()
  await expect(notice).toContainText('already in')
  await openWorker()
  await expect(draft).toHaveCount(1)
  await page.locator('.pane').getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.prose').last()).toHaveText('Received 1 file(s).')

  // Drag from the expanded worker's transcript onto the orchestrator composer.
  await openLeader()
  await page.evaluate((chatId) => window.rocketMap.act('worker.expand', { chatId }), worker.chatId)
  const expanded = page.getByTestId('worker-expanded')
  await expect(expanded.locator('.file-open')).toBeVisible()
  await expanded.locator('.file-open').dragTo(source.locator('.composer'))
  await expect(source.locator('.is-draft .file-attachment')).toHaveCount(1)
  await expect(notice).toContainText('Copied onboarding-brief.pdf')
  await notice.getByRole('button', { name: 'Undo' }).click()
  await expect(source.locator('.is-draft .file-attachment')).toHaveCount(0)
  await page.getByRole('button', { name: 'Close expanded worker', exact: true }).click()

  // Save as writes the stored original; Reveal shows only Craft Studio's own copy.
  const saved = join(rocket.profile, 'saved-brief.pdf')
  await rocket.app.evaluate(({ dialog, shell }, path) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as unknown as typeof dialog.showSaveDialog
    shell.showItemInFolder = (shown: string) => { (globalThis as { revealed?: string }).revealed = shown }
  }, saved)
  await sent.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Save as…' }).click()
  await expect(notice).toContainText('Saved saved-brief.pdf')
  expect(await readFile(saved)).toEqual(brief)
  await sent.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Reveal stored file' }).click()
  await expect(notice).toContainText('stored as')
  const revealed = await rocket.app.evaluate(() => (globalThis as { revealed?: string }).revealed)
  expect(revealed).toMatch(/[/\\]attachments[/\\][0-9a-f-]+\.pdf$/)

  // Deleting the chat the file came from leaves the worker's copy usable, across a restart.
  page.once('dialog', dialog => void dialog.accept())
  await (await section(page, 'Chats')).click()
  // The delete button shows only while the row is hovered; on a visible display the real pointer
  // can take the hover away between the two steps, so hover again until the click lands.
  await expect(async () => {
    await page.locator('.chat-row').filter({ hasText: 'Here is the brief' }).hover()
    await page.getByRole('button', { name: 'Delete chat: Here is the brief' }).click({ timeout: 2_000 })
  }).toPass({ timeout: 10_000 })
  await rocket.restart()
  page = rocket.page
  const kept = page.locator('.user-message .file-attachment')
  await expect(kept).toHaveCount(1)
  await kept.locator('.file-open').click()
  await expect(page.locator('.attachment-page')).toHaveCount(1)
  await rocket.capture('reuse-after-source-deleted')
})
