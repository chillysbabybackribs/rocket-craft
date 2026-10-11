# Craft Studio

An Electron app (Linux, personal tool) that owns one chat, its tools and an embedded browser, and
lends each message to Claude, Codex, Cursor or Antigravity through their CLIs. `README.md` has
the architecture; read it before changing how the processes talk to each other.

## What this is

A copy of Rocket Orchestrator that hosts open-source Craft apps on the right of the chat, under
a dock of installed apps. Read `docs/craft-studio-own-apps-plan.md` (direction, phases) and
`docs/craft-studio-performance-plan.md` (resource states, install on demand) before building any
of it; `docs/mockups/craft-studio.html` is the agreed UI. The shelf, the dock, installs and
native docking are built (`src/shared/craft-apps.ts`, `src/main/craft-*.ts`,
`src/renderer/src/components/{Dock,Shelf,CraftAppPanel}.tsx`); **the model tools for driving the
apps are not built yet.** The ArtCraft name and logo are trademarks and must not
appear anywhere in the app.

Craft Studio runs beside the user's Rocket apps and must never share anything with them: its
profile is `~/.config/Craft Studio`, its variables are `CRAFT_*` (inherited `CRAFT_*` are
dropped), its MCP server is `craft-studio` and its own tools are `studio_*`. Never point it at a
Rocket profile, and never stop or restart a running Rocket.

## Commands

```sh
npm run typecheck   # tsc, no emit
npm test            # host/renderer unit tests and UI subprocess cleanup regression tests
npm run check:ui    # build + unit tests + isolated Electron UI check, no real model turns
npm run dev         # the app, rebuilding on change (CRAFT_NO_SANDBOX=1 if the sandbox helper is not set up)
npm run open -- <path or URL>   # open it inside the running app (browser tab or artifact panel)
```

A shell started from a Rocket chat has `NODE_ENV=production`; install with `npm ci --include=dev`
there, or TypeScript, electron-vite and Playwright are left out.

Anything made for the user to look at (a mockup, a capture, a report) is opened with
`npm run open`, never `xdg-open` or an outside browser. Worker reports and evidence stay at their assigned paths; the leader opens accepted artifacts. Show a mockup in `docs/mockups` and get
it agreed before building a UI change, and make checks visible: `npm run check:ui -- --visible`,
or open the captures afterwards.

Run typecheck and tests after every change. To check against the real CLIs without the UI:

```sh
USAGE=1 TURNS=0 npm run check:live -- claude cursor   # usage readings only, no model turns
npm run check:live -- claude codex                    # a real conversation; spends subscription usage
```

Ask before running a check that sends model turns. Prefer `npm run check:ui` for UI checks;
it uses controlled responses, fresh profiles and a private display (see README). For manual UI checks, use `CRAFT_USER_DATA=<dir>`
so real chats are never touched, and `CRAFT_CAPTURE` (see the README) for a picture of the UI.

## Where things are

- `src/shared/types.ts`: every type that crosses a process boundary. Change the protocol here first.
- `src/host/`: the agent host, a utility process. `hub.ts` runs turns, `store.ts` is the SQLite
  transcript, `handoff.ts` builds what a provider is told about turns it missed.
- `src/host/providers/`: one adapter per provider behind `provider.ts`. Each file's header lists
  the CLI behaviour it depends on, with the version and date it was verified.
- `src/host/journal.ts`: the journal of errors, slow turns and model notes (`journal.jsonl`); see Self-check.
- `src/host/tools/`: the app's tool registry, served to all providers through role-selected profiles by one loopback MCP server.
- `src/shared/app-map.ts`: the hand-written map of the shell's places and actions;
  `src/renderer/src/app-map.ts` is the one dispatcher behind both the UI's buttons and the
  `studio_ui_where` / `go` / `act` tools. A new panel or button that a model may need goes in the
  map, with its state in `store.ts`, not in component state.
- `src/host/agent-situation.ts`: role-specific context ahead of messages: leader and ordinary chats get
  the live shell state and map; workers get short report rules without user tabs or the shell map.
- `src/host/workspace.ts`: the file map and saved notes a new session is told about its folder.
- `src/shared/sources.ts`: a turn's sources record: the pages it opened against the pages its
  reply cites, kept on the turn and marked on each link; the hub records both at a turn's end.
- `src/host/teamwork.ts`, `git.ts`: what a model is told about others working in the folder, and
  the commit the app makes of a turn's changes.
- `src/host/worktrees.ts`: a code worker's private git worktree and the checked, squashed merge of
  its work into the main folder; the orchestrator calls it, models never run that git.
- `src/host/worktree-home.ts`: maps a worktree folder to its main folder, so notes and the library
  stay with the project.
- `scripts/ui-slots.mjs`: the shared slot pool that limits concurrent `check:ui` runs.
- `src/host/library.ts`, `src/shared/library.ts`: the library's shelf, previews and filters, shared by
  the panel (`LibraryPanel.tsx`) and `library_list` (`docs/library-plan.md`).
- `src/main/`: the window, the browser tabs (`browser-pane.ts`) and the browser tools' hands
  (`browser-agent.ts`, `browser-page-lib.ts`). `cookie-import.ts` brings the user's logged-in
  sessions in from their OS browser (first-run and the page's right-click menu).
- `src/renderer/`: React UI. `store.ts` is the client state.

## Rules

- User preference: crop, zoom, resize, and inspect screenshots with deterministic tools such as
  Python Pillow or ImageMagick. Preserve source pixels for crops; use ordinary resampling for
  zooms, never generative reconstruction, OCR re-rendering, or invented missing text. Keep the
  original, save a separate output, inspect it, and open it with `npm run open`. Use generative
  editing for these tasks only when the user explicitly requests it.
- The app's SQLite transcript is the conversation. A provider's session is a cache: resume it and
  hand over only the turns it missed. No full-history replay except after a lost session.
- Agent work stays in the host process. Nothing that talks to a provider or the store runs in
  main or the renderer, and chat traffic never passes through main.
- An adapter knows nothing about other providers, the store or the renderer. The hub knows
  nothing about how any provider works.
- In the browser, anything that opens near the page (dropdowns, menus) overlays it in a view of
  its own. Never move or resize the page to make room.
- Model lists and usage are read live from the provider, never hardcoded.
- Every tool enabled by a session's saved chat role is available in its prompt; the host enforces
  that profile on every call. What a model should simply know goes ahead of
  the user's message (tabs, the file map, notes); add a tool only for something a model must do.
- Browser research: use native search or Craft Studio web_search, then web_read for primary sources.
  Browser search and source gathering are allowed recovery paths. Recover PDFs from their saved
  paths; try alternate primary sources after blocks. Never count a challenge or failed fetch as read.
- Provider payloads are `unknown`: read them through `recordOf` / `stringOf` in `src/host/json.ts`.
- When a CLI's behaviour is learned or re-verified, record it in that adapter's header with the
  CLI version and date. When it changes, fix the header with the code.
- Keep the README current with the code in the same change.
- Git stays out of the chat. Do not commit, stage, branch or push, and do not mention git or
  commits in replies unless asked. Inside Craft Studio the app commits each turn's changes itself, and
  the host makes orchestrator worktrees, merges accepted work and commits reviewed reports; models
  never run git for any of it, even in a worktree. In a worktree, do not run `npm install` or
  `npm run dev`.
- Other assistants may be editing this folder at the same time. Read a file again before changing
  it if it may have moved, and say so if someone else's change looks wrong rather than undoing it.

## Style

- TypeScript, ES modules, imports with the `.ts` extension, no semicolons, single quotes.
- Comments say why, in plain sentences, at the head of a file and above anything surprising.
- Stream translation is a pure class (`TurnTranslator`, `UpdateTranslator`, `StepTranslator`) so
  it can be tested without a CLI. Tests sit beside the file they test.
- User-facing errors are full sentences that say what to do next.

## Self-check

With `CRAFT_SELF_CHECK=1`, leader and ordinary chats have `studio_check`, `studio_diagnostics` and `studio_note`. Only leaders receive journal nudges. When the app misbehaves,
runs slow, or a `<self-check>` line appears ahead of a message, read the journal before guessing.
Anything you notice but were not asked to fix goes in `studio_note` with what you saw, the likely
cause and the change you would make. Edit code only for what was asked or a clear defect in code
you are already changing; propose anything larger in the chat. After a self-edit, call `studio_check` (typecheck and
tests), and read `studio_diagnostics` for anything the change caused. Keep this section and the
README's Self-check section current when the journal, its tools or its nudges change.
