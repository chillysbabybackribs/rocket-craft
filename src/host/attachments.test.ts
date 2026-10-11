import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { jpegBase64 } from '../../tests/fixtures/image.ts'
import { pdfBytes } from '../../tests/fixtures/pdf.ts'
import { AttachmentStore, decodeText, inspectImage, validateAttachments } from './attachments.ts'
import { Store } from './store.ts'
import { attachmentInput, claudeImageContent, codexImageContent, cursorImageContent } from './providers/images.ts'

test('images are validated by bytes and round-trip through SQLite and files after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocket-images-'))
  let store = new Store(join(root, 'rocket.db'))
  try {
    const bytes = Buffer.from(jpegBase64, 'base64')
    const images = new AttachmentStore(store, join(root, 'attachments'))
    const image = await images.import('../../screenshot.png', bytes, bytes)
    assert.equal(image.name, 'screenshot.png')
    assert.equal(image.mimeType, 'image/jpeg')
    assert.equal(image.width, 2)
    assert.throws(() => images.resolve(['../../etc/passwd']), /no longer available/)
    assert.throws(() => inspectImage(Buffer.from('<svg></svg>')), /valid PNG/)
    assert.throws(() => inspectImage(new Uint8Array(6 * 1024 * 1024)), /5 MB/)
    assert.throws(() => validateAttachments(Array(11).fill(image)), /at most 10/)
    store.close()
    store = new Store(join(root, 'rocket.db'))
    const reopened = new AttachmentStore(store, join(root, 'attachments'))
    assert.equal(await reopened.read(image.id), `data:image/jpeg;base64,${jpegBase64}`)
    const [resolved] = reopened.resolve([image.id])
    assert.deepEqual(await readFile(resolved.path), bytes)
    assert.equal(claudeImageContent('Look', [resolved])[1].type, 'image')
    assert.equal((claudeImageContent('Look', [resolved])[1] as { source: { data: string } }).source.data, jpegBase64)
    assert.equal((cursorImageContent('Look', [resolved])[1] as { data: string }).data, jpegBase64)
    assert.deepEqual(codexImageContent('Look', [resolved])[1], { type: 'localImage', path: resolved.path })
    const history = attachmentInput('Compare', Array.from({ length: 12 }, (_, index) => ({ ...resolved, id: `image-${index}` })))
    assert.equal(history.images.length, 10)
    assert.match(history.text, /read this file if needed/)
    const references = attachmentInput('History', [resolved], false)
    assert.equal(references.images.length, 0)
    assert.doesNotMatch(references.text, /included below/)
    assert.equal(store.unusedAttachments([image.id], Date.now() + 1000).length, 0)
    store.saveQueue('queued-chat', [{ id: 'queued', provider: 'claude', model: null, text: '', attachments: [image] }])
    assert.equal(store.unusedAttachments([], Date.now() + 1000).length, 0)
    store.saveQueue('queued-chat', [])
    assert.deepEqual(store.unusedAttachments([], Date.now() + 1000).map(entry => entry.id), [image.id])
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('PDFs and text files are stored by content, previewed, and given to providers as text within a budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rocket-files-'))
  let store = new Store(join(root, 'rocket.db'))
  try {
    const files = new AttachmentStore(store, join(root, 'attachments'))
    const code = await files.importFile('src/invite.ts', Buffer.from('export const role = "member"\nconsole.log(role)\n'))
    assert.deepEqual([code.kind, code.format, code.name, code.lines], ['file', 'text', 'invite.ts', 2])
    const pdf = await files.importFile('brief.pdf', pdfBytes('Invite your team'))
    assert.deepEqual([pdf.format, pdf.pages], ['pdf', 1])
    assert.ok(pdf.chars > 0)
    const scanned = await files.importFile('scan.pdf', pdfBytes(null))
    assert.equal(scanned.chars, 0)
    await assert.rejects(files.importFile('archive.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff])), /not an image, PDF or text file/)
    await assert.rejects(files.importFile('empty.txt', new Uint8Array()), /empty/)
    await assert.rejects(files.importFile('broken.pdf', Buffer.from('%PDF-1.4 nothing else')), /could not be read as a PDF/)
    assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])), 'hi')
    assert.equal(decodeText(Buffer.from('a\0b')), null)
    assert.throws(() => validateAttachments([{ ...code, size: 30 * 1024 * 1024 }, { ...pdf, size: 30 * 1024 * 1024 }]), /50 MB/)
    await assert.rejects(files.read(code.id), /Only images/)

    store.close()
    store = new Store(join(root, 'rocket.db'))
    const reopened = new AttachmentStore(store, join(root, 'attachments'))
    const text = await reopened.preview(code.id)
    assert.deepEqual(text, { type: 'text', text: 'export const role = "member"\nconsole.log(role)\n', truncated: false })
    const pages = await reopened.preview(pdf.id)
    assert.equal(pages.type, 'pdf')
    assert.equal(pages.type === 'pdf' && pages.pages.length, 1)
    assert.match(pages.type === 'pdf' ? pages.pages[0] : '', /^data:image\/jpeg;base64,/)

    const resolved = reopened.resolve([code.id, pdf.id, scanned.id])
    assert.match(resolved[0].path, /\.ts$/)
    const input = attachmentInput('Does this cover the brief?', resolved)
    assert.equal(input.images.length, 0)
    assert.match(input.text, /^Does this cover the brief\?/)
    assert.match(input.text, /"invite\.ts"; text, 2 lines; file .*; contents below/)
    assert.match(input.text, /<file name="invite\.ts" attachment="[^"]+">\nexport const role/)
    assert.match(input.text, /"brief\.pdf"; PDF, 1 page; .*extracted text below/)
    assert.match(input.text, /Invite your team/)
    assert.match(input.text, /"scan\.pdf".*no text could be extracted/)
    // Files go to every provider as text, so Antigravity's text-only route still carries them.
    assert.match(attachmentInput('', resolved, false).text, /Invite your team/)
    assert.equal(claudeImageContent('Look', resolved).length, 1)
    assert.equal(codexImageContent('Look', resolved).length, 1)
    assert.equal(cursorImageContent('Look', resolved).length, 1)

    const big = await reopened.importFile('big.log', Buffer.from('x'.repeat(70_000)))
    const budgeted = attachmentInput('', reopened.resolve([big.id, big.id, code.id]))
    assert.match(budgeted.text, /Truncated at 60000 of 70000 characters/)
    assert.match(budgeted.text, /Truncated at 60000 of 70000[\s\S]*Truncated at 60000 of 70000/)
    assert.match(budgeted.text, /"invite\.ts".*read this file if needed/)

    // Save as copies the stored original byte for byte; a relative or unwritable path is refused.
    await reopened.export(pdf.id, join(root, 'saved.pdf'))
    assert.deepEqual(await readFile(join(root, 'saved.pdf')), pdfBytes('Invite your team'))
    await assert.rejects(reopened.export(pdf.id, 'saved.pdf'), /Choose where to save/)
    await assert.rejects(reopened.export(pdf.id, join(root, 'missing-folder', 'saved.pdf')), /could not be saved there/)
    // Failed imports leave nothing behind; a PDF keeps its extracted text and rendered pages beside it.
    const stored = await readdir(join(root, 'attachments'))
    const ids = new Set([code.id, pdf.id, scanned.id, big.id])
    assert.ok(stored.every(name => ids.has(name.split('.')[0])))
    assert.ok(stored.includes(`${pdf.id}.extracted.txt`) && stored.includes(`${pdf.id}.pages`))
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
