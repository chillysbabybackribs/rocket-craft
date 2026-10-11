import assert from 'node:assert/strict'
import { test } from 'node:test'
import { downloadTarget, safeFileName, uniquePath } from './download-path.ts'

test('a suggested file name cannot climb out of the folder or carry control characters', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd')
  assert.equal(safeFileName('C:\\Users\\me\\report.pdf'), 'report.pdf')
  assert.equal(safeFileName('bad\u0007name.txt'), 'badname.txt')
  assert.equal(safeFileName(''), 'download')
  assert.equal(safeFileName('..'), 'download')
})

test('saveTo names a folder or a file, and defaults to the downloads folder', () => {
  const dirs = new Set(['/work/existing'])
  const isDir = (path: string) => dirs.has(path)
  assert.equal(downloadTarget(null, 'a.pdf', '/home/me/Downloads', isDir), '/home/me/Downloads/a.pdf')
  assert.equal(downloadTarget('/work/existing', 'a.pdf', '/d', isDir), '/work/existing/a.pdf')
  assert.equal(downloadTarget('/work/new/', 'a.pdf', '/d', isDir), '/work/new/a.pdf')
  assert.equal(downloadTarget('/work/reports', 'a.pdf', '/d', isDir), '/work/reports/a.pdf')
  assert.equal(downloadTarget('/work/brief.pdf', 'a.pdf', '/d', isDir), '/work/brief.pdf')
})

test('an existing or arriving file is never overwritten', () => {
  const taken = new Set(['/d/a.pdf', '/d/a (1).pdf'])
  assert.equal(uniquePath('/d/a.pdf', path => taken.has(path)), '/d/a (2).pdf')
  assert.equal(uniquePath('/d/b.pdf', path => taken.has(path)), '/d/b.pdf')
  assert.equal(uniquePath('/d/notes', path => path === '/d/notes'), '/d/notes (1)')
})
