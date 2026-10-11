import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test, expect, section } from './app'
import { seedLongChat, type LongChat } from '../fixtures/long-chat'

// The window's half of the long-chat benchmark: chats of real and larger sizes are written into
// the isolated profile, and the app opens each from the history, brings in the page above, reads
// up to the first turn, and switches back to it from another tab. Times are taken inside the
// page, from the action to the second frame after the result is in the DOM, with the longest
// main-thread task in each phase.
// Run alone with `npm run check:ui -- long-chat`; results are attached and saved under
// .artifacts/bench/. The host's half is src/host/transcript-bench.ts.

const SIZES = (process.env.LONG_CHAT_TURNS ?? '45,250,1000').split(',').map(Number)

/** `shiftPx`: how far the turn that was first on screen moved while turns went in above it. */
type Phase = { ms: number; longestTaskMs: number; shiftPx: number }
type Profile = { nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>; samples?: number[]; timeDeltas?: number[] }

/** Save the profile beside the results and print the functions that took the most time themselves. */
async function saveProfile({ profile }: { profile: Profile }): Promise<void> {
  const out = resolve('.artifacts/bench')
  await mkdir(out, { recursive: true })
  await writeFile(join(out, `transcript-open-${Date.now()}.cpuprofile`), JSON.stringify(profile))
  const self = new Map<string, number>()
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const deltas = profile.timeDeltas ?? []
  ;(profile.samples ?? []).forEach((id, index) => {
    const { functionName, url, lineNumber } = byId.get(id)!.callFrame
    // Frames with no script are the test's own injected queries, idle time and the engine; only
    // the collector among them is the app's cost.
    if (!url && functionName !== '(garbage collector)') return
    const key = `${functionName || '(anonymous)'} ${url.split('/').pop()}:${lineNumber}`
    self.set(key, (self.get(key) ?? 0) + (deltas[index] ?? 0) / 1000)
  })
  console.table([...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([fn, ms]) => ({ fn, ms: Math.round(ms) })))
}

test('long chats open, switch and scroll within budget', async ({ rocket }) => {
  test.setTimeout(600_000)
  const db = join(rocket.profile, 'rocket.db')
  const small = seedLongChat(db, { turns: 2, cwd: rocket.workspace, title: 'Short chat', seed: 7 })
  const chats: LongChat[] = SIZES.map((turns, index) => seedLongChat(db, { turns, cwd: rocket.workspace, seed: index + 1 }))
  await rocket.restart()
  const { page } = rocket
  // The trace's DOM snapshot of a fully read 1,000-turn transcript takes about 10 s and lands inside
  // the 10 s action timeout (task 0031). This spec measures timing, so its trace keeps screenshots only.
  await page.context().tracing.stop()
  await page.context().tracing.start({ screenshots: true, snapshots: false, sources: true })
  await page.evaluate(() => {
    const w = window as unknown as { tasks: number[][] }
    w.tasks = []
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) w.tasks.push([entry.startTime, entry.duration]) })
      .observe({ type: 'longtask', buffered: true })
  })

  // Act inside the page, then resolve two frames after the first pane shows what `until` asks:
  // the newest reply, more turns than before, or the chat's first turn. Reaching the first turn
  // scrolls to the top on every frame, as a reader would, until the last page is in.
  type Until = { newest: number } | { more: number } | 'first'
  const measure = (act: { click: string; text: string } | 'top', until: Until): Promise<Phase> => page.evaluate(async ({ act, until }) => {
    const w = window as unknown as { tasks: number[][] }
    const frame = (): Promise<void> => new Promise((done) => requestAnimationFrame(() => done()))
    const pane = (): Element => document.querySelector('.pane')!
    const top = (): void => { pane().querySelector('.transcript')!.scrollTop = 0 }
    const turns = (): NodeListOf<Element> => pane().querySelectorAll('.turn')
    const done = (): boolean => until === 'first'
      ? Boolean(turns()[0]?.textContent?.includes('Turn 1:'))
      : 'more' in until
        ? turns().length > until.more
        : Boolean(turns()[turns().length - 1]?.querySelector('.prose')?.textContent?.includes(`Reply ${until.newest}.`))
    const start = performance.now()
    // Only a scroll keeps the same chat on screen; a click may open one where there was none.
    const scroller = pane().querySelector('.transcript')
    const anchor = turns()[0]
    const offset = (): number => anchor && scroller ? anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top : 0
    if (act === 'top') top()
    else {
      const element = [...document.querySelectorAll(act.click)].find((candidate) => candidate.textContent?.includes(act.text))
      if (!element) throw new Error(`Nothing matches ${act.click} with "${act.text}".`)
      ;(element as HTMLElement).click()
    }
    const placed = offset()
    while (!done()) {
      if (performance.now() - start > 120_000) throw new Error(`The chat did not reach ${JSON.stringify(until)} within two minutes.`)
      await frame()
      if (until === 'first') top()
    }
    await frame()
    await frame()
    const end = performance.now()
    const longest = w.tasks.filter(([at, duration]) => at + duration >= start && at <= end).reduce((max, [, duration]) => Math.max(max, duration), 0)
    return { ms: Math.round(end - start), longestTaskMs: Math.round(longest), shiftPx: Math.round(Math.abs(offset() - placed)) }
  }, { act, until })
  const shown = (): Promise<number> => page.locator('.pane').first().locator('.turn').count()

  const openFromHistory = async (title: string, newest: number): Promise<Phase> => {
    await (await section(page, 'Chats')).click()
    await expect(page.getByRole('menu', { name: 'Chat history' })).toBeVisible()
    return await measure({ click: '[role="menuitem"]', text: title }, { newest })
  }

  await openFromHistory('Short chat', small.turns)
  const rows: Array<Record<string, number>> = []
  for (const chat of chats) {
    const title = `Long chat (${chat.turns} turns)`
    // LONG_CHAT_PROFILE=1 records where the largest open spends its time, by function.
    const profiling = process.env.LONG_CHAT_PROFILE === '1' && chat === chats.at(-1)
    const cdp = profiling ? await page.context().newCDPSession(page) : null
    if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start') }
    // Three opens from the history, the tab closed between them so its chat is fetched again; the
    // median is judged, since one open can land on a garbage collection or a busy machine. The
    // first is the only one that parses its markdown; later ones find it cached, as a chat opened
    // again does in use, so the first is reported and guarded on its own.
    const opens: Phase[] = []
    for (let trial = 0; trial < 3; trial++) {
      if (trial) await page.getByRole('button', { name: `Close tab: ${title}`, exact: true }).click()
      opens.push(await openFromHistory(title, chat.turns))
    }
    if (cdp) await saveProfile(await cdp.send('Profiler.stop'))
    const middle = <K extends keyof Phase>(key: K): number => opens.map((phase) => phase[key]).sort((a, b) => a - b)[1]!
    const open: Phase = { ms: middle('ms'), longestTaskMs: middle('longestTaskMs'), shiftPx: 0 }
    const opened = await shown()
    expect(opened, 'a chat opens with one page of turns').toBe(Math.min(chat.turns, 20))
    if (chat === chats[0]) {
      // A page leaves finished tool output out; opening a step brings it.
      const newest = page.locator('.pane').first().locator('.turn').last()
      await newest.locator('.activity-summary').click()
      await newest.locator('.tool-line:not([disabled])').first().click()
      await expect(newest.locator('.tool-output').first()).toContainText('store.')
      await newest.locator('.activity-summary').click()
    }
    const switchBack = async (): Promise<Phase> => {
      await page.getByRole('tab').filter({ hasText: 'Short chat' }).click()
      await expect(page.locator('.pane').first().locator('.turn')).toHaveCount(small.turns)
      return await measure({ click: '[role="tab"]', text: title }, { newest: chat.turns })
    }
    const back = await switchBack()
    const page2 = opened < chat.turns ? await measure('top', { more: opened }) : null
    const all = await measure('top', 'first')
    await expect(page.locator('.pane').first().locator('.turn')).toHaveCount(chat.turns)
    const stats = await page.evaluate(() => ({
      nodes: document.querySelectorAll('*').length,
      heapMB: Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1e6)
    }))
    const backAfterAll = await switchBack()
    rows.push({
      turns: chat.turns,
      items: chat.items,
      'turns on open': opened,
      'first open ms': opens[0]!.ms,
      'first open longest task ms': opens[0]!.longestTaskMs,
      'open ms (median of 3)': open.ms,
      'open longest task ms (median)': open.longestTaskMs,
      'switch back ms': back.ms,
      'switch longest task ms': back.longestTaskMs,
      'switch back after reading all ms': backAfterAll.ms,
      'its longest task ms': backAfterAll.longestTaskMs,
      'next page ms': page2?.ms ?? 0,
      'next page longest task ms': page2?.longestTaskMs ?? 0,
      'next page shift px': page2?.shiftPx ?? 0,
      'scroll to first turn ms': all.ms,
      'scroll longest task ms': all.longestTaskMs,
      'DOM nodes, all loaded': stats.nodes,
      'JS heap MB (approx.)': stats.heapMB
    })
    await expect(page.locator('.pane').first().locator('.turn').last()).toContainText(`Reply ${chat.turns}.`)
    // Budgets, about twice what this machine measured (docs/long-chat-plan.md), so a chat's
    // length showing up in its open time again fails the check rather than passing slowly.
    const at = `${chat.turns} turns`
    expect(open.longestTaskMs, `opening ${at} freezes the window no longer than 250 ms`).toBeLessThan(250)
    expect(open.ms, `opening ${at} shows the newest reply within 600 ms`).toBeLessThan(600)
    expect(opens[0]!.longestTaskMs, `opening ${at} for the first time freezes the window no longer than 400 ms`).toBeLessThan(400)
    // The tab's chat is kept, so switching back asks the host for nothing and parses nothing new.
    expect(back.longestTaskMs, `switching back to ${at} freezes the window no longer than 120 ms`).toBeLessThan(120)
    expect(back.ms, `switching back to ${at} shows the newest reply within 300 ms`).toBeLessThan(300)
    // Having read every turn, the chat goes back to its newest page; letting go of the rest is the
    // cost here, so the guard is looser, but far under the seconds a whole chat once took.
    expect(backAfterAll.longestTaskMs, `switching back to ${at} after reading all of it freezes no longer than 400 ms`).toBeLessThan(400)
    if (page2) {
      expect(page2.longestTaskMs, `the page above ${at} goes in without a freeze over 250 ms`).toBeLessThan(250)
      expect(page2.shiftPx, 'turns put in above leave the reader where they were').toBeLessThanOrEqual(2)
    }
    expect(all.longestTaskMs, `reading ${at} up to the first turn never freezes the window over 250 ms`).toBeLessThan(250)
  }

  console.table(rows)
  const body = JSON.stringify(rows, null, 2)
  await test.info().attach('Long chat timings', { body, contentType: 'application/json' })
  const out = resolve('.artifacts/bench')
  await mkdir(out, { recursive: true })
  await writeFile(join(out, `transcript-ui-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), body)
})
