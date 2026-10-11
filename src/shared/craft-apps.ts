// The Craft apps Craft Studio can install and dock: one entry per app, with its pinned release and
// the way each one is started and driven. The apps differ in ways that must not be assumed (how a
// control channel is opened, whether it needs a token, how the MCP bridge connects), so nothing
// here is shared between entries by default.
//
// Release values (tag, asset, size, SHA-256, unpacked size) were read with `gh api` from
// github.com/storytold/<app> on 2026-10-11 and checked by downloading every asset and verifying it
// against its SHA256SUMS.txt; every tarball unpacks to `<app>-<version>-linux-x86_64/` holding
// `bin/<app>` and `bin/<app>-cli`. Regenerate them with `npm run craft:manifest`. The flags come
// from each app's argument parsing at its pinned tag (main.rs, control_server.rs, the CLI's mcp
// subcommand), read on 2026-10-11, not from running the apps: most treat any unknown argument,
// `--help` included, as a file to open.
//
// Per-app quirks, verified against the pinned versions on 2026-10-11:
// - Every control server listens on 127.0.0.1 only.
// - PhotoCraft 0.7.0: requires a 64-hex token (`--control-token-file`; the app reads the file, or
//   creates it if missing) and `{"method":"auth"}` first. Read and write roots are refused unless
//   given (`--automation-read-root`, `--automation-write-root`, last one wins). A bad port exits 2.
//   Its bridge is `mcp --bridge 127.0.0.1:<port>`, loopback hosts only, and ignores roots.
// - VectorCraft 0.9.0: no token. Roots exist on the desktop app (ignored unless `--control` is
//   given); without them nothing is confined. `mcp` with no `--connect` silently runs headless.
// - FilmCraft 0.6.0: no token, no roots; bridge is `--bridge`; unknown options stop it starting.
// - LightCraft 0.6.0: no token, no roots. `--connect 7980` is misread (the port becomes a file
//   argument); always give `127.0.0.1:<port>`.
// - PdfCraft 0.6.0: `--control <file>`, not a port: the app binds a random port and writes
//   `{port, token, pid}` there (0600). JSON-RPC 2.0 framing, auth with the 128-bit token first.
//   No bridge to the running app: `pdfcraft-cli mcp` is headless only. Unknown `--x` options eat
//   the next argument.
// - EffectCraft 0.8.0: no token; bridge `--bridge`; its CLI (not the app) takes repeatable roots.
// - DesignCraft, DeckCraft, CADCraft 0.x: no token, no roots. CADCraft's `--connect` needs
//   host:port.
// - SoundCraft 0.5.0: no token, no roots; a host in `--connect` must be an IP literal.
// - WordCraft 0.5.0: no flag for its key: on every start it writes a 256-bit key to
//   `$XDG_CONFIG_HOME/wordcraft/control-key.local-<port>` (0600). Its bridge finds that file
//   only when it runs with the same XDG_CONFIG_HOME, or reads WORDCRAFT_CONTROL_KEY.
// - GridCraft 0.5.0: no token at all: any local process can drive it while it runs.
//
// The ArtCraft name and marks are trademarks: they must not appear in anything shown to the user.
// The names, colours, initials and one-line descriptions below are the agreed mockup's
// (docs/mockups/craft-studio.html).

export type CraftControl =
  /** `<flag> <port>`: Craft Studio picks a free loopback port. */
  | { kind: 'port'; flag: string }
  /** `<flag> <file>`: the app picks its port and writes `{port, token, pid}` to the file. */
  | { kind: 'file'; flag: string }

export type CraftAuth =
  | { kind: 'none' }
  /** Craft Studio writes a 64-hex token to a 0600 file and passes it; `auth` is the first request. */
  | { kind: 'tokenFile'; flag: string }
  /** The token is in the control file the app writes. */
  | { kind: 'controlFile' }
  /** The app writes its own key, at this path under its XDG_CONFIG_HOME (`{port}` is filled in). */
  | { kind: 'keyFile'; path: string }

export type CraftAppManifest = {
  id: string
  name: string
  likeName: string
  shortName: string
  initials: string
  accent: string
  description: string
  repo: string
  version: string
  tag: string
  /** The Linux x86_64 tar.gz release asset. */
  asset: string
  sha256: string
  downloadBytes: number
  /** Unpacked size, measured on 2026-10-11; the installer measures again after unpacking. */
  unpackedBytes: number
  /** The tarball's one top folder. */
  folder: string
  /** Paths inside the unpacked folder. */
  bin: string
  cli: string
  control: CraftControl
  auth: CraftAuth
  /** Desktop flags that confine what the control channel may read and write, if the app has them. */
  roots: { read: string; write: string } | null
  /**
   * `<cli> <args>` bridges the CLI's MCP server to the running app, with `{port}` and `{tokenFile}`
   * filled in. Null when the app has no bridge (its MCP server is headless only).
   */
  bridge: string[] | null
  extensions: string[]
  /** When the values above were last checked against the pinned release. */
  verified: string
}

function entry(app: Omit<CraftAppManifest, 'repo' | 'tag' | 'asset' | 'folder' | 'bin' | 'cli' | 'verified'>): CraftAppManifest {
  return {
    ...app,
    repo: `storytold/${app.id}`,
    tag: `v${app.version}`,
    asset: `${app.id}-${app.version}-linux-x86_64.tar.gz`,
    folder: `${app.id}-${app.version}-linux-x86_64`,
    bin: `bin/${app.id}`,
    cli: `bin/${app.id}-cli`,
    verified: '2026-10-11'
  }
}

const PORT: CraftControl = { kind: 'port', flag: '--control' }
const NONE: CraftAuth = { kind: 'none' }
const CONNECT = ['mcp', '--connect', '127.0.0.1:{port}']
const BRIDGE = ['mcp', '--bridge', '127.0.0.1:{port}']

export const CRAFT_APPS: readonly CraftAppManifest[] = [
  entry({
    id: 'photocraft', name: 'PhotoCraft', likeName: 'Photoshop', shortName: 'Photo', initials: 'Ph', accent: '#1f6feb',
    description: 'Photos, layers, masks, PSD',
    version: '0.7.0', sha256: '641f831252fd31b43ee1a12e572d7442e5652c2e5bf623de085741c370f0c91d', downloadBytes: 76_259_298, unpackedBytes: 150_724_142,
    control: PORT, auth: { kind: 'tokenFile', flag: '--control-token-file' },
    roots: { read: '--automation-read-root', write: '--automation-write-root' },
    bridge: [...BRIDGE, '--control-token-file', '{tokenFile}'],
    extensions: ['pcraft', 'psd', 'psb', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'gif', 'bmp', 'tga', 'exr', 'avif', 'ora', 'pdn']
  }),
  entry({
    id: 'vectorcraft', name: 'VectorCraft', likeName: 'Illustrator', shortName: 'Vector', initials: 'Ve', accent: '#d9822b',
    description: 'Logos, paths, illustration',
    version: '0.9.0', sha256: 'afbc4a0904740dfd1208e717664eb294965055e74c227c2ac3dc53af502e46a4', downloadBytes: 82_864_021, unpackedBytes: 172_674_571,
    control: PORT, auth: NONE,
    roots: { read: '--automation-read-root', write: '--automation-write-root' },
    bridge: CONNECT,
    extensions: ['vectorcraft', 'svg', 'svgz', 'pdf', 'ai', 'eps', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'psd', 'dxf', 'emf', 'wmf', 'afdesign']
  }),
  entry({
    id: 'filmcraft', name: 'FilmCraft', likeName: 'Premiere Pro', shortName: 'Film', initials: 'Fi', accent: '#7c3aed',
    description: 'Video editing and timelines',
    version: '0.6.0', sha256: 'b3d706d599699ead76b46a29d5697287b9f75a0bc9eb40f7733db7657dae8204', downloadBytes: 67_794_418, unpackedBytes: 140_353_827,
    control: PORT, auth: NONE, roots: null, bridge: BRIDGE,
    extensions: ['fcproj', 'mp4', 'mov', 'm4v', 'mkv', 'webm', 'mxf', 'm2ts', 'avi', 'wav', 'mp3', 'm4a', 'flac', 'png', 'jpg']
  }),
  entry({
    id: 'lightcraft', name: 'LightCraft', likeName: 'Lightroom', shortName: 'Light', initials: 'Li', accent: '#0e9fb8',
    description: 'Photo library and RAW develop',
    version: '0.6.0', sha256: 'd738f16b3a717b1e66716981aa4f8dbd68caa5bf9d04d175801a2278f18f69f1', downloadBytes: 98_442_371, unpackedBytes: 189_354_463,
    control: PORT, auth: NONE, roots: null, bridge: CONNECT,
    extensions: ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'webp', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'psd', 'heic']
  }),
  entry({
    id: 'pdfcraft', name: 'PdfCraft', likeName: 'Acrobat', shortName: 'PDF', initials: 'Pd', accent: '#d93f3f',
    description: 'Read, sign, combine PDFs',
    version: '0.6.0', sha256: '9a136e71e37b459ed5746dbe19a364ce84cf5d995c6f6c98af6147d818390a53', downloadBytes: 81_865_581, unpackedBytes: 218_485_546,
    control: { kind: 'file', flag: '--control' }, auth: { kind: 'controlFile' }, roots: null, bridge: null,
    extensions: ['pdf']
  }),
  entry({
    id: 'effectcraft', name: 'EffectCraft', likeName: 'After Effects', shortName: 'Effect', initials: 'Ef', accent: '#a855f7',
    description: 'Motion graphics, compositing',
    version: '0.8.0', sha256: '725c88cf379122d70f941dd3edacb54479d63ff1e2a00fae318eaee02ad762c4', downloadBytes: 61_045_164, unpackedBytes: 149_344_517,
    control: PORT, auth: NONE, roots: null, bridge: BRIDGE,
    extensions: ['ecproj', 'ecprojx', 'mp4', 'mov', 'mkv', 'webm', 'png', 'jpg', 'psd', 'svg', 'pdf', 'ai', 'exr', 'wav', 'gltf']
  }),
  entry({
    id: 'designcraft', name: 'DesignCraft', likeName: 'InDesign', shortName: 'Design', initials: 'De', accent: '#e0457b',
    description: 'Page layout, magazines, books',
    version: '0.6.0', sha256: 'abb661cd2fc53677d040fe0be3f241bbb8c0fad9619192a83109d53bd514bfb9', downloadBytes: 70_445_125, unpackedBytes: 147_823_455,
    control: PORT, auth: NONE, roots: null, bridge: CONNECT,
    extensions: ['designcraft', 'idml', 'png', 'jpg', 'jpeg', 'tif', 'psd', 'svg', 'pdf', 'ai', 'eps', 'docx', 'rtf', 'md', 'xlsx']
  }),
  entry({
    id: 'soundcraft', name: 'SoundCraft', likeName: 'Pro Tools', shortName: 'Sound', initials: 'So', accent: '#16a34a',
    description: 'Multitrack audio and mixing',
    version: '0.5.0', sha256: 'b1305b1a7ba7b8563204084dc0de652ef4236769ccf46a5e7f545a4a1060e803', downloadBytes: 15_267_409, unpackedBytes: 37_837_537,
    control: PORT, auth: NONE, roots: null, bridge: CONNECT,
    extensions: ['scraft', 'wav', 'aif', 'aiff', 'aifc', 'flac', 'mp3', 'ogg', 'm4a', 'aac', 'caf', 'mid', 'midi']
  }),
  entry({
    id: 'deckcraft', name: 'DeckCraft', likeName: 'PowerPoint', shortName: 'Deck', initials: 'Dk', accent: '#ea580c',
    description: 'Slides and presentations',
    version: '0.5.0', sha256: 'c2648c6071f631ecc6639ce6b7d60f68eed83ddeaba6b1559b07c5046863117c', downloadBytes: 74_777_200, unpackedBytes: 152_229_633,
    control: PORT, auth: NONE, roots: null, bridge: CONNECT,
    extensions: ['deckcraft', 'pptx', 'potx', 'ppsx', 'txt', 'md']
  }),
  entry({
    id: 'cadcraft', name: 'CADCraft', likeName: 'AutoCAD', shortName: 'CAD', initials: 'Ca', accent: '#0284c7',
    description: '2D drafting and plans',
    version: '0.5.0', sha256: '036c3b401987b6a9991b5fc7ba097d5b717e8d18522f7c3f626b0f6a363e208e', downloadBytes: 22_592_906, unpackedBytes: 55_563_588,
    control: PORT, auth: NONE, roots: null, bridge: CONNECT,
    extensions: ['dwg', 'dxf']
  }),
  entry({
    id: 'wordcraft', name: 'WordCraft', likeName: 'Word', shortName: 'Word', initials: 'Wo', accent: '#2563eb',
    description: 'Documents and letters',
    version: '0.5.0', sha256: '994bb376479ef6d76735cf4029e5ef3c2d52a85a4c9acde2b37c33b19c570203', downloadBytes: 90_044_436, unpackedBytes: 160_952_993,
    control: PORT, auth: { kind: 'keyFile', path: 'wordcraft/control-key.local-{port}' }, roots: null, bridge: CONNECT,
    extensions: ['docx', 'docm', 'dotx', 'doc', 'odt', 'rtf', 'txt', 'md', 'html', 'htm', 'tex']
  }),
  entry({
    id: 'gridcraft', name: 'GridCraft', likeName: 'Excel', shortName: 'Grid', initials: 'Gr', accent: '#15803d',
    description: 'Spreadsheets and charts',
    version: '0.5.0', sha256: 'e6505c2f929f9854c350a0df26189c4e56c8adf87cc61625f80d6a8eec2b628d', downloadBytes: 17_344_441, unpackedBytes: 42_613_879,
    control: PORT, auth: NONE, roots: null, bridge: CONNECT,
    extensions: ['xlsx', 'xlsm', 'xlsb', 'ods', 'csv', 'tsv', 'txt', 'json']
  })
]

export function craftApp(id: string): CraftAppManifest | undefined {
  return CRAFT_APPS.find((app) => app.id === id)
}

/** A file of the app's pinned GitHub release. */
export function releaseUrl(app: CraftAppManifest, file: string): string {
  return `https://github.com/${app.repo}/releases/download/${app.tag}/${encodeURIComponent(file)}`
}

export type LaunchPlace = {
  /** For `port` control: the loopback port Craft Studio chose. */
  port?: number
  /** For `file` control: where the app writes its port and token. */
  controlFile?: string
  /** For `tokenFile` auth: the 0600 file holding the token. */
  tokenFile?: string
  /** The chat's folder: the only place the control channel may read and write, where the app can be told. */
  folder?: string | null
}

/** The desktop app's arguments for a docked launch: its control channel, token and roots. */
export function launchArgs(app: CraftAppManifest, place: LaunchPlace): string[] {
  const args: string[] = []
  if (app.control.kind === 'port') {
    if (!place.port) throw new Error(`${app.name} needs a control port to start.`)
    args.push(app.control.flag, String(place.port))
  } else {
    if (!place.controlFile) throw new Error(`${app.name} needs a control file to start.`)
    args.push(app.control.flag, place.controlFile)
  }
  if (app.auth.kind === 'tokenFile') {
    if (!place.tokenFile) throw new Error(`${app.name} needs a control token to start.`)
    args.push(app.auth.flag, place.tokenFile)
  }
  if (app.roots && place.folder) args.push(app.roots.read, place.folder, app.roots.write, place.folder)
  return args
}

/** The CLI's arguments for an MCP server bridged to the running app, or null when there is no bridge. */
export function bridgeArgs(app: CraftAppManifest, place: { port: number; tokenFile?: string }): string[] | null {
  if (!app.bridge) return null
  return app.bridge.map((arg) => arg
    .replaceAll('{port}', String(place.port))
    .replaceAll('{tokenFile}', place.tokenFile ?? ''))
}

/** Where WordCraft-style apps write their own control key, under the app's XDG_CONFIG_HOME. */
export function keyFilePath(app: CraftAppManifest, port: number): string | null {
  return app.auth.kind === 'keyFile' ? app.auth.path.replaceAll('{port}', String(port)) : null
}
