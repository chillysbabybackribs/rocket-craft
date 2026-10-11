import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readChatLink } from './chat-links.ts'

test('chat links resolve files, encoded names, line references, and browser documents', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rocket-links-'))
  try {
    const path = join(cwd, 'my notes.md')
    await writeFile(path, '# Notes\nSecond line')
    await writeFile(join(cwd, 'page.html'), '<h1>Preview</h1>')
    const expected = { kind: 'artifact', path, text: '# Notes\nSecond line', markdown: true, line: 2 }
    assert.deepEqual(await readChatLink('./my%20notes.md:2:1', cwd), expected)
    assert.deepEqual(await readChatLink(`${pathToFileURL(path).href}#L2`, cwd), expected)
    assert.deepEqual(await readChatLink(`${path}:2`, cwd), expected)
    assert.deepEqual(await readChatLink('page.html#section', cwd), { kind: 'browser', url: `${pathToFileURL(join(cwd, 'page.html')).href}#section` })
    assert.deepEqual(await readChatLink('https://example.com/a?q=1#x', cwd), { kind: 'browser', url: 'https://example.com/a?q=1#x' })
    await assert.rejects(readChatLink('missing.txt', cwd), /Check that the file exists/)
    await mkdir(join(cwd, 'shots'))
    await writeFile(join(cwd, 'shots', 'a.png'), '')
    const folder = await readChatLink('shots', cwd)
    assert.equal(folder.kind, 'artifact')
    assert.ok(folder.kind === 'artifact' && folder.markdown && folder.text.includes(`\`${join(cwd, 'shots', 'a.png')}\``))
    await assert.rejects(readChatLink('javascript:alert(1)', cwd), /not supported/)
    await writeFile(join(cwd, 'binary.dat'), Buffer.from([0, 1, 2]))
    await assert.rejects(readChatLink('binary.dat', cwd), /binary file/)
    await writeFile(join(cwd, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65))
    await assert.rejects(readChatLink('large.txt', cwd), /too large/)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
