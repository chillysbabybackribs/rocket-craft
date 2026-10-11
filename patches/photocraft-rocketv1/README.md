# PhotoCraft local edits made for rocketv1 (saved 2026-10-10)

Saved from `/home/dp/src/photocraft` before any further work, so the edits survive
and can be re-applied. The source repository was not changed by saving them.

## Base

- Base commit: `953390a36ef59c6ca04c5850b5b5d9d0dd9e625a`
- Date: 2026-10-10 19:32:48 -0400
- Subject: `Navigator preview fills its group; no scroll fade over dock panels (#2726) (#2818)`
- Upstream remote: `https://github.com/storytold/photocraft.git`
- Stash: none at save time.

## Contents

- `tracked.patch` (37,975 bytes): `git diff --binary HEAD`, covering 35 modified tracked files
  (225 insertions, 21 deletions).
- `untracked/`: 10 untracked files, copied with their relative paths. None is over 5 MB. No
  `target/` or build output was included.

### Tracked changes (what they appear to do)

- `Cargo.toml`, `Cargo.lock`, `apps/photocraft/Cargo.toml`, `apps/photocraft-web/Cargo.toml`,
  `crates/ui-egui/Cargo.toml`: add the `photocraft-assistant` crate and, for the web build,
  `serde_json`.
- `apps/photocraft/src/main.rs`: starts the Chat panel's control server (its own loopback port, or
  the `--control` one) and wires the chat runner into the services.
- `apps/photocraft/src/control_server.rs`: adds `start_on`, which serves on a listener already bound.
- `apps/photocraft-web/src/main.rs`, `web.rs`: `?control` query flag installs the browser control
  bridge (`window.photocraft`).
- `crates/ui-egui/src/control.rs`: new `app.place {path}` control method (File › Place Embedded
  without its picker), with a test.
- `crates/ui-egui/src/canvas.rs`, `wheel_nav.rs`: a wheel zoom notch glides in over about 0.1 s
  instead of one frame; browser wheel pixels are counted as notches (120 px). Tests updated.
- `crates/ui-egui/src/lib.rs`, `menus.rs`, `state.rs`: the Chat panel as a toggle
  (`window.toggle.chat`, Window menu) and its state flag.
- `crates/ui-egui/src/i18n/*.tsv` (16 locales): one added "Chat" string each.
- `crates/ui-egui/src/input_tests.rs`: test expectations for the gliding zoom.
- `docs/control-protocol.md`: documents `app.place`.
- `docs/development.md`: documents the browser control bridge in place of "no control server".
- `xtask/src/layers.rs`: registers the `assistant` crate as a standalone layer.

### Untracked files (what they appear to do)

- `crates/assistant/` (`Cargo.toml`, `src/lib.rs`, `claude.rs`, `codex.rs`, `cursor.rs`,
  `process.rs`, `runner.rs`): the Chat panel's model runner. It drives the Claude, Codex and Cursor
  CLIs over stdio (print mode or JSON-RPC) and gives them PhotoCraft's MCP bridge as tools.
- `apps/photocraft/src/chat.rs`: desktop side of the Chat panel. It sets up the control server the
  models reach the window through, and the runner.
- `apps/photocraft-web/src/control_bridge.rs`: the in-browser control bridge
  (`window.photocraft` with an in-memory file store standing in for disk).
- `crates/ui-egui/src/chat_panel.rs`: the Chat column beside the dock (transcript, composer).

## Re-apply onto a fresh clone

```sh
git clone https://github.com/storytold/photocraft.git photocraft
cd photocraft
git checkout 953390a36ef59c6ca04c5850b5b5d9d0dd9e625a
git apply --check --binary /path/to/patches/photocraft-rocketv1/tracked.patch
git apply --binary /path/to/patches/photocraft-rocketv1/tracked.patch
cp -a /path/to/patches/photocraft-rocketv1/untracked/. .
```

(`git checkout <hash>` leaves a detached HEAD, which is fine for applying the patch. Use a
branch if you want to keep the result.)

## Verification

See the task report: a temporary clone at the base commit, the patch applied, the untracked files
copied, and `git diff --stat HEAD` compared with the original.
