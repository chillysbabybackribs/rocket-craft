import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeCodeExecutable } from './claude.ts'

test('claudeCodeExecutable prefers the user install over the SDK bundle', () => {
  const installed = join(homedir(), '.local', 'bin', 'claude')
  if (!existsSync(installed)) return
  assert.equal(claudeCodeExecutable(), installed)
})

test('CLAUDE_CODE_EXECUTABLE overrides the default install path', () => {
  const installed = join(homedir(), '.local', 'bin', 'claude')
  if (!existsSync(installed)) return
  const previous = process.env.CLAUDE_CODE_EXECUTABLE
  process.env.CLAUDE_CODE_EXECUTABLE = installed
  try {
    assert.equal(claudeCodeExecutable(), installed)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_EXECUTABLE
    else process.env.CLAUDE_CODE_EXECUTABLE = previous
  }
})
