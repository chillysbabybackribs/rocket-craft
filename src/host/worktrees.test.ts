import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { Store } from './store.ts'
import { Teamwork } from './teamwork.ts'
import { Worktrees } from './worktrees.ts'

const RUN = 'b1f0205e-8726-43e4-a5db-eb27e31a03c5'

function setup(options: { checkCommand?: string | null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rocket-worktrees-')))
  const dir = join(root, 'main')
  const dataDir = join(root, 'data')
  mkdirSync(dir)
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
  const write = (cwd: string, path: string, text: string): void => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), text)
  }
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.com')
  write(dir, '.gitignore', 'node_modules\n')
  write(dir, 'a.ts', 'a\n')
  write(dir, 'b.ts', 'b\n')
  mkdirSync(join(dir, 'node_modules'))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'start')
  const teamwork = new Teamwork(new Store(':memory:'), () => [], { commit: true })
  const service = new Worktrees({ folder: dir, dataDir, serial: (top, work) => teamwork.serial(top, work), checkCommand: options.checkCommand ?? 'true' })
  const task = (id: string, base: string) => ({ run: RUN, task: id, base, title: `work ${id}` })
  return { root, dir, dataDir, git, write, service, teamwork, task, done: () => rmSync(root, { recursive: true, force: true }) }
}

const count = (git: (cwd: string, ...args: string[]) => string, dir: string): number => Number(git(dir, 'rev-list', '--count', 'HEAD'))

test('create, a worker edit, then merge: the file lands in the main folder as one squashed commit', async () => {
  const t = setup()
  try {
    t.write(t.dir, 'dirty.ts', 'uncommitted main work\n')
    const made = await t.service.create(RUN, '0001')
    assert.equal(made.branch, 'rocket/b1f0205e/0001')
    assert.equal(made.folder, join(t.dataDir, 'worktrees', 'b1f0205e-0001'))
    assert.equal(readFileSync(join(made.folder, 'dirty.ts'), 'utf8'), 'uncommitted main work\n')
    assert.ok(existsSync(join(made.folder, 'node_modules')), 'node_modules is linked')
    assert.equal(t.git(made.folder, 'status', '--porcelain'), '')

    t.write(made.folder, 'a.ts', 'a changed\n')
    t.git(made.folder, 'commit', '-q', '-am', 'first turn')
    t.write(made.folder, 'new.ts', 'new, never committed\n')
    const before = count(t.git, t.dir)
    const result = await t.service.merge(t.task('0001', made.base))
    assert.equal(result.status, 'merged')
    assert.deepEqual(result.status === 'merged' && result.files.sort(), ['a.ts', 'new.ts'])
    assert.equal(readFileSync(join(t.dir, 'a.ts'), 'utf8'), 'a changed\n')
    assert.equal(readFileSync(join(t.dir, 'new.ts'), 'utf8'), 'new, never committed\n')
    assert.equal(count(t.git, t.dir), before + 1)
    assert.match(t.git(t.dir, 'log', '-1', '--format=%B'), /^Task 0001: work 0001\n\n- first turn/)
    assert.match(t.git(t.dir, 'status', '--porcelain'), /\?\? dirty\.ts/, 'the user\'s own file is not swept in')
    assert.equal(existsSync(made.folder), false)
    assert.equal(t.git(t.dir, 'branch', '--list', 'rocket/*'), '')
  } finally { t.done() }
})

test('a conflicting merge is refused and leaves the main folder untouched', async () => {
  const t = setup()
  try {
    const made = await t.service.create(RUN, '0001')
    t.write(made.folder, 'a.ts', 'worker\n')
    t.write(t.dir, 'a.ts', 'main\n')
    t.git(t.dir, 'commit', '-q', '-am', 'main moved')
    const head = t.git(t.dir, 'rev-parse', 'HEAD')
    const result = await t.service.merge(t.task('0001', made.base))
    assert.equal(result.status, 'refused')
    assert.equal(result.status === 'refused' && result.reason, 'conflict')
    assert.deepEqual(result.status === 'refused' && result.files, ['a.ts'])
    assert.match(result.status === 'refused' ? result.message : '', /^Task 0001 was not merged: a\.ts changed in both/)
    assert.equal(t.git(t.dir, 'rev-parse', 'HEAD'), head)
    assert.equal(t.git(t.dir, 'status', '--porcelain'), '')
    assert.equal(readFileSync(join(t.dir, 'a.ts'), 'utf8'), 'main\n')
    assert.ok(existsSync(made.folder), 'a refused task keeps its worktree')
  } finally { t.done() }
})

test('a file the user has edited and not committed is refused as dirty', async () => {
  const t = setup()
  try {
    const made = await t.service.create(RUN, '0001')
    t.write(made.folder, 'a.ts', 'worker\n')
    t.write(t.dir, 'a.ts', 'user edit\n')
    const result = await t.service.merge(t.task('0001', made.base))
    assert.equal(result.status === 'refused' && result.reason, 'dirty')
    assert.equal(readFileSync(join(t.dir, 'a.ts'), 'utf8'), 'user edit\n')
  } finally { t.done() }
})

test('a merge is refused while a rebase is in progress', async () => {
  const t = setup()
  try {
    const made = await t.service.create(RUN, '0001')
    t.write(made.folder, 'a.ts', 'worker\n')
    mkdirSync(join(t.dir, '.git', 'rebase-merge'))
    const result = await t.service.merge(t.task('0001', made.base))
    assert.equal(result.status === 'refused' && result.reason, 'in progress')
    assert.equal(readFileSync(join(t.dir, 'a.ts'), 'utf8'), 'a\n')
  } finally { t.done() }
})

test('a failing check is refused with the output tail and writes nothing', async () => {
  const t = setup({ checkCommand: 'echo first; echo "test x failed: expected 1" >&2; exit 3' })
  try {
    const made = await t.service.create(RUN, '0001')
    t.write(made.folder, 'a.ts', 'worker\n')
    const head = t.git(t.dir, 'rev-parse', 'HEAD')
    const result = await t.service.merge(t.task('0001', made.base))
    assert.equal(result.status === 'refused' && result.reason, 'check failed')
    assert.match(result.status === 'refused' ? result.output ?? '' : '', /test x failed: expected 1/)
    assert.equal(t.git(t.dir, 'rev-parse', 'HEAD'), head)
    assert.equal(readFileSync(join(t.dir, 'a.ts'), 'utf8'), 'a\n')
    assert.equal(t.git(t.dir, 'status', '--porcelain'), '')
    assert.equal(existsSync(join(t.dataDir, 'worktrees', 'check-b1f0205e-0001')), false, 'the scratch worktree is gone')
    assert.equal(t.git(t.dir, 'branch', '--list', 'rocket-check/*'), '')
  } finally { t.done() }
})

test('the check runs on the merged result, not on the worker alone', async () => {
  const t = setup({ checkCommand: 'test "$(cat a.ts)" = "a" && test -f b2.ts' })
  try {
    const made = await t.service.create(RUN, '0001')
    t.write(made.folder, 'b2.ts', 'worker\n')
    assert.equal((await t.service.merge(t.task('0001', made.base))).status, 'merged')
    const second = await t.service.create(RUN, '0002')
    t.write(second.folder, 'c.ts', 'c\n')
    const result = await t.service.merge(t.task('0002', second.base))
    assert.equal(result.status, 'merged', 'b2.ts from the first merge is in the checked tree')
  } finally { t.done() }
})

test('two merges at once run one after the other', async () => {
  const log = join(tmpdir(), `rocket-worktrees-log-${process.pid}`)
  const t = setup({ checkCommand: `echo start >> ${log}; sleep 0.4; echo end >> ${log}` })
  try {
    const one = await t.service.create(RUN, '0001')
    const two = await t.service.create(RUN, '0002')
    t.write(one.folder, 'one.ts', '1\n')
    t.write(two.folder, 'two.ts', '2\n')
    const results = await Promise.all([t.service.merge(t.task('0001', one.base)), t.service.merge(t.task('0002', two.base))])
    assert.deepEqual(results.map((r) => r.status), ['merged', 'merged'])
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['start', 'end', 'start', 'end'])
    assert.equal(t.git(t.dir, 'log', '--format=%s', '-2').split('\n').length, 2)
  } finally { rmSync(log, { force: true }); t.done() }
})

test('discard removes the folder and the branch at once', async () => {
  const t = setup()
  try {
    const made = await t.service.create(RUN, '0001')
    t.write(made.folder, 'a.ts', 'unsaved\n')
    await t.service.discard({ run: RUN, task: '0001' })
    assert.equal(existsSync(made.folder), false)
    assert.equal(t.git(t.dir, 'branch', '--list', 'rocket/*'), '')
    assert.equal(t.git(t.dir, 'worktree', 'list').split('\n').length, 1)
    await t.service.discard({ run: RUN, task: '0001' })
  } finally { t.done() }
})

test('reconcile removes an orphan and reports a task whose folder is missing', async () => {
  const t = setup()
  try {
    const keep = await t.service.create(RUN, '0001')
    const orphan = await t.service.create(RUN, '0002')
    const lost = await t.service.create(RUN, '0003')
    rmSync(lost.folder, { recursive: true })
    t.git(t.dir, 'branch', 'rocket/deadbeef/0009', 'HEAD')
    t.git(t.dir, 'branch', 'feature/other', 'HEAD')
    const result = await t.service.reconcile([{ run: RUN, task: '0001' }, { run: RUN, task: '0003' }])
    assert.deepEqual(result.missing, [{ run: RUN, task: '0003' }])
    assert.equal(existsSync(keep.folder), true)
    assert.equal(existsSync(orphan.folder), false)
    const branches = t.git(t.dir, 'branch', '--format=%(refname:short)').split('\n')
    assert.ok(branches.includes('rocket/b1f0205e/0001') && branches.includes('rocket/b1f0205e/0003') && branches.includes('feature/other'))
    assert.ok(!branches.includes('rocket/b1f0205e/0002') && !branches.includes('rocket/deadbeef/0009'))
  } finally { t.done() }
})

test('reconcile keeps a rocket branch checked out in another worktree and still deletes orphans', async () => {
  const t = setup()
  try {
    const keep = await t.service.create(RUN, '0001')
    t.git(t.dir, 'branch', 'rocket/otherprof/0099', 'HEAD')
    const other = join(t.root, 'live-worktree')
    mkdirSync(other)
    t.git(t.dir, 'worktree', 'add', '-q', other, 'rocket/otherprof/0099')
    t.git(t.dir, 'branch', 'rocket/orphan/0002', 'HEAD')
    const result = await t.service.reconcile([{ run: RUN, task: '0001' }])
    assert.deepEqual(result.missing, [])
    assert.equal(result.warnings.length, 0)
    const branches = t.git(t.dir, 'branch', '--format=%(refname:short)').split('\n')
    assert.ok(branches.includes('rocket/b1f0205e/0001'))
    assert.ok(branches.includes('rocket/otherprof/0099'), 'another profile\'s checked-out branch stays')
    assert.ok(!branches.includes('rocket/orphan/0002'))
    assert.equal(existsSync(keep.folder), true)
    assert.ok(existsSync(other))
  } finally { t.done() }
})

test('reconcile continues branch cleanup when one deletion fails', async () => {
  const t = setup()
  const stuckDir = join(t.dir, '.git/refs/heads/rocket/stuck')
  try {
    t.git(t.dir, 'branch', 'rocket/stuck/0001', 'HEAD')
    t.git(t.dir, 'branch', 'rocket/free/0002', 'HEAD')
    chmodSync(stuckDir, 0o555)
    const result = await t.service.reconcile([])
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /Could not delete branch rocket\/stuck\/0001/)
    assert.ok(result.removed.includes('rocket/free/0002'))
    const branches = t.git(t.dir, 'branch', '--format=%(refname:short)').split('\n')
    assert.ok(branches.includes('rocket/stuck/0001'))
    assert.ok(!branches.includes('rocket/free/0002'))
  } finally {
    try { chmodSync(stuckDir, 0o755) } catch { /* already gone */ }
    t.done()
  }
})

test('a folder outside a repository gets a sentence, not a stack', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rocket-worktrees-none-')))
  try {
    const service = new Worktrees({ folder: root, dataDir: join(root, 'd'), serial: (_top, work) => work() })
    await assert.rejects(service.create(RUN, '0001'), /not inside a git repository/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
