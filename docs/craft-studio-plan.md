# Craft Studio plan

Rocket's chat, providers and tool server, with the 12 ArtCraft "Crafting Apps" in place of the
side panels. The browser and library stay, as toggles. Every provider Rocket lends turns to
(Claude, Codex, Cursor, Antigravity, under the user's own subscriptions) can drive whichever app
is open, live, on the window the user is looking at.

Mockup: [`docs/mockups/craft-studio.html`](mockups/craft-studio.html). Nothing is built yet.

## Decision taken

**Native windows docked in** (chosen 2026-10-10). Rocket runs each app's Linux desktop build and
fits its window into the panel area. The web (WebAssembly) builds were ruled out as the main path:
models drive a live app through the desktop app's control channel, and DesignCraft's README says
"The web build has no control channel." Only FilmCraft and EffectCraft document a browser agent
API (`window.filmcraft`, `window.effectcraft`). Docking works because this machine runs X11
(`XDG_SESSION_TYPE=x11`); X11 lets one app's window be placed inside another's. Wayland would not.

## The 12 apps

All are Rust and egui/wgpu, Apache-2.0 (dual MIT in the tarballs), and in alpha or pre-alpha.
Each Linux release has an AppImage, deb, rpm, flatpak and tar.gz, with a `SHA256SUMS.txt`. The
x86_64 tar.gz holds both the app and its `-cli`, plus icons (checked on GridCraft 0.5.0).

| App | In the place of | Latest (2026-10-10) |
|---|---|---|
| PhotoCraft | Photoshop | 0.7.0 |
| VectorCraft | Illustrator | 0.9.0 |
| FilmCraft | Premiere Pro | 0.6.0 |
| LightCraft | Lightroom | 0.6.0 |
| PdfCraft | Acrobat | 0.6.0 |
| EffectCraft | After Effects | 0.8.0 |
| DesignCraft | InDesign | 0.6.0 |
| SoundCraft | Pro Tools | 0.5.0 |
| DeckCraft | PowerPoint | 0.5.0 |
| CADCraft | AutoCAD | 0.5.0 |
| WordCraft | Word | 0.5.0 |
| GridCraft | Excel | 0.5.0 |

They ship a new version almost daily, so Craft Studio pins a version per app and updates only when
the user asks.

### How an app is driven

- **Control channel:** `<app> --control <port>` listens on loopback for JSON lines. PhotoCraft
  requires a 256-bit token, best passed as `--control-token-file`, and the first request on each
  connection is `auth`. It also takes `--automation-read-root` and `--automation-write-root`.
- **MCP server:** `<app>-cli mcp` speaks MCP over stdio. On its own it edits files headless; bridged
  to the running app, it drives the live window. The bridge flag differs between apps: PhotoCraft
  uses `mcp --bridge 127.0.0.1:<port>`, while GridCraft, WordCraft, DeckCraft and LightCraft use
  `mcp --connect <port>`. Each app therefore gets its own entry in a manifest; no flag is assumed.
- **Tools:** each app's server offers a generic `execute_command` / `command_run` (any of the app's
  200–650+ commands), `list_commands`, inspect tools and, when bridged, `screenshot`. For example,
  GridCraft has `read_range`, `write_range`, `format_range`, `insert_chart` and others.
- **Frames:** PhotoCraft's docs warn that control requests wait for the window to draw a frame. On
  Wayland, an occluded window makes every request time out. Whether a hidden, docked window keeps
  drawing on X11 is the first thing the spike must answer.

## What changes from Rocket

| Kept | Toggles | Replaced or removed |
|---|---|---|
| Chat, composer, model picker | Browser | Tools panel (ledger), Progress view |
| The subscription usage notch: four rings and their flyouts, unchanged | | |
| Providers and adapters, hub, store, handoff | Library | Orchestrator worker board, worktrees |
| The loopback tool server and role profiles | | App map entries for the removed panels |

The 12 apps take the side panel's place. They are chosen from a **horizontal rail under the right
side**, beneath the docked app: one icon per app, each with its short name under it (Photo, Vector,
Film and so on), then Browser and Library at the rail's right end. The shown app is marked with a
bar on the rail's top edge, and apps running in the background have a green dot. The names sit
under the icons instead of in hover tooltips, because a tooltip would open upward over the docked
app window, which paints over anything Rocket draws there. The title strip keeps the window
lights, the chat title, Chats (history) and the subscription notch, with one ring per
provider and its hover flyout. The flyout already pulls itself left into the chat card, so the
docked app cannot cover it. One app, the browser or the library is shown beside the chat at a time.
Apps that are already running stay running when hidden, so switching is instant.

Whether to keep orchestrator runs (workers in parallel) is an open question below. The plan
assumes they are removed for now.

## Architecture

Rocket's rules hold: agent work stays in the host, window work stays in main, and the renderer
only draws.

1. **`src/shared/craft-apps.ts`: the manifest.** One entry per app: release repo, pinned version,
   binary names, control flags, token handling, the MCP bridge flag, file types it opens, and its
   icon. Everything else reads from this list. The apps differ in ways that must not be assumed:
   PhotoCraft takes `--control-token-file` and bridges with `mcp --bridge 127.0.0.1:<port>`, while
   GridCraft 0.5.0 has no token option at all (its port is open to any local process) and bridges
   with `mcp --connect <port>` (both measured 2026-10-10).
2. **`src/main/craft-dock.ts`: windows (main process).**
   - Downloads the pinned tar.gz the first time an app is opened, checks it against
     `SHA256SUMS.txt`, and unpacks it to `~/.local/share/craft-studio/apps/<app>/<version>/`.
   - Starts the app with `--control <free port> --control-token-file <0600 file>` and read and write
     roots set to the chat's working folder.
   - Finds the app's X window by `_NET_WM_PID` and reparents it into Rocket's window, taken from
     `getNativeWindowHandle()`.
   - Keeps it fitted to the panel bounds the renderer reports, the same way `browser-pane.ts`
     places browser tabs.
   - To hide an app it moves the window out of view rather than unmapping it, if the spike shows
     unmapped windows stop drawing.
   - Fallback if reparenting misbehaves: a borderless top-level window kept over the panel area and
     moved with Rocket.
3. **`src/host/craft-bridge.ts`: model control (host process).**
   - For each running app, starts `<app>-cli mcp <bridge flag> <port>` as a stdio MCP client.
   - Adds that app's tools to Rocket's own tool server, named with an app prefix (for example
     `photocraft__command_run`), so all four providers get them the same way.
   - Lists only the shown app's tools, plus one small `craft_apps` tool to list, open and switch
     apps (see Build, size and performance).
   - Ahead of each message the situation line names the apps that are open, the active one and its
     document, following the `agent-situation.ts` pattern.
4. **App map.** The rail is `src/renderer/src/components/AppRail.tsx`. A new `app {id}` place and the actions `app.open`, `app.close` and `app.focus`, so
   both the buttons and `rocket_ui_go` / `act` switch apps. State lives in `store.ts`.
5. **Popovers.** A docked app paints over Rocket's DOM, just as the browser page does. The existing
   rule applies: menus are pulled left inside the chat card.
6. **Files.** Exports land in the working folder, and the library lists them. Opening a library file
   offers the app that handles its type.

## Build, size and performance

Measured on this machine on 2026-10-10: 8 cores, 13 GB of RAM (about 9 GB available with Rocket
running), an NVIDIA GTX 1050 with 3 GB and an AMD integrated GPU, on X11. The app measurements ran
on a private virtual display with software rendering, so GPU memory is not counted; the spike
re-measures on the real display.

### What ships

| Piece | Size | Notes |
|---|---|---|
| Craft Studio itself (Electron, chat, host, UI) | about 110–130 MB as an AppImage (estimate) | The Electron runtime is 283 MB unpacked here and Rocket's own code 2.5 MB. Rocket is not packaged today, so the AppImage size is an estimate. |
| The 12 apps, downloaded | 718 MB in total (tar.gz) | From 14 MB (SoundCraft) and 16 MB (GridCraft) up to 93 MB (LightCraft). |
| The 12 apps, unpacked | about 1.4–1.8 GB | Unpacked is 2–2.6× the download: GridCraft 16 → 41 MB, PhotoCraft 72 → 144 MB. About 40% of each is the `-cli`, which carries its own copy of the engine. |

The installer ships only Craft Studio. Each app downloads the first time it is opened, or all at
once from the start screen for offline use. They go to `~/.local/share/craft-studio/apps/` and are
checked against `SHA256SUMS.txt`. The tar.gz is used rather than the AppImage: an AppImage mounts
itself through FUSE on every launch, which is slower and adds a process.

### What runs

| Process | Memory | CPU when idle |
|---|---|---|
| Rocket today (25 Electron processes, browser tabs included) | about 3.3 GB resident (summed, so shared pages are counted more than once) | — |
| PhotoCraft 0.7.0, empty, window open | 219 MB | 0.2% of one core |
| GridCraft 0.5.0, empty, window open | 241 MB | 0.3% of one core |
| An app's MCP bridge (`<app>-cli mcp`) | 4–8 MB | none between calls |

The apps are egui, which repaints only when something changes, so an idle app costs memory but
next to no CPU. Memory is the limit: 12 apps open and empty would take about 2.8 GB before any
document is loaded, and a layered photo, a video timeline or a RAW library takes far more.

Docking native windows keeps the apps out of Electron entirely: they are their own processes and
add no Chromium renderers. The web builds would each have been a Chromium renderer running the
engine as WebAssembly, heavier and slower.

### Keeping it light

1. **Nothing starts until it is opened.** An app on the rail with no dot has no process.
2. **A budget for background apps.** The shown app plus up to three more stay running, so switching
   back is instant. When a fifth is opened, the least recently used one closes, but only if
   `ui.inspect` reports no unsaved changes; otherwise it stays and its rail icon says it is holding
   unsaved work. The budget also shrinks when free memory runs low. It is a setting.
3. **Hidden apps are parked, not stopped.** A hidden app is moved out of view rather than
   unmapped, so its control channel keeps answering (the spike confirms this), and it runs at a
   lower CPU priority (`nice`) than the shown app.
4. **One app's tools in the prompt, not twelve.** Each app's MCP server lists 21 tools, about 16–18 KB
   of descriptions, or roughly 4k tokens (measured on PhotoCraft and GridCraft). Bridging all 12
   would add about 50k tokens to every turn, which would slow every reply and spend subscription
   usage. Models see the shown app's tools plus one `craft_apps` tool to list, open and switch apps;
   switching swaps the tool set before the next call.
5. **Bridges start on demand.** A bridge (4–8 MB) starts the first time a model calls into that app,
   and stops with the app.
6. **No forced updates.** The apps release almost daily. Each update is a full download of that app
   (zsync deltas exist only for AppImages), so updates happen per app, when the user asks.
7. **GPU.** Every running app holds its own wgpu surfaces, and the GTX 1050 has 3 GB. The spike
   checks which GPU the apps pick and how much each running app holds, and the background budget
   counts it.

### Layout of the new project

```
craft-studio/                      a copy of Rocket, trimmed
  src/shared/craft-apps.ts         the manifest: 12 entries, pinned versions and per-app flags
  src/main/craft-install.ts        download, checksum, unpack, per-app update
  src/main/craft-dock.ts           launch, reparent, fit, park, the background budget
  src/host/craft-bridge.ts         MCP bridges, the shown app's tools, craft_apps, the situation line
  src/renderer/src/components/
    AppRail.tsx                    the horizontal rail under the right side
    AppStart.tsx                   the start grid shown when no app is open
```

Removed from the copy: the Tools panel, the Progress view, the worker board and worktrees, unless
orchestrator runs are kept (open question 2).

## Phases

0. **Spike, go/no-go (about a day, in a scratch folder).** Use GridCraft, since its download is
   the smallest. Check that:
   - the app launches with `--control` and its window can be reparented into a bare Electron window;
   - resizing, mouse and keyboard focus, IME and copy/paste work;
   - control requests still work while the window is hidden or covered;
   - `gridcraft-cli mcp --connect` works through it.

   Then repeat the docking with PhotoCraft (wgpu and heavier) and FilmCraft (video and audio).
   The output is a short report with captures. If reparenting fails, try the overlay fallback
   before going further.
1. **New project.** Copy Rocket into its own folder (see open questions). Strip the removed panels
   and their map entries, and get typecheck, tests and `check:ui` green.
2. **Dock manager and launcher.** Build the manifest, downloads, docking and the app strip, for all
   12 apps, with a UI check that uses a stand-in app window.
3. **Model control.** Add the MCP bridge to the tool server and the situation line. Run a live check
   per provider, with permission first since it spends subscription usage.
4. **Polish.** Files and library hand-off, the per-app update action, crash restart, and the
   background budget (see Build, size and performance).

## Risks

- **Alpha software that changes daily.** Pin versions, and keep each app's quirks in its manifest
  entry with the version and date they were verified, as Rocket's provider headers do.
- **X11 only.** A Wayland session would need the overlay fallback or the web builds.
- **Docking quirks:** focus, IME, drag-and-drop and GPU surfaces in a reparented window. The spike
  is there to find these early.
- **Hidden windows not drawing** could make model control time out on apps that are open but not
  shown.
- **Tool count.** Bridging every app at once would add about 50k tokens to each turn; only the shown
  app's tools are listed.
- **Unprotected control ports.** GridCraft 0.5.0's control port takes no token, so any local process
  can drive it while it runs. This is acceptable on a single-user machine, but worth raising
  upstream.
- **Naming.** The ArtCraft name, wordmark and logos are trademarks, not open source (see
  Licence). Craft Studio never uses them in its own name, icon or chrome.

## Licence: what we may change

Checked 2026-10-10. All 12 apps are dual-licensed **MIT or Apache-2.0, at our option**, and each
repository has `LICENSE-MIT`, `LICENSE-APACHE` and `NOTICE`. That allows us to use, modify, fork,
combine and redistribute them, commercially or not.

- **What we must keep:** the copyright line, the licence text and the `NOTICE` of every app we ship
  or build from. Craft Studio gets an About page listing them. Under Apache-2.0, files we change must
  say they were changed.
- **Bundled assets keep their own licences**, listed in each app's `ATTRIBUTION.md`. In PhotoCraft
  these are the Inter and JetBrains Mono fonts and the craft-fonts families (SIL OFL 1.1), Lucide
  icons (ISC) and the SCOWL word list. All allow this use; their licence texts ship with the app.
- **The trademark rule** (PhotoCraft's `docs/brand/LICENSE-brand.txt`; the other 11 READMEs carry
  the same notice): the ArtCraft name, wordmark and mark are not covered by the open licence. If a
  modified version is **distributed or published**, those marks must be removed, and it must not be
  called or presented as ArtCraft. It may say in plain text that it is based on, for example,
  PhotoCraft by the ArtCraft team. A copy kept privately on this machine is not distributed. The
  rule names only the ArtCraft marks, not the app names such as PhotoCraft, but before any public
  release we would rename modified apps or ask the ArtCraft team.
- **ArtCraft's AI service is separate.** `artcraft-services` has no stated licence, and the team
  funds the apps by selling model access. Craft Studio does not need it, because models come
  through Rocket's existing subscriptions.

### Using upstream builds or our own

Modifying is allowed, but each fork is a maintenance cost: the apps release almost daily (PhotoCraft
has over 1,300 commits). The default is therefore **upstream release builds, unchanged**. We keep a
fork only for a change Craft Studio cannot work without, and offer it back upstream. A fork kept only
to propose changes upstream may keep the ArtCraft marks. Changes worth making, upstream first:

- a control-channel token for the apps that lack one (GridCraft 0.5.0);
- one bridge flag across all apps (`--connect` versus PhotoCraft's `--bridge`);
- an embedding mode: no window decorations, and keep drawing while parked out of view;
- a dirty-state field in `ui.inspect` everywhere, which the background budget relies on.

Building our own needs the Rust toolchain (1.95 or newer, per DesignCraft's README) and a release
build per app. We have not timed those builds.

## Open questions for the user

1. Build in a new folder (for example `~/Desktop/craft-studio`) as a copy of Rocket, or change
   this repo? Recommended: a new folder, so the Rocket you work in stays as it is.
2. Keep orchestrator runs (parallel workers driving several apps) or drop them for a single chat?
3. Should models also be allowed headless edits (on files, with no window) when an app is closed?

## Sources

Opened on 2026-10-10:

- [DesignCraft README](https://github.com/storytold/designcraft): the web build has no control
  channel; the `--control` and MCP usage.
- [PhotoCraft control protocol](https://github.com/storytold/photocraft/blob/main/docs/control-protocol.md):
  loopback only, the token file, `auth` first, `mcp --bridge`, and the frame-drawing caveat.
- [GridCraft MCP server](https://github.com/storytold/gridcraft/blob/main/docs/mcp.md): headless
  versus `--connect`, and the tool list.

The rest of the app list, versions, release files and README details come from the storytold
repositories through the GitHub API on the same date. The tarball layout was checked by
downloading GridCraft 0.5.0 and verifying it against its checksums.
