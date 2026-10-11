# Native-dock spike, live check under mutter (GNOME Shell 46, X11, display :1)

Run 2026-10-11, 00:35:29–00:36:41 local, on the user's real display `:1` (Xorg, GNOME Shell 46.0 /
mutter with `mutter-x11-frames`, two monitors, GTX 1050), with the upstream PhotoCraft 0.7.0 and
GridCraft 0.5.0 builds in `/tmp/craft-measure.b2Tv/x/`, Electron 44.7.0 from `../node_modules`.
Rehearsed first on a private Xvfb display running a real `gnome-shell --x11` (isolated HOME and
session bus), so the live part was one run of a prepared script.

## Verdict: all five items pass under mutter, with one change needed (catch the window at creation)

| # | Item | Live result |
|---|---|---|
| 1 | Dock GridCraft then PhotoCraft; flash / taskbar entry | **Pass with the early catch.** Without it mutter frames the app, shows it ~0.4 s, lists it ~0.36 s and gives it focus ~0.32 s. Catching it at `CreateNotify` removes all three. |
| 2 | Focus guard, wheel, drag, copy/paste | **Pass**, every check |
| 3 | Alt-Tab / Super / focus stealing | **Pass** (read from `_NET_CLIENT_LIST`, not by pressing the keys): docked apps never listed, never the active window |
| 4 | Composite redirect while parked | **Pass**: own screenshots 0.28–0.36 s (Grid), 0.78–0.83 s (Photo). Idle CPU is fine **unless the app is animating** (see below) |
| 5 | GPU | Both apps on the NVIDIA GTX 1050 (Vulkan), 198–199 MiB each, the same shown or parked |

**Live time: 66.7 s** with spike windows on the screen (spike start 00:35:29.8 to spike exit 00:36:36.5),
in one block. The pointer was restored to (1109,1141) and checked. Every process and scope I
started was stopped and checked. Your clipboard (an image) and active window were put back.

## 1. Docking under mutter: flash, taskbar, and catching the window early

Root-window watcher (`xdock.py` `watch_loop`) timeline for GridCraft docked the old way (mutter
manages it first, then the spike withdraws and reparents it). Times are from the app's
`CreateNotify`; live `:1`:

| ms | event |
|---|---|
| 0 | app creates its 1440×900 top-level |
| 1191 | app maps it; mutter adds it to `_NET_CLIENT_LIST` (dash, Ubuntu dock, Alt-Tab) |
| 1193 / 1201 | mutter reparents it into a frame and maps the frame: **its own decorated window is on screen** |
| 1220 | mutter makes it the **active window** (focus taken from the spike) |
| 1486 | spike withdraws it (unmap + ICCCM synthetic UnmapNotify) |
| 1538 / 1546 | Electron active again; app removed from `_NET_CLIENT_LIST` |
| 1586 / 1602 | mutter hands it back to the root; spike reparents it into Electron (withdraw wait 114 ms) |
| 1607–1617 | frame unmapped and destroyed |

So under mutter the old way gives a **~406 ms flash** of a separate decorated window, a **~355 ms
entry** in the dash and Alt-Tab list, and **~318 ms of stolen focus**. That is much worse than
openbox's 20–80 ms. Shot: `shots/live/01-grid-docked-baseline.png` (the docked result).

**The fix that works: catch the window at creation.** `op_watch` selects
`SubstructureNotify` on the root. On a root `CreateNotify` it asks the X server which client made
the window (`XResQueryClientIds` with `LocalClientPIDMask`, which works before the app sets
`_NET_WM_PID`). If that pid is the app just launched and the window is a real top-level (not
override-redirect, larger than 50×50), it runs `XGrabServer`, `XChangeWindowAttributes(override_redirect=True)`,
`XReparentWindow(app, electron, -5000, 0)` and `XUngrabServer`. When the app later maps it, the map
happens inside Electron. mutter never sees a `MapRequest`, so there is no frame, no list entry and
no focus change.

| Live `:1` | caught after create | window state when caught | framed | in `_NET_CLIENT_LIST` | active-window changes | click → docked |
|---|---|---|---|---|---|---|
| PhotoCraft | 14.9 ms | unmapped | no | no | none | 2228 ms |
| GridCraft (relaunched) | 8.3 ms | unmapped | no | no | none | 2290 ms |

In all four rehearsal catches and both live catches the window was still unmapped. The app maps it
more than a second after creating it, so the race has a wide margin. Shots:
`shots/live/02-photo-docked-early.png`, `03-grid-docked-early.png`. Each app also creates two or
three 1×1 helper windows (clipboard and similar); the size filter leaves them alone.

Setting `_NET_WM_STATE_SKIP_TASKBAR` early is implemented (`early: 'skip'`) but was not run. It
would only hide the list entry, not the flash or the focus change, and the catch makes it
unnecessary.

**Mutter bug found in rehearsal and fixed (`op_dock`).** On a loaded machine mutter took more
than 1 s to unmanage a withdrawn window. The spike's 1 s wait expired and it reparented the window
into Electron. mutter's late unmanage then **moved it back to the root**, leaving the app as a
stray undecorated top-level on the desktop. The wait is now for the hand-back itself (parent ==
root), up to 5 s. Live it took 114 ms. With the early catch this path is not used at all.

## 2. Focus guard, wheel, drag, clipboard

Same steps as `../focus-test.sh` and `../clip-test.sh`, with the pointer moved away after each
click so "keys follow the pointer" cannot pass by accident. Live `:1`, 150 ms per key into the
app:

| Check | Result |
|---|---|
| Click cell G7 in GridCraft → X focus | GridCraft's window (`0x4000004`) ✔ |
| Pointer moved over the chat, type `to-app` + Return | G7 = `to-app` ✔ (no dropped first letters on the real GPU; Xvfb rehearsal gave `to-a`) |
| Click the chat textarea → X focus | Electron (`0x2a00004`) ✔ |
| Pointer resting over GridCraft, type `to-chat` | reached the chat ✔ (forwarded by the shield) |
| Click G11, pointer away, type `again` | G11 = `again` ✔ |
| Wheel ×5 over GridCraft with the chat focused | sheet scrolled 0 → 230 px, then `-wheel` typed went to the chat: chat = `to-chat-wheel` ✔ |
| Drag across cells (C → B) | selection `D6:G14` ✔ |
| Copy in app (Ctrl+C) → clipboard → paste in chat | `copied-from-app\n` ✔ |
| Copy in chat → paste in app cell E6 | E6 = `pasted-into-app` ✔ |
| PhotoCraft: click canvas → X focus | PhotoCraft's window (`0x4c00004`) ✔ |
| PhotoCraft shortcuts E then B | tool Eraser, then Brush ✔ |
| PhotoCraft brush drag | history `Open, Brush Tool, Brush Tool`, stroke drawn ✔ |
| Chat focused, pointer over the canvas, type `m` (Move/Marquee shortcut) | `m` in the chat, PhotoCraft tool still Brush ✔ |

Guard log (live): one `focusin-electron → redirected to app` after the click on G7. mutter
re-focuses Electron's client window after a click into a child, the same as openbox, and the
guard's FocusIn redirect is what keeps the keyboard with the app. Shots: `04-grid-after-focus-test.png`,
`05-grid-after-clipboard.png`, `06-photo-after-brush.png`.

**Second bug found in rehearsal and fixed (`op_guard`): XID reuse.** A relaunched GridCraft got
the **same window XID** as the one just closed (X reuses a departed client's resource range). The
guard keyed shields by XID, so it believed the new window already had one. The old shield had died
with the old window, so the new app ran unguarded: clicks did not give it the keyboard and keys
followed the pointer. The guard now checks that the shield still exists. Production should key all
per-window state by launch, not by XID.

## 3. Alt-Tab, Super, focus stealing

Alt-Tab and Super were **not pressed**. They act on the whole desktop and could have switched to or
opened something outside the spike. What they show was read instead. mutter's switcher, the
Activities overview, the dash and the Ubuntu dock all list mutter's managed windows, which mutter
publishes as `_NET_CLIENT_LIST`. That property and `_NET_ACTIVE_WINDOW` were watched for the whole
run, and X input focus was polled every 20 ms.

- Early-caught apps: **never in `_NET_CLIENT_LIST`**, never `_NET_ACTIVE_WINDOW`. After docking
  both report `override_redirect=true`, parent = Electron, no `WM_STATE` and no `_NET_WM_STATE`.
- `_NET_ACTIVE_WINDOW` held only two values all run: the spike, and the old-way GridCraft for 318 ms.
  It was the spike at the end of every step.
- X focus went only to Electron, the two docked app windows and, once, `PointerRoot`. The time of
  the `PointerRoot` change was not recorded; most likely it was when mutter unmanaged the focused
  old-way GridCraft.
- mutter's focus-stealing prevention did not refuse the spike window: it was active on map, before
  any activation request.
- Not tested: pressing Alt-Tab away and back while an app holds the keyboard. Expected outcome:
  mutter focuses Electron's client window, and the guard's FocusIn redirect hands the keyboard back
  to the app because it still wants it. Not seen.

## 4. Parked under a compositing WM

The redirect (`XCompositeRedirectWindow(app, Automatic)` on park) works under mutter's own
compositing. Times are the app's own screenshot through its control channel while parked
(bridge round trip):

| | Live `:1` | Xvfb + gnome-shell rehearsal | earlier spike (Xvfb, no WM / openbox) |
|---|---|---|---|
| GridCraft `screenshot` | **362, 282 ms** | 1524, 1614 ms | 0.50 s |
| PhotoCraft `ui_screenshot` (max side 800) | **777, 828 ms** | 1440, 1645 ms | 1.27–2.1 s |

Both captures show the right content: `shots/live/grid-own-capture-while-parked.png`,
`photo-own-capture-while-parked.png`.

Idle CPU while parked (scope `cpu.stat`, 8 s):

| | Live `:1` | Rehearsal (gnome-shell on Xvfb) |
|---|---|---|
| PhotoCraft, parked | **37 ms** (0.5 % of a core) | 243 ms |
| GridCraft, parked, **copy marquee running** | **739 ms (9.2 %)** | 2698 ms |
| GridCraft, parked, after Escape | — | 33 ms |
| GridCraft, parked, no copy | — | 37 ms |
| GridCraft, right after a parked screenshot | — | 128 ms |

**New finding:** the clipboard test left GridCraft in copy mode, with an animated "marching ants"
marquee. A redirected window is never occluded, so a parked app keeps drawing any animation it has
running. A quiet parked app costs about 0.5 % of a core under mutter, as before. An animating one
costs whatever the animation costs. Options for Phase 2:

- (a) Rely on the squeeze (`CPUWeight=1`), which already caps it under contention.
- (b) Redirect only while a model call needs the app's pixels. A parked, unredirected app is
  occluded and stops drawing (shown by the earlier spike's 60 s screenshot hang). Redirect just
  before a screenshot, unredirect after. Untested: how long the app takes to produce its first
  frame after being redirected.

## 5. GPU

`nvidia-smi` process table, live `:1`, both apps running:

| | PhotoCraft | GridCraft | spike Electron GPU process |
|---|---|---|---|
| Adapter | NVIDIA GeForce GTX 1050, Vulkan, discrete, driver 580.178.04 (its own `ui_inspect.perf.timings.gpuInfo`) | NVIDIA (listed by nvidia-smi as C+G) | NVIDIA (G) |
| Shown | 199 MiB | 198 MiB | 22–23 MiB |
| Parked | 199 MiB | 198 MiB | — |

As before, parking returns no GPU memory. `--query-compute-apps` also listed pid 296847 (46 then
100 MiB). It is not from this run and had exited by the time I checked.

## What needs a different approach under mutter

1. **Catch the app's window at `CreateNotify`** (XRes pid, server grab, override-redirect, reparent
   into Electron). Do not let mutter manage it first: that costs a ~0.4 s visible window, a list
   entry and a focus steal.
2. If a window does get managed (a late or unexpected top-level), **wait for mutter to hand it
   back** before reparenting, or mutter will move it back to the root later.
3. **Key per-window state by launch, not XID**: XIDs are reused across app restarts.
4. **Decide the redirect policy**: always redirected while parked lets animations run. See 4(a)/(b).

The guard itself needed no change for mutter.

## Safety and cleanup

- **Input.** Synthetic input was XTEST pointer and key events, not `xdotool --window` /
  `XSendEvent`. Sent events bypass passive grabs and X focus, so they cannot test the guard. To keep
  the input on the spike's own windows, `drive.py` checked before every press that the window under
  the pointer (`XQueryPointer` on the root, which follows stacking and input shapes) was the spike's
  frame. Before every key it checked that X focus was Electron or inside it, and that
  `_NET_ACTIVE_WINDOW` was the spike. Any failure would have aborted before acting; none happened.
  Pointer moves are absolute warps, so the pointer never passed over another window.
- **Pointer.** Recorded with `xdotool getmouselocation` at 00:35:29.456: (1109,1141). Restored with
  `xdotool mousemove` at 00:36:36.846 and read back: (1109,1141), RESTORED.
- **Clipboard.** It held an image (`image/png`, 69,706 bytes). It was saved to a mode-600 file, not
  read or printed. The test briefly put its own strings there; a sentinel was set first so a failed
  copy could never record your text. Afterwards it was put back with `xclip -t image/png`, kept by
  mutter after xclip exited, compared byte for byte (RESTORED), and the file shredded. Only the
  `image/png` form was restored; any other formats the original owner offered are gone.
- **Active window.** `0x320000a` before and after (mutter returned focus to it).
- **App settings.** Scratch `XDG_CONFIG/DATA/CACHE/STATE` under `/tmp/lm-xdg-<label>`, Electron
  `userData` under `/tmp/lm-home`. Both deleted afterwards. `~/.config/photocraft` and
  `~/.config/gridcraft` were not used. No `--help` or unknown flags were passed.
- **Stopped.** The spike's Electron, both apps (each in its own `nd-<app>-<pid>` systemd scope),
  both MCP bridges and both `xdock.py` helpers. Afterwards: no process carrying this run's scratch
  environment, `systemctl --user list-units 'nd-*' --all` empty, nothing listening on 47711/47712.
- **Rehearsal display.** Xvfb `:93` with `dbus-run-session gnome-shell --x11 --replace`, HOME and
  `XDG_*` under `/tmp/lm-home`. It started about 30 helpers (gvfs, evolution, ibus, portals).
  Their two FUSE mounts were unmounted and every process with that HOME was stopped (count 0
  afterwards). Xvfb `:93` was stopped.
- **Not touched.** Rocket windows, other workers' displays (`:92`, `:94`, `:99`), the original
  spike files in `..`. Only `live-mutter/` was written.

## Files and how to rerun

`live-mutter/`: `main.js`, `xdock.py`, `index.html`, `ctl.mjs` and `gridui.py` are copies of the
spike's. `main.js` adds scratch `userData`, a window position and `open({app, early})`. `xdock.py`
adds the root watcher and early catch (`op_watch`, `op_expect`, `op_events`, `op_client_list`,
`op_toplevel`, `op_activate`, `op_wm_state`), plus the two fixes above. Also `drive.py` (the
guarded test sequence), `live.sh` (one block: record, run, quit, verify, restore) and
`package.json`.

```sh
# rehearsal on a private gnome-shell (needs the scratch HOME; see "Safety and cleanup")
Xvfb :93 -screen 0 1920x1080x24 -nolisten tcp &
env -i PATH=/usr/bin:/bin HOME=/tmp/lm-home XDG_RUNTIME_DIR=/tmp/lm-home/run DISPLAY=:93 \
  XDG_SESSION_TYPE=x11 dbus-run-session -- gnome-shell --x11 --replace &
DISPLAY=:93 SPIKE_X=100 SPIKE_Y=60 ./live.sh rehearsal
# live
DISPLAY=:1 SPIKE_X=200 SPIKE_Y=80 ./live.sh live
```

Results: `run/drive-<label>.json` (every step, the watcher timelines), `run/live-<label>.log`,
`shots/<label>/`, `shots/live-contact-sheet.png`.

## Still open

- Pressing Alt-Tab and Super for real (the property-based reading above is what they use, but the
  keys themselves were not pressed).
- IME and drag-and-drop from a file manager into a docked app: still untested, as in the first
  spike.
- The redirect-on-demand option in 4(b): first-frame time after redirecting a parked app.
