import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './app'

// Exercise the real MCP boundary and supervisor, including a fresh isolated source build.
test('UI scripts reuse isolated sessions, return failure captures and clean up on timeout', async ({ rocket }, info) => {
  test.setTimeout(180_000)
  const state = JSON.parse(await readFile(join(rocket.profile, 'tool-channel.json'), 'utf8')) as { port: number; secret: string }
  const call = async (args: Record<string, unknown>, chat = 'ui-run-inspector', provider = 'codex') => {
    const response = await fetch(`http://127.0.0.1:${state.port}/mcp/${state.secret}/${provider}/${chat}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_ui_run', arguments: { ...args, target: 'isolated' } } })
    })
    const result = (await response.json()).result as { isError?: boolean; content: Array<{ type: string; text?: string; data?: string }> }
    let data: any
    try { data = JSON.parse(result.content[0].text!) } catch { data = { error: result.content[0].text } }
    return { result, data }
  }
  const shellDraft = 'The live fixture is untouched'
  await rocket.page.getByRole('textbox', { name: 'Message', exact: true }).fill(shellDraft)
  try {
    const first = await call({ code: `
      await page.getByRole('navigation', {name:'Apps dock'}).getByRole('button', {name:'Browser',exact:true}).click()
      const browser = await ui.surface('browser')
      await browser.getByRole('textbox', {name:'Test input',exact:true}).fill('Private browser draft')
      await page.getByRole('textbox', {name:'Message',exact:true}).fill('Persistent isolated draft')
      await ui.resize(1000,700)
      return {draft:await page.getByRole('textbox',{name:'Message',exact:true}).inputValue(),browserDraft:await browser.getByRole('textbox',{name:'Test input',exact:true}).inputValue()}
    ` })
    expect(first.data.error, JSON.stringify(first.data)).toBeUndefined()
    expect(first.result.isError).toBeUndefined()
    expect(first.data.value).toEqual({ draft: 'Persistent isolated draft', browserDraft: 'Private browser draft' })
    expect(first.data.session.build).toBe('session build of current source')
    expect(first.data.session.profile).not.toBe(rocket.profile)
    expect(first.data.captures[0].instance.rendererUrl).toContain('/app/out/renderer/')
    expect(first.data.captures[0].window.bounds.width).toBe(1000)
    expect(first.result.content.some(block => block.type === 'image')).toBe(true)
    await info.attach('UI run: isolated app', { path: first.data.captures[0].images[0].path, contentType: 'image/png' })
    const pid = first.data.captures[0].instance.pid as number
    const second = await call({ capture: false, code: `return await page.getByRole('textbox',{name:'Message',exact:true}).inputValue()` }, 'ui-run-inspector', 'claude')
    expect(second.result.isError).toBeUndefined()
    expect(second.data.session.id).toBe(first.data.session.id)
    expect(second.data.value).toBe('Persistent isolated draft')
    expect(second.result.content.some(block => block.type === 'image')).toBe(false)
    const tab = await call({ capture: false, code: `
      await page.getByRole('button',{name:'New tab',exact:true}).click()
      await page.waitForFunction(()=>document.querySelectorAll('.btab').length===2 && document.querySelector('.btab.is-active')?.textContent.includes('UI page one'))
      const browser = await ui.surface('browser')
      return await browser.getByRole('textbox',{name:'Test input',exact:true}).inputValue()
    ` })
    expect(tab.result.isError, JSON.stringify(tab.data)).toBeUndefined()
    expect(tab.data.value).toBe('')
    const streamed = await call({ code: `
      await page.locator('.composer-folder').click()
      await page.getByRole('textbox',{name:'Message',exact:true}).fill('UI check: plan')
      await page.getByRole('button',{name:'Send',exact:true}).click()
      await page.getByRole('complementary',{name:'Plan',exact:true}).waitFor({state:'visible'})
      const plan = await ui.snapshot()
      await ui.release()
      await page.getByRole('button',{name:'Stop',exact:true}).waitFor({state:'hidden'})
      return {plan:plan.shell.panels.some(panel=>panel.name==='Plan'),request:await ui.request()}
    ` })
    expect(streamed.data.error, JSON.stringify(streamed.data)).toBeUndefined()
    expect(streamed.data.value.plan).toBe(true)
    expect(streamed.data.value.request.cwd).toBe(first.data.session.workspace)
    const failed = await call({ capture: false, code: `throw new Error('Deliberate inspection failure')` })
    expect(failed.result.isError).toBe(true)
    expect(failed.data.error).toBe('Deliberate inspection failure')
    expect(failed.result.content.some(block => block.type === 'image')).toBe(true)
    expect(failed.data.session.id).toBe(first.data.session.id)
    const timedOut = await call({ timeout: 1, code: 'while (true) {}' })
    expect(timedOut.result.isError).toBe(true)
    expect(timedOut.data.timedOut).toBe(true)
    expect(timedOut.data.session.open).toBe(false)
    expect(timedOut.result.content.some(block => block.type === 'image')).toBe(true)
    await expect.poll(async () => {
      try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2)[0] === 'Z' } catch { return true }
    }).toBe(true)
    const restarted = await call({ build: false, capture: false, code: `return await page.getByRole('textbox',{name:'Message',exact:true}).inputValue()` })
    expect(restarted.result.isError).toBeUndefined()
    expect(restarted.data.session.id).not.toBe(first.data.session.id)
    expect(restarted.data.value).toBe('')
    await expect(rocket.page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(shellDraft)
    const closed = await call({ close: true })
    expect(closed.result.isError).toBeUndefined()
    expect(await readFile(join(restarted.data.session.directory, 'trace-0.zip'))).not.toHaveLength(0)
  } finally { await call({ close: true }) }
})
