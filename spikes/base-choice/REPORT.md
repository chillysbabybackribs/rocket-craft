# Task 0004: which Rocket to copy for Craft Studio

Worker: Claude Opus 5.5, 2026-10-10 (23:00 to 23:40 EDT). Both sources were only read. The only
files written are this report, its copy at `/home/dp/Desktop/rocket-craft/spikes/base-choice/REPORT.md`,
and the evidence in `task-0004-evidence/`.

## Recommendation

**Copy `rocket-orchestrator`. Then port rocketv1's generate_image and PhotoCraft pieces into it.**

1. **rocket-orchestrator is rocketv1 plus three days of work.** Its first commit, `0495d27`
   (2026-10-08 01:17), is "Baseline copy of rocketv1". Since then it has 201 commits.
   - It added about 3,600 lines in 28 new files: the orchestrator's plan, control, worktrees,
     notifications, run controls, progress view and worker board.
   - It changed about 6,700 lines in files both trees share.
   - rocketv1 changed about 2,700 lines in shared files over the same time. Most of that is
     generated images, PhotoCraft and transcript zoom.
   - Both trees removed Goals and Evals independently. Orchestrator also removed Fill with Rocket.
   - Evidence: `churn-common-files.txt` and `tree-diff-orch-vs-v1.txt`.
2. **Craft Studio needs the orchestrator, and it only exists here.** That covers
   `orchestrator.ts` (1,114 lines changed since the fork), `orchestrator-plan.ts`,
   `orchestrator-control.ts`, `worktrees.ts`, role-based tool profiles (`tools/registry.ts:9-14`),
   orchestrator notifications and the progress view. Porting all of that into rocketv1 would mean
   about 10,000 changed lines across hub, store, registry, git, teamwork, app map and renderer
   store. That is roughly 5 to 8 days of high-risk merging.
3. **rocketv1's unique pieces are small and self-contained.**
   - generate_image: `image.ts` (154 lines) plus `tools/image.ts` (49), and about 300 lines of
     hooks in codex, hub, attachments, handoff, library and Transcript.
   - PhotoCraft pane and tools: about 640 lines.
   - Three small core speed-ups.
   - In total that is about 1.5k lines and roughly 2 to 3 days, much of it Phase 2/3 work anyway.
4. **The orchestrator copy is safer to run beside other Rockets.** It takes the single-instance
   lock before configuring Chromium (`src/main/index.ts:33-42`). It also publishes its own
   DevTools port in `live-port.json` (`src/main/live-port.ts`) instead of trusting Chromium's
   `DevToolsActivePort`, which another launch can overwrite. rocketv1 sets the debugging port
   before taking the lock.
5. **The orchestrator's shell is already closer to the mockup.** It has a single chat column on
   the left and a side region on the right. rocketv1 still has multi-pane chats (`pane.add`,
   `pane.close` in its app map), which Craft Studio's layout does not use.
6. **rocketv1's git history is broken, and its code is still changing.**
   - `.git/refs/heads/main` points at `005ae95…`, an empty object file (one of 13 empty objects).
     `git log` fails with "bad object HEAD".
   - The last good commit in the reflog is 2026-10-06 10:57.
   - Files kept changing until 2026-10-10 22:55, so about four days of rocketv1 work is in no
     commit.
   - Evidence: `rocketv1-git-state.txt` and `rocketv1-recent-edits.txt`.
   - What to port therefore has to be taken from rocketv1's working tree at port time. The
     sha256 of each source file as read today is in `rocketv1-port-sources.sha256`. I did not
     repair anything.

**Both bases are healthy as they stand** (run 2026-10-10 with `ROCKET_DATA_DIR` unset; output in
the evidence folder):

| Tree | Typecheck | Unit tests |
|---|---|---|
| rocket-orchestrator | passes | 336/336 pass |
| rocketv1 | passes | 260/260 pass |

**The other core pieces are the same in both trees** (title strip and usage notch, library,
browser, tool server). Both have `TitleStrip.tsx` with the four-ring usage notch, the same
`browser-*` modules, `library.ts` and the `channel.ts` tool server. The differences in those
files are listed in the port list below. Both use the same dependencies and Electron 44.5.1.

## Port list: from rocketv1 into the copy

Paths are rocketv1's. "Effort" is for one careful worker, including tests.

### A. generate_image and generated pictures (needed; about 1 day)

| File | What to take | Effort |
|---|---|---|
| `src/host/image.ts` + `image.test.ts` | Copy whole. The Hub API it needs (`createChat`, `send` with 4 args, `waitForTurn`, `turnItems`, `addItem`, `deleteChat`) exists in orchestrator's `hub.ts:135,159,216,394,403`. | 1 h |
| `src/host/tools/image.ts` | Copy whole. Add `generate_image` to the worker profile at orchestrator `tools/registry.ts:13`, or workers cannot make pictures. Drop "PhotoCraft opens it with photocraft_open" from the description until the app tools exist. | 30 min |
| `src/host/providers/codex.ts` | The `imageGeneration` and `imageView` cases, `codexImage()`, the `ROCKET_CODEX_TRACE` trace, and the header lines 45-64 (codex-cli 0.161.0, verified 2026-10-10/11). Orchestrator's codex adapter has no image handling and its header says 0.160.0. Bring `codex.test.ts` (+57 lines) too. | 2 h |
| `src/shared/types.ts` | The `image` Item variant and `GeneratedImageSource` (about 25 lines). | 15 min |
| `src/host/attachments.ts` | `inspectImage(maxBytes)`, `generatedName`, `keepGenerated` (about 60 lines), plus tests. | 45 min |
| `src/host/hub.ts` | `saveImage` constructor argument, `LiveTurn.saving`, `keepImage`, wait-before-end, image `startedAt` and the failed-on-end case (about 48 lines), plus `hub.test.ts` (+54). Orchestrator's constructor is `hub.ts` + `index.ts:221-236`, so the new argument goes after `ids => attachments.resolve(ids)`. | 1.5 h |
| `src/host/handoff.ts` | The `locate` argument and the "made an image" lines (about 24 lines), plus tests. | 30 min |
| `src/host/library.ts`, `src/shared/library.ts`, `src/host/tools/library.ts` | The `'generated'` source. Orchestrator's Library dropped the `hidden(chatId)` option (it had gone with Fill). Re-add it, or hide image chats with the existing `skipRoots`. | 1 h |
| `src/host/index.ts` (rocketv1 lines 146, 176, 205-206, 253-278, 292, 391) | Wiring: create `ImageRunner`, `images.observe(event)` hides picture chats' events, `chats.list` filters them, `images.shutdown()`. Also keep picture chats out of `orchestration.turnEnded` and the teamwork commit. | 1 h |
| `src/renderer/src/components/Transcript.tsx`, `images.css` | The image item: wave placeholder, caption and preview (about 180 lines of the Transcript diff). | 1.5 h |
| `src/host/ui-test.ts` | The `UI check: image` fixture, so `check:ui` can cover pictures without spending Codex usage. | 30 min |

### B. PhotoCraft in the right side (Phase 2/3; reuse, do not copy as-is)

| File | Use | Effort |
|---|---|---|
| `src/main/photocraft-pane.ts` (278) + `photocraft-files.ts` (18) + test | The basis of a web-app pane if the Phase 0 spike picks the web build, or keeps it for apps with no native fit. Generalise `photocraft://` and `persist:photocraft` to one privileged `craft://<app>` scheme with a `persist:craft-<app>` partition each, and take the build root from the app manifest, not `~/src/photocraft/dist/web`. If native windows win, only the scheme/partition idea and the file-handoff design carry over. | 1-1.5 days (web route) |
| `src/host/tools/photocraft.ts` (265) + test (155) | The seven tools (`photocraft_run`, `_batch`, `_commands`, `_control`, `_open`, `_save`, `_screenshot`) become the fixed app-named tool set (`craft_run({app,…})`, …). The path helpers `photocraftPath` and `clipHead` port unchanged. | 1-2 days (Phase 3) |
| `src/renderer/src/components/PhotocraftPanel.tsx` (78) | Replaced by the dock and app region. Useful only as a reference for bounds reporting. | — |
| `src/shared/types.ts` (`PhotocraftOp`/`Command`/`State`, 24 refs), `src/main/index.ts:16,38,55,105-107,176-185,272-273`, `src/preload/index.ts`, `app-map.ts` place `photocraft`, `store.ts` `setPhotocraftOpen` | The pattern to follow for the generic `app {id}` place and `app.open/close/focus` actions. Rewrite these for the manifest rather than copying them. | part of Phase 2 |
| `photocraftBrief` in rocketv1 `host/index.ts:~248` | The pattern for the "which apps are open" note ahead of each message. | part of Phase 3 |

### C. Core fixes rocketv1 made after the fork (cheap, worth taking; about 3 h total)

| File | Change | Effort |
|---|---|---|
| `src/host/journal.ts` | `scanNewestFirst` / `warningsSince`: reads the journal from its end instead of reading up to 4 MB on every message. | 45 min |
| `src/main/reading-scroll.ts` | Sends the reader library once per document rather than 4 times a second. | 30 min |
| `src/main/browser-a11y.ts` | `digestMaxFor`: a find-in-page query scans the whole page before capping. Wire it where rocketv1 does in `browser-agent.ts`. | 30 min |
| `src/host/tools/browser.ts` | One description line ("Every browser and tab call return…"). | 5 min |
| `src/renderer/src/transcript-zoom.ts` + test | Optional: Ctrl+wheel zoom of the transcript. | 2 h |

### Not to port from rocketv1

- Fill with Rocket: `fill.ts`, `shared/fill.ts`, `main/fill-page.ts`, `main/page-fill.ts`,
  `renderer/fill.*`.
- `design-library.ts`.
- The multi-pane chat (`pane.*` actions).

The orchestrator removed all of these on purpose in `b49ba21` and `9529c91`.

## Rename and isolation checklist (references are to rocket-orchestrator, today)

Observed on this machine:

- The running Rockets have WM_CLASS `rocket` (pid 175938) and `rocket-orchestrator` (pid 167152).
- Their profiles are `~/.config/Rocket` (15 GB) and `~/.config/Rocket Orchestrator` (1.5 GB).
- `SingletonLock` sits inside the profile folder, so the lock follows the profile.
- No `.desktop` file exists for either Rocket.
- A model shell inside Rocket Orchestrator inherits `ROCKET_DATA_DIR=/home/dp/.config/Rocket Orchestrator`
  and `ELECTRON_EXEC_PATH`/`ELECTRON_*` (seen in this worker's own environment).

### Must change: the copy collides or misbehaves otherwise

| # | Where | Today | Change to | Why |
|---|---|---|---|---|
| 1 | `package.json:3` `productName` | `Rocket Orchestrator` | `Craft Studio` | Electron derives `userData` from it, giving `~/.config/Craft Studio`. That one change separates the single-instance lock (`main/index.ts:34`), `live-port.json`, `tool-channel.json` (MCP port and secret), `rocket.db`, the journal, `orchestrator.json`, `worktrees/`, `ui-runs/`, `ui-snapshots/`, `capture-tmp/`, `browser-tabs.json`, `browser-history.json`, cookies and partitions. All of these are `userData`/`dataDir`-relative (`host/index.ts:64-67,140,148,154,160,175,210,254`; `main/index.ts:67,122,144,152,253,299`; `browser-pane.ts:59`; `browser-suggest.ts:22`; `ui-snapshot.ts:40`; `capture.ts:110`). |
| 2 | `package.json:2` `name` | `rocket-orchestrator` | `craft-studio` | The X11 WM_CLASS follows it (observed `rocket-orchestrator`). Also written into the isolated UI build by `scripts/ui-runner.mjs:41`. |
| 3 | `src/host/providers/provider.ts:50` `TOOL_SERVER` | `'rocket'` | `'craft-studio'` | **Antigravity's MCP config is global.** `antigravity.ts:263-281` runs `agy mcp add <serverName> <url>` and `agy mcp remove <serverName>`. With the same name, three apps would overwrite each other's URL and remove each other's entry. Rocket and Rocket Orchestrator already share `rocket` today (`index.ts:190` in both), a collision that exists now. Claude, Codex and Cursor get per-session MCP config (`claude.ts:122`, `codex.ts:287`, `cursor.ts:321`), so for them only the tool prefix changes (`mcp__craft-studio__…`). |
| 4 | Env prefix `ROCKET_*`: 19 names, 63 references (list in "Env vars" below) | `ROCKET_` | `CRAFT_` | Craft Studio will be built from inside Rocket chats, whose shells already carry `ROCKET_DATA_DIR` of Rocket Orchestrator. Main overrides it for its own host (`main/index.ts:76`), but `host/simulate-slow-turn.ts:12` would write into Rocket Orchestrator's profile, and `host/ui-test.ts:16` would refuse to start (`ROCKET_DATA_DIR` ≠ `ROCKET_USER_DATA`). A distinct prefix makes inherited Rocket variables inert. |
| 5 | `scripts/ui-runner.mjs:24` env scrub | `/^(ROCKET_\|ELECTRON_\|…)/` | scrub `ROCKET_` **and** `CRAFT_` | Same reason: an isolated UI run must not see either app's variables. |
| 6 | `scripts/electron-env.mjs:13-16` | deletes `ELECTRON_*`, PRIME vars | also delete every `ROCKET_*` | So `npm run dev`/`open` started from a Rocket chat does not hand Rocket's profile path to Craft Studio's providers and their shells. |
| 7 | `src/main/index.ts:75` `serviceName` | `'Rocket Agent Host'` | `'Craft Studio Agent Host'` | Process lists and any future "kill the host" or memory-valve code must tell the two hosts apart. |
| 8 | `src/host/index.ts:63` fallback | `~/.config/rocket` | `~/.config/Craft Studio` | Only used when the host runs without main (scripts). It must never point at a Rocket profile. Also `simulate-slow-turn.ts:6,12` (`~/.config/Rocket`). |
| 9 | UI-test profile marker `'rocket-ui-check-v1'`: `host/ui-test.ts:18`, `host/ui-test.test.ts:16`, `scripts/ui-runner.mjs:225`, `tests/ui/app.ts:41`, `scripts/demo-video.mjs:94` | `rocket-ui-check-v1` | `craft-ui-check-v1` | A Rocket test profile can then never be accepted by Craft Studio, or the reverse. |
| 10 | Electron sandbox helper (`scripts/electron-sandbox.mjs`) | the copy's fresh `node_modules/electron/dist/chrome-sandbox` will be user-owned | one `sudo chown root:root … && sudo chmod 4755 …` by the user, or `CRAFT_NO_SANDBOX=1` until then | `kernel.apparmor_restrict_unprivileged_userns=1` here, and both existing trees' helpers are `root 4755`. Workers cannot run sudo, so this is a Phase 1 blocker the leader must hand to the user. |
| 11 | `.claude/settings.json` (Stop hook → `scripts/auto-commit.sh`) | commits after every Claude Code turn | **do not copy** (or ask the user) | In rocket-craft this would make git commits on every turn, against the run's "workers never commit" rule. Rocket's own in-app auto-commit (`teamwork`/`git.ts`) is separate and only acts in git folders. |

### Should change: names a person or model sees

| Where | Today | Change to |
|---|---|---|
| `src/renderer/index.html:10` `<title>` | `Rocket` | `Craft Studio` |
| `src/host/tools/channel.ts:132` `serverInfo` | `rocket` / `Rocket` | `craft-studio` / `Craft Studio` |
| `src/host/providers/codex.ts:84` `clientInfo`, `:299` `serviceName` | `rocket` | `craft-studio` |
| `src/host/providers/claude.ts:112` `CLAUDE_AGENT_SDK_CLIENT_APP` | `rocket/0.1.0` | `craft-studio/0.1.0` |
| `src/host/git.ts:146` fallback author | `Rocket` | `Craft Studio` |
| `src/main/capture.ts:60` capture name | `Rocket` | `Craft Studio` |
| Tool names `rocket_ui_where/go/act` (`tools/ui-map.ts:77,88,109`), `rocket_ui_snapshot` (`ui-snapshot.ts:8`), `rocket_ui_run` (`ui-run.ts:97`, `registry.ts:13,61,78`), `rocket_check/diagnostics/note` (`self-check.ts:36,59,89`), `rocket_tool_history` (`tool-history.ts:7`), `rocket_tool_review` (`tool-review.ts:9`) | `rocket_*` | `studio_*`. There is no collision (each app has its own server), but the descriptions say "Rocket" (`grep -c Rocket src/host/tools/*.ts`: 33 mentions in 13 files). Do it in Phase 1 with one sed and the tests. |
| `src/renderer/src/App.tsx:105` and prose in README, CLAUDE.md and agent-situation | "Rocket Orchestrator" | Craft Studio |

### Already isolated: verify only

- **DevTools port.** `main/index.ts:36-52` picks a free loopback port per launch and publishes
  it per profile (`live-port.ts`). There are no fixed ports anywhere in `src/`.
- **MCP tool server.** `channel.ts:52` reuses the last port saved in its own profile and falls
  back to any free port.
- **`npm run open`** (`scripts/open.mjs:36-41`) launches `electron <root>`. That gives the copy's
  own `package.json` identity, so it reaches the copy's own lock and `second-instance` handler
  (`main/index.ts:293-296`), never Rocket's. Only the help text changes.
  - `mainFolder()` (`open.mjs:20-27`) uses git, so it only matters once rocket-craft is a repository.
- **Capture and test output.**
  - `.artifacts/ui/<run>` is under the repo root (`ui-check.mjs:12-13`, `playwright.config.ts:4`).
  - `ROCKET_CAPTURE` output goes where the caller says.
  - `ui-snapshots/` and `capture-tmp/` are under `userData`.
- **Journal.** `userData/journal.jsonl`, from both the host (`host/index.ts:67`) and main
  (`main/index.ts:67,122,152`).
- **Browser user agent.** `browser-pane.ts:82` strips `<app.name>/<version>` from it with
  `plainUserAgent(…, app.name)` (`browser-url.ts:78-81`). After the rename, check that a page
  sees no `Craft Studio`/`craft-studio` token, because a space in productName may change what
  Electron puts there.
- **Custom protocol schemes.** The orchestrator registers none today. rocketv1 registers
  `photocraft://` with partition `persist:photocraft` (`photocraft-pane.ts:26-28,58,76`), which
  would only clash if both apps shared a profile. Use `craft://` with `persist:craft-<app>` (see B).
- **IPC channels** (`rocket:*` in `preload/index.ts`) and **localStorage keys** (`rocket.*`) are
  per process and per profile, so they cannot collide. Renaming them is optional.
- **check:ui slot pool.** `scripts/ui-slots.mjs:9` uses `/tmp/rocket-ui-slots`, which is
  `nproc 8 / 4` = 2 slots, with exclusive runs for long-chat/stress. **Recommendation: keep it
  shared on purpose.** It is one CPU budget for one machine, so a Craft Studio check and a Rocket
  check never overload it together. If the leader wants independence instead, rename it to
  `craft-ui-slots` and `CRAFT_UI_SLOTS`.
- **Desktop file.** There is none today. When one is wanted, add
  `~/.local/share/applications/craft-studio.desktop` with `StartupWMClass=craft-studio` and a
  non-ArtCraft icon.
- **First run.** The cookie-import offer (`main/index.ts:144`, marker `cookies-imported`) will
  appear once in the new profile. That is expected.

### Later phases: name things so they cannot collide

- **systemd scopes** (performance plan): name them `craft-studio-<app>.scope`, not
  `<app>.scope`.
- **Craft apps' own config folders.** They already exist for standalone use: `~/.config/photocraft`,
  `gridcraft`, `soundcraft`, `photocraft-agent`, and `photocraft-chat.desktop` runs
  `~/src/photocraft/target/release/photocraft`. Apps started by Craft Studio should get their own
  config root (`XDG_CONFIG_HOME=~/.local/share/craft-studio/config/<app>`, or an app flag) so
  they do not share settings and recent files with the standalone builds.
- **Per-app control ports and token files.** These are already designed as free ports with 0600
  token files in `craft-studio-plan.md`. Keep the token files under `~/.config/Craft Studio`.

### Env vars (19 names to give the `CRAFT_` prefix)

`ROCKET_AUTO_COMMIT, ROCKET_BROWSER_HIDE, ROCKET_CAPTURE, ROCKET_CAPTURE_DELAY_MS, ROCKET_CAPTURE_EXIT,
ROCKET_CAPTURE_SCRIPT, ROCKET_DATA_DIR, ROCKET_NO_SANDBOX, ROCKET_SELF_CHECK, ROCKET_UI_OUTPUT,
ROCKET_UI_SKIP_BUILD, ROCKET_UI_SKIP_UNIT, ROCKET_UI_SLOTS, ROCKET_UI_SOURCE_ROOT, ROCKET_UI_TEST,
ROCKET_UI_TEST_ORIGIN, ROCKET_UI_VISIBLE, ROCKET_USER_DATA, ROCKET_WORKTREES`, plus `ROCKET_CODEX_TRACE`
and `ROCKET_PHOTOCRAFT_WEB` from the rocketv1 ports.

Locations: `grep -rnoE "ROCKET_[A-Z0-9_]+" src scripts playwright.config.ts`, plus README and
CLAUDE.md.

## What to leave out of the copy (removal list)

**Never copy:**

| Path | Size | Why |
|---|---|---|
| `.artifacts/` | **18 GB** | test output |
| `node_modules/` | 1 GB | run `npm ci` fresh, then item 10 above |
| `out/` | | build output |
| `.git/` | | the copy starts its own history if a repo is made |
| `docs/orchestrator/` | 70 MB | run records and evidence, including browser profiles and trace zips |
| `docs/research/`, `docs/opportunities/` | | not Craft Studio material |
| `.claude/settings.json` Stop hook | | see item 11 |

**Remove in Phase 1** (the plan replaces these, or they are unused):

- **Tool ledger panel.**
  - Remove `src/renderer/src/components/ToolLedgerPanel.tsx`, `src/host/tool-ledger-panel.ts`
    (+ test), app-map place `tools` and action `tools.refresh` (`shared/app-map.ts:45-48,56`),
    `setToolsOpen` and its state in `store.ts`, the `tools` section and Wrench icon in
    `Toolbar.tsx`, its CSS, and `tests/ui/tool-ledger.spec.ts` and `tool-failure-pane.spec.ts`.
  - **Keep** `tool-ledger.ts` (the `tool-calls.db` observer) and the `rocket_tool_history`/`review`
    tools. They are cheap and feed self-check.
- **The Sections drawer in the title strip.** Remove `Toolbar.tsx`, `toolbar.ts`,
  `toolbar.test.ts` and `tests/ui/toolbar.spec.ts`. The dock replaces it. Keep the Chats
  (history) button and the usage notch in `TitleStrip.tsx`, as the mockup shows.
- **The artifact panel as a separate side.** `ArtifactPanel.tsx` opens text files from
  `npm run open`/chat links. Fold it into the library reader (`PanelReader.tsx`), so the right
  side is only an app, the browser, the library or the catalog. Or keep it until Phase 2 if that
  is simpler; it is small (8 lines changed since the fork).
- **Demo and benchmark scripts.** Remove `scripts/demo-video.mjs`, `demo-edit.py`,
  `browser-phase0-baseline.mjs` and `auto-commit.sh`, the `package.json` scripts `demo:video`
  and `check:browser-phase0`, and `src/host/transcript-bench.ts` with `bench:transcript`.
  - **Keep** `src/host/ui-demo.ts`: `ui-test.ts:7` imports it.
  - Keep `live-check.ts` and `simulate-slow-turn.ts` (rename the env var, item 8).
- **Docs.** Bring README.md, DESIGN.md, CLAUDE.md, `docs/craft-studio-*.md`,
  `docs/mockups/craft-studio.html`, `docs/orchestrator.md`, `docs/worktree-plan.md` and
  `docs/library-plan.md`. Rewrite README/CLAUDE.md for Craft Studio in the same change.
  `docs/mockups/` is 9.7 MB in total; take only what is cited.

**Keep for now, decide in Phase 5 (several models):**

- Orchestrator UI: `ProgressView.tsx`, `OrchestratorShell.tsx`, `RunControls.tsx`, `Split.tsx`,
  the worker board, `notifications.ts`, `orchestrator-notifications.ts`.
- `worktrees.ts`/`worktree-home.ts`. They refuse cleanly in non-git folders (`worktrees.ts:137`).

The task makes the orchestrator a goal, and this code is built and tested. Removing it now and
re-adding it later costs more than hiding it. For Phase 2 the progress view can stay reachable
from the title strip rather than from the dock. Where it lives needs a mockup.
`docs/craft-studio-plan.md` assumed the orchestrator would be removed; the assignment overrides that.

## Cost of each direction, side by side

| | Copy rocket-orchestrator, port from rocketv1 | Copy rocketv1, port from orchestrator |
|---|---|---|
| New code to bring in | about 1.5k lines (A + B + C), mostly additive | about 3.6k new lines + about 6.7k changed in shared files |
| Hard parts | the hub's image `saving` wait; Library `hidden` re-added | orchestrator state machine, role profiles in registry, store schema changes, git/teamwork merge logic, single-instance fix |
| Also to remove | nothing extra | Fill with Rocket (about 1.5k lines across host/main/renderer/shared), multi-pane chats |
| Estimate | 2-3 days (A: 1 day now; B, C mostly inside Phases 2-3) | 5-8 days, high regression risk |
| Source history | 201 clean commits | git broken since 2026-10-06 |

## Open questions and assumptions

1. **Folder name.** I assumed the copy lives in `~/Desktop/rocket-craft` (the user task), not
   `~/Desktop/craft-studio` (`craft-studio-own-apps-plan.md`). I also assumed the app name
   "Craft Studio" and package name `craft-studio`. The leader can change the names; the
   checklist stays the same.
2. **Git.** rocket-craft is not a git repository, and the user said a GitHub repo may be made.
   If it becomes one:
   - Rocket's in-app auto-commit and the orchestrator's worktrees start working in it.
   - `.claude/settings.json`'s Stop hook must stay out of it, or be agreed with the user.
3. **Moving target.** rocketv1 is still being edited (last change 22:55 today). Re-read its
   files at port time; the sha256 list shows what this report saw. Its broken git (empty HEAD
   object) is the user's to repair. I touched nothing.
4. **Sandbox helper.** The `chrome-sandbox` fix (item 10) needs the user's sudo once for the new
   `node_modules`. Until then `CRAFT_NO_SANDBOX=1`.
5. **Slot pool.** I recommend sharing `/tmp/rocket-ui-slots` with Rocket (one CPU budget). That
   is a judgement call the leader may reverse.
6. **Not verified.**
   - That WM_CLASS follows `package.json` `name` was inferred from the two running apps
     (`rocket`, `rocket-orchestrator`), not tested with a renamed copy.
   - The user-agent token after a productName containing a space was not tested.
   - Both need a 1-minute check once the copy runs.
7. **PhotoCraft port shape.** Its form depends on tasks 0002/0003 (native window vs web page).
   The base choice does not.

## How to reproduce

```sh
cd ~/Desktop/rocket-orchestrator && git log --format='%h %ad %s' --date=iso | tail -1   # 0495d27 baseline copy of rocketv1
git -C ~/Desktop/rocketv1 log -1        # fatal: bad object HEAD
mkdir /tmp/base && git archive 0495d27 src | tar -x -C /tmp/base
diff -rq ~/Desktop/rocket-orchestrator/src ~/Desktop/rocketv1/src     # 28 / 22 unique files, 77 differ
diff -rN /tmp/base/src ~/Desktop/rocket-orchestrator/src | grep -c '^[<>]'
xprop -id <window> WM_CLASS     # rocket / rocket-orchestrator
env -u ROCKET_DATA_DIR npx tsc --noEmit; env -u ROCKET_DATA_DIR node --experimental-transform-types --test "src/**/*.test.ts"
```

Evidence in `task-0004-evidence/`:

- `tree-diff-orch-vs-v1.txt`
- `churn-common-files.txt`
- `typecheck-*.txt`, `unit-*.txt`
- `rocketv1-git-state.txt`, `rocketv1-recent-edits.txt`
- `rocketv1-port-sources.sha256`
