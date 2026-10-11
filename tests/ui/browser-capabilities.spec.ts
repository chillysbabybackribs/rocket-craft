import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './app'

/** MCP browser tools the way a provider calls them (same pattern as downloads.spec.ts). */
async function browserMcp(profile: string) {
  const state = JSON.parse(await readFile(join(profile, 'tool-channel.json'), 'utf8')) as { port: number; secret: string }
  const url = `http://127.0.0.1:${state.port}/mcp/${state.secret}/claude/browser-phase0`
  const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    })
    const { result } = await response.json() as { result: { content: Array<{ text: string }>; isError?: boolean } }
    return { text: result.content.map((each) => each.text).join('\n'), isError: result.isError }
  }
  const run = async (code: string, timeout = 30) => call('browser_run', { code, timeout })
  return { call, run }
}

test.describe('Browser Phase 0 baseline (harness)', () => {
  test('SPA: hash goto before slow detail fetch finishes (read vs route gap)', async ({ rocket }) => {
    const { origin, profile } = rocket
    const { run } = await browserMcp(profile)
    const detailUrl = `${origin}/spa?slow=1200#/record/alpha`
    const out = await run(`
      await tab.goto(${JSON.stringify(detailUrl)});
      return await tab.read({ max: 4000 });
    `)
    expect(out.isError).toBeFalsy()
    expect(out.text).toMatch(/Loading/)
    expect(out.text).not.toMatch(/ALPHA-42/)
  })

  test('SPA: waitFor after hash goto shows detail', async ({ rocket }) => {
    const { origin, profile } = rocket
    const { run } = await browserMcp(profile)
    const detailUrl = `${origin}/spa#/record/alpha`
    const out = await run(`
      await tab.goto(${JSON.stringify(detailUrl)});
      await tab.waitFor('text=Alpha Corp', { timeout: 8000 });
      return await tab.read({ max: 4000 });
    `)
    expect(out.isError).toBeFalsy()
    expect(out.text).toMatch(/ALPHA-42/)
  })

  test('SPA: JSON extract via browser.fetch', async ({ rocket }) => {
    const { origin, profile } = rocket
    const { run } = await browserMcp(profile)
    const api = `${origin}/spa/api/records/beta`
    const out = await run(`
      const res = await browser.fetch(${JSON.stringify(api)});
      return res.json();
    `)
    expect(out.isError).toBeFalsy()
    expect(out.text).toMatch(/BETA-99/)
  })

  test('SPA: click link + wait reaches detail', async ({ rocket }) => {
    const { origin, profile } = rocket
    const { run } = await browserMcp(profile)
    const out = await run(`
      await tab.goto(${JSON.stringify(`${origin}/spa`)});
      await tab.click('text=Beta LLC');
      await tab.waitFor('text=BETA-99', { timeout: 8000 });
      return await tab.read({ max: 3000 });
    `)
    expect(out.isError).toBeFalsy()
    expect(out.text).toMatch(/BETA-99/)
  })

  test('SPA: ref heal after list rerender (same label, new node)', async ({ rocket }) => {
    const { origin, profile } = rocket
    const { run } = await browserMcp(profile)
    const out = await run(`
      await tab.goto(${JSON.stringify(`${origin}/spa`)});
      const before = await tab.read({ focus: 'elements', max: 2000 });
      const line = before.split('\\n').find((row) => row.includes('Alpha Corp'));
      const ref = line?.match(/\\be\\d+\\b/)?.[0];
      if (!ref) throw new Error('no Alpha Corp ref');
      await tab.click('#rerender');
      await sleep(200);
      await tab.click(ref);
      await tab.waitFor('text=ALPHA-42', { timeout: 8000 });
      return await tab.read({ max: 2000 });
    `)
    expect(out.isError).toBeFalsy()
    expect(out.text).toMatch(/ALPHA-42/)
  })

  test('Phase 1: read header includes hash and route hint on detail', async ({ rocket }) => {
    const { origin, profile } = rocket
    const { run } = await browserMcp(profile)
    const detailUrl = `${origin}/spa#/record/beta`
    const out = await run(`
      await tab.goto(${JSON.stringify(detailUrl)});
      await tab.waitFor('text=BETA-99', { timeout: 8000 });
      return await tab.read({ max: 1500 });
    `)
    expect(out.isError).toBeFalsy()
    expect(out.text).toMatch(/hash: #\/record\/beta/)
    expect(out.text).toMatch(/route: detail/)
  })

  test('Phase 1: goto until request waits for slow SPA detail API', async ({ rocket }) => {
    const { origin, profile } = rocket
    const { run } = await browserMcp(profile)
    const detailUrl = `${origin}/spa?slow=800#/record/alpha`
    const out = await run(`
      await tab.goto(${JSON.stringify(detailUrl)}, { until: 'request', untilValue: 'spa/api/records/alpha', timeout: 6000 });
      return await tab.read({ max: 4000 });
    `)
    expect(out.isError).toBeFalsy()
    expect(out.text).toMatch(/ALPHA-42/)
    expect(out.text).not.toMatch(/Loading…/)
  })

  test('Phase 2: query filters a large list to one row', async ({ rocket }) => {
    const { origin, profile } = rocket
    const { run } = await browserMcp(profile)
    const out = await run(`
      await tab.goto(${JSON.stringify(`${origin}/spa`)});
      const full = await tab.read({ focus: 'elements', max: 500 });
      const narrow = await tab.read({ focus: 'elements', query: 'Beta LLC', max: 20 });
      if (!narrow.includes('Beta LLC')) throw new Error('missing Beta');
      if (narrow.includes('Decoy row')) throw new Error('query should drop decoys');
      return { fullLen: full.length, narrowLen: narrow.length };
    `)
    expect(out.isError).toBeFalsy()
    expect(out.text).not.toMatch(/Decoy row/)
    const fullLen = Number(out.text.match(/"fullLen":\s*(\d+)/)?.[1] ?? 0)
    const narrowLen = Number(out.text.match(/"narrowLen":\s*(\d+)/)?.[1] ?? 0)
    expect(narrowLen).toBeGreaterThan(0)
    expect(narrowLen).toBeLessThan(fullLen / 2)
  })

  test('Phase 2: a11y snapshot exposes link refs', async ({ rocket }) => {
    const { origin, profile } = rocket
    const { run } = await browserMcp(profile)
    const out = await run(`
      await tab.goto(${JSON.stringify(`${origin}/spa`)});
      return await tab.read({ focus: 'a11y', max: 40 });
    `)
    expect(out.isError).toBeFalsy()
    expect(out.text).toMatch(/Accessibility snapshot/)
    expect(out.text).toMatch(/Beta LLC/)
    expect(out.text).toMatch(/\[ref=e\d+\]/)
  })

  test('Phase 2: tab.follow hash link reaches detail', async ({ rocket }) => {
    const { origin, profile } = rocket
    const { run } = await browserMcp(profile)
    const out = await run(`
      await tab.goto(${JSON.stringify(`${origin}/spa`)});
      await tab.follow('#/record/beta');
      await tab.waitFor('text=BETA-99', { timeout: 8000 });
      return await tab.read({ max: 2000 });
    `)
    expect(out.isError).toBeFalsy()
    expect(out.text).toMatch(/BETA-99/)
    expect(out.text).toMatch(/hash: #\/record\/beta/)
  })

  test('Phase 3: read attaches truncated JSON from record API', async ({ rocket }) => {
    const { origin, profile } = rocket
    const { run } = await browserMcp(profile)
    const detailUrl = `${origin}/spa#/record/alpha`
    const out = await run(`
      await tab.goto(${JSON.stringify(detailUrl)}, { until: 'request', untilValue: 'spa/api/records/alpha', timeout: 8000 });
      return await tab.read({ max: 3000 });
    `)
    expect(out.isError).toBeFalsy()
    expect(out.text).toMatch(/Attached JSON/)
    expect(out.text).toMatch(/ALPHA-42/)
  })

  test('Phase 3: browser_run delta lists new network after navigation', async ({ rocket }) => {
    const { origin, profile } = rocket
    const { run } = await browserMcp(profile)
    const out = await run(`
      await tab.goto(${JSON.stringify(`${origin}/spa`)});
      await tab.waitFor('body[data-ready="true"]', { timeout: 8000 });
      await tab.click('text=Beta LLC');
      await tab.waitFor('text=BETA-99', { timeout: 8000 });
      return 'done';
    `)
    expect(out.isError).toBeFalsy()
    expect(out.text).toMatch(/Since script started \(network\)/)
    expect(out.text).toMatch(/spa\/api\/records\/beta/)
  })

  test('Phase 3: spa hook and waitForNavigation (call before route change)', async ({ rocket }) => {
    const { origin, profile } = rocket
    const { run } = await browserMcp(profile)
    const out = await run(`
      await tab.goto(${JSON.stringify(`${origin}/spa`)});
      await tab.eval(() => { if (!globalThis.__rocketSpaHook) throw new Error('SPA hook missing on agent tab'); });
      const nav = tab.waitForNavigation({ timeout: 8000 });
      await tab.eval(() => {
        history.pushState({}, '', '#/record/alpha');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      await nav;
      await tab.waitFor('text=ALPHA-42', { timeout: 8000 });
      return await tab.read({ max: 1500 });
    `)
    expect(out.isError).toBeFalsy()
    expect(out.text).toMatch(/ALPHA-42/)
  })

  test('Phase 4: som screenshot reports marker count', async ({ rocket }) => {
    const { origin, profile } = rocket
    const { run } = await browserMcp(profile)
    const out = await run(`
      await tab.goto(${JSON.stringify(`${origin}/spa`)});
      const shot = await tab.screenshot({ som: true, max: 20 });
      return JSON.stringify({ som: shot.som, markers: shot.markers, path: shot.path });
    `)
    expect(out.isError).toBeFalsy()
    expect(out.text).toMatch(/"som":true/)
    expect(Number(out.text.match(/"markers":(\d+)/)?.[1] ?? 0)).toBeGreaterThan(2)
  })

  test('Phase 4: exportHar writes entries after navigation', async ({ rocket }) => {
    const { origin, profile } = rocket
    const { run } = await browserMcp(profile)
    const out = await run(`
      await tab.goto(${JSON.stringify(`${origin}/spa`)});
      await tab.click('text=Alpha Corp');
      await tab.waitFor('text=ALPHA-42', { timeout: 8000 });
      const har = await tab.exportHar({ saveTo: 'phase4.har.json' });
      return har.entries + ' ' + (har.summary || '');
    `)
    expect(out.isError).toBeFalsy()
    expect(out.text).toMatch(/HAR export/)
    expect(out.text).toMatch(/[1-9]\d*/)
  })

  test('SPA: network log lists record API on detail navigation', async ({ rocket }) => {
    const { origin, profile } = rocket
    const { run } = await browserMcp(profile)
    const out = await run(`
      await tab.goto(${JSON.stringify(`${origin}/spa`)});
      await tab.click('text=Alpha Corp');
      await tab.waitFor('text=ALPHA-42', { timeout: 8000 });
      return await tab.read({ focus: 'network', max: 40 });
    `)
    expect(out.isError).toBeFalsy()
    expect(out.text).toContain('spa/api/records/alpha')
  })
})
