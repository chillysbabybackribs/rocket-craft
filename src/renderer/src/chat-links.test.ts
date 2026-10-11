import assert from 'node:assert/strict'
import { test } from 'node:test'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { chatUrlTransform, remarkFileLinks } from './chat-links.ts'

test('markdown links, bare URLs, and code paths link without altering code blocks', () => {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFileLinks)
  const text = '[notes](<my notes.md>) https://example.com/x\n\n`src/main.ts:12` and README.md.\n\n```\nsrc/main.ts\n```'
  const tree = processor.runSync(processor.parse(text))
  const urls: string[] = []
  type LinkNode = { type: string; url?: string; children?: LinkNode[] }
  const visit = (node: LinkNode): void => {
    if (node.type === 'link') urls.push(node.url!)
    node.children?.forEach(visit)
  }
  visit(tree)
  assert.deepEqual(urls, ['my notes.md', 'https://example.com/x', 'src/main.ts:12', 'README.md'])
})

test('link transform permits local files and rejects executable schemes', () => {
  for (const url of ['file:///tmp/a.md', '/tmp/a.ts:3', 'src/main.ts', 'README.md', 'https://example.com']) assert.equal(chatUrlTransform(url), url)
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', '//example.com', '#fragment']) assert.equal(chatUrlTransform(url), '')
})
