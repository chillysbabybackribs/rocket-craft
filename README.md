# Craft Studio

Craft Studio is a copy of Rocket Orchestrator that will host open-source creative apps beside its
chat: the chat on the left, and on the right one of an installed Craft app, the browser, the
library, or the app shelf. It runs beside the user's Rocket apps without sharing a profile, port,
lock or environment variable with them.

## The right side and the dock

The agreed UI is `docs/mockups/craft-studio.html`. The chat column is on the left; the right side
(`App.tsx`'s `RightSide`, styles in `craft.css`) shows exactly one of an installed app
(`CraftAppPanel.tsx`), the shelf (`Shelf.tsx`), the browser or the library, chosen by `side` in
`store.ts`. A file a link opens, a turn's changes and the orchestrator's progress view still open
in the artifact panel, over whatever the side shows, until closed. Under the right side the dock
(`Dock.tsx`) holds the installed apps (icon and short name, in install order; a bar on the shown
one; a green dot while it runs; an app installing sits there dimmed with its progress), then
**+ Add** for the shelf, a divider, and the Browser and Library toggles. Toggling the browser or
library off returns to the last app, else the shelf. Labels sit under the icons and nothing opens
upward, because a docked app window paints over anything drawn across it. A first run, with no
saved side, opens on the shelf.

The shelf lists every app with its "like …" name, description and size, and Install, Open and
Remove (Remove asks first when the app is running) or the install's progress; a failed install
shows main's full-sentence error with Retry. Installing and removing are only the user's: the app
map has `app {id}`, `shelf`, `app.show` and `shelf.open`, and no install or remove.

The renderer talks to main through `window.craft` (`CraftBridge` in `src/shared/types.ts`, read
through `src/renderer/src/craft.ts`): `catalog`, `install`, `remove`, `show(id, bounds, folder)`,
`setBounds`, `hide` and `onState`. The app region sends its window-content-relative bounds in CSS
pixels (main multiplies by the display's scale and the page zoom) with `show` on its first layout,
along with the chat's folder, `setBounds` on every later change, and `hide` when it leaves
(shelf, browser, library, a file shown over it, or an image preview open). `studio_ui_where`
lists every app's install and run state under `craft`. `tests/ui/craft-dock.spec.ts` checks the
whole flow against a fake bridge (`tests/ui/craft-fake.ts`, installed as `window.__craftFake` by an
init script, which the renderer prefers over the preload's). `tests/ui/craft-real.spec.ts`
installs the real PhotoCraft into a scratch apps folder, shows it and checks its X window sits on
the region's edges; it downloads about 80 MB, so it runs only with `CRAFT_UI_REAL_APPS=1`.

The worker board stays in the left column, drawn only while the chat owns a run. A run splits
the window in half, so at 1360px the orchestrator column and one board column fit beside the
right side; the leader's open plan, or a narrower window, folds the board to its rail of status
counts, which opens the board over the chat. The run's
head in the chat column keeps its Progress link, which opens the progress view on the right side.
Rocket's tool ledger panel (Tools) was dropped from the UI and the map; the ledger and
`studio_tool_review` still work.

## The Craft apps: install, dock and processes

Main owns the apps (`src/main/craft-*.ts`); the renderer only asks through `window.craft`
(`CraftBridge` in `src/shared/types.ts`, exposed by the preload). `show(id, bounds, folder?)` takes
the chat's folder as an optional third argument: an app started then may read and write only there,
where the app supports it (PhotoCraft and VectorCraft). A new `onState` listener first gets every
app's current state. A capture-phase `pointerdown` on the page (in the preload) gives the keyboard
back to the page when a docked app had it.

- **Manifest** (`src/shared/craft-apps.ts`): the 12 apps, each pinned to a release (tag, tar.gz,
  size, SHA-256) and with its own control, token, roots and MCP-bridge flags, read from each app's
  source at that tag. The file's header lists every app's quirks with the version and date.
  `npm run craft:manifest` compares it with GitHub.
- **Install** (`craft-install.ts`): only from the UI's IPC, never from model tools. The pinned
  tar.gz and `SHA256SUMS.txt` are fetched over HTTPS; the archive must match both the list and the
  pinned hash (a release republished under the same tag is refused), its members must stay in its
  one folder, and its links inside it. It unpacks to `~/.local/share/craft-studio/apps/<id>/<version>/`
  (`$XDG_DATA_HOME` honoured; `CRAFT_APPS_DIR` replaces the whole `craft-studio` folder, for tests).
  A marker file is written last; the profile's `craft-apps.json` records which apps this profile
  installed. Remove deletes the unpacked app only; the app's settings (`settings/<id>`) and the
  user's documents stay.
- **Processes** (`craft-launch.ts`): an app starts on its first show (or a model's first call) in its
  own `systemd-run --user --scope` unit `craft-studio-<id>-<pid>-<n>`, with a free loopback control
  port (PdfCraft: a control file), a 0600 token file where the app takes one, private XDG folders
  under `settings/<id>`, and no `WAYLAND_DISPLAY`. Nothing ever closes an app except the user
  (Remove, or the app's own close) and Craft Studio quitting, which stops every scope (SIGTERM, then
  SIGKILL after 3 s) before the agent host.
- **States** (`craft-dock.ts`): shown (no limits), working (hidden, used in the last two minutes:
  `CPUWeight=50`), resting (hidden and idle two minutes: `MemoryHigh=64M`, `CPUWeight=5`; under
  memory pressure, `/proc/pressure/memory` some avg10 above 10, `32M` and `1`). Limits are lifted
  before an app is shown or called. A parked app is Composite-redirected while working (it keeps
  drawing, so a model's screenshot works) and unredirected when it rests (it then draws nothing,
  animations included); `touch(id)` redirects it again before a model's call.
- **Docking** (`craft-dock/x11-helper.ts`, a utility process built as `out/main/craft-x11.js`,
  pure Node on the `x11` package): it watches the root for `CreateNotify`, asks X-Resource which
  process made the window, and if it is the launch (its pid, a child, or anything in its scope)
  makes the window override-redirect and reparents it into Craft Studio's window under a server
  grab, before the app maps it, so the window manager never sees it. A window managed anyway is
  withdrawn and reparented only after the WM hands it back. Parked windows are moved out of view,
  never unmapped. The focus guard (an InputOnly shield per app, keys forwarded to Electron, a
  synchronous click grab replayed to the app, FocusIn redirected back to the app) runs in the same
  process, so a busy main process never freezes the pointer.

### Models drive the apps

One fixed tool set drives all twelve apps, the app named in every call, so a model's prompt costs
the same with one app installed or twelve (`src/host/tools/craft.ts`): `craft_apps` (all twelve
with installed, running and shown state and each running app's document), `craft_show`,
`craft_commands {app, search?, offset?}`, `craft_run {app, command, params?}`,
`craft_batch {app, steps[], stop_on_error?}`, `craft_inspect {app, what?}`, `craft_open {app, path}`,
`craft_save {app, path?, format?}` and `craft_screenshot {app, maxWidth?}`. Leaders, ordinary chats
and workers all get them. Models never install or remove apps: a call to an app that is not
installed is refused with a sentence telling the model to ask the user, who installs from the shelf.

- **Every call** asks main to `touch` the app (`CraftAgentOp` over the host-to-main channel,
  `CraftStudio.agentOp`): main refuses an app that is not installed, starts one that is not running
  parked (confined to the calling chat's folder where the app supports it), lifts a resting app's
  limits and redirects it so it draws, and answers how to reach its control channel. The host then
  talks to the app itself over loopback (`craft-client.ts`), so a slow app never holds up main.
- **Transport:** each app's own control channel, never its CLI's `mcp --bridge/--connect` server
  (one more process per app, and PdfCraft has none). One connection per running app, kept between
  calls and replaced when the app is started again; one call at a time per app (a batch is one
  turn), so two models never interleave in one document. A connection the app dropped while idle
  (PhotoCraft: 30 s) is replaced before the next call, and a request lost to such a close is sent
  once more. A just-started app is docked before it listens, so a refused connection is retried for
  up to 15 s. Timeouts (90 s for a command, 30 s for reads and screenshots, 120 s for files) end in
  a sentence telling the model to inspect before trying again.
- **What differs per app** is one table, `craft-adapters.ts`: framing (JSON lines, or JSON-RPC 2.0
  for PdfCraft), sign-in (PhotoCraft's token, WordCraft's key file, PdfCraft's control file), how a
  command runs, which method inspects, where the document's name and file are, how files open,
  save and export, whether paths must stay in the app's folder, how screenshots come back (inline
  base64 or a file), which control methods `craft_run` may call by name, and what it refuses:
  quitting, resizing or raising the window, `app.open`/`app.save` (use `craft_open`/`craft_save`),
  and commands that would open a native file or print dialog. A save without a path is refused
  where the app would ask with a dialog for a never-saved document. The table's header lists each
  app's quirks with the version and date read, and which apps were run against it.
- **Screenshots** are the app's own `ui.screenshot`, which works while it is parked (redirected),
  scaled in the host to 1024 px wide unless the model asks otherwise (`src/host/png.ts`).
- **Ahead of each message** (`craftSituation`, all roles) one `<craft-apps>` line says which apps
  are installed, which is shown, which are running and the shown app's document. It never starts,
  lifts or waits for an app: a resting app is not asked, and the document is dropped after 1.5 s.

`npm run craft:tools-e2e -- <evidence dir> [--display=:94] [--keep-apps=<dir>]` checks the tools the
way a provider calls them (`tools/call` on the MCP channel, under a chat made by one UI-test
message) against real GridCraft and PhotoCraft on a private Xvfb display.

`npm run craft:e2e -- <evidence dir> [--wm=openbox|mutter] [--rest]` builds Craft Studio into a temp
folder and checks all of this on a private Xvfb display with real downloads, in UI-test mode (no
real model can receive anything typed there). Never point it at your own display: it clicks and
types.

## What this is

- Direction and phases: `docs/craft-studio-own-apps-plan.md`.
- Measurements, resource states (systemd scopes for hidden apps) and install on demand:
  `docs/craft-studio-performance-plan.md`.
- Per-app notes and licences: `docs/craft-studio-plan.md`. Agreed UI: `docs/mockups/craft-studio.html`.

**Built so far:** Rocket Orchestrator renamed and isolated (Phase 1); Phase 2: the app
manager behind `window.craft` (main and the preload) and the right side's dock, shelf and app
region (see "The right side and the dock" below); Phase 3: the model tool set that drives any
installed app (see "Models drive the apps" above). The rest of this README describes the Rocket base.
Other `docs/` files cited below (mockups, plans) were not copied; they are in Rocket
Orchestrator's repository, `~/Desktop/rocket-orchestrator/docs/`.

### Running beside Rocket

- The profile is `~/.config/Craft Studio` (Electron's `userData`, from `productName`). The
  single-instance lock, `live-port.json`, the tool server's port and secret, `rocket.db`, the
  journal and the browser's cookies all live in it.
- Environment variables use the `CRAFT_` prefix. The launch scripts and the main process drop any
  `ROCKET_*` they inherit (a shell inside a Rocket chat carries Rocket's `ROCKET_DATA_DIR`), so
  neither the app nor its providers can reach Rocket's profile.
- The window's X11 class is `craft-studio` (from the package name).
- The MCP tool server is named `craft-studio`, so tools reach models as `mcp__craft-studio__…`, and
  Antigravity's global MCP entry does not overwrite Rocket's `rocket` entry. The app's own tools
  are `studio_*` (`studio_ui_where`, `studio_check`, …).
- The `check:ui` slot pool under `/tmp/rocket-ui-slots/` is shared with Rocket on purpose: it
  is one CPU budget for one machine.

One chat, many agents: the app owns the conversation and an embedded browser, and lends each
message to whichever provider you pick: Claude, Codex, Cursor or Antigravity. You can switch
provider on every message; they all share the same chat.

## Run

```sh
npm install
npm run dev        # development, with rebuild on change
npm run preview    # production build, then launch
npm test           # unit tests, beside the files they test
npm run check:ui   # build, unit tests, then the isolated desktop self-check
npm run open -- docs/mockups/craft-studio.html   # open a file or URL inside the running app
```

A shell started from a Rocket chat has `NODE_ENV=production`, which makes `npm install` skip the
dev dependencies (TypeScript, electron-vite, Playwright). Use `npm ci --include=dev` there.

Craft Studio runs one instance per profile. `npm run open -- <path or URL>` hands its argument to the
running app, which opens it as a chat link would: a page or HTML file in a browser tab, a text
file in the artifact panel. With no app running it starts one. Mockups and reports made for you
by an assistant belong here, not in an outside browser.

Each provider runs through its own CLI, signed in with your own account. Install and sign in to
the ones you want: `claude`, `codex`, `cursor-agent`, `agy`.

### Linux sandbox

Chromium's sandbox needs its helper to be owned by root with mode `4755`. Electron updates
can replace that helper and reset its permissions. `npm run dev`, `npm run preview`, and
`npm run open` check it before launching and automatically repair it using `sudo -n` when
passwordless sudo is available. Correct permissions require no sudo calls.

If automatic repair is unavailable, the launcher prints these manual repair commands:

```sh
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

`CRAFT_NO_SANDBOX=1 npm run dev` starts without the sandbox instead. Use that only for a quick
look: the embedded browser then renders web pages unsandboxed.

## How it fits together

```
renderer (React)  ⇄ MessagePort ⇄  agent host (utility process)  ⇄  provider CLIs
        │                               └─ SQLite transcript
        └─ ipc ─ main (window, browser tabs)
```

- **Main** (`src/main`) owns the window and the browser view, forks the agent host, and hands the
  renderer a MessagePort to it. Chat traffic never passes through main.
- **Agent host** (`src/host`) owns the transcript (`store.ts`), decides what each provider is told
  (`hub.ts`, `handoff.ts`), and runs one adapter per provider (`providers/`).
- **Renderer** (`src/renderer`) subscribes per transcript row, so a token stream re-renders one
  row. The host batches events to one message per frame.

### Continuous orchestration

Ask a chat to run a continuous task with the `orchestrator` tool. That chat assigns fresh workers,
reviews their evidence, and chooses deeper follow-ups with an optional model per worker. The `models`
action lists live provider IDs and defaults; dispatch validates explicit IDs and reports discovery
failures before falling back to the provider default. Cursor usually uses Composer 2.5, Claude uses
Haiku 5.5 for easy tasks and stronger models when warranted, and Codex models are the orchestrator’s
choice. Each assignment names the chosen model and why; the choice persists through queued starts
and restarts. Leader review turns keep the provider default. At startup the host sets how many
workers may run at once from this machine (one per CPU core and one per 0.75 GB of available memory,
at least one); leader prompts and orchestrator `status` include that limit. Per provider, Claude,
Codex, and Cursor may run up to six at once; Antigravity stays at one (shared tool connection).
Any number of workers can be dispatched; excess waits in a FIFO queue per provider. Leader review
prompts and orchestrator `status` replies carry compact worker
rows (paths, status, a short result—not full assignments); use `detail` with a task id when the leader
needs the full dispatch text. When more than twenty workers need review, the newest twenty are listed
with a count and ids for the rest. The host keeps review turns continuing while `docs/orchestrator/<run-id>/progress.md` stays a terse run
document—full reviews beside each report, not pasted outcomes—which Craft Studio shows as the progress view
(Now, Needs you, Plan, Workers, Activity) whenever it opens. The user can change the plan there or in
the file: each change locks the step, and the orchestrator must acknowledge it before it dispatches
again. Message the chat or edit the file's User notes section to steer it. The orchestrator can `reply` to a worker (same paths as the worker-board reply box);
finished workers reopen for another turn and must be reviewed again. Workers are told to stop
background watchers and not wait on answers. Workers cannot ask the user or control the live shell;
assigned UI verification uses isolated checks. Assumptions and blockers go in the report and the orchestrator can
correct them. If a worker's report is written but its turn stays open only because background tasks
run, the host ends it after three minutes so the run cannot hang. Stop remains available while
workers run. The run head offers Wrap up while running or paused: it cancels queued assignments,
lets active workers finish and requests the final review. Resume appears only while paused, beside
a reason banner. Interrupted runs pause for explicit resume after a restart. Background worker
terminal events and missing-checkpoint review pauses notify through the native desktop service;
startup/reconnect snapshots and cancelled queued workers stay silent. Code workers (Claude, Codex,
Cursor) each edit in their own git worktree under the profile's `worktrees/`, made from the main folder when they start; the
leader passes `worktree: false` for read-only research, and Antigravity always works in the main
folder. A review's `verdict: accept` merges the work into the main folder as one commit, after
typecheck and unit tests pass on the merged result; `reject` discards it. A refused merge comes back
in the next review with its files, for a fix-up worker dispatched with `fixes`. The progress view and
each worker window show the merge state (Merge queued, Merging…, Merged with the short commit,
Refused with its reason, Discarded). Run folders are committed by the host when a task is reviewed,
never by another turn's commit. Lifecycle, refusals, restart recovery and the UI-test switches are in
[the orchestration guide](docs/orchestrator.md#code-workers-in-worktrees), which also covers actions and validation.

### Switching providers

The app's SQLite log is the conversation. Each provider's own session is a cache of the part it
has seen: per chat and provider, the store keeps the session id and the last turn that session
contains. A message to a provider resumes its session and hands over only the turns after that
mark; the handoff names the files those turns read and edited, so the next provider need not search
for them. Codex receives them as real history (`thread/inject_items`); the other three receive a
tagged block in front of the message. If a provider has lost its session, it gets a new one and
the whole conversation.

A handoff stays in the receiving session's history, read again with every later message, so it
carries what each turn concluded and not how it got there (`handoff.ts`): the user's words, the
reply after the turn's last tool call (the narration between calls is left out), and the files it
touched. The newest three turns go whole with a line per other tool call; older ones keep their
files and the head and tail of their request and reply. The whole block is held to 30,000
characters, cutting the middle of the longest older replies first and, for a history too long to
fit even cut down, leaving out the oldest turns with a line saying how many. The missed turns and
their items are read in one query (`turnsWithItems`), so a full replay of a long chat stays fast.

What a session is told once (the git rules, the workspace map) goes to it when it starts, not
again when a session is resumed after the app restarts. The browser research guidance is in
`browser_read`'s description, which every session has, so it is not repeated ahead of a message.

### Tokens

Each turn keeps what it cost (`Turn.tokens`): input tokens across its model calls with how many
came from the prompt cache, output tokens, and `context`, the input of its last call, which is how
full the session is. Claude reports them in its `result` and `message_start` events, Codex in
`thread/tokenUsage/updated`. Cursor's agent sends no usage over ACP and Antigravity's stream has
shown only thinking counts, so their turns carry none. The readings go into the journal with each
turn's timing, and `studio_diagnostics` summarizes them per provider and model.

### The orchestrator shell

Craft Studio is laid out around one run (`docs/mockups/orchestrator-shell.html`,
`src/renderer/src/components/OrchestratorShell.tsx`, `orchestrator.css`). On the left, full height
below the title strip, is the orchestrator's chat: pane 0, the only pane. At start it shows the chat owning a running orchestration when its own
chat owns none. Without a run the chat has the left side alone. With one, a divider resizes it (min 340px, since the right side is always shown; double-click resets to 40%). On its right, the
worker board has one small window per task of the run that chat owns, with no cap: running first,
then queued, then finished, newest first, filtered All / Running / Done, and the board scrolls.
Each window is the worker chat's real transcript drawn read-only through `ShownChatContext`
(compact CSS), loaded with `loadWorkerChat` and kept live by the usual events (`pruneViews` keeps
the board's worker chats), with the provider, a status dot, the task's first line, elapsed time,
and Expand, Stop and Open report. The assignment the run sent (the `<rocket-orchestration>`
message, recognised by the task's `turnId`, else by its marker line and task text, through
`WorkerShownContext` in `pane.ts`) is one "Assignment" line in a window, with the whole text as
its tooltip, and sits behind "Show assignment" when expanded; a window also drops the turn's own
"Working for" head, since its own head has the clock. A queued window says which provider's slot
it waits for and its place in that provider's queue. Expand shows the worker over the board with a
reply box that sends to that worker's chat with its dispatched provider (disabled while it is
queued, as the host refuses it); Esc closes it, and ← / → (also with an empty reply box focused)
or the Previous / Next worker buttons step through the board's order. Stop on a queued or running
worker calls `orchestrator.cancelTask`, so the run records it (a queued one is cancelled and never
starts; a running one stays running until its provider's turn ends); on a finished worker running a
reply it calls `chat.stop`. An interrupted worker the user stopped reads as cancelled. Open report
opens the report in the artifact panel. The worker's changed-files line opens its own turn diff
through `openTurnChanges(chatId, turnId)` using the shown chat. The plan drawer belongs to its
chat: the leader's stays in its column and the worker's in its expanded view. Both use
`components/Split.tsx`, with its width clamped in `styles.css` so it never clips. With a side panel open the orchestrator column's minimum
drops to 340px and the board's to 300px (one column); if those still do not fit, the board folds to
a rail of status counts which, clicked, lays the board over the shell (Esc folds it), never over
the side panel. The board's state (`board` in `store.ts`) is in the app map: `worker.expand`,
`worker.collapse`, `worker.next`, `worker.previous`, `run.wrapUp` and `run.resume`, and `studio_ui_where` lists the workers
under `board`. The test ids (`orch-shell`, `orchestrator-chat`, `worker-board`, `worker-window`
with `data-chat-id` and `data-status`, `worker-expanded`, `worker-board-empty`, and `worker-rail`)
are relied on by `tests/ui/orchestra-shell.spec.ts`.

The run head offers **Wrap up** while running or paused and **Resume** only while paused.
Wrap up cancels queued assignments, lets active workers finish, and requests the final review;
Resume clears the pause reason and continues the run. A paused run shows its reason beneath the
head. Both controls use `run.wrapUp` / `run.resume` in the app map, backed by guarded run-ID RPCs
`orchestrator.wrapUp` / `orchestrator.resume`. Refusals appear beneath that run's head. The map's
`board.run` includes its ID, reason, available controls and pending action. Composer and worker
Stop retain their existing behavior.

Background worker terminal transitions and reviews ending without a checkpoint submit native
desktop notifications. Startup and reconnect snapshots stay silent, as do cancelled queued tasks.
Main validates destinations and suppresses duplicates and foreground notices. Clicking opens the
owner chat: a worker opens expanded with All selected; a pause focuses the run head and folds the
board overlay. The artifact panel stays open. Deleted targets show a no-longer-available sentence.
Delivery depends on OS support and desktop notification settings; a submitted notice does not
guarantee a visible toast. The isolated UI fixture checks submissions and click routing with a fake
native factory, rather than a desktop notification daemon.

### The orchestrator chat column

The column is one whole chat with its own tabs, transcript, composer, folder and model. The
toolbar's Chats menu opens chats there, Ctrl+1–4 picks its provider for the next message, and its
chat is the one marked in the history. Closing the last tab leaves the new-chat screen. The tabs
and the open chat come back after a restart; a profile saved with several panes, or from before
panes, restores its first one.

In the renderer (`src/renderer/src/store.ts`) `panes` holds that single entry and `views`, keyed
by chat, holds what a shown chat has loaded, so the column and the worker board share one copy of
a chat. The components inside the column read their chat through `PaneContext` (`pane.ts`); a
worker drawn on the board is not a second pane but a chat shown through `ShownChatContext`.

### The title strip

There is no rail: the chat card starts at the window's left edge. The 48px strip above the cards
(`TitleStrip.tsx`, design in `docs/mockups/usage-in-titlebar.html`) holds the window lights and the
toolbar at its start, and the usage notch at its centre: a tab hanging from the window's top edge
with one ring per provider and its percentage beside it. The strip's two outer columns share the
width equally, so the notch stays at the window's centre until the toolbar outgrows its half, and
then moves right rather than covering it. Hovering a ring opens its flyout (each limit, when it
resets, and a refresh button) below the notch, pulled left to end inside the chat card for the same
reason as the toolbar's menus. The strip is the window's drag handle wherever no control sits.

### The toolbar

The toolbar in the title strip (`Toolbar.tsx`) is one button, Chats, which opens the list of every
chat. Rocket's Sections drawer and Customize are gone: Browser and Library are dock toggles, and
Tools was dropped. The menu is pulled left to end inside the chat card, since the browser's page
and a docked app are native views that would paint over it.

### Images and files in chat

Paste a screenshot into the message field, choose **Attach files**, or drop files anywhere in
the chat column. A thumbnail tray keeps images beside the draft; click a thumbnail to
enlarge it, remove it with its cross, or drag it onto the chat column to copy it there. Images may
be sent without text. In the transcript, attachments sit above a separate prompt bubble;
image-only messages have no empty text bubble. Attaching never sends automatically. PNG, JPEG, WebP and GIF are accepted,
up to 5 MB each, 8000 pixels per side, 32 megapixels, and ten images totaling 20 MB per message.

Craft Studio copies image bytes and thumbnails into its profile's `attachments/` directory and keeps
metadata in SQLite. Draft references and text survive restarts in renderer preferences; sent
and queued references live in SQLite. The existing MessagePort carries imports directly to the
host. Original files may be moved after importing. Unreferenced images older than a day are
collected when the renderer reconnects, preserving images still in drafts, queues or transcripts.

Image messages wait for the active turn to finish, including with providers that support text
steering. **Edit** and **Stop** restore the whole message. Queues recovered after a restart stay
visible until sent or edited. Claude receives image content blocks, Codex receives local image
paths, and Cursor receives ACP image blocks only when its handshake advertises support.
Antigravity image submission is not supported yet. Provider
image formats have unit coverage and documented contracts; real image model turns have not yet
been exercised. Switching providers or recovering a lost session carries image references in
the handoff, sends current and recent images within the message budget, and supplies stored
file paths for older images. Image files must remain available to the local provider processes.

PDFs and text or code files use the same paperclip, paste and drop, and sit in the same row as
images, as cards with a document mark, name, type and size (`docs/mockups/file-attachments.html`).
Clicking a card opens it in the side panel: text as text, a PDF as its first 12 pages rendered to
images. The host decides what a file is from its bytes, not its name or MIME label: `%PDF-` makes
a PDF, UTF-8 without NUL bytes makes text, and anything else is refused with a message saying so.
Each file may be up to 25 MB, files together up to 50 MB per message, and ten attachments of any
kind per message. PDFs are read with poppler-utils (`pdfinfo`, `pdftotext`, `pdftoppm`) outside
the app; a password-protected or damaged PDF is refused at import with what to do, and nothing in
a file is rendered as a page or executed. The stored copy keeps its extension, a PDF's extracted
text sits beside it as `<id>.extracted.txt`, and its preview pages in `<id>.pages/`.

Every provider receives files the same way (`src/host/providers/images.ts`): the message names
each file with its stored path, and the text (a PDF's extracted text) follows inside `<file>`
blocks, up to 60,000 characters a file and 120,000 a message, current files first. Past the
budget, or for a PDF with no text (likely scanned), the model is told to read the stored file.
Because files travel as text, Antigravity takes them, though not images. No provider's native
document input is relied on yet.

Every attachment, in a draft, a waiting message or a sent one, has a ⋯ menu (also right-click,
Shift+F10 or the context-menu key; `components/AttachmentMenu.tsx`, agreed in
`docs/mockups/attachment-reuse.html`). **Copy to chat** lists the open chat,
then recent chats with a search, and appends the attachment to that chat's draft, keeping its
text and files; nothing is sent, the card is highlighted briefly, and a notice offers Undo.
Dragging an attachment from a worker's window onto the column does the same, with a drop target that names the
chat. A copy is the same stored file referenced twice, so deleting the source chat leaves it
working: collection keeps every attachment a draft, queue or transcript still names. **Save as**
opens the system save dialog in main and the host copies the stored original there byte for
byte. **Reveal stored file** shows the host's copy in the file manager under its stored name
(`<id>.<ext>`); main refuses any path outside the profile's `attachments/` folder.

The camera beside the paperclip (`components/Capture.tsx`, agreed in
`docs/mockups/screen-capture.html`) captures into that composer's draft: **Browser page** (the
visible part of the current tab), **Craft Studio window**, **Another app's window…** (a picker of every
open window and screen with previews), **Entire screen** (the one under the pointer) or **Select a
region…**. Main does the capturing (`src/main/capture.ts`). Windows and screens come from
Electron's `desktopCapturer`, which on X11 lists them all and returns a window at its own size;
Craft Studio finds itself there by `getMediaSourceId()`, so its capture includes the native browser view.
With PipeWire (Wayland) `desktopCapturer` returns only the one source picked in the system dialog.
A region hides Craft Studio, freezes the screen under the pointer into a frameless window of its own
(sandboxed, no Node, reporting its selection through its title) and crops source pixels from the
drag. Every capture opens a review dialog with a pen (red, yellow, blue, white), an eraser that
removes paint only, and Clear; the drawing is flattened into the image at the capture's resolution.
Add to draft imports it like any image (PNG, or JPEG when a busy screen is over the 5 MB image
limit) with a notice offering Undo; Retake and Cancel change nothing, and nothing is sent. The
destination is fixed when the camera is pressed, so switching chats meanwhile does not
redirect it.

### Library

The dock's Library toggle opens every file the chats have touched, on the right side
(`components/LibraryPanel.tsx`, agreed in `docs/mockups/document-library.html`; the plan is
`docs/library-plan.md`). Four sources fill it, and nothing else on the disk is listed:
attachments a chat has sent (a draft's are not on the shelf until sent), files a model downloaded
with the browser (indexed when the turn ends, from main's record of the chat's downloads), Markdown
files a turn wrote (from the turn's changed files), and files opened from a chat (a link or
`npm run open`). Attachments are read live from the store; the others are rows in `library_files`,
keyed by path, so a file keeps the source it first arrived with.
On the first start with a library, the Markdown files earlier turns wrote are added once from the
turn patches the store kept, each dated by the last turn that wrote it; files since deleted are
skipped.

The panel is a filter rail (source, kind, chat, added; each option shows how many files choosing
it would leave) and a search over names, folders, paths and chat titles, then a grid or a list.
Cards show real previews made by the host (`src/host/library.ts`): a PDF's first page from
`pdftoppm`, a picture's thumbnail (the attachment's own, or ImageMagick's for a download), the
start of a text or Markdown file set as a small page, and an Office file's embedded thumbnail
when it carries one. Previews are cached under the profile's `library-previews/` by path, size
and time, at most two are made at once, and a card asks for its picture only as it scrolls near.
A missing tool or a failed preview leaves the card's type mark. A file that has moved shows as
missing. Clicking a card opens it in the side panel (text, rendered Markdown, a PDF's first 12
pages, or the picture) with **Library** to go back; the grid outlines the card last opened.

Filters, search and opening a file go through the app map (`library` place with the filters as
parameters, `library.clear`, `library.open`), and `library_list` (`src/host/tools/library.ts`) lists
the same shelf with the same filters (`src/shared/library.ts`), so a model and the user see one
answer. Viewers that a model can mark (PDF.js, CodeMirror 6) come in the plan's next slices.

### Messages sent while a turn runs

The composer stays open while a turn runs; Esc or the Stop button beside Send stops it. A message
to the provider that is answering joins its turn (`Hub.post`, `ProviderAdapter.steer`): Claude
Code gets it as a streamed user message with priority `next`, Codex through `turn/steer`. The
message is wrapped in an instruction to carry on without acknowledging it, so no "Got it" reply.
The model reads it only at its next step, which can be many seconds away, so until then it shows
dashed under the turn ("Claude reads this at its next step"). The adapter calls `steer`'s `taken`
callback when the model reads it: Claude Code echoes it (`--replay-user-messages`) and reports
`command_lifecycle` `started`; Codex reports a `userMessage` item. Only then is it stored as a
user item marked `steer` inside the same turn, at the point it was read, and the transcript splits
the turn there, folding the earlier steps into their own summary. Words a turn never said it read
are recorded in it when it ends, not sent again; a stopped turn dropped them, so Send now sends
them first and Stop returns them to the composer. Cursor and Antigravity cannot take
words mid-turn, and a message to a different provider must wait for the turn anyway: those queue
in the hub, show under the turn with Send now (stop, then send) and Edit (back to the composer),
and go out together as one message to the last picked provider when the turn ends. Stop returns
queued text to the composer instead of sending it. Answers to a question card in a plain chat go
through the same queue. Stop cancels a Claude message still queued inside Claude Code
(`interrupt({ cancelQueued: true })`), so it does not run as a turn of its own; only a CLI too old
to cancel it has its process retired instead, which ends its background work.

### Turns a provider starts by itself

Claude Code can start a turn with no message from the app: when a subagent or shell it ran in
the background finishes, it answers on its own. A turn whose reply ends while such tasks still
run is therefore held open: it keeps its working state, its head reads "Waiting for 2 background
tasks" instead of "Thinking" (`Turn.activity`, set through the sink and never stored), and the
follow-up lands in it (Stop ends the wait). A follow-up with no turn open,
after a restart for instance, gets a turn of its own through `onUnprompted` (`provider.ts`), with
a notice saying what finished. Before this, those replies were dropped. While background tasks are
live, the Claude Code process is not retired for idleness, since that would kill them.

### Browser

The browser panel has Chromium's tab strip and shortcuts (Ctrl+T, W, Shift+T, Tab, 1–9, L) and a
Safari-style address field. Each tab is a native view owned by main (`src/main/browser-pane.ts`);
only the active one is on screen. The address field's dropdown is a view of its own
(`browser-suggest.ts`, `src/renderer/suggest.html`) stacked above the page, so it overlays the
page and never moves it. Tabs, history and the last
session are kept in the profile folder.

Closing tabs keeps Craft Studio and its chats open; the last browser tab leaves one home tab.
Agent tab-close calls remove restored tabs without loading them or opening an extra agent tab,
and wait for native page cleanup before returning. Navigation and debugger traffic stop before
a loaded view closes. Every provider is told that only an explicit request to quit Craft Studio
authorizes closing the app or its process, including restarts after source edits.

Pages see an ordinary Chrome. Electron's default user agent adds `Craft Studio/<version>` and
`Electron/<version>`, and Chromium sets `navigator.webdriver` in every page when the remote
debugging port it is started with is 0 (`content/child/runtime_features.cc`); login pages read
both as a bot, and X locked logins out for a while after a model visited it. So the browser session's
user agent is Chrome's own (`plainUserAgent` in `src/main/browser-url.ts`, keeping the real Chrome
version), and main finds a free loopback port itself and passes it by number. The debugging port
is still only on loopback. After acquiring the single-instance lock, main publishes its PID and
port in the profile’s `live-port.json`; the live UI connection checks that PID and reads this
file instead of Chromium’s `DevToolsActivePort`, which other Electron launches can overwrite.
Opener launches hand off their argument without enabling remote debugging.

Client hints are the third tell. Electron has no client-hints delegate
(`ElectronBrowserContext::GetClientHintsControllerDelegate` returns null, Electron 44), so Chromium
never sends the `Sec-CH-UA` headers a real Chrome puts on every secure request, and
`navigator.userAgentData` carries a Chromium-only brand list; against a user agent that says Chrome,
both are inconsistencies a managed challenge (Cloudflare's "Just a moment…" on openai.com, for one)
picks up. `userAgentMetadata` (`browser-url.ts`) builds the metadata Chrome itself would send for
the bundled Chrome version, with Chrome's own algorithm for the GREASE brand and the brand order.
It reaches pages two ways, from the same metadata so they agree: the pane attaches each tab's
debugger as the tab is made and sets it with `Network.setUserAgentOverride`, which is what
`navigator.userAgentData` reads (opening DevTools detaches it; it is put back when they close); and
the session's `webRequest` adds the headers, the three low-entropy hints on every HTTPS request and
the high-entropy ones for an origin that asked with `Accept-CH`. `Critical-CH` restarts are not
emulated: such an origin gets its extra hints from the second request on. The fingerprint behind
this is in `docs/browser-realism-audit.md`.

Two more things ride on that per-tab debugger session. Electron leaves `window.chrome` an empty
object, where Chrome has `loadTimes`, `csi` and `app`; `chrome-object.ts` is the fill, read from the
installed Chrome 152 itself, run at document start in every frame through
`Page.addScriptToEvaluateOnNewDocument`. And the override's `acceptLanguage` is what gives
`navigator.languages` Chrome's `["en-US", "en"]` (Electron's own reading repeats "en"). Protocol
commands only land once a page has a renderer, and a new view has none until it navigates, so a new
tab loads a blank document first, then the real page with everything in place; the blank entry is
taken out of history as soon as the next page is in. A page's own synchronous read of a brand-new
iframe's `chrome` still sees it empty for an instant, since the fill is a script and Chrome's is
native. Notification permission is the one tell left as is: Electron's permission handlers are
yes/no, so a fresh site cannot be shown Chrome's "default" state.

Hands-free reading scrolls the page at a steady pace (the double chevron at the right of the
toolbar, or Alt+S; the design is `docs/mockups/reading-scroll.html`). While a tab reads, the
button opens into a pill (`ReadingControl.tsx`): play/pause in a ring that fills with the page,
a log-scale speed slider from ¼× to 8× (1× is 30 px/s; the maths is `src/shared/reading.ts`),
the speed with the time the rest of the page takes, and stop. The scrolling runs in the page, in an
isolated world of its own (`src/main/reading-scroll.ts`), so it moves every frame and sees the
reader's own input: the wheel, scrollbar and scroll keys move the page and reading carries on from
there half a second later, Space pauses, a click or typing pauses, and at the foot it waits a few
seconds for a feed to load more before it calls the page done. Main starts and stops it, pauses a
tab that leaves the screen, forgets it when the page navigates, takes Esc and Alt+↑/↓ (slower,
faster), and asks the page on screen for its progress four times a second. The speed is shared by
every tab and kept with the session in `browser-tabs.json`.

The file panel beside the chat has the same reading in its header, for whatever it shows: a plan
or other Markdown, a library document or PDF, an attachment, a turn's diff (`PanelReader.tsx`,
with the scrolling in `src/renderer/src/panel-reader.ts`, which mirrors the page's because it cannot
share its code). It scrolls the view's `.artifact-content`, takes the same keys while focus is in the
panel, and starts at rest for each new file. One speed serves both: the renderer keeps it in its
preferences and passes it to main, and a change main makes (Alt+↑/↓ in a page) comes back with the
browser's state.

Background tabs are hidden with `setVisible(false)`, so Chromium stops drawing them.
`CRAFT_BROWSER_HIDE=park npm run dev` moves them off screen instead, the older way, in case a
tab ever comes back blank; see the note in `src/main/browser-url.ts`.

The embedded browser can share the user's logged-in sessions from their own OS browser
(`src/main/cookie-import.ts`). On first launch, cookies from the default OS browser are copied into
the `persist:browser` session, which keeps them on disk, so the import survives restarts and runs
once (a `cookies-imported` marker in the profile records that it has). Later, the page's right-click
menu has **Import login cookies**, listing each detected browser with "This site" and "All sites".
Chrome, Chromium, Brave, Edge and Vivaldi are read from their profile's Cookies database and
decrypted with the key kept in the login keyring ("<Browser> Safe Storage", via `secret-tool`);
Firefox's `cookies.sqlite` is read as-is. Only the user's profile is read, never written, and the
database is copied before reading so a running browser cannot block it.
`tests/ui/page-menu.spec.ts` checks the page's menu offers the import whenever a browser is found.

The page's menu once also offered Fill with Craft Studio, which wrote a model's answer into a field.
It was removed; a profile's old `fill/` folder stays on disk and is no longer read.

Chat links open beside the conversation: HTTP(S) URLs and local HTML, images, PDFs, and media
open in a new browser tab. Text and source files open in a closable artifact preview; Markdown
renders as a document. Relative file links use the chat's working folder (or the containing
artifact's folder), and `:line` / `#Lline` references highlight the source line. Markdown links,
bare URLs, and recognizable file paths, including inline-code paths, are clickable. A folder opens
as a list of its entries, each a link in turn. Text previews are limited to 2 MB; missing files
and unsupported binary formats show an actionable error. Nothing opened from inside the app is
handed to a system app: the Tools view's capture links and any link that tries to open a new
window go through the same path as a chat link.

### Sources

Search results are leads. Craft Studio records pages only after usable content returns from a reader.
Navigation, a download alone, empty output, search pages and recognized access challenges do
not count as source evidence. Provider fetches with textual failures are marked failed even
when their protocol omits an error flag. Detection is conservative and heuristic: an opened
mark means readable content was returned, not that a claim is true. Historical records are
unchanged. The source record and citation notices are shared across all four providers.

### Tools

Craft Studio owns one tool registry. Each session receives the profile selected by its saved chat role,
and the host enforces that role on every call. The agent host keeps the tools in one registry (`src/host/tools/registry.ts`) and serves them over a single MCP server on loopback
(`channel.ts`), the one channel all four CLIs accept. Each session is given a URL that names its
chat. Antigravity is the exception: its MCP config is global, so the app registers itself there
as `craft-studio` (`agy mcp add`) and works out the chat from the turn that is running. Its CLI also
leaves MCP tools out of the model's prompt, so the adapter opens a new conversation's first
message with only the active chat's allowed tools, their arguments and how to call them. Shared
connections refuse lists and calls when there is no single active chat. Workers and unbound new
chats skip session warming, so an ordinary spare cannot advertise tools to a future worker.

Every provider receives shared `web_search` and `web_read` tools in addition to the four
browser tools (`src/host/tools/browser.ts`). Native search remains available. `web_search`
uses the app browser with Google/Bing fallback; it needs a live app browser and may encounter
engine challenges. `web_read` retrieves source text directly, extracts HTML with Readability,
extracts PDFs with installed `pdftotext`, and falls back to the browser for failed HTTP reads.
It also accepts downloaded PDF paths. It preserves extracted text on disk, supports pagination,
reports attempts and retrieval time, and bounds network downloads, time and output size.
It never sends source content through an intermediate model summarizer. Browser source gathering
and search are permitted recovery paths. Access challenges remain explicit failures; no bypass
or universal access is promised. These host changes require a restart and refreshed provider sessions.

`browser_read` returns a page as text with links, its controls with short refs, and
the data requests it made. `browser_screenshot` returns a tab as a small JPEG, for what text
cannot say. `browser_run` runs a
script the model writes against a small Playwright-shaped API (`tab.goto`, `tab.eval`,
`tab.click`, `tab.fill`, `tab.waitFor`, `browser.fetch`), so a whole task is one call; the script
runs in a worker thread of the host and each step is a request to main
(`src/main/browser-agent.ts`), which drives the tab over the DevTools protocol. A model works in tabs of its own, marked with a dot in the tab strip. Opening one or navigating it
to a URL switches the browser view to that tab so you can follow along; the page does not take
keyboard focus from the composer. The model touches your tabs only by id. The open tabs ride at the
head of the user's message when they have changed, so listing them costs no call. A page counts as
loaded when its document is ready, not when its last ad is. While a turn uses a tab, its page runs
at full speed even when concealed; when the turn ends it goes back to being an ordinary background
tab, and a deleted chat's own tab is closed.

`browser_download` saves a file with the user's sign-ins and no save dialog: a `url` (absolute or
relative to the tab's page) or a `click` target that starts the download. It waits for the file
(default 120 s, at most 600) and returns its path, size and type, or how far it got. Files go to
the user's Downloads folder unless `saveTo` names a folder or a file, relative paths starting in
the chat's working folder; an existing file is never overwritten (`report (1).pdf`). A click in
`browser_run` that starts a download is saved the same way and listed in the script's result.
Electron shows a save dialog whenever `will-download` does not set a save path, and a model cannot
answer one, so main (`src/main/browser-downloads.ts`) sets the path itself for any download from a
page a model is working in: its own tab, or a tab its running turn touched. A download you start
in a tab no model is using still opens the usual save dialog.

Craft Studio's Codex process disables the bundled `unified-computer-use`, `browser` and `chrome`
plugins through process-local configuration overrides, so `cua_repl` and the related browser
skills and hooks do not compete with Craft Studio's browser tools. The overrides apply to new and
resumed chats when that process starts; restart Craft Studio after updating to apply them. Native web
search and other plugins retain their configured settings, as do Codex sessions outside Craft Studio.

`studio_ui_snapshot` (`src/host/tools/ui-snapshot.ts`, `src/main/ui-snapshot.ts`) shows the
currently running Craft Studio window without clicking, switching tabs or changing focus. It returns
images directly to the model, visible shell control names and panel bounds, native view bounds,
and the running process, start time, app version and main bundle fingerprint. It captures the
composed window through ImageMagick on X11, including native browser pages and dropdowns; if
that is unavailable, it returns separate shell and native-view images with a warning that they
cannot verify overlap or stacking. Full-resolution PNGs and `snapshot.json` are retained under
`<profile>/ui-snapshots/`; images sent to the model are JPEGs limited to 1600 pixels wide.
Snapshots show the running instance, so source edits may still require a rebuild or reload.
This read-only tool is available to leader and ordinary chats across providers; workers do not
receive live-shell tools. It does not require self-check mode.

`studio_ui_run` drives the **live Craft Studio window by default**. It attaches to the running
Electron app through a Chromium debugging endpoint bound to loopback, identifies the shell
and visible native views by their target IDs, and disconnects after each script. It does
not build or launch another app. Actions affect the user's actual chats, drafts, history and
browser session. The same live window is shared by all chats and providers; one script runs
at a time. Restart Craft Studio after installing this change to enable the endpoint and new schema.

The tool accepts `code`, the body of an async function, with `page`, `ui`, `sleep` and
`console`. Await every action. `page.getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`,
`getByTestId` and CSS `locator` support locator chaining, clicks, filling, keys, hovering,
visibility waits and reads. Locator option names/text must be strings, not regular expressions.
Use DOM evaluation for inspection, never to mutate renderer state to manufacture a passing UI.
For example, to read the orchestrator composer (pane 0; an expanded worker has its own textbox):

```js
return await ui.pane(0).getByRole('textbox', { name: 'Message' }).inputValue()
```

`ui.surface('browser' | 'suggestions')` returns the page API for the currently visible native
view, including when multiple tabs have identical URLs. `ui.resize(width, height)` resizes
the live window (880×560 through 4000×2400); `ui.read()` returns shell controls and panels;
`ui.snapshot()` includes a capture in the result. A final snapshot is included by default;
`capture=false` skips it on success, while script failures still capture. Results include the
live process identity, logs and saved paths under `<profile>/ui-runs/`, with full-resolution
captures under `<profile>/ui-snapshots/`. Source edits require rebuilding and restarting the
live app. The default script timeout is 30 seconds (maximum 120). Scripts run in worker threads,
so an infinite loop can be stopped. Timeout disconnects automation and leaves Craft Studio open;
completed actions remain in the app. Live mode rejects `build`, `reset`, `close` and the
controlled-test helpers `ui.request()`, `ui.release()` and `ui.restart()`.

Use **`target: "isolated"` explicitly** for regression tests. This mode builds current source
into a private app folder under `.artifacts/ui-run/`, then launches Electron on a private Xvfb
display with a marked fresh profile, scratch workspace, controlled providers and the desktop
self-check network filter. Providers in the same chat share this isolated inspection session.
Select its scratch folder through the normal folder button before sending `UI check:` prompts.
`ui.request()` reads the latest controlled turn; `ui.release()` completes a held response or
plan; `ui.restart()` restarts its profile and build. Ordinary prompts fail instead of starting
real provider CLIs. Isolated resize limits are 880×560 through 2400×1400.

For isolated calls, `reset=true` discards the session and rebuilds; `build=false` uses the
existing `out/` build for a new session; `close=true` closes it without a script. Initial build
and startup have a separate three-minute deadline. Timeout discards the isolated session.
Four sessions may be open at once, idle sessions close after ten minutes, and chat deletion
and host shutdown close their sessions. Subprocess cleanup covers detached Electron descendants.
Captures, per-call JSON results, `runner.log` and traces remain in the session directory.

### The app map

The shell is finite, so a model navigates it by name rather than hunting for buttons in a
screenshot. `src/shared/app-map.ts` is a hand-written map of every **place** the shell can show
(`chat`, `app`, `shelf`, `browser`, `library`, `progress`, with the parameters a place takes, such as the
library's filters or the progress view's section) and every **action** a model can take (`chat.open`,
`app.show`, `shelf.open`, `library.open`, `worker.expand`, `plan.edit`, `need.answer` …), each naming the component
file that renders it. The renderer's dispatcher (`src/renderer/src/app-map.ts`) implements the map:
`where()` reads the shell's state in the map's words, `go(place, params)` shows a place and
`act(action, params)` does an action, going to its place first when that is not on screen. The
dashboard's own buttons call the same `go` and `act`, so what a click does and what a model does is
one path, and the tables are typed against the map so a missing handler fails the typecheck. What a
panel shows lives in the store for this reason (the right side, the library's filters, the progress
view's section in `store.ts`).
Mapped controls carry `data-nav="<place>"`, which `studio_ui_snapshot` reports as `nav`.

The host serves the map as three tools (`src/host/tools/ui-map.ts`), run in the renderer through
main's `uiMap` op: `studio_ui_where` (no image; the orchestrator column, whether it is the asking chat's, the
side panel and what it shows, the worker board, the progress view's plan and pending changes), `studio_ui_go` and `studio_ui_act`
(both return where the shell ended up and an image, `capture=false` to skip it). A wrong place,
action or parameter is refused with the valid choices (`UI_MAP_REFUSED`) and nothing moves.
`tests/ui/app-map.spec.ts` walks every place through the dispatcher and the tools.

Three checks keep the map and the UI the same thing. The typecheck fails on a map entry the
dispatcher does not implement. `src/shared/app-map.test.ts` reads the renderer source and fails
on a `go('…')`, `act('…')` or `data-nav` naming something the map lacks, on a map entry no control
uses, and on a place whose `file` is gone. The UI spec fails on a place the running app cannot
reach. Adding UI a model may need is therefore: a map entry, a handler (the typecheck says where),
state in the store, and a control that calls `go` or `act`; the tools and the turn context follow.

Role-specific context (`src/host/agent-situation.ts`) gives leader and ordinary chats a live
"Where you are" line and the shell map. Workers receive short assignment and report rules,
without the user browser-tab list, shell map, or generic plan-opening guidance. Workers put
questions and blockers in their report and finish; leaders ask blocking questions through
checkpoint `needs`, shown in the progress view. Context is still injected each turn; session
context caching is separate work.

Besides the browser and UI tools there is `library_list` (see Library), `remember` (see Workspace and memory), `ask_user` (below)
and, with `CRAFT_SELF_CHECK=1`, the three self-check tools. Every
enabled tool's schema is available from session start. Workers receive browser and web research,
`library_list`, `remember`, and `studio_ui_run` with explicit `target: "isolated"` only. Leaders
receive every registered tool except `ask_user`; ordinary chats receive all tools. Calls through
cached schemas are checked against the saved role too. What a model should simply know goes ahead of the
user's message instead (tabs, the file map, notes, trouble reports), and a tool is added only for
something a model must do.

`ask_user` (`src/host/tools/ask.ts`) is how a model asks the user something, and it never holds
the chat up. The call posts a card in the transcript and returns at once; the model is told to
carry on with everything the answer does not change and end its turn as usual, so no CLI is left
holding a connection open for a human. A question must carry two to four options, each with a
short label and what picking it means, and the index of the option the model would take itself;
the card marks that one "Suggested", so taking the model's word is one click, and an unanswered
question costs nothing. One question per turn; a second call, a question without real options,
or one without the model's own pick is refused with a message saying what to do instead. An
answer, clicked or typed under "Something else", is sent as the chat's next message with the
question quoted above it, to the provider picked in the composer; clicked while the turn that
asked is still running, it goes the moment that turn ends. A handoff names a question that is still open, so another provider
knows what the user has not yet decided.

Cursor has blocking questions and plan approvals of its own over ACP (`cursor/ask_question`,
`cursor/create_plan`). Nobody would answer them, so its adapter skips the question with a
pointer to `ask_user` and accepts the plan, as an unattended session would.

### Plans

The plan a model keeps while it works is shown beside the chat, not in it. Each adapter turns
its provider's own list into one `plan` item per turn (`<turnId>:plan`, `PlanStep[]` with
`todo` / `doing` / `done`), replaced whole on every update: Claude Code's `TodoWrite` calls, which
no longer appear as tool rows; Codex's `turn/plan/updated` notifications; the ACP `plan` session
update from Cursor. The turn's head line, which reads "Thinking" while it works, reads
`Planning · 2 of 5` instead, the count moving as steps finish, and `Planned · 5 of 5` once the
turn is over. The line opens and closes the plan drawer (`PlanDrawer.tsx`): a side pane with
only a hide arrow for chrome, the request as its title and the plan's lines under a count, done
lines ticked and dim, the one under way marked with the accent. The drawer opens by itself on the
first plan of a running turn; closing it is remembered per chat (`planClosed` in the renderer's
preferences), after which only the head line opens it. Nothing else is added to the transcript,
and the handoff does not carry the plan: the reply says what was done. The agreed states are in
`docs/mockups/plan.html`.

### Workspace and memory

A new provider session starts already knowing the folder (`src/host/workspace.ts`): its files, one
line per folder, from `git ls-files`, cut to a budget by listing upper folders and counting what
lies deeper; and the notes earlier sessions saved about it. So a session's first calls are not
spent listing and searching. Notes are the project's memory, shared by all four providers: a model
saves one with the `remember` tool (`src/host/tools/memory.ts`), they are kept per folder in the
store, and a session already going is told the ones others save. Reading notes is not a tool, so
it costs no call and no schema. A handoff names the files the missed turns edited and read, each
once and relative to the chat's folder, so the next provider goes straight to them.

A chat running in a Craft Studio worktree (see Continuous orchestration) works in a private copy that is
deleted when its task ends, so what belongs to the project is filed under the main folder.
`homeOf` (`src/host/worktree-home.ts`) maps a worktree folder to its run's folder from the
orchestrator's task list, with no git call per message; `workspace.ts` and `remember` use it, so
the chat sees and saves the main folder's notes, while its file map is listed from the worktree.
A fresh session there is also told once, in a `<worktree>` block beside `<git>`
(`src/host/teamwork.ts`), that the folder is a private copy and what it must not do (the full text
is in the orchestration guide). The library skips Markdown written inside the worktrees folder, and
a merge adds the Markdown it wrote at its main-folder path under the worker's chat (`merged` in
`OrchestratorOptions`, wired in `src/host/index.ts`). `studio_ui_run` with `target: "isolated"`
builds from the calling chat's repository root (its worktree), falling back to the host's source
root when that folder has no `scripts/ui-runner.mjs`, and `npm run open` uses the main folder's
`out/` when the current folder has none.

### Several assistants, one folder

Chats can run at once in the same project, and the user and other programs change its files too.
Ahead of a message, a model is told (`src/host/teamwork.ts`) who else is working in the folder
right now and on what, what other chats finished there since its last turn, and which files
changed under it, so it reads those again before touching them.

Git is the app's job, not the models'. When a turn completes, the files that changed during it
are committed on the current branch, alone, with the user's request as the message
(`src/host/git.ts`). Changes are found by comparing a snapshot of the folder at the turn's start
and end, so files changed by a shell command count; what the user had already changed, and files
another running turn has edited, are left out. A stopped or failed turn commits nothing: its
files go in with the turn that finishes the work. Nothing is ever pushed, hooks are not run, and
no commit is made mid-merge or off a branch. Models are told not to commit or bring git up.
`CRAFT_AUTO_COMMIT=0` turns the committing off. A folder that is not a git repository is left
as it is.

The same two snapshots give the user what the turn did. Each finished turn that changed files
carries one line under its reply, `Changed 3 files +184 −12` with a bar of the balance, and the
line opens the turn's unified diff beside the chat in the artifact panel (`ChangesView.tsx`): a
strip of its files to jump between, each under a heading that stays while its hunks scroll. The
patch is `git diff` between the snapshots of the turn's own files (`patchBetween`), read into
files and lines by `src/shared/patch.ts`, kept with the turn in the store (`turn_patches`, cut at
2 MB on a file boundary) and served by `turn.changes`; the totals sit on the turn itself. This
needs no commit, so it works with committing off too.

The panel's header offers **Undo this turn**: one question in a strip under the header naming
the files, and on Undo the turn's files are put back from its start snapshot (`restoreFrom`:
working tree only, the user's index untouched; files the turn made are removed). With committing
on, the reversal is committed as `Undo: <request>` so the history says what happened. The turn
stays in the chat with its diff dimmed as a record, its line tagged `undone`, and the next model
in the folder is told the files changed under it. Undo is not offered while a turn runs in that
folder, or when one of the files has changed since; the note names the file, so the user knows
what to look at (`teamwork.undoable`). There is no redo: the diff is still there to read, and a
model can be asked to do it again. The states are in `docs/mockups/turn-changes.html`.

Claude Code sessions working on this repository outside the app are covered by a Stop hook
(`.claude/settings.json`, `scripts/auto-commit.sh`) that commits what a turn left changed.

### Long chats

A chat opens with its newest 20 turns (`TURN_PAGE`, `store.snapshot`), not its whole history.
`ChatView.hasOlder` says there are earlier ones, and as the reader scrolls within a screen and a
half of the top, `loadOlder` fetches the 20 before the first loaded (`chat.older`) and puts them
in above. `Transcript` keeps the reader where they were, by the distance from the bottom it keeps
up to date on every scroll and resize, and tells a page put in above from a turn just sent by the
last turn's id. A `turn` event for a turn above the loaded ones is left for when it is fetched.
Pages read their items through `items_by_turn`, ordered by turn, so a page costs the same in any
chat.

A page leaves out the output of finished tool calls, most of a chat's bytes, which shows only when
a step is opened: such a call carries `outputLength`, and opening the step fetches the output
(`item.output`, `loadOutput`). The turn in flight keeps its output, as it streams.

The window keeps the chat of every open tab, and of every worker on the board, not just the ones on screen; live events
keep it current, so going back to a tab asks the host for nothing (`pruneViews`, `openChat`). A kept
chat that was read far up goes back to its newest page as it comes back on screen (`newestPage`).
`ChatMarkdown` keeps what it parsed, by folder and text, for the last 600 texts, so a chat shown
again parses nothing; a reply's last block is not kept while it streams.

Two benchmarks measure how the transcript copes with a long history, using seeded synthetic
chats shaped like real ones (`tests/fixtures/long-chat.ts`). `npm run bench:transcript` times
the host: reading a chat to open it, the payload, the attachment sweep and a full handoff.
`npm run check:ui -- long-chat` times the isolated app opening a chat (the first open and the
median of three), opening a step's output, switching back to its tab, bringing in the page above
(and checks the reader does not move), reading up to the first turn and switching back again,
with `LONG_CHAT_PROFILE=1` for a CPU profile. Its budgets fail the check when a chat's length shows
up in its open time again. Both write to `.artifacts/bench/`. The audit, the baseline and the plan are in `docs/long-chat-plan.md`.

### Permissions

All four providers run unattended with full access to the chat's working folder and your shell,
as in the reference build. There are no approval prompts yet.

### Self-check

The host keeps a journal of its own trouble, `journal.jsonl` in the profile folder (one JSON
object per line, rotated at 2 MB; `src/host/journal.ts`). It always records: uncaught errors in the
host, uncaught errors in the page (sent over the renderer's port, once per message), host restarts seen by main, failed turns, tool failures, and turns far slower than usual for
their provider and model; every other turn is kept as a timing line with its tokens, when its
provider reports them. With `CRAFT_SELF_CHECK=1` the app also serves three tools to leader and ordinary chats across
providers (`src/host/tools/self-check.ts`): `studio_check` runs the chat folder's `typecheck` and
`test` scripts and returns what failed (a failure also lands in the journal as a tool error);
`studio_diagnostics` reads the journal and the timing
and token averages, and `studio_note` files what a model saw, why it thinks it happened and the change it
would make. Only the leader is told, ahead of its next message, when new warnings or errors have
arrived, once; workers keep their assignment context. Notes edit nothing; changing code is still the user's request or the model's
judgement about a clear defect, as `CLAUDE.md` says.

The profile folder is `~/.config/Craft Studio` (Electron's `userData`), so the journal is
`~/.config/Craft Studio/journal.jsonl`; `tail -f` it to watch. `npm run simulate:slow-turn` writes a
fake slow turn from a `sim` provider to check detection; those rows stay in the journal and show
in the timing averages, so use `CRAFT_DATA_DIR=<dir>` to point it at a scratch folder instead.

### Tool-call history

Craft Studio records calls to its shared MCP tools in `<profile>/tool-calls.db`, independently of
self-check mode. Each call has a start and immutable finish, version/build fingerprints,
provider and available model/turn identity, redacted arguments, duration, outcome, structured
error and artifact references. Unfinished calls from a previous host are interrupted.
Recording failures cannot change tool behavior.

`studio_tool_history` returns bounded call lists or deterministic failure groups. Default:
last 24 hours, 10 results. Filter by tool/version, error code or dates; use a call ID for
redacted arguments and artifact references. Failure rates include successes in the same
version/operation scope. UI operation failures are distinct from script-authored exceptions.
History stays out of session prompts; tool descriptions are not automatically rewritten.

`studio_tool_review` records investigator annotations separately from call evidence: lifecycle
stage, cause notes, proposed fix and optional retry links. Use `action=queue` to list failures
still needing review.

Records are pruned after 30 days or beyond 10,000 finished/previous-instance calls, at startup
and every 100 starts. Active calls are preserved. Captures and traces are not deleted by ledger
pruning. See [tool-failure-history.md](docs/tool-failure-history.md) for format, redaction,
retention and query details. Craft Studio dropped Rocket's Tools panel (`ToolLedgerPanel.tsx`) and its
`tools` place; the ledger and `studio_tool_review` are unchanged.

Tools was once the Evals section, which also ran scenarios across providers and scored tools
from those runs. That panel, its runners and `docs/evals` were removed; a profile's old
`eval-live/` folder stays on disk and is no longer read.

### Desktop self-check

`npm run check:ui` builds the current source, runs unit tests, and drives the actual Electron
app with Playwright. The default uses a private Xvfb display so the test cannot steal your
keyboard input. On Linux it requires `Xvfb`, `xvfb-run` and `xauth`; ImageMagick's `import`
adds full-window screenshots. No Playwright browser download is needed: it uses the project's
Electron binary.

Concurrent UI checks share a small slot pool so several worktrees can run `check:ui` without
overloading the machine. Lock files live under the OS temp directory in `rocket-ui-slots/`, shared with Rocket on purpose (one
slot per four CPU cores, at least one; override with `CRAFT_UI_SLOTS`). A run waits with short
polls when every slot is taken; stale locks are reclaimed when the owning process is gone. Runs
that include `long-chat` or `orchestra-stress`, or the full suite with no file filter, take every
slot and run alone. Isolated `studio_ui_run` sessions use the same pool while they build and run.

Use `npm run check:ui -- --visible` to watch on your desktop (it sets
`CRAFT_UI_VISIBLE=1`, and `orchestra-stress` then records its frame budgets without holding the
run to them, since a shared desktop compositor and load move them), or
`npm run check:ui -- --repeat-each=3` to run every scenario three times with fresh profiles.

Live self-check tools connect through the running instance’s PID-checked `live-port.json`,
so `npm run open` cannot redirect them to an opener’s temporary debugging port.

Each run keeps a timestamped directory under `.artifacts/ui/`, printed at start and finish.
It contains `runner.log`, `summary.json`, the machine-readable `results.json`, and an HTML
report in `report/index.html`. The report includes named check steps, screenshots, native
view bounds, the app log, the isolated journal, and a Playwright trace. Open it with
`npx playwright show-report <run-directory>/report`; traces can be inspected from the report.
Failed runs exit nonzero and capture the UI before closing. Test windows and the local web
server close automatically; profiles remain with the report for investigation.
SIGINT/SIGTERM stops the owned subprocess tree, including detached Electron processes;
TERM-resistant children are killed after a grace period. Interrupted runs exit with status
130/143 and record failure in `summary.json`.

The checks exercise composer input, folder selection, usage, model selection, streaming,
completion, tool output, provider handoff, cancellation, failure recovery, chat drafts,
history, the chat column (a turn streaming into it, closing tabs, and the tabs
after a restart), the title strip (no rail, the usage notch centred, its flyout inside the chat card), renderer reload, full app restart, recovery from a host crash during a response,
minimum window size, browser navigation/tabs, the address dropdown, chat links (browser tabs
and local artifact preview), and model question cards from `ask_user`. The shell, embedded
page and dropdown are separate Playwright targets. Their
screenshots and bounds are retained separately; on X11, a whole-window capture also records
how the native views overlap. If that optional capture is unavailable, the report says so.
Assertions also check the native page bounds and dropdown visibility, overlap and stacking
order, so misplaced or hidden native views fail even without visual screenshot comparison.

The test fixture (`tests/ui/app.ts`) uses a fresh marked profile and scratch workspace. All
four provider adapters are replaced by `src/host/ui-test.ts`; real provider CLIs are never
started. Before any restored tab loads, the app and `persist:browser` sessions both block
HTTP/WebSocket origins outside the local fixture; new-tab home navigation redirects to it.
Responses wait for the test to
observe the stream before finishing, which avoids timing-dependent sleeps. The host, SQLite
store, MessagePort, and renderer are real. The folder dialog returns the scratch workspace.
This checks app behavior, not provider authentication, CLI translation, or native OS dialogs;
`check:live` remains the separate, explicitly authorized provider integration check.

The safeguards scenarios deliberately remove the browser filter and damage native view
layout, then require the same assertions to reject those faults. The subprocess unit test
checks ordinary and detached descendants, including ones that ignore SIGTERM.

Add scenarios in `tests/ui/` (`rocket.spec.ts`, `safeguards.spec.ts`, `recovery.spec.ts`,
`question.spec.ts`, `chat-links.spec.ts`).
The orchestrator layout checks run with `npm run check:ui -- --grep orchestra-shell`.
`tests/ui/orchestra-shell.spec.ts` checks fresh layout, live workers, replies, cancellation,
reports and scrolling. Its controlled leader calls the real MCP tool; dispatches beyond a
provider's own limit queue (six alternating workers leave the second Antigravity one waiting),
a dispatch while a finished worker awaits review is refused, and reviewed workers accumulate to eight board windows.
UI checks keep worktrees and committing off, since scratch workspaces sit inside this repository;
a spec turns them on with `test.use({ rocketEnv: { CRAFT_WORKTREES: '1', CRAFT_AUTO_COMMIT: '1' } })`
only when its workspace is a repository of its own. `tests/ui/worktree.spec.ts` does: two workers
that edit (`UI check: edit as <name>` in the assignment) make the same change from one base, the
first is accepted and merged, the second is refused as a conflict naming `auth.js`, then rejected
and its worktree and branch removed. A controlled worker may write its report outside its worktree
when it is inside the main folder the worktree was made from.
`tests/ui/side-pane.spec.ts` checks
that the plan drawer's side pane resizes, saves its width and restores it after a restart.

Prefer accessible controls and observable state;
do not mutate renderer state to manufacture a passing UI. `CRAFT_UI_TEST=1` is reserved for
this runner and requires the marked profile before either main or host opens the store.
The runner supplies `CRAFT_UI_TEST_ORIGIN` for its loopback server; this hook is inactive
outside UI test mode.

## Development hooks

- `CRAFT_SELF_CHECK=1` serves the self-check tools and nudges described above.
- `CRAFT_DATA_DIR=<dir>` moves the host's data (transcript, journal, tool channel) and is set by main to the profile folder; set it by hand only for scripts that run the host without the app.
- `CRAFT_USER_DATA=<dir>` uses another profile folder, so test runs never touch real chats.
- `CRAFT_CAPTURE=<file.png>` saves a picture of the UI after load; `CRAFT_CAPTURE_SCRIPT`,
  `CRAFT_CAPTURE_DELAY_MS` and `CRAFT_CAPTURE_EXIT=1` script a flow first and quit after.
- `npm run check:live -- claude codex cursor antigravity` runs a real conversation across
  providers without the UI. It uses a little of each subscription.
- `npm run demo:video` records a demo video (`.artifacts/demo/run/demo.mp4`): sending messages,
  switching between Claude, Codex and Cursor, and the browser tools filling a form in one
  `browser_run` script. Like `check:ui`, it runs an isolated app on a private display with a fresh
  profile and a local site. No model is called. The turns are scripted in `src/host/ui-demo.ts`,
  but their tool calls go through the real MCP channel. `scripts/demo-video.mjs` records the screen
  at 2× and logs where each action happened. `scripts/demo-edit.py` adds the camera zooms, the
  pointer, outlines on the filled fields, and captions. It only crops and resamples the recorded
  frames.
