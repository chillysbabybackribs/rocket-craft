import { memo, useMemo, useRef, useState } from 'react'
import type { PatchFile } from '../../../shared/patch.ts'
import { parsePatch, patchTotals } from '../../../shared/patch.ts'
import type { TurnPatch } from '../../../shared/types.ts'

// What a turn changed, as a unified diff: a strip of its files to jump between, then each file
// under a heading that stays put while its hunks scroll. Read-only; putting the folder back is a
// later decision (docs/mockups/turn-changes.html).

/** `+184 −12`, each figure in its colour; a side with nothing is left out. */
export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="counts">
      {added > 0 && <span className="is-add">+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span className="is-del">−{removed}</span>}
    </span>
  )
}

/** Five blocks showing the balance of added to removed lines, as GitHub draws it. */
export function Bar({ added, removed }: { added: number; removed: number }) {
  const total = added + removed
  if (!total) return null
  const green = removed === 0 ? 5 : added === 0 ? 0 : Math.min(4, Math.max(1, Math.round((5 * added) / total)))
  const red = removed === 0 ? 0 : 5 - green
  return (
    <span className="bar" aria-hidden="true">
      {Array.from({ length: 5 }, (_, index) => <i key={index} className={index < green ? 'is-add' : index < green + red ? 'is-del' : ''} />)}
    </span>
  )
}

const KIND_LABEL: Record<PatchFile['kind'], string | null> = { edited: null, added: 'new', deleted: 'deleted', binary: 'binary' }

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

const FileDiff = memo(function FileDiff({ file, anchor }: { file: PatchFile; anchor: (element: HTMLDivElement | null) => void }) {
  const kind = KIND_LABEL[file.kind]
  return (
    <section className="diff-file">
      <div className="diff-file-head" ref={anchor}>
        <span className="diff-file-path" title={file.path}>{file.path}</span>
        {kind && <span className="diff-kind">{kind}</span>}
        <Counts added={file.added} removed={file.removed} />
      </div>
      {file.kind === 'binary'
        ? <p className="diff-note">Binary file; nothing to show.</p>
        : (
          <pre className="diff-hunks">
            {file.hunks.map((hunk, index) => (
              <code key={index}>
                <span className="diff-hunk-head">{hunk.header}</span>
                {hunk.lines.map((line, at) => (
                  <span key={at} className={`diff-line${line.type === '+' ? ' is-add' : line.type === '-' ? ' is-del' : ''}`}>
                    <span className="diff-n">{line.old ?? ''}</span>
                    <span className="diff-n">{line.new ?? ''}</span>
                    <span className="diff-sign">{line.type === ' ' ? '' : line.type === '+' ? '+' : '−'}</span>
                    {line.text}
                  </span>
                ))}
              </code>
            ))}
          </pre>
        )}
    </section>
  )
})

export function ChangesView({ patch }: { patch: TurnPatch }) {
  const files = useMemo(() => parsePatch(patch.patch), [patch])
  const totals = patchTotals(files)
  const heads = useRef(new Map<string, HTMLDivElement>())
  const [current, setCurrent] = useState<string | null>(null)
  const jump = (path: string): void => {
    setCurrent(path)
    heads.current.get(path)?.scrollIntoView({ block: 'start' })
  }
  return (
    <>
      <div className="diff-files" role="tablist" aria-label="Changed files">
        {files.map((file) => (
          <button
            type="button"
            role="tab"
            key={file.path}
            className={`diff-tab${current === file.path ? ' is-current' : ''}`}
            aria-selected={current === file.path}
            title={file.path}
            onClick={() => jump(file.path)}
          >
            {basename(file.path)}
            <Counts added={file.added} removed={file.removed} />
          </button>
        ))}
      </div>
      <div className="artifact-content diff-body" tabIndex={-1}>
        {files.map((file) => (
          <FileDiff key={file.path} file={file} anchor={(element) => { if (element) heads.current.set(file.path, element); else heads.current.delete(file.path) }} />
        ))}
        {patch.truncated && <p className="diff-note">This turn changed more than is kept: {totals.files} files are shown, the rest were left out.</p>}
      </div>
    </>
  )
}
