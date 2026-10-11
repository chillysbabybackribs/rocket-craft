import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Journal } from '../journal.ts'
import { selfCheckTools } from './self-check.ts'

function project(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rocket-check-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }))
  return dir
}

async function check(cwd: string | null): Promise<{ text: string; isError?: boolean }> {
  const journal = new Journal(join(mkdtempSync(join(tmpdir(), 'rocket-check-j-')), 'j.jsonl'))
  const tool = selfCheckTools(journal, () => cwd).find((entry) => entry.name === 'studio_check')!
  const result = await tool.run({}, { provider: 'claude', chatId: 'c' })
  const first = result.content[0]
  return { text: first?.type === 'text' ? first.text : '', isError: result.isError }
}

test('a passing project reports each script as passed', async () => {
  const result = await check(project({ typecheck: 'node -e 0', test: 'node -e 0' }))
  assert.equal(result.isError, undefined)
  assert.match(result.text, /typecheck: passed[\s\S]*test: passed/)
})

test('a failing script is an error that carries its output', async () => {
  const result = await check(project({ typecheck: 'node -e "console.log(\'bad type\'); process.exit(1)"' }))
  assert.equal(result.isError, true)
  assert.match(result.text, /typecheck: FAILED[\s\S]*bad type/)
})

test('a folder without scripts says what to do instead', async () => {
  assert.match((await check(project({}))).text, /no "typecheck" or "test" script/)
  assert.match((await check(null)).text, /no package.json/)
})
