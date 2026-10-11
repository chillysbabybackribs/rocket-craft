import assert from 'node:assert/strict'
import test from 'node:test'
import { buildA11ySnapshot, filterReadByQuery, parseReadQuery, type AxNode } from './browser-a11y.ts'

test('parseReadQuery treats slash syntax as regex', () => {
  const parsed = parseReadQuery('/Beta/i')
  assert.ok(parsed?.regex)
  assert.match('Beta LLC', parsed!.regex!)
})

test('filterReadByQuery keeps matching control lines', () => {
  const body = 'e1 link "Alpha"\ne2 link "Beta LLC"\ne3 button "Go"'
  const out = filterReadByQuery(body, 'Beta', 10)
  assert.match(out, /Beta LLC/)
  assert.doesNotMatch(out, /Alpha/)
})

test('buildA11ySnapshot assigns refs to actionable nodes', () => {
  const nodes: AxNode[] = [
    { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, name: { type: 'computedString', value: 'SPA' }, childIds: ['2'] },
    { nodeId: '2', role: { type: 'role', value: 'link' }, name: { type: 'computedString', value: 'Beta LLC' }, backendDOMNodeId: 42 }
  ]
  const { text, pins } = buildA11ySnapshot(nodes, 10, null)
  assert.match(text, /\[ref=e1\]/)
  assert.deepEqual(pins, [{ ref: 'e1', backendDOMNodeId: 42 }])
})
