# Native-dock spike: Craft app windows inside an Electron window on X11

Run 2026-10-10/11 on this machine (X11, 8 cores, 13 GB RAM, GTX 1050 3 GB + AMD Vega iGPU),
with the upstream PhotoCraft 0.7.0 and GridCraft 0.5.0 linux-x86_64 builds, Electron 44.7.0, on a
private Xvfb display `:91` (no window manager, then openbox 3.6.1 unpacked locally), plus a short
real-GPU check on the user's display `:1` (GNOME Shell / mutter).

## Verdict: GO, with three required pieces

Reparenting a native Craft app window into the Electron window works for both apps: it renders,
resizes, takes mouse, wheel and keyboard, copies and pastes both ways, keeps answering its control
channel while parked or squeezed, and comes back on screen in 0.14–0.47 s. It is good enough for
daily use and full model control **only with these three pieces**, all proven in this spike:

1. **Composite-redirect a parked window.** A window the X server reports as fully obscured (moved
   out of the parent's bounds, or covered by a sibling) stops painting, so `ui.screenshot` hangs
   for 60 s and blocks every later call on that bridge. `XCompositeRedirectWindow(app,
   CompositeRedirectAutomatic)` while parked keeps it drawing (screenshots 0.5–1.3 s while parked).
2. **A focus guard.** Without it, keys follow the pointer: with the chat focused and the mouse
   resting over the app, the chat's keys go to the app (which drops them), and clicking the app
   does not give it the keyboard. The guard (an InputOnly key "shield" per app, key forwarding to
   Electron, a passive click grab, a FocusIn redirect and a DOM pointerdown hook) fixed every case
   tested, with no window manager and under openbox.
3. **Lift the limit before work.** A squeezed app answers inspects in 0.1–0.25 s, but a full-image
   edit took 2.6 s squeezed against 0.58 s right after lifting `MemoryHigh`.

Not yet proven, and needed before Phase 2 is called done: the focus guard and redirect **under
mutter on the real display** (only openbox was available on Xvfb), IME, and drag-and-drop from a
file manager into a docked app (XDND targets top-level windows; untested). GPU memory is the hard
limit, not RAM: every running app holds about 200 MiB on the GTX 1050 whether shown, parked or
squeezed (see GPU).

The overlay fallback (a borderless top-level kept over the region) also works and needs no focus
guard at all; it is not needed, but it is a cheap fallback if mutter defeats the guard.

## What was built

`main.js` (Electron main), `index.html` (left "chat" with a textarea, right region, bottom dock with
Photo and Grid), `xdock.py` (the X11 side: one python-xlib connection per helper process, JSON
lines), `ctl.mjs` (one request to the spike's control socket `run/ctl.sock`), `measure.mjs`
(timings), `focus-test.sh`, `clip-test.sh`, `gpu-check.sh`, plus small test helpers `xmove.py`,
`xredirect.py`, `gridui.py`.

A dock click: `systemd-run --user --scope --unit=nd-<app>-<pid> -- <app> --control <port>
[--control-token-file <f>]` (systemd-run execs, so the child pid is the app pid; verified), with
scratch `XDG_CONFIG_HOME` / `DATA` / `CACHE` / `STATE` so the user's own app settings are not used.
The window is found by `_NET_WM_PID`, reparented at the right region's bounds, and the other app is
parked by moving it out of the parent's bounds (never unmapped). The renderer reports the region's
bounds with a `ResizeObserver`; main refits the shown window. Models' side: each app's
`<app>-cli mcp` bridge (PhotoCraft `--bridge 127.0.0.1:<port> --control-token-file <f>`,
GridCraft `--connect <port>`) is started on first use and driven over stdio JSON-RPC.

Run it: `Xvfb :91 -screen 0 1600x1000x24 -nolisten tcp &`, then
`DISPLAY=:91 node_modules/.bin/electron --no-sandbox .` (the SUID sandbox helper is not set up in
this scratch folder), then e.g. `node ctl.mjs open '{"app":"photo"}'`,
`DISPLAY=:91 node measure.mjs <label> cold|parked|squeeze [doc]`,
`DISPLAY=:91 ./focus-test.sh <label> [delay-ms]`, `DISPLAY=:91 ./clip-test.sh <label>`.
`SPIKE_MODE=overlay` switches to the overlay fallback, `SPIKE_REDIRECT=never|park|always` and
`SPIKE_GUARD=0` turn the two fixes off for comparison.

## Results

### 1. Reparenting, rendering, resize, input, clipboard

| Check | PhotoCraft | GridCraft | Evidence |
|---|---|---|---|
| Reparent into Electron's X window (no WM) | works | works | `shots/02-photo-docked.png`, `01-grid-docked.png` |
| Reparent under openbox (window first managed by the WM) | works; WM hands it back in 4 ms | works; 18 ms | `shots/20-openbox-photo-docked.png` |
| Renders inside the region | yes | yes | as above |
| Resize with the Electron window (1200×760, 1560×960) | fitted exactly (820×664, 1180×864) | fitted | `shots/03-…`, `04-…` |
| Mouse clicks | yes (New document button, tool icons) | yes (cell selection) | `shots/11-photo-newdoc-dialog.png` |
| Mouse drag | brush stroke drawn; history shows "Brush Tool" | — | `shots/13-photo-brush-stroke2.png` |
| Wheel over the app while the chat keeps the keyboard | — | scrolls (0 → 478–500 px) | focus tests |
| In-app menus and dialogs (egui draws them inside its window) | File menu opens inside the region | — | `shots/14-photo-file-menu.png` |
| Keyboard, no guard, Electron focused | **lost** (app ignores keys it gets while unfocused) | **lost** | `shots/05-…`, `07-…` |
| Keyboard with the focus guard (no WM and openbox) | shortcuts B/E/M switch tools, Return confirms dialog | typing lands in the clicked cell | `shots/focus-nowm.png`, `focus-openbox.png` |
| Chat typing with the pointer resting over the app | — | reaches the chat (forwarded keys) | focus tests |
| Copy app → Electron textarea | — | `copied-from-app\n` pasted | `clip-test.sh` (no WM, openbox, overlay) |
| Copy Electron textarea → app | — | `pasted-into-app` in the cell | same |

GridCraft drops characters typed fast right at the start of a cell edit (`to-app` → `tp` at
150 ms per key on a loaded machine). The same happens to an **undocked** GridCraft under the same WM
(`shots/22-grid-standalone-typing.png`: `tp` at 150 ms, `tapp` at 300 ms), so it is GridCraft on
this software-rendered display, not docking. Not checked on the real GPU.

Focus test output (`focus-test.sh`, 150 ms per key):

```
nowm:     focus after app click=app, after chat click=electron | G7='to-app' | chat="to-chat+wheel" | scroll 0 -> 488
openbox:  focus after app click=app, after chat click=electron | G31='tp' (GridCraft edit-start drop) | chat="to-chat+wheel" | scroll 488 -> 965
openbox, 300 ms per key: G31='t-app', G35='again' | chat="to-chat+wheel"
overlay (openbox, no guard): G7='to-app', G11='again' | chat="to-chat+wheel" | scroll 0 -> 500
```

### 2. DOM over the docked region

Covered, as expected: a red DOM popover placed across the boundary is cut off exactly where the
docked window begins (`shots/15b-dom-popover-crop.png`). The same holds in overlay mode. Popovers
must stay inside the chat card, as the plan already says.

### 3. Control channel while parked

Bridge round trip, `tools/call` through `<app>-cli mcp` (ms). Run with a heavier document
(PhotoCraft 4000×3000, noise + duplicated blurred layer; GridCraft 20,000 cells) and load average
about 23 on 8 cores from another job, so absolute numbers are pessimistic. An earlier unloaded run
with an empty PhotoCraft gave 4–8 ms for `ui_inspect` while parked, and an `image.adjustments.invert`
edit while parked took 188 ms.

| | PhotoCraft `ui_inspect` | GridCraft `inspect_workbook` |
|---|---|---|
| Shown | 89, 186, 112, 107, 100 | 142, 90, 77, 68, 73 |
| Parked (redirected) | 114, 97, 97, 87, 87 | 143, 96, 92, 89, 73 |
| Squeezed (`MemoryHigh=48M`, `CPUWeight=1`) | 245, 190, 122, 115, 112 | 154, 105, 104, 86, 89 |

| Screenshot through the control channel | PhotoCraft `ui_screenshot` | GridCraft `screenshot` |
|---|---|---|
| Shown | 0.76 s (unloaded), 1.23 s (loaded) | 0.63 s |
| Parked off-screen, **no redirect** | **timed out after 60 s** (15 s on retest) | **timed out** (20 s cap); a `write_range` queued behind it waited 40 s |
| Parked, covered by the other docked app (same position, below) | **timed out after 60 s** | — |
| Parked with 1 px left visible | 2.5 s | — |
| Parked off-screen, Composite-redirected | 1.4–2.1 s unloaded, 1.27 s loaded | 0.50 s |
| Squeezed and redirected | 1.27 s | 0.56 s |

`shots/19-photo-ui_screenshot-while-parked-redirected.png` is PhotoCraft's own capture while parked
and redirected, showing the invert done while parked. `shots/26-…` and `27-…` are GridCraft's while
parked and while squeezed.

Two bridge behaviours a production bridge must handle (not docking issues):

- **PhotoCraft closes an idle control connection after about 30 s**; the next bridge call fails once
  with "connection closed by the app; operation may have completed" and the one after reconnects.
  Retry read-only calls once, or keep the connection warm.
- **A stalled request blocks the bridge**: calls are sequential, so a hung screenshot delays every
  later call by up to 60 s.

### 4. Squeeze, and showing after rest

`systemctl --user set-property --runtime nd-<app>-<pid>.scope MemoryHigh=48M CPUWeight=1`,
read from `/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/<unit>.scope/`.

| | PhotoCraft (4000×3000, 2 layers) | GridCraft (20,000 cells) |
|---|---|---|
| `memory.current` awake | 425.3 MB | 143.2 MB |
| 1 s after squeezing | 31.0 MB RAM, 392.5 MB swap | 49.4 MB RAM, 81.2 MB swap |
| 2, 4, 8, 15 s | 30.6 MB RAM, 392.5 MB swap (flat) | 49.4 MB, 81.2 MB (flat) |
| After 6 bridge calls + screenshot while squeezed | 43.1 MB, 415.5 MB swap | 49.7 MB, 90.0 MB swap |
| `systemctl set-property` (lift) | 56 ms | 26 ms |
| Show after rest, lift first: click → correct frame | **380 ms** | **466 ms** |
| Show after rest, not lifted | 322 ms | 253 ms |
| Show without squeeze (parked only) | 244 ms | 137 ms |
| RAM right after showing | 42.4 MB (only touched pages return) | 49.6 MB |

"Correct frame" is the first screen grab of the region matching (≤ 2% pixels differing) a grab
taken while the app was last shown; the grab loop runs about every 80 ms on this display, so the
figures are ±80 ms. The redirect is removed when the app is shown.

Real work right after rest (PhotoCraft `image.adjustments.invert` on the 4000×3000 document,
bridge time): awake 637 ms; after 15 s squeezed then lifted 575 ms; **still squeezed 2,635 ms**.

Idle CPU, 10 s, from the scope's `cpu.stat`: PhotoCraft shown 50 ms, parked and redirected 51 ms;
GridCraft parked and redirected 49 ms. About 0.5% of one core in every state: the redirect does not
make a parked app busy.

### 5. Cold start, click to first frame

Measured from the `open` request (the click) to the first grab of the region that has changed from
the background by more than 30% and has an app's detail. Each app was closed between runs; its
binary was in the page cache.

| Run | PhotoCraft: window mapped / docked / **first frame** / control answers | GridCraft: same |
|---|---|---|
| No WM, quieter machine | 781–1225 / 786–1236 / **1152–1507** / 705–1073 ms | 704–948 / 713–952 / **992–1264** / 558–777 ms |
| No WM, load average 23 | 2026–2798 / 2038–2815 / 2576–3865 / 1773–2552 ms | 2293–2827 / 2305–2910 / 3394–4440 / 1845–2188 ms |
| Openbox, load average 23 | 2513–3489 / 2542–3519 / 2667–3991 / 1999–2224 ms | 2185–3058 / 2217–3095 / 2342–3238 / 1654–2008 ms |

The WM adds nothing measurable; machine load roughly doubles cold start. Under a WM the app's own
top-level is visible for the 20–80 ms between its map and the reparent (a brief flash, plus a
taskbar entry). Catching the window at `CreateNotify` / `_NET_WM_PID` before it maps would avoid it;
not tried.

### 6. Overlay fallback

`SPIKE_MODE=overlay`, under openbox: the app stays a top-level with `_MOTIF_WM_HINTS` decorations
off and `WM_TRANSIENT_FOR` = Electron, moved to the region's root coordinates on every Electron
`move`. It renders in place (`shots/23-overlay-grid.png`), follows a programmatic move and an
interactive title-bar drag with 0 px error at every 30 ms sample (`shots/24-…`, `25-…`), and focus,
typing, wheel and clipboard all work **without any guard**, because the WM handles focus between two
top-levels. Costs: Electron looks inactive while the app has focus (`_NET_ACTIVE_WINDOW` is the
app), the app is a separate window to the WM, and `_NET_WM_STATE_ABOVE` (set in the spike) would
keep it above every other window on the desktop, so production must rely on `WM_TRANSIENT_FOR` only.
Parked overlay windows were not tested; they would need the same redirect.

Needed? No: reparenting with the guard works. Keep it as the fallback if mutter breaks the guard.

### GPU (real display `:1`, then Xvfb)

`gpu-check.sh`: each app launched alone on `:1` with scratch config, at most 20 s (`timeout`), read
with `nvidia-smi --query-compute-apps` and the `nvidia-smi` process list, then closed (scope gone
afterwards). Empty document, window shown at its default 1440×900.

| | PhotoCraft | GridCraft |
|---|---|---|
| Real display, shown | **198 MiB**, type C+G, on GPU 1.6 s after launch | **198 MiB**, C+G, after 0.87 s |
| Xvfb, shown or parked (canvas on NVIDIA Vulkan, window presented through llvmpipe) | 203 MiB | 203 MiB (also while parked) |
| Xvfb with `VK_ICD_FILENAMES` set to the radeon or lavapipe ICD | — | not on the NVIDIA card at all |

So each running app costs about 200 MiB of the 3 GB card regardless of state, and squeezing or
parking returns none of it. With Rocket and the desktop holding 0.6–0.9 GB, about 10 apps fit.
`VK_ICD_FILENAMES` keeps an app off the NVIDIA card; which adapter it then uses on the real display
(AMD iGPU or software) was not read.

PhotoCraft's own log on `:1` reports `GPU startup: Plan { backend: Auto }` with the scratch config.
With the user's existing `~/.config/photocraft`, an accidental launch (see below) chose
`backend: Gl`, failed with "gl not compatible with provided surface" and relaunched itself on the
CPU renderer (`--safe-gpu`).

## The X11 calls that worked

Finding the window (`xdock.py op_find`): `XQueryTree` recursively from the root, then
`XGetWindowProperty(_NET_WM_PID)` equal to the launched pid, `XGetWindowAttributes` with
`map_state == IsViewable` and class `InputOutput`; largest wins. Took 0.6–1.2 s after spawn
(unloaded), i.e. as soon as the app maps.

Docking (`op_dock`):
1. If a WM manages it (its parent is not the root): `XUnmapWindow(app)` plus the ICCCM withdraw
   `XSendEvent(root, synthetic UnmapNotify, SubstructureRedirect|SubstructureNotify)`, then poll
   until the WM has reparented it back to the root and `WM_STATE` is Withdrawn (4–18 ms on openbox).
2. `XChangeWindowAttributes(app, override_redirect=True)` so the WM never takes it again.
3. `XReparentWindow(app, electron, x, y)` where `electron` is `getNativeWindowHandle()` read as a
   64-bit little-endian XID. Use `Menu.setApplicationMenu(null)` (or account for the menu bar):
   Electron's default menu bar is drawn inside the same X window and offsets the region by 28 px.
4. `XMoveResizeWindow(app, x, y, w, h)`, `XMapWindow(app)`.

Fitting: `XConfigureWindow(app, x, y, w, h, stack_mode=Above)` on every bounds report.
Parking: `XCompositeRedirectWindow(app, CompositeRedirectAutomatic)` then `XMoveWindow(app,
-(w+200), 0)`. Showing: `XCompositeUnredirectWindow` then the fit. The redirect belongs to the X
connection that made it and ends when that connection closes, so the dock's connection must live as
long as the app.

Focus guard (`guard_loop`, its own X connection):
- Per app, `XCreateWindow(parent=app, InputOnly)` full size: the shield. Only the dock selects on it:
  `XSelectInput(shield, KeyPressMask|KeyReleaseMask)`, and
  `XGrabButton(AnyButton, AnyModifier, shield, owner_events=True, ButtonPressMask, GrabModeSync,
  GrabModeAsync)`.
- Shield mapped while Electron should have the keyboard. A key on it is forwarded with
  `XSendEvent(electron, KeyPress/KeyRelease)`; Chromium accepts synthetic keys (checked with
  `xdotool type --window`).
- Press with buttons 1–3 on the shield: `XSetInputFocus(app, RevertToParent, time)`,
  `XAllowEvents(ReplayPointer, time)`, **then** `XUnmapWindow(shield)`. Unmapping before the replay
  loses the press; replaying with the shield mapped lets it propagate to the app.
- Buttons 4–7 (wheel): `XAllowEvents(ReplayPointer)` only, so scrolling does not take the keyboard.
- `XSelectInput(electron, FocusChangeMask)`: a `FocusIn` on Electron while the app should have the
  keyboard (the WM re-focusing its client after a click) is answered with `XSetInputFocus(app)`.
- A DOM `pointerdown` (capture phase) in the renderer sends IPC; main does
  `XSetInputFocus(electron)` and maps and raises the shield.

What did not work: a passive grab on Electron's own window (openbox already holds that grab:
`BadAccess` on `GrabButton`; mutter will too); an InputOnly shield as a sibling above the app (the
replayed press goes to Chromium, not the app); relying on X's pointer rule (keys go to whichever
side the pointer is over).

Overlay: `XChangeProperty(_MOTIF_WM_HINTS, decorations=0)`, `XChangeProperty(WM_TRANSIENT_FOR,
electron)`, `_NET_WM_STATE` client message (drop ABOVE in production), and
`XConfigureWindow(x, y, w, h, stack_mode=Above)` in root coordinates on every Electron `move`.

Test tip: `xdotool getwindowfocus` without `-f` reports the top-level client, which hides a focused
child under a WM; use `-f`.

## Other findings for later phases

- PhotoCraft draws its own title bar with minimise, maximise and close buttons, its logo and an
  "ArtCraft" link on the welcome page (`shots/02-…`). Close would quit the app from inside Rocket's
  panel. An embedding mode (no window controls) is worth asking upstream for; the brand in the app's
  own UI matters only if a modified build is published.
- Native windows other apps may open (detached panels, file dialogs) would be separate top-levels,
  not docked. Not tested.
- IME and drag-and-drop into a docked window: not tested.

## Things I did outside the plan

- At the very start, a `--help` probe of both app binaries ran on the real display `:1`: both treat
  `--help` as a file to open and started their windows. PhotoCraft exited on its own after about
  1 min 48 s; I killed GridCraft (pid 192087) after about 2 min. Both used the user's own
  `~/.config/photocraft` and `~/.config/gridcraft` (logs appended there). Every later launch used
  scratch config directories.
- openbox 3.6.1 was fetched with `apt-get download` and unpacked to `/tmp/nd-wm` (no install, no
  root) to test under a window manager on `:91`.

## Cleanup

All stopped before finishing: the spike's Electron (which ends both apps, both MCP bridges and both
`xdock.py` helpers), the standalone GridCraft and the two ICD test runs (`nd-grid-standalone-*`,
`nd-icd-*`), the redirect helper, openbox and Xvfb `:91`. Checked afterwards: no matching
processes, no `nd-*` systemd scopes, nothing listening on ports 47711–47714, 47721–47722. The two
real-display runs ended inside their 20 s cap and their scopes were inactive.
`node_modules` (297 MB) and `run/` (logs, measurement JSON, scratch XDG dirs) remain in this folder.
