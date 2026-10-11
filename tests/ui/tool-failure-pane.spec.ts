import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './app'
import { openWorkerBeside } from './orch.ts'

// The same greeting in the orchestrator and an expanded worker must not make an unscoped Message
// box guess. ui.pane(0) is the left chat; the worker's reply box is the expanded worker, not a second pane.
test('ui.pane targets the orchestrator when the same greeting is on an expanded worker', async ({ rocket }, info) => {
  test.setTimeout(180_000)
  const state = JSON.parse(await readFile(join(rocket.profile, 'tool-channel.json'), 'utf8')) as { port: number; secret: string }
  const call = async (args: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${state.port}/mcp/${state.secret}/codex/pane-selector-regression`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_ui_run', arguments: { ...args, target: 'isolated' } } })
    })
    const result = (await response.json()).result as { isError?: boolean; structuredContent?: { error?: { code: string } }; content: Array<{ type: string; text?: string }> }
    let data: any
    try { data = JSON.parse(result.content[0].text!) } catch { data = { error: result.content[0].text } }
    return { result, data }
  }

  await openWorkerBeside(call)

  const ambiguous = await call({ capture: false, code: `
    await page.getByRole('textbox', {name:'Message', exact:true}).fill('Wrong pane draft')
    return 'should not run'
  ` })
  expect(ambiguous.result.structuredContent?.error?.code).toBe('AMBIGUOUS_TARGET')

  const scoped = await call({ code: `
    await ui.pane(0).getByRole('textbox', {name:'Message', exact:true}).fill('Orchestrator draft')
    const worker = await page.getByTestId('worker-expanded').getByRole('textbox', {name:'Message', exact:true}).inputValue()
    await page.getByTestId('worker-expanded').getByRole('textbox', {name:'Message', exact:true}).fill('Worker draft')
    return {
      orchestrator: await ui.pane(0).getByRole('textbox', {name:'Message', exact:true}).inputValue(),
      workerBefore: worker
    }
  ` })
  expect(scoped.result.isError, JSON.stringify(scoped.data)).toBeUndefined()
  expect(scoped.data.value).toEqual({ orchestrator: 'Orchestrator draft', workerBefore: '' })
  await info.attach('Pane selector regression', { path: scoped.data.captures[0].images[0].path, contentType: 'image/png' })
})
