import assert from 'node:assert/strict'
import test from 'node:test'
import { agentSituationContext, AGENT_SITUATION } from './agent-situation.ts'

test('agent situation is always returned for every turn, with the map and where the shell is', () => {
  const block = agentSituationContext('Where you are: one chat pane, this chat is pane 0 (ui.pane(0)); no side panel.')
  assert.match(block, /<agent-environment>/)
  assert.ok(block.includes(AGENT_SITUATION))
  assert.ok(block.includes('studio_ui_snapshot'))
  assert.ok(block.includes('browser_read'))
  assert.ok(block.includes('this chat is pane 0'))
  assert.ok(block.includes('- app {id'))
  assert.ok(block.includes('- shelf.open —'))
  assert.ok(!block.includes('evals.'))
  assert.ok(block.includes('docs/something-plan.md'))
  assert.ok(block.includes('unless the user explicitly asks to close or quit the Craft Studio app'))
})

test('without a readable window the block says to ask studio_ui_where', () => {
  const block = agentSituationContext()
  assert.ok(block.includes('call studio_ui_where'))
  assert.ok(block.includes('Places (studio_ui_go)'))
})

test('workers get report rules without live shell map, where line or plan-opening guidance', () => {
  const block = agentSituationContext('Where you are: user shell', 'worker')
  assert.match(block, /Write your report to the assigned path/)
  assert.match(block, /Never wait for answers/)
  assert.match(block, /isolated UI checks/)
  assert.doesNotMatch(block, /Where you are|Places \(|Actions \(|npm run open|docs\/something-plan|<agent-environment>/)
})

test('worker first-turn context never reads user tabs or shell, and only leaders hear nudges', async () => {
  const { roleContext } = await import('./agent-situation.ts')
  const inputs = { workspace: async () => '<workspace>files</workspace>', teamwork: async () => '<others>worker titles</others>', browser: async () => '<browser>user tabs</browser>', where: async () => 'Where you are: user shell', nudge: () => '<self-check>trouble</self-check>' }
  const worker = await roleContext('worker', { ...inputs, browser: async () => { throw new Error('Must not read tabs') }, where: async () => { throw new Error('Must not read shell') } })
  assert.match(worker!, /<worker-environment>[\s\S]*assigned path/)
  assert.doesNotMatch(worker!, /<browser>|Places \(|Where you are|self-check|npm run open/)
  assert.match((await roleContext('leader', inputs))!, /self-check[\s\S]*checkpoint needs/)
  assert.doesNotMatch((await roleContext('ordinary', inputs))!, /<self-check>/)
})
