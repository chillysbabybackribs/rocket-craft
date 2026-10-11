import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CraftAppManifest } from '../shared/craft-apps.ts'

// Settings an app is given before its first launch (the manifest's `seedSettings`), so its start
// screen carries no promotion and it draws no caption buttons of its own. The seeded keys are what
// docking needs, so they are applied on every launch, even over a value the app saved on an earlier
// run (PhotoCraft writes its default autoShowHomeScreen=true the first time it starts). Every other
// key in the file is kept, and a file that cannot be read is left exactly as it is.

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

/** `seed` over `existing`: seeded leaf values win, nested objects merge, other keys are kept. */
export function mergeSeed(existing: Json, seed: Json): Json {
  const merged: Json = { ...existing }
  for (const [key, value] of Object.entries(seed)) {
    merged[key] = isObject(merged[key]) && isObject(value) ? mergeSeed(merged[key] as Json, value) : value
  }
  return merged
}

/**
 * Writes the app's seed settings under its config home. Returns a sentence when the existing file
 * was unusable (left untouched; the app starts with its defaults), otherwise null. Never throws.
 */
export async function seedAppSettings(app: CraftAppManifest, configHome: string): Promise<string | null> {
  const seed = app.seedSettings
  if (!seed) return null
  const file = join(configHome, seed.file)
  let existing: Json = {}
  try {
    const text = await readFile(file, 'utf8')
    if (text.trim()) {
      const parsed: unknown = JSON.parse(text)
      if (!isObject(parsed)) return `${app.name}'s settings file ${file} does not hold a JSON object, so it was left as it is and ${app.name} starts with its own defaults. Delete the file to have Craft Studio write fresh settings.`
      existing = parsed
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return `${app.name}'s settings file ${file} could not be read (${(error as Error).message}), so it was left as it is and ${app.name} starts with its own defaults. Delete the file to have Craft Studio write fresh settings.`
    }
  }
  const merged = mergeSeed(existing, seed.values)
  if (JSON.stringify(merged) === JSON.stringify(existing) && Object.keys(existing).length) return null
  try {
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.craft-studio.tmp`
    await writeFile(temp, JSON.stringify(merged, null, 2) + '\n')
    await rename(temp, file)
  } catch (error) {
    return `${app.name}'s settings could not be written to ${file} (${(error as Error).message}), so ${app.name} starts with its own defaults. Check that the folder is writable.`
  }
  return null
}
