import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { researchTools } from './research.ts'
import { webReadProblem } from '../../shared/web-evidence.ts'

const context = { provider: 'claude' as const, chatId: 'research-test' }
const article = '<html><head><title>Research result</title></head><body><article><h1>Research result</h1><p>' + 'A measured primary research finding with documented limitations. '.repeat(30) + '</p><a href="/paper">Paper</a></article></body></html>'
const output = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map(c => c.text || '').join('\n')

test('shared reader returns original article and links, saves pagination, credits only successful sources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'research-'))
  try {
    const opened: string[] = []
    const tools = researchTools({ request: async () => { throw new Error('Browser should not be needed') } }, dir, () => dir, (_, url) => opened.push(url), async () => new Response(article, { headers: { 'content-type': 'text/html' } }))
    for (const provider of ['claude', 'codex', 'cursor', 'antigravity'] as const) {
      const result = await tools[0]!.run({ url: 'https://example.org/result', max: 300 }, { ...context, provider })
      assert.ok(!result.isError)
      assert.match(output(result), /Measured|measured/)
      const path = output(result).match(/Saved text: (.+)/)![1]!
      const more = await tools[0]!.run({ path, offset: 300, max: 1000 }, context)
      assert.match(output(more), /Characters 300–1300/)
    }
    assert.equal(opened.length, 4)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('403 falls back to browser, but a challenge is an explicit failure with no source credit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'research-'))
  try {
    let body = '# Just a moment...\nhttps://example.org/ · tab t1'
    const opened: string[] = []
    const tools = researchTools({ request: async () => body }, dir, () => dir, (_, url) => opened.push(url), async () => new Response('', { status: 403 }))
    const blocked = await tools[0]!.run({ url: 'https://example.org/' }, context)
    assert.equal(blocked.isError, true)
    assert.match(output(blocked), /HTTP 403/)
    assert.deepEqual(opened, [])
    body = '# Research\n' + 'Verified source text. '.repeat(30)
    const recovered = await tools[0]!.run({ url: 'https://example.org/' }, context)
    assert.ok(!recovered.isError)
    assert.match(output(recovered), /browser: readable/)
    assert.equal(opened.length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('search switches engines after a challenge and never credits result destinations', async () => {
  const seen: string[] = []
  const tools = researchTools({ request: async op => {
    if (op.op !== 'read') throw new Error('Unexpected operation')
    seen.push(op.url!)
    return op.url!.includes('google') ? '# Just a moment...' : '# Search results\n' + 'Example research https://example.org/paper '.repeat(10)
  } }, tmpdir(), () => null, () => { throw new Error('Search must not count as a source') })
  const result = await tools[1]!.run({ query: 'site:example.org research' }, context)
  assert.ok(!result.isError)
  assert.equal(seen.length, 2)
  assert.match(output(result), /Unverified search leads from bing/)
})

test('local PDF is extracted with poppler without requiring a model or network', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'research-'))
  try {
    // Minimal real PDF; Poppler reconstructs the absent xref table.
    const path = join(dir, 'paper.pdf')
    const sentence = 'A primary research document with enough readable text to verify that PDF extraction works without binary content reaching the model.'
    const stream = `BT /F1 12 Tf 40 100 Td (${sentence}) Tj ET`
    await writeFile(path, `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 1200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n5 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF`)
    const tools = researchTools({ request: async () => { throw new Error('No browser') } }, dir)
    const result = await tools[0]!.run({ path }, context)
    assert.ok(!result.isError, output(result))
    assert.match(output(result), /local\+pdf/)
    assert.match(output(result), /primary research document/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('failure detector recognizes the incident without rejecting articles discussing access failures', () => {
  for (const text of ['', '# Just a moment...', 'The server returned HTTP 403 Forbidden.', 'This is a raw PDF file dump: compressed binary streams.']) assert.ok(webReadProblem(text))
  assert.equal(webReadProblem('# How to handle HTTP 403\nAn article about CAPTCHA and access denied errors.'), null)
})
