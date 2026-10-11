import { basename, extname, join } from 'node:path'

// Where a model's download lands, as plain functions so they can be tested without Electron.

/** A file name a page suggested, made safe to write: no folders, no control characters. */
export function safeFileName(suggested: string): string {
  const name = basename(String(suggested).replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200)
  return name && name !== '.' && name !== '..' ? name : 'download'
}

/**
 * The path to save to. `saveTo` is an absolute folder or file path, or null for `folder`. A path
 * ending in a slash, an existing folder, or a name without an extension is taken as a folder.
 */
export function downloadTarget(saveTo: string | null, suggested: string, folder: string, isDirectory: (path: string) => boolean): string {
  const name = safeFileName(suggested)
  if (!saveTo) return join(folder, name)
  if (/[\\/]$/.test(saveTo) || isDirectory(saveTo) || !extname(saveTo)) return join(saveTo, name)
  return saveTo
}

/** Never overwrite: `report.pdf` becomes `report (1).pdf`, as browsers do. `taken` covers files still arriving. */
export function uniquePath(path: string, taken: (path: string) => boolean): string {
  if (!taken(path)) return path
  const ext = extname(path)
  const stem = path.slice(0, path.length - ext.length)
  for (let n = 1; ; n++) {
    const next = `${stem} (${n})${ext}`
    if (!taken(next)) return next
  }
}
