import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  addWorktree, applyMerged, baseCommit, changedBetween, commitSquashed, deleteBranch, mergeTrees, pruneWorktrees,
  removeWorktree, snapshot, subjectsBetween, worktreeState
} from './git.ts'

// Replays the worktree experiments (01 base, 02 turn commit, 04d merge-tree, 05 node_modules link,
// 06 setup) on temporary repositories. Every test ends with `untouched()`: the user's index, HEAD,
// branch and status must be exactly what they were, except for the files a merge wrote.

const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

function temp(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `rocket-git-${name}-`)))
  folders.push(dir)
  return dir
}

function sh(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
}

/** Like `sh` but keeps the leading space of the first status line. */
function raw(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trimEnd()
}

function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), text)
}

/** A repository with five tracked files and one commit; node_modules is ignored as in this project. */
function repo(): string {
  const dir = temp('main')
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.name', 'Test')
  sh(dir, 'config', 'user.email', 'test@example.com')
  write(dir, '.gitignore', 'node_modules\n')
  for (const name of ['a.ts', 'b.ts', 'c.ts', 'readme.md', 'src/d.ts']) write(dir, name, `${name} line 1\nline 2\nline 3\nline 4\nline 5\n`)
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-q', '-m', 'start')
  return dir
}

/** Everything a merge must leave alone, read from outside our code. */
function observe(dir: string) {
  return {
    index: sh(dir, 'ls-files', '-s'),
    indexFile: readFileSync(join(dir, '.git', 'index')).toString('hex'),
    head: sh(dir, 'rev-parse', 'HEAD'),
    branch: sh(dir, 'symbolic-ref', 'HEAD'),
    status: raw(dir, 'status', '--porcelain', '--untracked-files=all'),
    staged: sh(dir, 'diff', '--cached', '--name-only')
  }
}

function markersIn(dir: string): string[] {
  const files = sh(dir, 'ls-files', '-co', '--exclude-standard').split('\n').filter(Boolean)
  return files.filter((file) => existsSync(join(dir, file)) && /^(<<<<<<<|>>>>>>>) /m.test(readFileSync(join(dir, file), 'utf8')))
}

/** The user's index, HEAD, branch, staged and unstaged files are as before; nothing half-merged is left. */
function untouched(dir: string, before: ReturnType<typeof observe>, wrote: string[] = []): void {
  const after = observe(dir)
  assert.equal(after.head, before.head, 'HEAD moved')
  assert.equal(after.branch, before.branch, 'branch changed')
  assert.equal(after.index, before.index, 'index entries changed')
  assert.equal(after.staged, before.staged, 'staged files changed')
  if (!wrote.length) {
    assert.equal(after.indexFile, before.indexFile, 'index file changed')
    assert.equal(after.status, before.status, 'status changed')
  } else {
    // Only the files the merge wrote differ in status; everything else reads as before.
    const strip = (status: string) => status.split('\n').filter((line) => line && !wrote.includes(line.slice(3))).join('\n')
    assert.equal(strip(after.status), strip(before.status), 'status of other files changed')
  }
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    assert.equal(existsSync(join(dir, '.git', name)), false, `${name} left behind`)
  }
  assert.equal(sh(dir, 'ls-files', '-u'), '', 'unmerged entries left in the index')
  assert.deepEqual(markersIn(dir), [], 'conflict markers left in a file')
}

/** The state experiment 06 builds: the user has a staged file, an edited file and an untracked file. */
function dirty(dir: string): void {
  write(dir, 'readme.md', 'readme.md line 1\nstaged edit\nline 3\nline 4\nline 5\n')
  sh(dir, 'add', 'readme.md')
  write(dir, 'c.ts', 'c.ts line 1\nline 2\nuser edit\nline 4\nline 5\n')
  write(dir, 'notes/todo.txt', 'untracked\n')
}

/** A worktree on `rocket/run1/<task>` from the main tree now, plus its base commit. */
async function worker(dir: string, task: string): Promise<{ folder: string; branch: string; base: string; before: string }> {
  const base = (await baseCommit(dir, `base ${task}`))!
  const folder = join(temp(`wt-${task}`), 'tree')
  const branch = `rocket/run1/${task}`
  await addWorktree(dir, folder, branch, base)
  return { folder, branch, base, before: base }
}

/** What a turn does in a worktree: edit files, then commit them on the branch. */
function turn(folder: string, message: string, files: Record<string, string | null>): void {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(join(folder, path), { force: true })
    else write(folder, path, text)
  }
  sh(folder, 'add', '-A')
  sh(folder, 'commit', '-q', '--no-verify', '-m', message)
}

// Experiment 01: the base commit.

test('baseCommit holds the dirty, staged and untracked state and touches nothing of the user\'s', async () => {
  const dir = repo()
  dirty(dir)
  const before = observe(dir)
  const base = (await baseCommit(dir, 'Craft Studio base for task 0001'))!
  untouched(dir, before)
  assert.equal(sh(dir, 'rev-parse', `${base}^`), before.head)
  assert.equal(sh(dir, 'show', `${base}:c.ts`).includes('user edit'), true)
  assert.equal(sh(dir, 'show', `${base}:readme.md`).includes('staged edit'), true)
  assert.equal(sh(dir, 'show', `${base}:notes/todo.txt`), 'untracked')
  assert.equal(sh(dir, 'log', '-1', '--format=%s', base), 'Craft Studio base for task 0001')
  // No branch or tag points at it.
  assert.equal(sh(dir, 'branch', '--contains', base), '')
})

test('baseCommit works without a commit identity and in a repository with no commits', async () => {
  const dir = temp('fresh')
  sh(dir, 'init', '-q', '-b', 'main')
  write(dir, 'a.txt', 'one\n')
  const home = temp('home')
  const keep = { ...process.env }
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
  try {
    const base = (await baseCommit(dir))!
    assert.equal(sh(dir, 'show', `${base}:a.txt`), 'one')
    assert.equal(sh(dir, 'rev-list', '--parents', '-n1', base), base)
  } finally {
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL']) {
      if (keep[key] === undefined) delete process.env[key]
      else process.env[key] = keep[key]
    }
  }
})

test('a worktree starts with the dirty state, clean, on its branch, and the main tree is as it was', async () => {
  const dir = repo()
  dirty(dir)
  const before = observe(dir)
  const { folder, branch, base } = await worker(dir, '0001')
  untouched(dir, before)
  assert.equal(sh(folder, 'status', '--porcelain'), '')
  assert.equal(readFileSync(join(folder, 'c.ts'), 'utf8').includes('user edit'), true)
  assert.equal(readFileSync(join(folder, 'readme.md'), 'utf8').includes('staged edit'), true)
  assert.equal(readFileSync(join(folder, 'notes/todo.txt'), 'utf8'), 'untracked\n')
  assert.equal(sh(folder, 'symbolic-ref', '--short', 'HEAD'), branch)
  assert.equal(sh(folder, 'rev-parse', 'HEAD'), base)
  assert.match(sh(dir, 'worktree', 'list'), /rocket\/run1\/0001/)
})

test('a worktree is made with hooks off', async () => {
  const dir = repo()
  const marker = join(temp('hook'), 'ran')
  for (const hook of ['post-checkout', 'reference-transaction']) {
    write(dir, `.git/hooks/${hook}`, `#!/bin/sh\ntouch ${marker}\n`)
    execFileSync('chmod', ['+x', join(dir, '.git/hooks', hook)])
  }
  await worker(dir, '0001')
  assert.equal(existsSync(marker), false, 'a hook ran')
})

test('a worktree that cannot be made leaves no branch behind and says why', async () => {
  const dir = repo()
  const base = (await baseCommit(dir))!
  const taken = temp('taken')
  write(taken, 'file', 'x')
  await assert.rejects(addWorktree(dir, join(taken, 'file', 'inside'), 'rocket/run1/0009', base))
  assert.equal(sh(dir, 'branch', '--list', 'rocket/*'), '')
})

// Experiment 02: the per-turn commit in a worktree.

test('a turn commit in a worktree lands on its branch and the main tree stays as it was', async () => {
  const dir = repo()
  dirty(dir)
  const before = observe(dir)
  const { folder, branch, base } = await worker(dir, '0001')
  const { commitPaths, snapshot: snap, commitBlocker, repoRoot } = await import('./git.ts')
  assert.equal(await repoRoot(folder), folder)
  const first = (await snap(folder))!
  write(folder, 'a.ts', 'changed in worktree\n')
  const second = (await snap(folder))!
  assert.deepEqual(await changedBetween(folder, first, second), ['a.ts'])
  assert.equal(await commitBlocker(folder), null)
  assert.deepEqual(await commitPaths(folder, ['a.ts'], 'Turn one'), ['a.ts'])
  assert.deepEqual(await subjectsBetween(dir, base, branch), ['Turn one'])
  untouched(dir, before)
  // The private index is the worktree's own, not the main tree's.
  assert.notEqual(sh(folder, 'rev-parse', '--git-path', 'rocket-index'), sh(dir, 'rev-parse', '--git-path', 'rocket-index'))
})

// Experiment 05: node_modules.

test('a symlinked node_modules is ignored by a worktree snapshot', async () => {
  const dir = repo()
  write(dir, 'node_modules/pkg/index.js', 'module.exports = 1\n')
  const { folder, base } = await worker(dir, '0001')
  symlinkSync(join(dir, 'node_modules'), join(folder, 'node_modules'))
  assert.equal(lstatSync(join(folder, 'node_modules')).isSymbolicLink(), true)
  assert.equal(sh(folder, 'status', '--porcelain'), '')
  const state = (await worktreeState(folder))!
  assert.equal(sh(folder, 'rev-parse', `${state.tree}`), state.tree)
  assert.deepEqual(await changedBetween(folder, base, state.tree), [])
  assert.equal(sh(folder, 'ls-tree', '-r', '--name-only', state.tree).includes('node_modules'), false)
})

// The dirty-worktree read.

test('worktreeState reads a stopped worker\'s uncommitted edits, deletions and new files', async () => {
  const dir = repo()
  const { folder, branch, base } = await worker(dir, '0001')
  turn(folder, 'Turn one', { 'a.ts': 'committed\n' })
  write(folder, 'b.ts', 'edited, never committed\n')
  rmSync(join(folder, 'c.ts'))
  write(folder, 'new/e.ts', 'brand new\n')
  const tip = sh(folder, 'rev-parse', 'HEAD')
  const state = (await worktreeState(folder))!
  assert.equal(sh(folder, 'rev-parse', 'HEAD'), tip, 'the worktree\'s own HEAD moved')
  assert.equal(sh(dir, 'rev-parse', branch), tip)
  assert.equal(sh(dir, 'rev-parse', `${state.commit}^`), tip)
  assert.deepEqual((await changedBetween(dir, base, state.tree)).sort(), ['a.ts', 'b.ts', 'c.ts', 'new/e.ts'])
  assert.equal(sh(dir, 'show', `${state.tree}:b.ts`), 'edited, never committed')
})

// Experiment 04d / 06: merging.

test('a clean merge lands the worker\'s files and leaves the user\'s staged, edited and untracked files alone', async () => {
  const dir = repo()
  dirty(dir)
  const { folder, branch, base } = await worker(dir, '0001')
  turn(folder, 'Turn one', { 'a.ts': 'a.ts line 1\nworker\nline 3\nline 4\nline 5\n', 'new/f.ts': 'new\n' })
  turn(folder, 'Turn two', { 'b.ts': null, 'src/d.ts': 'src/d.ts line 1\nline 2\nline 3\nline 4\nworker end\n' })
  // The main tree moves on while the worker runs: a commit to a file the worker also edits, in another place.
  write(dir, 'src/d.ts', 'top line from main\nline 2\nline 3\nline 4\nline 5\n')
  sh(dir, 'add', 'src/d.ts')
  sh(dir, 'commit', '-q', '-m', 'main moves', '--', 'src/d.ts')
  const before = observe(dir)
  const tip = sh(dir, 'rev-parse', branch)
  const ours = (await baseCommit(dir, 'ours'))!
  const merged = await mergeTrees(dir, base, ours, tip)
  untouched(dir, before)
  assert.equal(merged.conflicts, undefined)
  assert.equal(typeof merged.tree, 'string')
  const result = await applyMerged(dir, base, tip, ours, merged.tree!)
  assert.deepEqual(result.written?.slice().sort(), ['a.ts', 'b.ts', 'new/f.ts', 'src/d.ts'])
  untouched(dir, before, result.written)
  assert.equal(existsSync(join(dir, 'b.ts')), false)
  assert.equal(readFileSync(join(dir, 'new/f.ts'), 'utf8'), 'new\n')
  assert.equal(readFileSync(join(dir, 'src/d.ts'), 'utf8'), 'top line from main\nline 2\nline 3\nline 4\nworker end\n')
  // The user's own work is where they left it.
  assert.equal(readFileSync(join(dir, 'c.ts'), 'utf8').includes('user edit'), true)
  assert.equal(readFileSync(join(dir, 'notes/todo.txt'), 'utf8'), 'untracked\n')
  assert.equal(sh(dir, 'diff', '--cached', '--name-only'), 'readme.md')
  void folder
})

test('a conflict is refused with the file named and nothing in the main tree is touched', async () => {
  const dir = repo()
  dirty(dir)
  const { folder, branch, base } = await worker(dir, '0001')
  turn(folder, 'Turn one', { 'a.ts': 'a.ts line 1\nworker version\nline 3\nline 4\nline 5\n', 'b.ts': 'b.ts line 1\nline 2\nline 3\nline 4\nworker b\n' })
  write(dir, 'a.ts', 'a.ts line 1\nmain version\nline 3\nline 4\nline 5\n')
  sh(dir, 'add', 'a.ts')
  sh(dir, 'commit', '-q', '-m', 'main edits a.ts', '--', 'a.ts')
  const before = observe(dir)
  const files = Object.fromEntries(['a.ts', 'b.ts', 'c.ts', 'readme.md', 'notes/todo.txt'].map((f) => [f, readFileSync(join(dir, f), 'utf8')]))
  const ours = (await baseCommit(dir))!
  const merged = await mergeTrees(dir, base, ours, sh(dir, 'rev-parse', branch))
  assert.deepEqual(merged, { conflicts: ['a.ts'] })
  untouched(dir, before)
  for (const [name, text] of Object.entries(files)) assert.equal(readFileSync(join(dir, name), 'utf8'), text, `${name} changed`)
  void folder
})

test('a file the user has uncommitted edits in is refused when the worker changed it, and nothing is written', async () => {
  const dir = repo()
  const { folder, branch, base } = await worker(dir, '0001')
  turn(folder, 'Turn one', { 'a.ts': 'a.ts line 1\nworker\nline 3\nline 4\nline 5\n', 'b.ts': 'b.ts line 1\nline 2\nline 3\nline 4\nworker b\n' })
  // After the worker started, the user edits a file the worker also changed, and does not commit it.
  write(dir, 'a.ts', 'a.ts line 1\nline 2\nline 3\nline 4\nuser tail\n')
  const before = observe(dir)
  const tip = sh(dir, 'rev-parse', branch)
  const ours = (await baseCommit(dir))!
  const merged = await mergeTrees(dir, base, ours, tip)
  assert.equal(merged.conflicts, undefined)
  const result = await applyMerged(dir, base, tip, ours, merged.tree!)
  assert.deepEqual(result, { refused: 'dirty', files: ['a.ts'] })
  untouched(dir, before)
  assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8').endsWith('user tail\n'), true)
  assert.equal(readFileSync(join(dir, 'b.ts'), 'utf8'), 'b.ts line 1\nline 2\nline 3\nline 4\nline 5\n', 'b.ts was written although the merge was refused')
  void folder
})

test('a file the user already had dirty when the worker started is refused too', async () => {
  const dir = repo()
  dirty(dir)
  const { folder, branch, base } = await worker(dir, '0001')
  turn(folder, 'Turn one', { 'c.ts': 'c.ts line 1\nline 2\nuser edit\nline 4\nworker tail\n' })
  const before = observe(dir)
  const tip = sh(dir, 'rev-parse', branch)
  const ours = (await baseCommit(dir))!
  const merged = await mergeTrees(dir, base, ours, tip)
  const result = await applyMerged(dir, base, tip, ours, merged.tree!)
  assert.deepEqual(result, { refused: 'dirty', files: ['c.ts'] })
  untouched(dir, before)
  void folder
})

test('a file that changes after the merge was computed is refused as moved', async () => {
  const dir = repo()
  const { folder, branch, base } = await worker(dir, '0001')
  turn(folder, 'Turn one', { 'a.ts': 'a.ts line 1\nworker\nline 3\nline 4\nline 5\n' })
  const tip = sh(dir, 'rev-parse', branch)
  const ours = (await baseCommit(dir))!
  const merged = await mergeTrees(dir, base, ours, tip)
  // A commit lands on the file in between: it is clean against HEAD, but not what the merge saw.
  write(dir, 'a.ts', 'a.ts line 1\nline 2\nline 3\nline 4\nlate commit\n')
  sh(dir, 'commit', '-q', '-am', 'late')
  const before = observe(dir)
  assert.deepEqual(await applyMerged(dir, base, tip, ours, merged.tree!), { refused: 'moved', files: ['a.ts'] })
  untouched(dir, before)
  void folder
})

test('a worker change to a file the user changed identically is not a conflict', async () => {
  const dir = repo()
  const { folder, branch, base } = await worker(dir, '0001')
  turn(folder, 'Turn one', { 'b.ts': 'same\n' })
  write(dir, 'b.ts', 'same\n')
  sh(dir, 'commit', '-q', '-am', 'same change')
  const ours = (await baseCommit(dir))!
  const merged = await mergeTrees(dir, base, ours, sh(dir, 'rev-parse', branch))
  assert.equal(merged.conflicts, undefined)
  void folder
})

// The squashed commit.

test('a merged task is one commit with the turn subjects in its body, and other work stays uncommitted', async () => {
  const dir = repo()
  dirty(dir)
  const { folder, branch, base } = await worker(dir, '0001')
  turn(folder, 'Add the parser', { 'a.ts': 'a.ts line 1\nworker\nline 3\nline 4\nline 5\n' })
  turn(folder, 'Fix the parser', { 'new/f.ts': 'new\n' })
  const tip = sh(dir, 'rev-parse', branch)
  const before = observe(dir)
  const ours = (await baseCommit(dir))!
  const merged = await mergeTrees(dir, base, ours, tip)
  const result = (await applyMerged(dir, base, tip, ours, merged.tree!)).written!
  const commit = await commitSquashed(dir, result, 'Task 0001: parser', await subjectsBetween(dir, base, tip))
  assert.ok(commit)
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), commit)
  assert.equal(sh(dir, 'rev-parse', 'HEAD^'), before.head)
  assert.equal(sh(dir, 'log', '-1', '--format=%B', commit), 'Task 0001: parser\n\n- Add the parser\n- Fix the parser')
  assert.deepEqual(sh(dir, 'show', '--name-only', '--format=', commit).split('\n').sort(), ['a.ts', 'new/f.ts'])
  // Still staged, edited and untracked as the user left them.
  assert.equal(sh(dir, 'diff', '--cached', '--name-only'), 'readme.md')
  assert.match(raw(dir, 'status', '--porcelain'), / M c\.ts/)
  assert.match(sh(dir, 'status', '--porcelain'), /\?\? notes\//)
  assert.equal(await commitSquashed(dir, result, 'again', []), null)
  void folder
})

// Experiment 11: cleanup.

test('removing a worktree and its branch leaves nothing behind, even for dirty or vanished folders', async () => {
  const dir = repo()
  dirty(dir)
  const before = observe(dir)
  const one = await worker(dir, '0001')
  const two = await worker(dir, '0002')
  const three = await worker(dir, '0003')
  write(one.folder, 'a.ts', 'dirty and uncommitted\n')
  await removeWorktree(dir, one.folder)
  await deleteBranch(dir, one.branch)
  // A folder deleted behind git's back is pruned, then its branch goes.
  rmSync(two.folder, { recursive: true, force: true })
  assert.match(sh(dir, 'worktree', 'list', '--porcelain'), /prunable/)
  await pruneWorktrees(dir)
  await deleteBranch(dir, two.branch)
  // A locked branch name that does not exist is not an error.
  await deleteBranch(dir, 'rocket/run1/nothing')
  await removeWorktree(dir, three.folder)
  await removeWorktree(dir, three.folder)
  await deleteBranch(dir, three.branch)
  assert.equal(existsSync(one.folder), false)
  assert.equal(existsSync(three.folder), false)
  assert.equal(sh(dir, 'branch', '--list', 'rocket/*'), '')
  assert.equal(sh(dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1)
  untouched(dir, before)
})

test('two runs with the same task id do not collide when their folders differ', async () => {
  const dir = repo()
  const base = (await baseCommit(dir))!
  const a = join(temp('run-a'), 'b1f0205e-0001')
  const b = join(temp('run-b'), 'c2e1316f-0001')
  await addWorktree(dir, a, 'rocket/b1f0205e/0001', base)
  await addWorktree(dir, b, 'rocket/c2e1316f/0001', base)
  assert.equal(existsSync(join(a, 'a.ts')), true)
  assert.equal(existsSync(join(b, 'a.ts')), true)
  await removeWorktree(dir, a)
  await removeWorktree(dir, b)
})

test('snapshot of the main tree is unaffected by worktrees existing', async () => {
  const dir = repo()
  const before = (await snapshot(dir))!
  await worker(dir, '0001')
  assert.equal(await snapshot(dir), before)
})
