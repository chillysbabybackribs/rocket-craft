import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { oneLine } from './json.ts'

// The few things the app asks of git, so that models never have to: what a folder's files look
// like at a moment (a snapshot), what changed between two such moments, and a commit of exactly
// the files a turn changed. Snapshots are trees written through an index of the app's own, so
// the user's index, staged changes and branch are never touched by taking one.

const TIMEOUT_MS = 15_000
/** States in which a commit would land in the middle of something the user is doing by hand. */
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply']

interface GitOptions { input?: string; env?: Record<string, string>; timeout?: number }

/** Runs git and reports how it ended, for the few commands whose exit code is an answer (merge-tree exits 1 on conflicts). */
function gitRun(top: string, args: string[], options: GitOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    // Paths are passed as they are: a file named `a[1].ts` is that file, not a pattern.
    const child = execFile('git', ['--literal-pathspecs', '-C', top, ...args], {
      timeout: options.timeout ?? TIMEOUT_MS, maxBuffer: 32_000_000, env: { ...process.env, ...options.env }
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
      if (code === -1) fail(new Error(oneLine(stderr || error?.message || 'git did not run', 300)))
      else done({ code, stdout, stderr })
    })
    // A git that exits before reading its input reports why itself; the broken pipe adds nothing.
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.input ?? '')
  })
}

async function git(top: string, args: string[], options: GitOptions = {}): Promise<string> {
  const { code, stdout, stderr } = await gitRun(top, args, options)
  if (code) throw new Error(oneLine(stderr || `git ${args[0]} exited with ${code}`, 300))
  return stdout
}

const nul = (text: string): string[] => text.split('\0').filter(Boolean)

/** The top of the repository a folder is in, or null when it is in none. A home folder is never treated as a project. */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
    return top && top !== homedir() ? top : null
  } catch {
    return null
  }
}

async function gitPath(top: string, name: string): Promise<string> {
  return resolve(top, (await git(top, ['rev-parse', '--git-path', name])).trim())
}

/** The working tree as it stands, as a tree id: every file git tracks or would track. Null when it cannot be taken. */
export async function snapshot(top: string): Promise<string | null> {
  try {
    // An index kept between snapshots, so only files that changed since the last one are read again.
    const index = await gitPath(top, 'rocket-index')
    if (!existsSync(index)) await copyFile(await gitPath(top, 'index'), index).catch(() => {})
    const env = { GIT_INDEX_FILE: index }
    await git(top, ['add', '-A'], { env })
    return (await git(top, ['write-tree'], { env })).trim() || null
  } catch {
    return null
  }
}

/** The files that differ between two snapshots, relative to the top. */
export async function changedBetween(top: string, before: string, after: string): Promise<string[]> {
  if (before === after) return []
  return nul(await git(top, ['diff', '--name-only', '-z', '--no-renames', before, after]))
}

/** How much of a turn's patch is kept; past this a turn has rewritten more than anyone reads in a panel. */
export const PATCH_LIMIT = 2_000_000

/** The unified diff of these files between two snapshots, cut to `PATCH_LIMIT` with `truncated` saying so. */
export async function patchBetween(top: string, before: string, after: string, paths: string[]): Promise<{ patch: string; truncated: boolean }> {
  if (before === after || !paths.length) return { patch: '', truncated: false }
  // `git diff` has no --pathspec-from-file; the paths go on the command line, literal under --literal-pathspecs.
  const text = await git(top, ['diff', '--no-color', '--no-renames', '--no-ext-diff', before, after, '--', ...paths])
  if (text.length <= PATCH_LIMIT) return { patch: text, truncated: false }
  // Cut at a file boundary, so what is shown is whole files.
  const cut = text.lastIndexOf('\ndiff --git ', PATCH_LIMIT)
  return { patch: text.slice(0, cut > 0 ? cut : PATCH_LIMIT), truncated: true }
}

/** The paths among `paths` that exist in a snapshot. */
export async function pathsIn(top: string, tree: string, paths: string[]): Promise<string[]> {
  if (!paths.length) return []
  const listed = nul(await git(top, ['ls-tree', '-r', '-z', '--name-only', tree, '--', ...paths]))
  const wanted = new Set(paths)
  return listed.filter((path) => wanted.has(path))
}

/**
 * Put files back as a snapshot has them, in the working tree only: the user's index is not
 * touched. Files the snapshot does not hold are removed; those are the ones made after it.
 */
export async function restoreFrom(top: string, tree: string, paths: string[]): Promise<void> {
  const kept = await pathsIn(top, tree, paths)
  if (kept.length) await git(top, ['restore', `--source=${tree}`, '--worktree', '--', ...kept])
  const keptSet = new Set(kept)
  for (const path of paths) if (!keptSet.has(path)) await rm(resolve(top, path), { force: true })
}

/** Why a commit should not be made right now, or null when one can be. */
export async function commitBlocker(top: string): Promise<string | null> {
  for (const name of IN_PROGRESS) if (existsSync(await gitPath(top, name))) return `a ${name.replace(/_HEAD|_LOG/, '').toLowerCase()} is in progress`
  return git(top, ['symbolic-ref', '-q', 'HEAD']).then(() => null, () => 'HEAD is not on a branch')
}

/**
 * Commit these files, and only these, as they now stand: whatever else is changed or staged in
 * the repository is left exactly as it is. Returns the files committed, which is none when they
 * hold nothing new. Hooks are not run: this is the app keeping a record, not a person publishing.
 */
export async function commitPaths(top: string, paths: string[], message: string): Promise<string[]> {
  const wanted = new Set(paths)
  const status = nul(await git(top, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']))
  const dirty = status.map((entry) => entry.slice(3)).filter((path) => wanted.has(path))
  if (!dirty.length) return []
  const input = dirty.join('\0')
  const fromInput = ['--pathspec-from-file=-', '--pathspec-file-nul']
  await git(top, ['add', '-A', ...fromInput], { input })
  await git(top, ['commit', '-q', '--no-verify', '-m', message, ...fromInput], { input })
  return dirty
}

// Worktrees for workers. Everything below works in git's object store or in the worker's own
// folder: the main tree's index, HEAD and branch are never written, and no merge, cherry-pick,
// rebase, stash or reset ever runs there. Hooks are off for every call that checks files out.

const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null']
/** Checking out a large tree can take longer than a question about one. */
const CHECKOUT_TIMEOUT_MS = 120_000

/** A commit identity for commits the app makes with `commit-tree`, which cannot run without one. */
async function identity(top: string): Promise<Record<string, string>> {
  const has = (key: string) => git(top, ['config', '--get', key]).then((value) => !!value.trim(), () => false)
  const env: Record<string, string> = {}
  if (!(await has('user.name'))) Object.assign(env, { GIT_AUTHOR_NAME: 'Craft Studio', GIT_COMMITTER_NAME: 'Craft Studio' })
  if (!(await has('user.email'))) Object.assign(env, { GIT_AUTHOR_EMAIL: 'rocket@localhost', GIT_COMMITTER_EMAIL: 'rocket@localhost' })
  return env
}

/** HEAD as a commit id, or null in a repository with no commits yet. */
async function headCommit(top: string): Promise<string | null> {
  return git(top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).then((id) => id.trim() || null, () => null)
}

/** A commit of `tree` that no branch points at, on top of `parent` (none for a first commit). */
export async function commitTree(top: string, tree: string, parent: string | null, message: string): Promise<string> {
  const args = ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]
  return (await git(top, args, { env: await identity(top) })).trim()
}

/**
 * The working tree as it stands, uncommitted and untracked files included, as a commit on top of
 * HEAD that no branch points at. It goes through the app's own index, so the user's index, HEAD
 * and branch are not touched. Null when the tree cannot be read.
 */
export async function baseCommit(top: string, message = 'Craft Studio base'): Promise<string | null> {
  const tree = await snapshot(top)
  return tree ? commitTree(top, tree, await headCommit(top), message) : null
}

/**
 * A folder at `folder` on a new branch `branch` that starts at `base`. The files are checked out
 * in a second step, with hooks off, so no `post-checkout` hook of the repository runs.
 */
export async function addWorktree(top: string, folder: string, branch: string, base: string): Promise<void> {
  const existed = existsSync(folder)
  try {
    await git(top, [...NO_HOOKS, 'worktree', 'add', '-q', '--no-checkout', '-b', branch, folder, base])
    await git(folder, [...NO_HOOKS, 'reset', '-q', '--hard'], { timeout: CHECKOUT_TIMEOUT_MS })
  } catch (error) {
    // Half a worktree is worse than none: take it and its branch back out, but never a folder that was there already.
    if (!existed) await removeWorktree(top, folder).catch(() => {})
    await deleteBranch(top, branch).catch(() => {})
    throw error
  }
}

/** Take a worktree away, with whatever uncommitted work it holds. A folder already gone is only forgotten. */
export async function removeWorktree(top: string, folder: string): Promise<void> {
  await git(top, ['worktree', 'remove', '--force', '--force', folder]).catch(() => {})
  await rm(folder, { recursive: true, force: true })
  await pruneWorktrees(top)
}

/** Forget worktrees whose folders no longer exist. */
export async function pruneWorktrees(top: string): Promise<void> {
  await git(top, ['worktree', 'prune'])
}

/** Delete a branch whether or not it was merged, since a squashed merge never makes it so. Missing is fine. */
export async function deleteBranch(top: string, branch: string): Promise<void> {
  const exists = await git(top, ['show-ref', '--verify', '-q', `refs/heads/${branch}`]).then(() => true, () => false)
  if (exists) await git(top, ['branch', '-D', '-q', branch])
}

/** The local branches whose names start with `prefix`, such as `rocket/`. */
export async function listBranches(top: string, prefix: string): Promise<string[]> {
  const text = await git(top, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`])
  return text.split('\n').filter(Boolean)
}

/** Branch names checked out in any worktree (`branch refs/heads/...` lines from porcelain list). */
export async function checkedOutBranches(top: string): Promise<Set<string>> {
  const text = await git(top, ['worktree', 'list', '--porcelain'])
  const branches = new Set<string>()
  for (const line of text.split('\n')) {
    const match = /^branch refs\/heads\/(.+)$/.exec(line)
    if (match) branches.add(match[1])
  }
  return branches
}

/** A worktree's files as they stand, including edits no turn committed, as a tree and a commit on top of its tip. */
export async function worktreeState(folder: string, message = 'Craft Studio worktree state'): Promise<{ tree: string; commit: string } | null> {
  const tree = await snapshot(folder)
  return tree ? { tree, commit: await commitTree(folder, tree, await headCommit(folder), message) } : null
}

/** The turn subjects a branch holds past its base, oldest first. */
export async function subjectsBetween(top: string, base: string, tip: string): Promise<string[]> {
  return (await git(top, ['log', '--reverse', '--format=%s', `${base}..${tip}`])).split('\n').filter(Boolean)
}

export type MergeResult = { tree: string; conflicts?: undefined } | { tree?: undefined; conflicts: string[] }

/**
 * Merge `theirs` into `ours` from the stated `base`, in the object store only: the working tree,
 * the index and HEAD are never written. Each is a commit or a tree. Returns the merged tree, or
 * the files that conflict.
 */
export async function mergeTrees(top: string, base: string, ours: string, theirs: string): Promise<MergeResult> {
  const { code, stdout, stderr } = await gitRun(top, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', `--merge-base=${base}`, ours, theirs])
  const [tree, ...files] = nul(stdout)
  if (code === 0 && tree) return { tree }
  if (code === 1) return { conflicts: files }
  throw new Error(oneLine(stderr || `git merge-tree exited with ${code}`, 300))
}

export type ApplyResult =
  | { written: string[]; refused?: undefined; files?: undefined }
  | { written?: undefined; refused: 'dirty' | 'moved'; files: string[] }

/**
 * Write what a worker changed, taken from the merged tree, into the main working tree: only the
 * files the worker changed between `base` and `worker`, and nothing else. `ours` is the tree the
 * merge started from. A file is refused, and then nothing at all is written, when the user has
 * uncommitted edits in it ('dirty') or it changed since `ours` was taken ('moved'). The index
 * and HEAD are not touched.
 */
export async function applyMerged(top: string, base: string, worker: string, ours: string, merged: string): Promise<ApplyResult> {
  const theirs = new Set(await changedBetween(top, base, worker))
  const now = await snapshot(top)
  if (!now) throw new Error('The main folder could not be read, so nothing was written. Try the merge again.')
  const head = (await git(top, ['rev-parse', '--verify', '-q', 'HEAD^{tree}']).catch(() => '')).trim()
  const dirty = head ? (await changedBetween(top, head, now)).filter((path) => theirs.has(path)) : []
  if (dirty.length) return { refused: 'dirty', files: dirty }
  const moved = (await changedBetween(top, ours, now)).filter((path) => theirs.has(path))
  if (moved.length) return { refused: 'moved', files: moved }
  const written = (await changedBetween(top, now, merged)).filter((path) => theirs.has(path))
  await restoreFrom(top, merged, written)
  return { written }
}

/**
 * One commit for a merged task: the title as its subject and the turn subjects as its body,
 * holding these files only, made the way a turn's commit is. Returns the new commit, or null
 * when the files held nothing new.
 */
export async function commitSquashed(top: string, paths: string[], title: string, subjects: string[]): Promise<string | null> {
  const body = subjects.map((subject) => `- ${subject}`).join('\n')
  const committed = await commitPaths(top, paths, body ? `${title}\n\n${body}` : title)
  return committed.length ? (await headCommit(top)) : null
}
