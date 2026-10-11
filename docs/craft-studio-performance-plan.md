# Craft Studio: all 12 apps a click away, with no slowdown

Written 2026-10-10. Companion to [`craft-studio-own-apps-plan.md`](craft-studio-own-apps-plan.md).
It answers one question: how the dock can open any of the 12 apps at any time without the
machine bogging down, and without limiting what models can do in any app.

## The rule

**What a session costs depends on what is on screen and what a model is working in, not on how
many apps are open.** No app is closed to save memory; idle apps are shrunk instead. Any app
answers a model at any time, open or not.

## Install on demand

Nothing is installed at first. The right side shows the **catalog**: all 12 apps, each with what
it is for, its size and an Install button. The catalog appears on first run and from **+ Add** on
the dock (mockup: [`mockups/craft-studio.html`](mockups/craft-studio.html), screen 2).

- **Install:** the app is fetched or built, and its icon appears in the dock as soon as it is ready.
  While it installs, the dock icon and its catalog card show progress. Clicking the icon opens the
  app in the right side.
- **The dock holds only installed apps,** then + Add, then Browser and Library.
- **Remove** (from the catalog) deletes the app and its build output. Your documents stay where they
  are.
- **Models see only installed apps.** `craft_apps` lists what is installed. When a task needs an app
  that is not, the model says so and the chat shows a one-click "Install Vector?" card. Models never
  install on their own, because an install spends disk and, for our own copies, build time.

What installing means for our own copies:

- **An app we have not changed** is downloaded as ArtCraft's release, checked against its checksum
  and unpacked: seconds, 14–93 MB to download.
- **An app we have changed** is built from our copy: about 6 minutes for a desktop build, as
  measured on PhotoCraft (the own-apps plan's figure, not re-measured here). Built apps are kept in
  a local store, so reinstalling or updating Craft Studio does not rebuild them. Builds share one
  build folder, so the second app compiles much faster than the first.

This keeps everything else in this plan smaller: disk, build time and memory scale with the apps you
chose, not with 12.

## What was measured (2026-10-10, this machine)

The tests ran on a private virtual display with software rendering, using empty documents, the
upstream 0.7.0 PhotoCraft and 0.5.0 GridCraft builds, each app in its own systemd scope.

| | PhotoCraft | GridCraft |
|---|---|---|
| Cold start, click to control channel answering | 0.84 s | 1.45 s |
| Memory awake (the app's own share, as its scope counts it) | 112 MB | 132 MB |
| Memory after being squeezed to 40 MB for 8 s | 39 MB in RAM, 50 MB moved to swap | 38 MB in RAM, 69 MB moved to swap |
| A model's command, awake | 61 ms | 78 ms |
| A model's command, squeezed | 21–158 ms | 21–344 ms |
| CPU while idle | 0.2% of one core | 0.3% of one core |

So an idle app can give back about two thirds of its memory and still answer a model in well
under half a second. The machine has 13 GB of RAM (about 9 GB free with Rocket running), an 8 GB
swap file on NVMe, 8 cores, and a GTX 1050 with 3 GB, of which 2.4 GB was free.

## How it stays fast

### 1. Every app is its own native process

All 12 run as their desktop builds, each docked into the right side, not as web pages:

- **Memory can come back.** A native process can have its idle memory moved out, as measured above.
  A web build's WebAssembly memory only grows; it never returns memory to the system, and each web
  page also carries a Chromium renderer.
- **Speed.** Native code runs at full speed and uses the GPU directly.
- **Separation.** One app working hard cannot stall Rocket's window, and Rocket can set each app's
  share of the machine.

Phase 0 of the own-apps plan still compares both ways on PhotoCraft. These numbers favour native
for all 12, with web pages only as a fallback if docking fails.

### 2. Three states per app, set by Rocket, invisible to the user

| State | When | Memory | CPU share |
|---|---|---|---|
| **Shown** | On screen | No limit | Full |
| **Working** | Hidden, but a model has called into it in the last 2 minutes, or it is exporting or rendering | No limit | Lower than Shown, so the screen never stutters |
| **Resting** | Hidden and idle | Squeezed: memory above a small limit (about 64 MB, tuned in testing) moves to swap | Lowest |

Each app runs in its own systemd scope (`systemd-run --user --scope`), and Rocket changes its
`MemoryHigh` and `CPUWeight` as the state changes. This works on this machine without root; it is
what the tests used. Showing an app or calling it lifts the limit before anything else happens, so
neither you nor a model ever works inside a squeezed app.

Apps are never paused (`SIGSTOP`): a paused app could not answer a model. A hidden app is parked
out of view and keeps answering. egui redraws only when something changes, so a resting app costs
almost no CPU.

### 3. Opening is instant even from cold

- **First click:** the app starts in about 1 to 1.5 s (measured). Meanwhile the right side shows the
  app's last picture, saved when it was last hidden, dimmed with a small spinner. The swap is
  barely noticeable.
- **Later clicks:** the app is already running, so the switch is a window move, then the time to
  bring a resting app's memory back from NVMe. That is milliseconds for an empty app and should be
  well under a second for a large document; Phase 0 measures it on real files.
- **Warm-up (optional):** when Rocket has been idle for a minute, it starts the apps you use most, so
  they are ready and already resting. It is a setting, off by default.

### 4. A safety valve instead of closing apps

Even with all 12 installed, all 12 resting would cost about 0.5 GB of RAM (empty documents, from
the numbers above). Real documents
cost more, so Rocket watches memory pressure (`/proc/pressure/memory`) and swap use:

1. Under pressure, the limit on resting apps tightens.
2. Only if swap passes about 75% does Rocket close an app, and only one that is resting, has no
   unsaved work and has no model in it, choosing the one used longest ago. Before closing, it
   records what was open (document, view, tool), and the next click or model call reopens it in that
   state. To you it looks like a slower switch; to a model it looks like nothing happened.

An app with unsaved work, or with a model in it, is never closed.

### 5. Models keep full control

- **One fixed tool set for all apps** (as in the own-apps plan): run, batch, look up commands,
  inspect, open, save and screenshot, plus list, open and switch apps. Every call names its app. The
  prompt cost stays the same with 1 app open or 12. Bridging each app's own MCP server instead would
  add about 4k tokens per app, about 50k for all 12 (measured: 21 tools, 16–18 KB per app).
- **Any installed app, any time.** A call to an app that is not running starts it parked (about
  1 s) and then runs the command. A call to a resting app moves it to Working first. Models never have to ask for an
  app to be opened, and never find one closed.
- **A model does not have to be in the shown app.** Models drive apps through the control channel,
  not the screen, so a model can work in a hidden app while you work in another. `screenshot`
  renders the app's own window offscreen, which works while it is parked (PhotoCraft's docs describe
  offscreen rendering through the control channel).
- **Lean replies.** Screenshots come back downscaled unless a model asks for full size, and each
  command answers with what changed rather than the whole document. That keeps a model fast and
  keeps its context small over long sessions.
- **One model per app at a time.** Its calls are queued per app, so two models never interleave
  commands in the same document. Others can work in other apps at the same time.

### 6. The GPU

Every running app holds GPU memory for its window, and the GTX 1050 has 3 GB (2.4 GB free with
Rocket open). This is the one cost not yet measured, because the tests used software rendering.
Phase 0 measures each app's GPU memory with `nvidia-smi`. If 12 do not fit:

- light apps (Grid, Words, PDF, Deck) can run on the AMD integrated GPU, which uses system memory, chosen
  per app in the manifest;
- our copies release their window's GPU surfaces while parked and recreate them when shown. This is
  a small change in shared code (`craft-libs`), applied to every app.

### 7. Rocket itself stays light

- **Window placement only.** Docking moves or resizes a native window only when the right side
  changes size or the app changes; nothing is drawn per frame by Rocket.
- **Off the main process.** App control runs in the host process, never in Electron's main process
  or the UI. A slow app can delay only its own replies.
- **Cheap dock updates.** The dock's dots (running, unsaved, model working) update from
  state-change events, not by polling.

### 8. Disk, so builds never fill it

PhotoCraft's build folder in `~/src/photocraft` is already 27 GB (23 GB of it debug builds), and the
disk has 74 GB free. For our copies:

- **One shared build folder** for all 12. They share most of their code (egui, wgpu, craft-libs), so
  that compiles once.
- **Release builds only, one form per app** (desktop), with debug builds kept only for an app being
  debugged.
- **A disk budget in the build script,** which clears old outputs and warns before free space drops
  below 30 GB.

## What Phase 0 must confirm

1. **Show-after-rest:** the time from click to a usable frame for a resting app, with a real document
   in each heavy app (a layered PSD, a 1080p timeline, a RAW folder).
2. **GPU memory:** how much each app holds on the GTX 1050 while shown, parked and resting.
3. **Swap behaviour:** squeezing a parked, docked window keeps answering and drawing. Measured above
   for the control channel; not yet for a docked window.
4. **Worst case:** all 12 open, one shown, two models working, a video export running. The shown app
   stays smooth and Rocket's chat stays responsive.

## Changes to the own-apps plan this implies

- **Install on demand:** the catalog, the dock holding only installed apps, and install cards in the
  chat, as described above.
- **Instead of "up to four stay running; the oldest closes":** all stay running, idle ones are
  squeezed, and the safety valve closes one only under real memory pressure, restoring it on the
  next click.
- **Native windows for all 12** as the working assumption, with Phase 0 confirming it.
- **New items for "changes every app gets":** release GPU surfaces while parked, a control password
  everywhere, and a record of the open state for restore after the safety valve.
