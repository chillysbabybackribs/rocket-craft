import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StepTranslator, toolBrief } from './antigravity.ts'

test('a new conversation is told each tool, its arguments and how to call it', () => {
  const brief = toolBrief('rocket', [
    {
      name: 'studio_diagnostics',
      description: 'Read the journal.',
      inputSchema: {
        type: 'object',
        properties: {
          severity: { enum: ['info', 'warn'], description: 'The least severe entry to list.' },
          limit: { type: 'number' }
        },
        required: ['severity']
      }
    },
    { name: 'studio_check', description: 'Run typecheck and tests.', inputSchema: { type: 'object', properties: {} } }
  ])
  assert.match(brief, /call_mcp_tool, giving ServerName "rocket"/)
  assert.match(brief, /## studio_diagnostics\nRead the journal\.\nArguments:\n {2}- severity \("info" \| "warn", required\): The least severe entry to list\.\n {2}- limit \(number\)/)
  assert.match(brief, /## studio_check\nRun typecheck and tests\.\nNo arguments\./)
})

test('with no tools there is nothing to tell', () => {
  assert.equal(toolBrief('rocket', []), '')
})

test('a step that was only thinking carries no text and shows nothing', () => {
  // As agy 1.2.17 sends it: DONE at once, with a thinking token count and no delta.
  const translator = new StepTranslator('t')
  const out = translator.handle({
    event: 'step_update',
    step_update: { conversation_id: 'c', step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { thinking_tokens: 152 } }
  })
  assert.deepEqual(out.ops, [])
  assert.equal(out.conversationId, 'c')
})
