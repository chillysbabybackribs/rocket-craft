// A unified diff, as `git diff` writes it, read into files, hunks and lines. The host uses the
// counts to describe a turn's changes in one line; the renderer uses the lines to draw them.
// Only what git itself emits is handled (no renames, since the app diffs with --no-renames).

export type PatchLine = {
  /** ' ' is context, '+' added, '-' removed. */
  type: ' ' | '+' | '-'
  /** Line numbers in the old and new file; null where the line is not in that side. */
  old: number | null
  new: number | null
  text: string
}

export type PatchHunk = { header: string; lines: PatchLine[] }

export type PatchFile = {
  path: string
  kind: 'edited' | 'added' | 'deleted' | 'binary'
  added: number
  removed: number
  hunks: PatchHunk[]
}

const FILE_HEAD = /^diff --git a\/(.*) b\/(.*)$/
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parsePatch(text: string): PatchFile[] {
  const files: PatchFile[] = []
  let file: PatchFile | null = null
  let hunk: PatchHunk | null = null
  let oldLine = 0
  let newLine = 0
  for (const line of text.split('\n')) {
    const head = FILE_HEAD.exec(line)
    if (head) {
      file = { path: head[2]!, kind: 'edited', added: 0, removed: 0, hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    // An empty line inside a hunk is a blank context line whose leading space was stripped on the way here.
    if (!hunk || !(line === '' || /^[ +\-\\]/.test(line)) || HUNK_HEAD.test(line)) {
      // Between hunks: the extended header lines, then the hunk head.
      if (line.startsWith('new file mode')) file.kind = 'added'
      else if (line.startsWith('deleted file mode')) file.kind = 'deleted'
      else if (line.startsWith('Binary files')) file.kind = 'binary'
      const at = HUNK_HEAD.exec(line)
      if (at) {
        hunk = { header: line, lines: [] }
        file.hunks.push(hunk)
        oldLine = Number(at[1])
        newLine = Number(at[2])
      } else {
        hunk = null
      }
      continue
    }
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    const type = (line === '' ? ' ' : line[0]) as PatchLine['type']
    const body = line.slice(1)
    if (type === '+') {
      file.added++
      hunk.lines.push({ type, old: null, new: newLine++, text: body })
    } else if (type === '-') {
      file.removed++
      hunk.lines.push({ type, old: oldLine++, new: null, text: body })
    } else {
      hunk.lines.push({ type: ' ', old: oldLine++, new: newLine++, text: body })
    }
  }
  return files
}

/** The totals a transcript line shows. */
export function patchTotals(files: PatchFile[]): { files: number; added: number; removed: number } {
  return {
    files: files.length,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0)
  }
}
