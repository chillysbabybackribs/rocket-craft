# Spike: hosting Craft apps as web pages inside Electron

Date: 2026-10-10/11. Worker task 0003 of the Craft Studio orchestration. This is the web-page half of
the Phase 0 comparison; native docking is measured by another worker.

**Short answer.** Upstream web builds run well in an Electron `WebContentsView` from a privileged
`craft://` scheme. They start in 2–5 s, their memory per app is similar to the native builds', and a
per-renderer systemd scope can squeeze a hidden app the same way as a native process. But only
FilmCraft exposes a control API on the web. It answers only while the page is drawing frames, and a
hidden view that has stopped drawing stalls both the API and running work. The web build runs on one
thread, so FilmCraft's export took 2.7× as long as the native build's on this machine. Native docking
should stay the main path, with web views as the fallback. Details and numbers follow.

## What was built

`/home/dp/Desktop/rocket-craft/spikes/web-view/`:

| File | What it does |
|---|---|
| `main.mjs` | Electron 41.5.0 app. Serves each upstream web build from `craft://<app>/` (privileged: standard, secure, fetch, CORS, code cache, stream) with COOP/COEP/CORP headers, each app in its own partition and `WebContentsView` over the right part of a 1600×960 window. The left side stands in for the chat and a strip at the bottom for the dock. Hides other apps when one is shown (modes below). Measures RSS and swap from `/proc/<pid>/status`, CPU from `/proc/<pid>/stat`, and the scope's `memory.current`. Saves results to `results/<scenario>-<label>.json`. |
| `preload.cjs` | Reports the app's **first frame after start-up**: when the page's own loading element is removed or hidden by the app's WebAssembly, plus two animation frames. That is the "first interactive frame" used below. |
| `scenarios/*.mjs` | `load` (timings, idle memory), `memory` (life-cycle), `parked` (hide modes), `files` (open/save), `api` (window surface), `speed` + `hiddenwork` (FilmCraft export), `isolation`, `httpcache`, `gpulost`, `shots`. |
| `native-speed.mjs` | Native FilmCraft 0.6.0 over its TCP control channel, doing the same export. |
| `run.sh` | Runs one scenario on Xvfb `:92` (started and stopped by the script) inside its own `systemd-run --user --scope`. |
| `compose-shots.py` | Pastes a view's capture onto the shell capture (Electron's window capture leaves child views out). |

Upstream builds, from `gh release download`, checked with `sha256sum -c` against each release's
`SHA256SUMS.txt` (all OK): `photocraft-web-0.7.0.zip`, `gridcraft-web-0.5.0.zip`, `filmcraft-web-0.6.0.zip`,
and `filmcraft-0.6.0-linux-x86_64.tar.gz` for the native comparison. Nothing was built from source.

Reproduce: `npm install --include=dev`, then for example `SPIKE_APP=photocraft ./run.sh memory mem-photocraft`
(scenario env vars are listed in each file's header).

## Conditions (read before the numbers)

- **The machine was heavily loaded the whole time:** load average 17–50 on 8 cores, from other
  workers' Rust builds, Blender and three other Electron apps. Wall-clock times are therefore noisy and
  pessimistic. I added **renderer CPU time from navigation commit to ready**, which load affects much
  less, and recorded the load average with each run.
- **The private display has no GPU.** Chromium blocklists WebGL2 on Xvfb, and the apps then never start
  (seen in the first run). The Xvfb runs use `--ignore-gpu-blocklist --enable-unsafe-swiftshader
  --use-angle=swiftshader`: WebGPU has no adapter there, so all three apps ran wgpu on WebGL2 through
  SwiftShader ("Software rasterizer detected").
- **Real display `:1`:** two launches (cold, then warm) with `--enable-unsafe-webgpu` and Vulkan
  features. They took 50 s in total, with the window shown without taking focus. WebGPU found the
  GTX 1050 ("nvidia pascal") and FilmCraft reported `backend: BrowserWebGpu, compositor: gpu`.
- One run per configuration unless noted.

## 1. Load time to first interactive frame

ms from `loadURL` to the first frame after the app's loader goes away (`ready` = loader gone).
"CPU" = renderer CPU ms from commit to ready.

| Run | Load avg | PhotoCraft frame / CPU | GridCraft frame / CPU | FilmCraft frame / CPU |
|---|---|---|---|---|
| Xvfb, cold (profile G) | 17.5 | 3511 / 1980 | 3291 / 1920 | 4560 / 1620 |
| Xvfb, warm (G, 2nd launch) | 18 | 3645 / 2040 | 2960 / 1550 | 4563 / 1550 |
| Xvfb, cold (E) | 32 | 6560 / 2320 | 3421 / 1780 | 6374 / 1780 |
| Xvfb, warm (E) | 32 | 4740 / 2410 | 3681 / 1640 | 6725 / 1810 |
| Xvfb, cold (F) | 33–37 | 7854 / 2310 | 8273 / 1690 | 11151 / 1740 |
| Xvfb, warm (F) | 40 | 12105 / 2510 | 6029 / 1650 | 12917 / 1840 |
| Xvfb, early single-app runs (lighter load) | – | 2179 | 3561 | – |
| **Real display, GTX 1050, cold** | 19 | **5363 / 1310** | **2783 / 780** | **4797 / 1200** |
| **Real display, warm** | 19 | **3495 / 1350** | **2152 / 740** | **3228 / 1160** |

- **A warm V8 code cache does not help.** For `craft://` pages Chromium writes no WebAssembly code
  cache: `Code Cache/wasm` stays at 72 bytes after every launch. Only the JS glue is cached
  (~150 KB per app), and renderer CPU to ready is the same cold and warm. Over a loopback HTTP server
  (`httpcache` scenario), the wasm cache does fill, by 1.4 MB per launch, but renderer CPU to ready
  stayed at 2190 → 2210 → 2230 ms over three launches, so the cache is written but not used, or it
  saves nothing here. The real display's faster warm wall-clock time is not reflected in CPU time,
  so it is most likely disk cache or load noise.
- With a real GPU the start-up work is about 40–60% smaller (CPU 1.3 / 0.8 / 1.2 s against
  2.0 / 1.6–1.9 / 1.6 s).
- For reference, the performance plan measured native PhotoCraft at 0.84 s and GridCraft at 1.45 s to
  a control channel answering, on a quiet machine. I did not reproduce that here: native FilmCraft
  took 9.6–15.3 s to answer at load average 24–50, which is not comparable.

## 2. Memory

Renderer RSS in MB (`/proc/<pid>/status`; sandboxed renderers refuse `smaps_rollup`, so there is no
PSS). "Scope" is what the renderer's own cgroup is charged (`memory.current`, plus its swap). About
90 MB of each RSS is file-backed Chromium code shared between renderers. The GPU process (200–385 MB
under SwiftShader) and Electron's browser process are shared by all views and not counted per app.

| Stage (Xvfb, `memory` scenario) | PhotoCraft | GridCraft | FilmCraft |
|---|---|---|---|
| Idle, shown | 227 (scope 121) | 187 (scope 81) | 279 (scope 173) |
| Document opened | 190 + 86 swap* (scope 139 + 79 swap); 4000×3000 JPEG, opened in 6.0 s | 175 (scope 67); 20 000×10 CSV, 2.2 s | 374 (scope 261); 10 s 720p clip imported + sequence, 1.5 s |
| `setVisible(false)` 30 s, throttling off | 182 | 175 | 377 |
| Removed from window 30 s, throttling on | 175 | 173 | 382 |
| + Chromium memory-pressure signal (critical) + GC | 174 | 171 | 373 |
| **Squeezed: scope `MemoryHigh=32M`, 15 s** | **82** (scope 31 + 175 swap) | **134** (scope 27 + 37 swap) | **143** (scope 32 + 234 swap) |
| Shown again: show → next frame | 546 ms | 35 ms | 499 ms |
| Discard (close the page): all-process RSS freed | 273 | 175 | 171 |
| Reopened (document gone) | 218 | 185 | 275 |

\* PhotoCraft's pages were already swapping before any limit, when the whole machine was short of
memory (862 MB free at the time).

Answers to the questions:

- **Memory does not come back when an app is merely hidden.** Hiding in any mode returns 5–10%
  (some JS heap and compositor tiles). Chromium's own pressure path, `Memory.simulatePressureNotification`
  at critical level plus a forced GC, returns 1–2 MB. WebAssembly linear memory never shrinks.
- **`setBackgroundThrottling` does not change memory.** It changes CPU (next table) and whether the app
  keeps working.
- **Discarding returns everything** (171–273 MB per app) but loses the document. Only FilmCraft has
  web recovery (OPFS snapshots), so for PhotoCraft and GridCraft a discard is a restart from scratch.
- **The squeeze the native plan uses also works on a renderer, with one catch.** cgroup v2 never moves
  memory already charged elsewhere, so the renderer must be put into its own scope as soon as its
  process is known (on `did-navigate`, before the WebAssembly is fetched; `busctl … StartTransientUnit
  … PIDs`). Moving it later had no effect (first attempts: RSS unchanged). Done at commit, a 32 MB limit
  pushed 37–234 MB to swap. Scripts still answered in 2–27 ms, and the first frame after showing came
  in 35–546 ms.
- **Per-app cost compared with native** (performance plan, native scope while awake: PhotoCraft
  112 MB, GridCraft 132 MB): the web renderers' own scopes are 121 MB and 81 MB idle. So per app
  the two are similar. The web way adds one shared GPU process (about 200–300 MB) and Chromium's
  shared code. The plan's statement that "a web build's memory only grows; it never returns memory" holds
  for the heap inside the page. It does not hold for the system: the kernel can still swap a squeezed
  renderer out.

### Hide modes: CPU, and whether the app still answers (`parked` scenario, 10 s each)

| Mode | PhotoCraft CPU (renderer / GPU proc) | GridCraft | FilmCraft | FilmCraft `window.filmcraft` call |
|---|---|---|---|---|
| Shown | 7.4% / 2.6% | 6.7% / 2.3% | 16.9% / 2.5% | answers, 146 ms |
| Parked off the window edge (rocketv1's `conceal`) | 6.5% / 2.2% | 6.3% / 2.1% | 18.3% / 3.1% | answers, 61 ms |
| `setVisible(false)`, throttling off | 0.2% / 0.7% | 0.3% / 0.9% | 10.6% / 0.9% | answers, 736 ms |
| Removed from the window, throttling on | **0% / 0%** | **0% / 0%** | 10.2% / 0% | **no answer (8 s timeout)** |

The first `memory` runs right after opening documents showed 7–9% for `setVisible(false)` too, so that
mode is not reliably quiet. `document.visibilityState` stayed `visible` in every mode.

**Work while hidden** (`hiddenwork`: FilmCraft export frames done in 30 s): shown 63, parked 52,
`setVisible(false)` 56, **removed + throttled 2**. A model can therefore only drive, or leave running,
a web app whose page still draws frames, and FilmCraft at least redraws continuously (10–18% of a core
under SwiftShader). This is the reason rocketv1 parks PhotoCraft instead of hiding it.

## 3. Agent / control API on `window`

Checked against a blank same-origin frame (`api` scenario) and the upstream sources at each release tag.

| App | What it adds to `window` | What a model can do through it |
|---|---|---|
| PhotoCraft 0.7.0 | `wasmBindings` = `{default, initSync}` (Trunk's loader only) | Nothing. `apps/photocraft-web/src/main.rs` says: "no TCP control server (browsers can't listen on sockets)". The control handler (`crates/ui-egui/src/control.rs`) is compiled into the wasm but not wired to JS. Without a patch a model has only synthetic mouse and keyboard on an egui canvas (no accessibility tree on the web) and screenshots. |
| GridCraft 0.5.0 | `wasmBindings` = `{default, initSync}` | Same: "no TCP control channel" (`apps/gridcraft-web/src/main.rs`). `control.rs` is in the wasm but unreachable. The only scriptable thing is the URL flag `?sample=sales\|budget\|grades`. |
| FilmCraft 0.6.0 | `filmcraft` (`request, execute, commands, inspect, screenshot, info, files, readFile, importFiles, importUrl, openProject`), `filmcraftLoad`, `filmcraftFatal` | Everything the desktop control channel offers: 693 engine commands, `ui.elements` (90 on screen), `ui.click/key/drag`, PNG screenshots of the canvas (1120×860, about 5 MB base64), import by URL or `File`, read back what the app wrote (exports). Errors are clear sentences ("command `sequence.addEdit` is not available right now: no sequence is open"). Documented in upstream `docs/web.md`. Caveat: only answers while the page draws (above). |

### What would need patching per app for model control

- **PhotoCraft:** a `window.photocraft` bridge that hands calls to `control.rs` and adds a file store
  (`put`/`take`). rocketv1's fork already has this; it is in the 36 uncommitted edits in `~/src/photocraft`
  that task 0001 is saving, and needs porting onto upstream 0.7.0.
- **GridCraft:** the same bridge (`window.gridcraft.call`, file put/take) around its existing
  `control.rs`.
- **FilmCraft:** no API work. Its control queue should also drain on a timer when no animation frames
  arrive, so a hidden or throttled view still answers. Otherwise the app has to stay parked and pay
  10–18% CPU.
- **All three (one shared change in `craft-libs` would cover the 12):** the JS bridge, draining control
  calls without frames, and a host file store. Branding has to be removed in any case: the upstream
  web welcome screens show an "ArtCraft" link and a "Join us on Discord" / Discord button (see the
  screenshots), and the ArtCraft name is a trademark that must not appear. The native builds share the
  same egui UI, so this applies to native docking too.

## 4. File open and save in the web build

- **Open.** Each build calls `rfd`'s web dialog, which creates an `<input type=file>`. In Electron
  that would show a GTK chooser to the user. Intercepting it over CDP
  (`Page.setInterceptFileChooserDialog` + `Page.fileChooserOpened` → `DOM.setFileInputFiles`) hands
  the page any file the host names, with no dialog: PhotoCraft's Ctrl+O opened `photo-4000x3000.jpg`
  (chooser mode `selectMultiple`). A synthetic drop also works (`Input.dispatchDragEvent` with `files`;
  GridCraft opened a 20 000-row CSV). GridCraft's Ctrl+O opens its own Backstage Open page instead of a
  chooser, so a direct open there needs the drop or a patch. FilmCraft has `importUrl`/`importFiles`/`openProject`.
- **Save.** Every save and export is a browser download named after the file only (PhotoCraft:
  "No save dialog on the web: the suggested name becomes the download name"). Electron's
  `session.on('will-download')` + `item.setSavePath()` writes it to a path the host chooses, with no
  prompt: PhotoCraft Save As → `photo-4000x3000.psd` (6.99 MB), GridCraft Ctrl+S →
  `table-20000x10.xlsx` (1.48 MB), FilmCraft export → `shown.mp4` (4.71 MB). The app never knows the
  real path, so the host has to remember where each document came from and map the download name back to
  it. Saving over the original is a host decision, not the app's. PhotoCraft's web build has no autosave or
  crash recovery (its `HOSTING.md`); FilmCraft keeps OPFS snapshots. Preferences live in `localStorage`
  per partition.

## 5. Speed: same operation, web against native (FilmCraft)

Import `clip-720p-10s.mp4` (ffmpeg testsrc2, 1280×720, 30 fps, AAC), `file.newSequence {fromItem}`,
`file.exportMedia {format: h264, crf: 23}`, polling `jobs.list` until done. Both on Xvfb (software
rendering), same 300 frames, output sizes match (4.71 against 4.73 MB).

| Build | Wall time | Frames/s | CPU time | Load avg |
|---|---|---|---|---|
| Web (one thread, WebGL2 → CPU compositor) | 249.6 s | 1.20 | 134.7 s renderer* | 35 |
| Native, all 8 cores | 92.4 s | 3.25 | 83.6 s | 50 |
| Native pinned to one core (`taskset -c 3`) | 221.9 s | 1.35 | 119.5 s | 24 |

\* The GPU process restarted during the web run, so its CPU share was not captured.

So per CPU-second the WebAssembly build is roughly 10–15% slower than native code on one core, but it
can only use one thread (`filmcraft.info().threads: false`; FilmCraft's `docs/web.md` says the same).
On this 8-core machine native finished 2.7× sooner, even with load average 50. Peak RSS was 1080 MB
native against about 380 MB web (native keeps multi-threaded frame caches). Treat this as indicative:
one run each, a heavily and unevenly loaded machine, and different compositor paths. PhotoCraft and
GridCraft could not be compared fairly, because their web builds offer no scripted way to run an
operation.

## Other observations

- **Cross-origin isolation is not granted in Electron 41.5.0.** `crossOriginIsolated` stays false
  with COOP `same-origin` + COEP `require-corp`, both on `craft://` and on a loopback HTTP server, and
  in a plain `BrowserWindow` (minimal repro in the `isolation` scenario and in `/tmp/wv-iso`, since
  removed). `SharedArrayBuffer` appears only with `--enable-features=SharedArrayBuffer`.
  `new WebAssembly.Memory({shared: true})` works either way. This does not matter for these builds:
  all three are single-threaded, and their `HOSTING.md` files say they need no isolation headers. It
  will matter for a threaded build. rocketv1's comment ("cross-origin isolation headers that
  WebAssembly threads need") assumes the headers alone are enough, which is not what I observed.
- **Software GPU instability.** On SwiftShader the shared GPU process restarted ("Context was lost")
  in all 6 runs where FilmCraft imported media. FilmCraft's canvas then stayed blank, though its
  API kept answering, and the other views logged `CONTEXT_LOST_WEBGL`. It did not happen in a run without
  an import. I did not test it on the real GPU because of the 60-second limit there. One GPU process for
  all web apps is a shared point of failure that native windows do not have.
- **GPU memory per app** was not measured reliably: `nvidia-smi` readings overlapped with other
  workers' GPU use.
- PhotoCraft and GridCraft idle at about 0.2% CPU when not drawing (egui redraws only on change).
  FilmCraft redraws continuously (10–18% of a core under SwiftShader).

## Screenshots

- `shots/real-display-three-apps.png`: the three upstream builds on the real GPU display (welcome screens
  with the ArtCraft and Discord links).
- `shots/xvfb-window-photocraft.png`, `shots/xvfb-window-gridcraft.png`: the spike window with each
  app over the right side, a document open (4000×3000 JPEG; 20 000×10 CSV).
- `shots/files1-photocraft-saveas.png`: PhotoCraft after Save As ("Saved photo-4000x3000.psd"), saved
  through the intercepted download.
- `shots/mem-photocraft-photocraft-reshown.png`: PhotoCraft shown again after the 32 MB squeeze, with
  the document intact.
- `shots/mem-filmcraft-filmcraft-document.png`: FilmCraft's blank canvas after the SwiftShader GPU
  process restart.

## Recommendation

Keep **native docking as the main path** if worker 0002's spike shows docking works, and keep **web
views as the fallback**. The reasons, from these measurements:

1. **Speed:** single-threaded wasm took 2.7× as long on the one fair test, and every heavy app
   (Film, Photo filters, Light, CAD) would pay that.
2. **Control:** the native builds already have the TCP control channel and MCP. On the web, two of
   three apps need a bridge patch first, and even FilmCraft's API stops answering when its view stops
   drawing.
3. **Hidden apps:** a web app keeps working only if parked and drawing (0–18% CPU each, all through
   one GPU process). A native app can be squeezed and still answers.
4. **Files:** native apps open and save real paths. Web apps need CDP chooser interception and download
   mapping in the host.

**What the web way does well**, worth keeping as the fallback: there is no window management, it
starts in 2–5 s, per-app memory is comparable, squeezing works (scope at commit), and opening and saving
can be made silent. If it is used, park hidden views rather than removing them, create each
renderer's scope on `did-navigate`, add `--enable-features=SharedArrayBuffer` only if a threaded build
appears, and do the bridge, frame-independent control and branding patches once in `craft-libs`.

## Housekeeping

- Every process I started is stopped: Xvfb `:92`, `:93` and `:94`, all spike Electron instances, native
  FilmCraft, and their transient `craft-webview-*` / `craft-native-*` scopes (none left in
  `systemctl --user list-units`). The running Rocket apps were not touched.
- `npm install` left `node_modules/electron/dist/chrome-sandbox` set root-owned 4755 via `sudo -n`,
  as Rocket's own `scripts/electron-sandbox.mjs` does.
- A mistaken `npx electron --version` downloaded electron 44.7.0 into the npm `_npx` cache. It is unused.
- Profiles were deleted after the runs. `results/` keeps the JSON, logs, downloads and native exports.
