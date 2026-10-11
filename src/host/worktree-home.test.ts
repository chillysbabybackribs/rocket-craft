import assert from 'node:assert/strict'
import { test } from 'node:test'
import { homeOf, worktreeHome } from './worktree-home.ts'

const runs = [{
  cwd: '/main',
  tasks: [
    { worktree: { folder: '/data/worktrees/b1f0205e-0001', branch: 'b', base: 'x' }, startedAt: 500, createdAt: 100 },
    { worktree: null, startedAt: null, createdAt: 1 },
    { worktree: { folder: '/data/worktrees/b1f0205e-0002', branch: 'b', base: 'x' }, startedAt: null, createdAt: 300 }
  ]
}] as never

test('a worktree folder, or a folder inside one, maps to its run\'s main folder', () => {
  assert.equal(homeOf(runs, '/data/worktrees/b1f0205e-0001'), '/main')
  assert.equal(homeOf(runs, '/data/worktrees/b1f0205e-0001/src/host'), '/main')
  assert.deepEqual(worktreeHome(runs, '/data/worktrees/b1f0205e-0001'), { main: '/main', since: 500 })
  assert.equal(worktreeHome(runs, '/data/worktrees/b1f0205e-0002')?.since, 300, 'a task that has not started yet falls back to its creation time')
})

test('other folders, and a sibling with the same prefix, map to themselves', () => {
  assert.equal(homeOf(runs, '/main'), '/main')
  assert.equal(homeOf(runs, '/elsewhere'), '/elsewhere')
  assert.equal(homeOf(runs, '/data/worktrees/b1f0205e-00011'), '/data/worktrees/b1f0205e-00011')
  assert.equal(worktreeHome(runs, '/main'), null)
})
