// Compares src/shared/craft-apps.ts with what GitHub serves now, app by app: the latest release
// tag, and for the pinned tag the tar.gz size and its line in SHA256SUMS.txt. It prints what
// differs and the values to paste; it never edits the manifest, because a new version also needs
// its flags re-read from the app's source (see the manifest's header).
//
//   npm run craft:manifest            # needs an authenticated `gh`
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/shared/craft-apps.ts', import.meta.url), 'utf8')
const pinned = [...source.matchAll(/id: '([a-z]+)'[\s\S]*?version: '([\d.]+)', sha256: '([0-9a-f]{64})', downloadBytes: ([\d_]+)/g)]
  .map(([, id, version, sha256, bytes]) => ({ id, version, sha256, bytes: Number(bytes.replaceAll('_', '')) }))
const gh = (path, jq) => execFileSync('gh', ['api', path, '--jq', jq], { encoding: 'utf8' }).trim()
let differences = 0
for (const app of pinned) {
  const latest = gh(`repos/storytold/${app.id}/releases/latest`, '.tag_name')
  const assets = JSON.parse(gh(`repos/storytold/${app.id}/releases/tags/v${app.version}`, '[.assets[] | {name, size, url: .browser_download_url}]'))
  const asset = assets.find((entry) => entry.name === `${app.id}-${app.version}-linux-x86_64.tar.gz`)
  const sums = assets.find((entry) => entry.name === 'SHA256SUMS.txt')
  const listed = sums ? execFileSync('curl', ['-sSfL', sums.url], { encoding: 'utf8' }).split('\n').find((line) => line.endsWith(` ${asset?.name}`) || line.endsWith(`*${asset?.name}`))?.slice(0, 64) : null
  const notes = []
  if (latest !== `v${app.version}`) notes.push(`newer release ${latest}`)
  if (!asset) notes.push('pinned asset missing')
  else if (asset.size !== app.bytes) notes.push(`size ${asset.size} (pinned ${app.bytes})`)
  if (listed && listed !== app.sha256) notes.push(`sha256 ${listed} (pinned ${app.sha256}): republished`)
  if (notes.length) differences++
  console.log(`${app.id.padEnd(12)} ${app.version.padEnd(6)} ${notes.length ? notes.join('; ') : 'matches'}`)
}
console.log(differences ? `\n${differences} app(s) differ. Update craft-apps.ts by hand and re-read flags for new versions.` : '\nThe manifest matches GitHub.')
