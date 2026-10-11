import assert from 'node:assert/strict'
import test from 'node:test'
import { citationMarks, openedUrl, pageKey, sourcesNotice, turnSources, urlsIn } from './sources.ts'

test('a page key is the host and path, with www, the fragment, a trailing slash and tracking parameters dropped', () => {
  assert.equal(pageKey('https://www.Example.com/docs/'), 'example.com/docs')
  assert.equal(pageKey('http://example.com/docs#intro'), 'example.com/docs')
  assert.equal(pageKey('https://example.com/docs?utm_source=x&page=2'), 'example.com/docs?page=2')
  assert.equal(pageKey('https://example.com/a.md'), 'example.com/a.md', 'a path is a different page from its twins')
  assert.equal(pageKey('file:///home/me/notes.md'), null)
  assert.equal(pageKey('not a url'), null)
})

test('the urls in a reply are its link targets and bare urls, each once, without trailing punctuation', () => {
  const text = 'See [the docs](https://example.com/docs?x=1) and https://example.com/docs?x=1 or https://example.org/a. Also <https://example.net/b>, twice: https://example.net/b'
  assert.deepEqual(urlsIn(text), ['https://example.com/docs?x=1', 'https://example.org/a', 'https://example.net/b'])
})

test('only requests that go to a page count as opening one', () => {
  assert.equal(openedUrl({ op: 'goto', chat: 'c', tab: 't', url: 'https://a.com' }), 'https://a.com')
  assert.equal(openedUrl({ op: 'fetch', url: 'https://a.com/x', method: null, headers: null, body: null }), 'https://a.com/x')
  assert.equal(openedUrl({ op: 'read', chat: 'c', tab: null, url: null, focus: 'all', selector: null, max: null }), null)
  assert.equal(openedUrl({ op: 'click', chat: 'c', tab: 't', target: 'e1' }), null)
})

test('a turn’s sources mark each cited page opened or not, by page, and are null with nothing to record', () => {
  const opened = [
    { url: 'https://www.example.com/docs/', via: 'browser' as const },
    { url: 'https://example.com/docs#top', via: 'provider' as const },
    { url: 'https://example.com/other', via: 'provider' as const }
  ]
  const sources = turnSources(opened, ['First https://example.com/docs.', 'Then [news](https://news.example.org/story) and https://example.com/docs again'])
  assert.deepEqual(sources, {
    opened: [{ url: 'https://www.example.com/docs/', via: 'browser' }, { url: 'https://example.com/other', via: 'provider' }],
    cited: [{ url: 'https://example.com/docs', opened: true }, { url: 'https://news.example.org/story', opened: false }]
  })
  assert.deepEqual(citationMarks(sources), { 'example.com/docs': true, 'news.example.org/story': false })
  assert.equal(turnSources([], ['No links here, and file:///tmp/a.md is not a page']), null)
  assert.equal(citationMarks(null), undefined)
})

test('the next message is told about unopened citations, and nothing when every citation was opened', () => {
  const notice = sourcesNotice({ opened: [], cited: [{ url: 'https://a.com/x', opened: false }, { url: 'https://b.com', opened: true }] })
  assert.match(notice!, /^<sources>\nThe last reply in this chat cited a page its turn never opened: https:\/\/a\.com\/x\./)
  assert.ok(notice!.includes('not verified'))
  assert.equal(sourcesNotice({ opened: [], cited: [{ url: 'https://b.com', opened: true }] }), null)
  assert.equal(sourcesNotice(null), null)
})
