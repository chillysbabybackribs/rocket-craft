# Per-app toolkits for Craft Studio

Read-only research, 2026-10-11. All 12 apps cloned at their pinned tags (`git clone --depth 1 --branch v<version>` into `/tmp/craft-tk/<app>`; versions as in `src/shared/craft-apps.ts`). Nothing was built or run. Companion file: `toolkits.json` (`{app: [{name, description, inputSchema, control, source, live, origin, writes, estTokens}]}`). Evidence (command-registry extracts with file:line, and the MCP inventory) is in `docs/orchestrator/00dcd7ac-7008-4c86-bb48-f9bcd0892975/task-0016-evidence/`.

## 1. Answer in short

- **Every app can get a specific toolkit of 11–16 tools at about 0.9k–1.5k tokens (1.3k–2.0k with per-tool wrapper overhead), well under the 3k cap.** No app needs trimming; the only budget threat is mirroring an app's whole MCP set (LightCraft alone generates ~300 `cmd_*` tools) and that is a "do not".
- **Eleven apps map almost entirely onto `engine.execute {command, params}` plus a few direct control methods** (`sheet.read`, `cell.get`, `ui.render`, `cmdline.input`, `render.frame`, `jobs.list`). The MCP wrappers are thin: most of their value is client-side composition (set 10 properties with 10 commands, fix up arguments, take a screenshot and read the file). The host can do all of that without the bridge process; the list of what has to be ported is in §3.2.
- **PdfCraft is the exception.** Its MCP server (124 tools, +2 meta tools in compact mode) is headless-only and never touches the running app. The control channel only has `ui.state`, `ui.set`, `ui.command {id}` (no params), `ui.open`, `ui.click/drag/type/key`, `ui.screenshot`. The live toolkit is therefore small (7 tools; `ui.state` is already `craft_inspect`) and the file operations (`pdf_file_*`, 6 tools) are proposed as one-shot `pdfcraft-cli` calls on files on disk, which is a decision for the user (§7, Q1).
- **74 of the 166 proposed tools are the app's own MCP tools, kept under a `<shortid>_<verb>` name**; the other 92 are new helpers built from the command registry; they concentrate in PhotoCraft, SoundCraft, PdfCraft, CADCraft and WordCraft, whose own MCP sets are generic or headless-only. Everything that duplicates a core `craft_*` tool (list/run/batch/inspect/open/save/screenshot/undo/UI clicks) is cut.
- **Two things in the current host code deserve a look** (found while mapping, §3.3): EffectCraft `render.frame` is listed as an engine command in `craft-adapters.ts` but is a direct control method, and DesignCraft / VectorCraft `command_batch` expect `$N.path` back-references that `craft_batch` would have to implement to match.

## 2. Conventions

- **Names:** `<shortid>_<verb>`: grid, photo, vector, film, light, pdf, effect, design, sound, deck, cad, word. No upstream brand name in any tool name or description.
- **Control templates** (`control` in `toolkits.json`): `{"via":"engine.execute","command":C,"params":P}` is `engine.execute {command:C, params:P}` (for PdfCraft the equivalent is `ui.command {id}`, no params); `{"method":M,"params":P}` is a direct control method; `{"steps":[…]}` runs the listed calls in order and skips a step whose `$args` were not given; `{"switch":"action", a:…, b:…}` picks the call by that argument; `{"cli":…}` is a one-shot CLI run. In params: `$name` = the tool argument, `$name?` = pass only if present, `"$*"` = pass every argument through, `$tmp` = a temp file the host reads back and deletes.
- **Live?** `live` = reaches the running app over its control channel (what the user watches change). `cli` = operates on files via a one-shot CLI, not the open document. The own-MCP tables use *both* (works headless and bridged), *app-only* (needs the window) and *headless-only* (no control equivalent).
- **Tokens:** `ceil(len(JSON of {name, description, inputSchema}) / 4)`, computed by the generator over `toolkits.json`. A real tool list adds roughly 25–40 tokens of wrapper per tool; the summary table shows both. Own-MCP sets were not measured (running the CLIs was out of scope).
- **Citations** are `file:line` at the pinned tag, relative to the repo root; `a/b` means definition line / dispatch line.

## 3. Cross-cutting findings

### 3.1 What the core `craft_*` set already covers (so app toolkits leave it out)

| Core tool | Replaces these own-MCP tools |
|---|---|
| `craft_commands` | `list_commands` / `command_list` / `describe_command` (all 12 apps; PdfCraft answers `ui.commands`) |
| `craft_run`, `craft_batch` | `execute` / `run_command` / `command_run` / `batch` / `command_batch`, `invoke_menu`, `call_app`, `control_call`, every `ui_*` click/drag/key/type/pointer/tool/menu/dialog tool, `undo`/`redo` |
| `craft_inspect` | `inspect_*` / `doc_inspect` / `get_project` / `get_state`, `ui_inspect` |
| `craft_open`, `craft_save` | `open_*` / `doc_open` / `open_project`, `save_*` / `doc_save` / `doc_export` / `export`, `export_png`, `bounce_mix` for formats the adapter exports |
| `craft_screenshot` | `screenshot`, `ui_screenshot`, `render_preview` (window capture) |

What the core set cannot do and the toolkits therefore keep: **document rendering** (not a window capture: `ui.render` in Deck/Design/Word/CAD/Light, `render.frame` in Effect, the Program-monitor frame in Film), **composite edits** (several commands for one intent) and **named, typed arguments** for the 10–15 operations a model does all day. That second point is the real reason to have app tools: `craft_run` takes a free-form `params` object that the model has to get right from `craft_commands` output; a typed tool puts the parameter names in its schema.

### 3.2 Client-side logic the host must port (we do not run the MCP bridge)

| App | MCP tool | What the wrapper does besides one control call | Source |
|---|---|---|---|
| GridCraft | `format_range` | up to 11 `home.*` commands, one per property, stops at the first failure and reports which were applied | crates/mcp/src/tools.rs:445-505 |
| GridCraft | `sort_range`, `filter` | turns `"B desc"` into `{column, order}`; `filter` sends `selection.set` first when `range` is given | tools.rs:507-544 |
| GridCraft | `save_workbook` | refuses a never-saved workbook without a path (`document.inspect` path is null) | tools.rs:545-553 |
| VectorCraft | `command_batch` | replaces params that are exactly `"$N.path"` / `"$last.path"` with an earlier step's result; `"$$"` is a literal `$` | crates/mcp/src/tools.rs:96-104 (description), 899 (`command_batch`) |
| VectorCraft | `draw_shape`, `draw_path`, `transform`, `add_text` | map `[x,y]` points to anchors, pick `shape.*`, apply `paint.*` to the new id, run move→rotate→scale→reflect→shear in order after `select.set` | tools.rs:521-640 |
| DesignCraft | `batch` | same `"$N.path"` / `"$last.path"` / `"${N.path}"` substitution, plus a `script` form (one `command.id {json}` per line) | crates/mcp/src/tools.rs:114-136 (description), 452 (`batch`) |
| DesignCraft | `set_story_text` | finds the story id from a frame via `story.get`, then `story.setText`, then `story.get` | tools.rs:468 (`story_id`), 539-544 |
| DeckCraft | `add_shape`, `add_text_box` | `shape.insert` then `shape.fill`/`shape.line` on the new id; `insert.textBox`, `text.exit`, `edit.select`, then `format.size/color/align` | tools.rs:353-391 |
| LightCraft | `import` | expands folders to files recursively (`expand_paths`) before `library.import` | tools.rs:624-658; `expand_paths` in crates/mcp/src/headless.rs:168 |
| LightCraft | `set_develop` | `library.select` if `id`, `develop.set` for `values`, `develop.merge` for `settings`, then `develop.controls` to echo the touched sliders | tools.rs:659-695 |
| LightCraft | `render_photo` | `ui.render` writes a temp PNG; the wrapper reads it, optionally downscales/re-encodes, deletes it, and refuses a path that is a photo's original (`export.checkTarget`) | tools.rs:488-515 |
| FilmCraft | `command_run` (bridge) | long exports (`LONG_COMMANDS` with `wait:true`) are started with `wait:false` and polled with `jobs.list` every poll interval, because the control server answers within 60 s | crates/automation/src/bridge.rs:41-70, long_job.rs:24 |
| FilmCraft | `render_frame` (bridge) | `playhead.set` to the time, `ui.screenshot {panel:"Program"}`, then restores playhead and selection | crates/automation/src/server.rs:417-466 |
| EffectCraft | `add_effect`, `add_keyframe`, `set_property` | `layer.tree` before/after to compute `effects/#n`; `engine.batch` of `effect.apply` + `prop.set`; `keys.select` + `keys.easyEase` for interpolation | crates/automation/src/tools.rs:218-253, 316-390 |
| PhotoCraft | `command_run` with `wait` | long filters, Content-Aware Fill, Photomerge run as jobs when `wait:false` (`{job}`), polled with `jobs.list` | crates/automation/src/server.rs:649, 779-800 |
| WordCraft | `type_text` | with `paragraphs:true` splits on `\n` and sends `text.newParagraph` between `text.insert {raw:true}` calls | crates/mcp/src/tools.rs:221-240 |

### 3.3 Discrepancies seen between the sources and `src/host/tools/craft-adapters.ts`

1. **EffectCraft `render.frame` is a control method, not an engine command.** The adapter lists it under `exports` with `viaEngine: true` (`craft-adapters.ts`, effectcraft entry). The app registers it as a direct method (`crates/ui-egui/src/control.rs:426`), the MCP bridge calls it directly with `b.call("render.frame", …)` (`crates/automation/src/backend.rs:125`), and the engine registry extract has no command of that name (`grep -rn render.frame crates` hits only those two places). Via `engine.execute` it would most likely answer "unknown command". Its params: `{comp?, time? | seconds?, max_side? | maxSide?, transparent?, base64?, path?}`; without `base64` it writes the PNG to `path` (default a temp file) and answers its path (`control.rs:453-490`).
2. **FilmCraft/EffectCraft control servers answer within 60 s.** Exports must go through the job path of §3.2 or `craft_run` will time out on a long `file.exportMedia`.
3. **GridCraft's own tool text says `{"command":"sheet.insert"}`; the registry id is `home.insertSheet`** (`crates/engine/src/cmd/sheet.rs:40`); `sheet.insert` does not exist. `grid_sheet` uses the real ids.
4. **PhotoCraft `ui_screenshot`/`doc_render_preview` in bridge mode capture the window**, not the flattened image (`server.rs:577-598`); a flattened render in bridge mode needs `document.pixel` sampling, `file.export`/`app.save` to a path, or `ui.screenshot`. `photo_pixel` exists for colour checks; a flattened-image tool is not available over the channel (see §7, Q3).
5. **LightCraft generates one `cmd_<id>` MCP tool per registry command** (`tools.rs:331-356`, on by default, `server.rs:70`). ~300 commands × ~60 tokens ≈ 18k tokens. Never mirror.
6. **WordCraft/GridCraft/others read param docs from `engine.commands`**; those strings are the ground truth used for every schema here. Where a registry entry has no param string (for example WordCraft `para.heading1`), the extract printed the next entry's string; those were not used.

### 3.4 Safety and rules that carry over

- Toolkits never expose quit/close/window/dialog commands. The existing `refused` table in `craft-adapters.ts` still applies to anything sent through `engine.execute`, because the toolkit tools are only a different way of building the same call.
- Tools that write files (`light_export`, `design_export`, `film_export`, `sound_bounce`, `pdf_file_*`) go through the same path checks as `craft_save` (roots for PhotoCraft/VectorCraft; "any" for the rest) and the dialog-command guard (`DIALOG_COMMAND` regex).
- `writes: false` in `toolkits.json` marks read-only tools so the host can advertise `readOnlyHint`.

## 4. Summary

| App | Own MCP tools | Kept (renamed) | New | Toolkit size | ~tokens (schema) | ~tokens (+30/tool wrapper) | ≤ 3k? |
|---|---:|---:|---:|---:|---:|---:|---|
| PhotoCraft 0.7.0 (`photo_`) | 21 | 2 | 11 | 13 | 1345 | 1735 | yes |
| VectorCraft 0.9.0 (`vector_`) | 32 | 9 | 4 | 13 | 1483 | 1873 | yes |
| FilmCraft 0.6.0 (`film_`) | 17 | 3 | 11 | 14 | 1193 | 1613 | yes |
| LightCraft 0.6.0 (`light_`) | 28 + ~300 `cmd_*` | 10 | 6 | 16 | 1323 | 1803 | yes |
| PdfCraft 0.6.0 (`pdf_`) | 124 (+2 compact-mode meta) | 0 | 13 | 13 | 929 | 1319 | yes |
| EffectCraft 0.8.0 (`effect_`) | 36 | 11 | 2 | 13 | 1120 | 1510 | yes |
| DesignCraft 0.6.0 (`design_`) | 25 | 5 | 7 | 12 | 1058 | 1418 | yes |
| SoundCraft 0.5.0 (`sound_`) | 17 | 2 | 13 | 15 | 1268 | 1718 | yes |
| DeckCraft 0.5.0 (`deck_`) | 25 | 11 | 4 | 15 | 1395 | 1845 | yes |
| CADCraft 0.5.0 (`cad_`) | 14 | 5 | 11 | 16 | 1534 | 2014 | yes |
| WordCraft 0.5.0 (`word_`) | 16 | 5 | 6 | 11 | 878 | 1208 | yes |
| GridCraft 0.5.0 (`grid_`) | 21 | 11 | 4 | 15 | 1504 | 1954 | yes |

Own-MCP counts are the tool names in each server's table (the per-app tables below group aliases and long runs of near-identical tools into one row). PdfCraft: 124 distinct `t("…")` names in `tools.rs:117-1111` (the `command_*`, `doc_inspect` and `render_preview` tools are among them); `tool_search`/`tool_call` exist only in compact mode (`mcp.rs:49-59`).

## 5. Per-app tables

### PhotoCraft 0.7.0 — prefix `photo_`

MCP source: `crates/automation/src/server.rs`. rmcp `#[tool]` server; bridge mode forwards to the control channel (`engine.execute`, `ui.*`, `jobs.*`).
Control-channel facts used: `engine.execute` takes `wait` for long commands (`crates/automation/src/server.rs:779-790`); `jobs.list` / `jobs.cancel` are engine commands (`crates/engine/src/jobs.rs:767`) and control methods (`crates/ui-egui/src/control.rs:312`); `ui.screenshot` at `control.rs:947`.

**A. The app's own MCP tools** (21 rows; 19 rows work against the running app)

| Own tool | Source (def/dispatch) | Live? | Decision | Maps to |
|---|---|---|---|---|
| `session_list` | `server.rs`:496 | both | cut → craft_apps / craft_inspect | headless: session; bridge: ui.inspect |
| `doc_open` | `server.rs`:507 | both | cut → craft_open | app.open |
| `doc_new` | `server.rs`:519 | both | keep → photo_new (no core equivalent) | engine.execute file.new |
| `doc_save` | `server.rs`:544 | both | cut → craft_save | app.save {path, format, quality, tiffLayers} |
| `doc_export` | `server.rs`:549 | both | cut → craft_save | app.save {path} |
| `doc_inspect` | `server.rs`:557 | both | cut → craft_inspect | engine.execute document.inspect |
| `doc_render_preview` | `server.rs`:578 | both | cut → craft_screenshot | bridge: window screenshot (not the flattened image) |
| `render_preview` | `server.rs`:596 | both | cut → craft_screenshot | same as doc_render_preview |
| `doc_select` | `server.rs`:601 | headless-only | cut | no bridge equivalent (bridge_only_headless) |
| `doc_close` | `server.rs`:609 | headless-only | cut | no bridge equivalent; Craft Studio never closes documents for a model |
| `command_list` | `server.rs`:617 | both | cut → craft_commands | engine.commands |
| `command_run` | `server.rs`:649 | both | cut → craft_run | engine.execute {command, params, wait} |
| `jobs_list` | `server.rs`:655 | both | keep → photo_jobs | jobs.list |
| `jobs_cancel` | `server.rs`:661 | both | keep → photo_jobs | jobs.cancel |
| `command_batch` | `server.rs`:667 | both | cut → craft_batch | client-side loop over engine.execute |
| `ui_inspect` | `server.rs`:713 | app-only | cut → craft_inspect {what:"ui"} | ui.inspect |
| `ui_screenshot` | `server.rs`:721 | app-only | cut → craft_screenshot | ui.screenshot |
| `ui_pointer` | `server.rs`:731 | app-only | cut → craft_run ui.pointer | ui.pointer |
| `ui_menu_invoke` | `server.rs`:748 | app-only | cut → craft_run ui.menu.invoke | ui.menu.invoke {id} |
| `ui_set` | `server.rs`:758 | app-only | cut → craft_run ui.set | ui.set |
| `control_call` | `server.rs`:766 | app-only | cut → craft_run | any control method |

**B. Proposed toolkit** — 13 tools, ~1345 tokens (~1735 with wrapper overhead)

| Tool | Maps to | Live? | Keep/Cut | ~tok | Source |
|---|---|---|---|---:|---|
| `photo_new` | engine.execute `file.new` | live | keep (own MCP tool) | 100 | mcp `server.rs`:519; `file.new` engine/src/commands.rs:338 |
| `photo_add_layer` | by `kind`: pixel→`layer.new.layer`; group→`layer.new.group`; solid→`layer.newFillLayer.solidColor`; gradient→`layer.newFillLayer.gradient` | live | keep (new, from registry) | 145 | `layer.new.layer` engine/src/commands.rs:521; `layer.new.group` engine/src/commands.rs:531; +2 more in toolkits.json |
| `photo_layer_set` | engine.execute `layer.setProps` | live | keep (new, from registry) | 130 | `layer.setProps` engine/src/commands.rs:602 |
| `photo_layer_op` | by `action`: duplicate→`layer.duplicate`; delete→`layer.delete`; merge_down→`layer.mergeDown`; merge_visible→`layer.mergeVisible`; flatten→`layer.flattenImage` | live | keep (new, from registry) | 72 | `layer.duplicate` engine/src/commands.rs:550; `layer.delete` engine/src/commands.rs:575; +3 more in toolkits.json |
| `photo_select` | by `shape`: rect→`select.rect`; ellipse→`select.rect`; all→`select.all`; none→`select.deselect`; invert→`select.inverse`; subject→`select.subject`; color_range→`select.colorRange` | live | keep (new, from registry) | 144 | `select.rect` engine/src/commands.rs:450; `select.all` engine/src/commands.rs:421; +4 more in toolkits.json |
| `photo_fill` | `tools.setColors` → `edit.fill` | live | keep (new, from registry) | 94 | `edit.fill` engine/src/commands.rs:391; `tools.setColors` engine/src/commands.rs:894 |
| `photo_adjust` | engine.execute `layer.newAdjustmentLayer.<kind> \| image.adjustments.<kind>` — ids are generated at commands.rs:1077-1078 from the ADJ table | live | keep (new, from registry) | 157 | `layer.setAdjustment` engine/src/commands.rs:816; `layer.newAdjustmentLayer.<kind> (generated from the ADJ table)` engine/src/commands.rs:1077-1093 |
| `photo_filter` | engine.execute `filter.<filter>` | live | keep (new, from registry) | 91 | `filter.blur.gaussianBlur` engine/src/filters.rs:331 |
| `photo_text` | engine.execute `type.create` | live | keep (new, from registry) | 116 | `type.create` engine/src/type_cmds.rs:613 |
| `photo_mask` | by `action`: reveal_all→`layer.layerMask.revealAll`; hide_all→`layer.layerMask.hideAll`; from_selection→`layer.layerMask.revealSelection`; hide_selection→`layer.layerMask.hideSelection`; delete→`layer.layerMask.delete`; apply→`layer.layerMask.apply` | live | keep (new, from registry) | 81 | `layer.layerMask.revealAll` engine/src/commands.rs:695; `layer.layerMask.hideAll` engine/src/commands.rs:704; +3 more in toolkits.json |
| `photo_canvas` | by `op`: image_size→`image.imageSize`; canvas_size→`image.canvasSize`; crop→`image.crop` | live | keep (new, from registry) | 107 | `image.imageSize` engine/src/image_cmds.rs:632; `image.canvasSize` engine/src/image_cmds.rs:640; +1 more in toolkits.json |
| `photo_jobs` | by `action`: list→`jobs.list`; cancel→`jobs.cancel` | live | keep (own MCP tool) | 61 | mcp `server.rs`:655; `jobs.list` engine/src/jobs.rs:767 |
| `photo_pixel` | engine.execute `document.pixel` | live, read-only | keep (new, from registry) | 47 | `document.pixel` engine/src/commands.rs:1000 |

**Cap:** 1735 ≤ 3000 — nothing to cut. If a future cap is tighter, drop in this order: `photo_pixel`, `photo_jobs`, `photo_canvas`.

### VectorCraft 0.9.0 — prefix `vector_`

MCP source: `crates/mcp/src/tools.rs` (+ `crates/mcp/src/*.rs`). Hand-written `tool()` table; remote backend forwards to the control channel; `docs/mcp.md` documents both backends.
Control-channel facts used: `ui.render` (`crates/ui-egui/src/control.rs:321`) answers `pngBase64`; commands, `document.inspect`, `ui.*` as in `docs/control-protocol.md`; file roots `--automation-read-root/--automation-write-root` apply to every path a command reads or writes (`docs/mcp.md`).

**A. The app's own MCP tools** (32 rows; 32 rows work against the running app)

| Own tool | Source (def/dispatch) | Live? | Decision | Maps to |
|---|---|---|---|---|
| `command_list` | `tools.rs`:83/729 | both | cut → craft_commands | engine.commands |
| `list_commands` | `tools.rs`:129/740 | both | cut → craft_commands | engine.commands (alias) |
| `command_run` | `tools.rs`:90/745 | both | cut → craft_run | engine.execute |
| `run_command` | `tools.rs`:139/745 | both | cut → craft_run | engine.execute (alias) |
| `invoke_menu` | `tools.rs`:281/745 | both | cut → craft_run | engine.execute (same call, kept for menu ids) |
| `command_batch` | `tools.rs`:97/737 | both | cut → craft_batch (must support "$N.path" refs, command_batch at tools.rs) | client-side loop with $N.path substitution |
| `doc_inspect` | `tools.rs`:107/755 | both | cut → craft_inspect | document.inspect {depth, childLimit} |
| `inspect_document` | `tools.rs`:149/755 | both | cut → craft_inspect | document.inspect (alias) |
| `render_preview` | `tools.rs`:114/738 | both | cut → craft_screenshot | ui.render {scale} |
| `ui_inspect` | `tools.rs`:120/761 | app-only | cut → craft_inspect {what:"ui"} | ui.inspect |
| `inspect_ui` | `tools.rs`:162/761 | app-only | cut | ui.inspect (alias) |
| `ui_screenshot` | `tools.rs`:122/739 | app-only | cut → craft_screenshot | ui.screenshot {data:true} |
| `screenshot` | `tools.rs`:295/820 | both | cut → craft_screenshot | ui.render / ui.screenshot |
| `select_tool` | `tools.rs`:169/765 | both | cut → craft_run ui.tool.select | ui.tool.select |
| `pointer_gesture` | `tools.rs`:176/766 | both | cut → craft_run ui.pointer | ui.pointer |
| `press_key` | `tools.rs`:264/803 | both | cut → craft_run ui.key | ui.key |
| `type_text` | `tools.rs`:274/812 | app-only | cut → craft_run ui.text | ui.text |
| `open_panel` | `tools.rs`:288/816 | app-only | cut → craft_run ui.set {panel} | ui.set |
| `open_file` | `tools.rs`:310/821 | both | cut → craft_open | app.open |
| `save_file` | `tools.rs`:320/822 | both | cut → craft_save | app.save |
| `export` | `tools.rs`:330/823 | both | cut → craft_save | app.export |
| `undo` | `tools.rs`:454/877 | both | cut → craft_run edit.undo | edit.undo |
| `redo` | `tools.rs`:455/878 | both | cut → craft_run edit.redo | edit.redo |
| `draw_path` | `tools.rs`:201/794 | both | keep → vector_draw_path | path.create + paint.setFill/setStroke + stroke.set |
| `draw_shape` | `tools.rs`:218/795 | both | keep → vector_draw_shape | shape.rectangle\|ellipse\|polygon\|star\|line + paint |
| `set_paint` | `tools.rs`:249/796 | both | keep → vector_set_paint | paint.setFill / paint.setStroke / stroke.set |
| `add_text` | `tools.rs`:349/840 | both | keep → vector_add_text | text.create \| text.createInPath (+ type.pathOptions) |
| `apply_effect` | `tools.rs`:371/841 | both | keep → vector_effect | effect.apply / effect.list |
| `pathfinder` | `tools.rs`:385/852 | both | keep → vector_pathfinder | select.set + object.pathfinder.<op> |
| `transform` | `tools.rs`:398/856 | both | keep → vector_transform | object.move/rotate/scale/reflect/shear (in that order) |
| `create_graph` | `tools.rs`:420/857 | both | keep → vector_graph | graph.create |
| `text_wrap` | `tools.rs`:440/864 | both | keep → vector_text_wrap | object.textWrap.make / release |

**B. Proposed toolkit** — 13 tools, ~1483 tokens (~1873 with wrapper overhead)

| Tool | Maps to | Live? | Keep/Cut | ~tok | Source |
|---|---|---|---|---:|---|
| `vector_draw_shape` | `shape.<shape>` → `paint.setFill` → `paint.setStroke` → `stroke.set` | live | keep (own MCP tool) | 234 | mcp `tools.rs`:218/795; `shape.rectangle` engine/src/cmd/create.rs:12; `shape.ellipse` engine/src/cmd/create.rs:21; +4 more in toolkits.json |
| `vector_draw_path` | `path.create` → `paint.setFill\|setStroke, stroke.set` | live | keep (own MCP tool) | 116 | mcp `tools.rs`:201/794; `path.create` engine/src/cmd/create.rs:38 |
| `vector_set_paint` | `paint.setFill` → `paint.setStroke` → `stroke.set` | live | keep (own MCP tool) | 96 | mcp `tools.rs`:249/796; `paint.setFill` engine/src/cmd/paint.rs:14; `paint.setStroke` engine/src/cmd/paint.rs:23 |
| `vector_add_text` | engine.execute `text.create \| text.createInPath` | live | keep (own MCP tool) | 134 | mcp `tools.rs`:349/840; `text.create` engine/src/cmd/create.rs:56 |
| `vector_transform` | `select.set` → `object.move` → `object.rotate` → `object.scale` → `object.reflect` → `object.shear` | live | keep (own MCP tool) | 149 | mcp `tools.rs`:398/856; `object.move` engine/src/cmd/object.rs:30; `object.rotate` engine/src/cmd/object.rs:39; +3 more in toolkits.json |
| `vector_pathfinder` | `select.set` → `object.pathfinder.<operation>` | live | keep (own MCP tool) | 103 | mcp `tools.rs`:385/852; `object.pathfinder.unite` engine/src/cmd/pathops.rs:20 |
| `vector_effect` | engine.execute `effect.apply (no effect → effect.list)` | live | keep (own MCP tool) | 80 | mcp `tools.rs`:371/841; `effect.apply` engine/src/cmd/effectcmd.rs:21; `effect.list` engine/src/cmd/effectcmd.rs:30 |
| `vector_graph` | engine.execute `graph.create` | live | keep (own MCP tool) | 148 | mcp `tools.rs`:420/857; `graph.create` engine/src/cmd/graph.rs:23 |
| `vector_text_wrap` | `select.set` → `object.textWrap.make \| object.textWrap.release` | live | keep (own MCP tool) | 74 | mcp `tools.rs`:440/864; `object.textWrap.make` engine/src/cmd/textwrap.rs:17 |
| `vector_select` | engine.execute `select.set` | live | keep (new, from registry) | 51 | `select.set` engine/src/cmd/select.rs:28 |
| `vector_arrange` | by `action`: group→`object.group`; ungroup→`object.ungroup`; lock→`object.lock`; hide→`object.hide`; front→`object.arrange.bringToFront`; back→`object.arrange.sendToBack`; align→`object.align`; distribute→`object.distribute` | live | keep (new, from registry) | 124 | `object.group` engine/src/cmd/object.rs:102; `object.align` engine/src/cmd/object.rs:157; +2 more in toolkits.json |
| `vector_artboard` | by `action`: add→`artboard.new`; set→`artboard.setProps`; delete→`artboard.delete` | live | keep (new, from registry) | 92 | `artboard.new` engine/src/cmd/layer.rs:123; `artboard.setProps` engine/src/cmd/layer.rs:133; +1 more in toolkits.json |
| `vector_layer` | by `action`: add→`layer.new`; set→`layer.setProps`; delete→`layer.delete` | live | keep (new, from registry) | 82 | `layer.new` engine/src/cmd/layer.rs:24; `layer.setProps` engine/src/cmd/layer.rs:78; +1 more in toolkits.json |

**Cap:** 1873 ≤ 3000 — nothing to cut. If a future cap is tighter, drop in this order: `vector_artboard`, `vector_layer`, `vector_text_wrap`, `vector_graph`.

### FilmCraft 0.6.0 — prefix `film_`

MCP source: `crates/automation/src/server.rs`. rmcp server; the bridge client is `crates/automation/src/bridge.rs`.
Control-channel facts used: `playhead.set`, `timeline.*`, `effects.*`, `clip.*`, `file.*` are **engine commands**; `ui.screenshot {path, panel}` is a control method (`crates/ui-egui/src/control.rs:413`); the server answers within 60 s, long exports use `wait:false` + `jobs.list` (`crates/automation/src/bridge.rs:41-70`).

**A. The app's own MCP tools** (17 rows; 17 rows work against the running app)

| Own tool | Source (def/dispatch) | Live? | Decision | Maps to |
|---|---|---|---|---|
| `command_list` | `server.rs`:311 | both | cut → craft_commands | command.list (engine command) |
| `command_run` | `server.rs`:336 | both | cut → craft_run (add the long-job path: see report) | engine.execute (long exports: wait:false + jobs.list poll, bridge.rs:41-70) |
| `command_batch` | `server.rs`:345 | both | cut → craft_batch | client-side loop |
| `doc_inspect` | `server.rs`:372 | both | cut → craft_inspect | project.inspect + sequence.inspect |
| `render_preview` | `server.rs`:381 | both | cut → film_frame | playhead.set + ui.screenshot {panel:"Program"} (live) — same as render_frame |
| `project_inspect` | `server.rs`:390 | both | cut → craft_inspect | project.inspect |
| `sequence_inspect` | `server.rs`:399 | both | keep → film_sequence (craft_inspect only reads the project) | sequence.inspect |
| `media_import` | `server.rs`:408 | both | keep → film_import | file.import |
| `render_frame` | `server.rs`:417 | both | keep → film_frame | live: playhead.set, ui.screenshot {panel:"Program"}, restore playhead/selection |
| `ui_inspect` | `server.rs`:474 | app-only | cut → craft_inspect {what:"ui"} | ui.inspect |
| `ui_elements` | `server.rs`:483 | app-only | cut → craft_run ui.elements | ui.elements |
| `ui_click` | `server.rs`:492 | app-only | cut → craft_run ui.click | ui.click |
| `ui_drag` | `server.rs`:508 | app-only | cut → craft_run ui.drag | ui.drag |
| `ui_key` | `server.rs`:517 | app-only | cut → craft_run ui.key | ui.key |
| `ui_type` | `server.rs`:526 | app-only | cut → craft_run ui.type | ui.type |
| `ui_screenshot` | `server.rs`:535 | app-only | cut → craft_screenshot | ui.screenshot {panel} |
| `ui_control` | `server.rs`:547 | app-only | cut → craft_run | any control method |

**B. Proposed toolkit** — 14 tools, ~1193 tokens (~1613 with wrapper overhead)

| Tool | Maps to | Live? | Keep/Cut | ~tok | Source |
|---|---|---|---|---:|---|
| `film_sequence` | engine.execute `sequence.inspect` | live, read-only | keep (own MCP tool) | 56 | mcp `server.rs`:399; `sequence.inspect` engine/src/commands.rs:2914 |
| `film_import` | engine.execute `file.import` | live | keep (own MCP tool) | 74 | mcp `server.rs`:408; `file.import` engine/src/commands.rs:1017 |
| `film_frame` | `playhead.set` → `ui.screenshot` | live, read-only | keep (own MCP tool) | 56 | mcp `server.rs`:417; `playhead.set` engine/src/commands.rs:2102 |
| `film_new_sequence` | engine.execute `file.newSequence` | live | keep (new, from registry) | 101 | `file.newSequence` engine/src/commands.rs:873 |
| `film_place` | engine.execute `timeline.place` | live | keep (new, from registry) | 109 | `timeline.place` engine/src/commands.rs:2182 |
| `film_cut` | engine.execute `timeline.razor` | live | keep (new, from registry) | 70 | `timeline.razor` engine/src/commands.rs:2466 |
| `film_trim` | engine.execute `timeline.trim` | live | keep (new, from registry) | 94 | `timeline.trim` engine/src/commands.rs:2286 |
| `film_move` | engine.execute `timeline.move` | live | keep (new, from registry) | 78 | `timeline.move` engine/src/commands.rs:2277 |
| `film_delete` | `timeline.select` → `edit.rippleDelete (ripple:true) \| edit.clear (leaves a gap)` | live | keep (new, from registry) | 56 | `edit.rippleDelete` engine/src/commands.rs:1343; `edit.clear` engine/src/commands.rs:1319; +1 more in toolkits.json |
| `film_effect` | by `action`: apply→`effects.apply`; set→`effects.setParam`; remove→`effects.remove` | live | keep (new, from registry) | 130 | `effects.apply` engine/src/commands.rs:2545; `effects.setParam` engine/src/commands.rs:2598; +1 more in toolkits.json |
| `film_clip` | `clip.speedDuration` → `clip.audioGain` → `clip.rename` | live | keep (new, from registry) | 89 | `clip.speedDuration` engine/src/commands.rs:1431; `clip.audioGain` engine/src/commands.rs:1605; +1 more in toolkits.json |
| `film_playhead` | engine.execute `playhead.set` | live | keep (new, from registry) | 63 | `playhead.set` engine/src/commands.rs:2102 |
| `film_track` | `timeline.setTrack` → `sequence.addTracks` | live | keep (new, from registry) | 116 | `timeline.setTrack` engine/src/commands.rs:2479; `sequence.addTracks` engine/src/commands.rs:1785 |
| `film_export` | engine.execute `file.exportMedia` — poll jobs.list via engine.execute until finished (bridge.rs:41-70); the control server answers within 60 s | live | keep (new, from registry) | 101 | `file.exportMedia` engine/src/commands.rs:1283 |

**Cap:** 1613 ≤ 3000 — nothing to cut. If a future cap is tighter, drop in this order: `film_track`, `film_playhead`, `film_clip`.

### LightCraft 0.6.0 — prefix `light_`

MCP source: `crates/mcp/src/tools.rs` (+ `crates/mcp/src/*.rs`). Hand-written helpers plus generated `cmd_*` tools.
Control-channel facts used: `ui.render {id, size, path}` (`crates/ui-egui/src/control.rs:387`) writes a PNG to `path`; the library, develop and album calls are engine commands; the app has no document, so `craft_open` imports (adapter) and nothing is "saved".

**A. The app's own MCP tools** (25 rows; 25 rows work against the running app)

| Own tool | Source (def/dispatch) | Live? | Decision | Maps to |
|---|---|---|---|---|
| `command_list / list_commands` | `tools.rs`:82/559, 127/559 | both | cut → craft_commands | engine.commands |
| `command_run / run_command` | `tools.rs`:92/578, 134/620 | both | cut → craft_run | engine.execute |
| `command_batch` | `tools.rs`:99/582 | both | cut → craft_batch | client-side loop (stop_on_error) |
| `doc_inspect` | `tools.rs`:109/612 | both | cut → craft_inspect | library.state + catalog.stats (two engine commands) |
| `render_preview` | `tools.rs`:116/613 | both | keep → light_render | ui.render {id, size, path} then read the file |
| `render_photo` | `tools.rs`:215/709 | both | keep → light_render | ui.render (same, with optional save path) |
| `import` | `tools.rs`:141/624 | both | keep → light_import | library.import (folders expanded client-side by expand_paths) |
| `query_photos` | `tools.rs`:156/647 | both | keep → light_photos | catalog.query |
| `select_photos` | `tools.rs`:168/648 | both | keep → light_select | library.select |
| `list_controls` | `tools.rs`:175/657 | both | keep → light_controls | develop.controls |
| `get_develop` | `tools.rs`:182/658 | both | keep → light_develop_get | library.select (if id) + develop.get |
| `set_develop` | `tools.rs`:189/659 | both | keep → light_develop | library.select + develop.set + develop.merge + develop.controls |
| `apply_preset` | `tools.rs`:201/691 | both | keep → light_preset | preset.apply |
| `crop` | `tools.rs`:208/702 | both | keep → light_crop | crop.set / crop.reset |
| `export` | `tools.rs`:227/710 | both | keep → light_export | library.select (if id) + app.export |
| `screenshot / ui_screenshot` | `tools.rs`:273/752, 270/752 | app-only | cut → craft_screenshot | ui.screenshot {path} |
| `ui_inspect / inspect_ui` | `tools.rs`:269/753, 279/753 | app-only | cut → craft_inspect {what:"ui"} | ui.inspect |
| `set_ui` | `tools.rs`:281/754 | app-only | cut → craft_run ui.set | ui.set |
| `list_widgets` | `tools.rs`:288/755 | app-only | cut → craft_run ui.widgets | ui.widgets |
| `click` | `tools.rs`:295/756 | app-only | cut → craft_run ui.click / ui.clickWidget | ui.click, ui.clickWidget |
| `press_key` | `tools.rs`:302/767 | app-only | cut → craft_run ui.key | ui.key |
| `type_text` | `tools.rs`:308/768 | app-only | cut → craft_run ui.text | ui.text |
| `clipboard` | `tools.rs`:310/769 | app-only | cut → craft_run ui.clipboard | ui.clipboard |
| `pointer_gesture` | `tools.rs`:317/770 | app-only | cut → craft_run ui.pointer | ui.pointer |
| `cmd_<id> (one generated tool per registry command, ~300)` | tools.rs:331-356, server.rs:70 | both | CUT, never mirror (≈ 300 tools ≈ 15k+ tokens) | engine.execute {command: id} |

**B. Proposed toolkit** — 16 tools, ~1323 tokens (~1803 with wrapper overhead)

| Tool | Maps to | Live? | Keep/Cut | ~tok | Source |
|---|---|---|---|---:|---|
| `light_import` | engine.execute `library.import` | live | keep (own MCP tool) | 111 | mcp `tools.rs`:141/624; `library.import` engine/src/cmd/library.rs:1324 |
| `light_photos` | engine.execute `catalog.query` | live, read-only | keep (own MCP tool) | 77 | mcp `tools.rs`:156/647; `catalog.query` engine/src/cmd/query.rs:64 |
| `light_select` | engine.execute `library.select` | live | keep (own MCP tool) | 78 | mcp `tools.rs`:168/648; `library.select` engine/src/cmd/library.rs:524 |
| `light_controls` | engine.execute `develop.controls` | live, read-only | keep (own MCP tool) | 59 | mcp `tools.rs`:175/657; `develop.controls` engine/src/cmd/query.rs:167 |
| `light_develop_get` | `library.select` → `develop.get` | live, read-only | keep (own MCP tool) | 49 | mcp `tools.rs`:182/658; `develop.get` engine/src/cmd/query.rs:154 |
| `light_develop` | `library.select` → `develop.set` → `develop.merge` → `develop.controls` | live | keep (own MCP tool) | 102 | mcp `tools.rs`:189/659; `develop.set` engine/src/cmd/develop.rs:144; `develop.merge` engine/src/cmd/develop.rs:223 |
| `light_auto` | engine.execute `develop.auto` | live | keep (new, from registry) | 33 | `develop.auto` engine/src/cmd/develop.rs:340 |
| `light_preset` | engine.execute `preset.apply` | live | keep (own MCP tool) | 76 | mcp `tools.rs`:201/691; `preset.apply` engine/src/cmd/develop.rs:923 |
| `light_crop` | `library.select` → `crop.set` → `crop.reset` | live | keep (own MCP tool) | 71 | mcp `tools.rs`:208/702; `crop.set` engine/src/cmd/develop.rs:481; `crop.reset` engine/src/cmd/develop.rs:644 |
| `light_rate` | `photo.rate` → `photo.flag` → `photo.label` | live | keep (new, from registry) | 94 | `photo.rate` engine/src/cmd/library.rs:627; `photo.flag` engine/src/cmd/library.rs:642; +1 more in toolkits.json |
| `light_meta` | engine.execute `photo.setMeta` | live | keep (new, from registry) | 137 | `photo.setMeta` engine/src/cmd/library.rs:775 |
| `light_album` | by `action`: create→`album.create`; add→`album.addPhotos`; remove→`album.removePhotos` | live | keep (new, from registry) | 99 | `album.create` engine/src/cmd/library.rs:869; `album.addPhotos` engine/src/cmd/library.rs:1106; +1 more in toolkits.json |
| `light_filter` | `library.filter` → `library.sort` | live | keep (new, from registry) | 64 | `library.filter` engine/src/cmd/library.rs:348; `library.sort` engine/src/cmd/library.rs:463 |
| `light_copy_settings` | by `action`: copy→`develop.copy`; paste→`develop.paste`; sync→`develop.sync` | live | keep (new, from registry) | 78 | `develop.copy` engine/src/cmd/develop.rs:738; `develop.paste` engine/src/cmd/develop.rs:779; +1 more in toolkits.json |
| `light_export` | engine.execute `app.export` | live | keep (own MCP tool) | 124 | mcp `tools.rs`:227/710 |
| `light_render` | `ui.render` — id defaults to library.state selection.active; reads the temp file, re-encodes, optionally copies to path (tools.rs:495-515) | live, read-only | keep (own MCP tool) | 71 | mcp `tools.rs`:215/709 |

**Cap:** 1803 ≤ 3000 — nothing to cut. If a future cap is tighter, drop in this order: `light_filter`, `light_copy_settings`, `light_meta`, `light_album`.

### PdfCraft 0.6.0 — prefix `pdf_`

MCP source: `crates/automation/src/tools.rs`. Headless-only server (`crates/automation/src/mcp.rs`, `tools.rs`); no bridge to the running app. Control channel: `crates/ui-egui/src/control.rs` (JSON-RPC 2.0, token from the control file).
Control-channel facts used: JSON-RPC 2.0 control methods `ui.state`, `ui.commands`, `ui.command {id}`, `ui.set {key, value}`, `ui.open`, `ui.inspect`, `ui.click`, `ui.drag`, `ui.move`, `ui.type`, `ui.key`, `ui.screenshot` (`crates/ui-egui/src/control.rs:262-310`); `ui.set` keys: page, zoom, layout, rotate, find, select, panel, dialog, tool, quick, mode, comment, layer (`crates/ui-egui/src/lib.rs:1538-1760`). There is no `engine.execute`. The CLI usage block is `apps/pdfcraft-cli/src/main.rs:48-60`.

**A. The app's own MCP tools** (8 rows; 0 rows work against the running app)

| Own tool | Source (def/dispatch) | Live? | Decision | Maps to |
|---|---|---|---|---|
| `doc_open, doc_list, doc_info, doc_close, doc_save, doc_set_info, doc_inspect, doc_combine, doc_split, …` | `tools.rs`:121-1116 | headless-only | cut for the live app; offer as file tools (see pdf_file_*) | no control-channel equivalent: the MCP server edits its own in-memory documents (mcp.rs instructions) |
| `page_* (render, rotate, delete, move, insert_blank, insert_file, extract, replace, duplicate, number)` | `tools.rs`:121-1116 | headless-only | cut live; page_rotate/delete/duplicate approximated by pdf_page via ui.command | ui.command {id: page.*} takes no params and acts as the menu does |
| `text_extract, text_find, text_lines, text_paragraphs, text_edit` | `tools.rs`:121-1116 | headless-only | cut live; text via pdf_file_text (one-shot CLI) or ui.set find | ui.set {key:"find"} highlights; no text result |
| `comment_* (list, reply, set_status, mark, lock, edit, delete…), comments_*` | `tools.rs`:121-1116 | headless-only | cut live | no control equivalent; comments are drawn with ui.set quick + ui.drag |
| `form_*, stamp_custom, redact_*, content_*, link_*, bookmark_*, measure_*, sign_*, accessibility_*, pdfa_*, ocr_*, js_*, action_*, doc_compare*, doc_export_*, doc_optimize, doc_flatten, doc_reduce, doc_watermark, doc_background, …` | `tools.rs`:121-1116 | headless-only | cut live | same |
| `edit_undo / edit_redo` | `tools.rs`:121-1116 | headless-only | cut → craft_run ui.command edit.undo | ui.command |
| `command_list / command_run / command_batch / doc_inspect / render_preview` | `tools.rs`:121-1116 | headless-only | cut → craft_commands / craft_run / craft_batch / craft_inspect / craft_screenshot | ui.commands, ui.command, ui.state, ui.screenshot |
| `tool_search, tool_call (compact mode only)` | `tools.rs`:121-1116 | headless-only | cut | — |

**B. Proposed toolkit** — 13 tools, ~929 tokens (~1319 with wrapper overhead)

| Tool | Maps to | Live? | Keep/Cut | ~tok | Source |
|---|---|---|---|---:|---|
| `pdf_goto` | `ui.set` | live | keep (new, from registry) | 38 | `ui.set page` ui-egui/src/lib.rs:1636 |
| `pdf_view` | `ui.set` → `ui.set` | live | keep (new, from registry) | 95 | `ui.set zoom` ui-egui/src/lib.rs:1637; `ui.set layout` ui-egui/src/lib.rs:1638; +3 more in toolkits.json |
| `pdf_find` | `ui.set` | live | keep (new, from registry) | 52 | `ui.set find` ui-egui/src/lib.rs:1686 |
| `pdf_pages` | `ui.set` → `ui.set` | live | keep (new, from registry) | 67 | `ui.set select` ui-egui/src/lib.rs:1694 |
| `pdf_page` | `ui.command` — takes no params; result is {ran}; verify with pdf_state; live check needed for which actions open a dialog | live | keep (new, from registry) | 92 | `ui.command` ui-egui/src/control.rs:270, 617; `page.rotate` engine/src/commands.rs:332 |
| `pdf_tool` | `ui.set` | live | keep (new, from registry) | 87 | `ui.set quick` ui-egui/src/lib.rs:1700 |
| `pdf_comment_select` | `ui.set` | live | keep (new, from registry) | 61 | `ui.set comment` ui-egui/src/lib.rs:1753 |
| `pdf_file_info` | `pdfcraft-cli info <path> [--password PW]` (one-shot CLI, files on disk) | cli, read-only | keep (new, from registry) | 62 | `pdfcraft-cli info` apps/pdfcraft-cli/src/main.rs:49 |
| `pdf_file_text` | `pdfcraft-cli text <path> [--page N]` (one-shot CLI, files on disk) | cli, read-only | keep (new, from registry) | 54 | `pdfcraft-cli text` apps/pdfcraft-cli/src/main.rs:51 |
| `pdf_file_edit` | `pdfcraft-cli edit <path> --out <out> [--rotate …] [--delete …] [--move …] [--insert-blank …] [--title …] [--author …]` (one-shot CLI, files on disk) | cli | keep (new, from registry) | 128 | `pdfcraft-cli edit` apps/pdfcraft-cli/src/main.rs:52 |
| `pdf_file_combine` | `pdfcraft-cli combine <paths…> --out <out>` (one-shot CLI, files on disk) | cli | keep (new, from registry) | 54 | `pdfcraft-cli combine` apps/pdfcraft-cli/src/main.rs:54 |
| `pdf_file_extract` | `pdfcraft-cli extract <path> --pages <pages> --out <out>` (one-shot CLI, files on disk) | cli | keep (new, from registry) | 68 | `pdfcraft-cli extract` apps/pdfcraft-cli/src/main.rs:55 |
| `pdf_file_split` | `pdfcraft-cli split <path> (--every N \| --before P) [--out-dir DIR]` (one-shot CLI, files on disk) | cli | keep (new, from registry) | 71 | `pdfcraft-cli split` apps/pdfcraft-cli/src/main.rs:56 |

**Cap:** 1319 ≤ 3000 — nothing to cut. If a future cap is tighter, drop in this order: the six `pdf_file_*` tools (they are optional anyway).

### EffectCraft 0.8.0 — prefix `effect_`

MCP source: `crates/automation/src/tools.rs`. Static `TOOLS` table; bridge and headless backends (`backend.rs`).
Control-channel facts used: `render.frame` is a **direct control method** (`crates/ui-egui/src/control.rs:426`, handler `453-490`); `engine.batch` is an engine command (`crates/engine/src/commands/batch.rs:107`); `ui.*` as in the control protocol; the control server answers within 60 s (long jobs: `crates/automation/src/long_job.rs`).

**A. The app's own MCP tools** (22 rows; 22 rows work against the running app)

| Own tool | Source (def/dispatch) | Live? | Decision | Maps to |
|---|---|---|---|---|
| `list_commands / command_list` | `tools.rs`:544/178, 912 | both | cut → craft_commands (filter param is `filter` on engine.commands) | command.list |
| `describe_command` | `tools.rs`:560/203 | both | keep → via craft_commands (cut); command.describe gives a JSON Schema per command | command.describe {command} |
| `execute_command / command_run` | `tools.rs`:572/197, 928 | both | cut → craft_run | engine.execute |
| `command_batch` | `tools.rs`:960/986 | both | cut → craft_batch | client-side loop |
| `batch` | `tools.rs`:896 | both | keep → effect_batch (one atomic undo step, "$N.key" refs resolved in the app) | engine.batch |
| `run_script` | `tools.rs`:588/261 | both | keep → effect_script | script.run {code} |
| `get_project / doc_inspect` | `tools.rs`:603/270, 972/980 | both | cut → craft_inspect | project.summary (+ comp.info) |
| `get_comp` | `tools.rs`:610/274 | both | keep → effect_comp | comp.info |
| `get_layer` | `tools.rs`:617/300 | both | keep → effect_layer | layer.tree |
| `get_property` | `tools.rs`:634/311 | both | keep → effect_get | prop.get |
| `set_property` | `tools.rs`:646/316 | both | keep → effect_set | prop.set \| prop.addKey + prop.setExpression + prop.get |
| `add_keyframe` | `tools.rs`:663/347 | both | keep → effect_keys | prop.addKey ×N, keys.select, keys.easyEase \| keys.interpolation, prop.get |
| `add_effect` | `tools.rs`:682/218 | both | keep → effect_add_effect | layer.tree + engine.batch[effect.apply, prop.set…] + layer.tree |
| `list_effects` | `tools.rs`:698/208 | both | keep → effect_list_effects | effect.list |
| `list_fonts` | `tools.rs`:705/212 | both | keep → effect_fonts | text.fonts |
| `get_state` | `tools.rs`:720/255 | both | cut → craft_inspect | editor.state + app.capabilities |
| `render_frame / render_preview` | `tools.rs`:727/393, 943 | both | keep → effect_frame (comp frame, not the window) | render.frame — a CONTROL METHOD (ui-egui control.rs:426), {max_side, base64:true, time, comp} |
| `open_project` | `tools.rs`:746/411 | both | cut → craft_open | file.open \| file.openDemoProject \| file.newProject |
| `save_project` | `tools.rs`:755/424 | both | cut → craft_save | file.saveAs \| file.save |
| `undo / redo / history` | `tools.rs`:762/447, 769/451, 776/433 | both | cut → craft_run edit.undo / edit.history.* | edit.history.list, edit.history.goto |
| `script_ui` | `tools.rs`:783 | both | cut (ScriptUI windows opened by scripts; reachable through craft_run ui.* if needed) | scriptui.list\|get\|click\|set\|close (engine commands, tools.rs:455-466) |
| `screenshot, ui_inspect, ui_elements, ui_click, ui_drag, ui_key, ui_type, ui_set, control` | `tools.rs`:801/492, 818/513, 825/516, 832/519 | app-only | cut → craft_screenshot / craft_inspect / craft_run | ui.* (bridge only; refused while file roots confine the CLI) |

**B. Proposed toolkit** — 13 tools, ~1120 tokens (~1510 with wrapper overhead)

| Tool | Maps to | Live? | Keep/Cut | ~tok | Source |
|---|---|---|---|---:|---|
| `effect_comp` | engine.execute `comp.info` | live, read-only | keep (own MCP tool) | 68 | mcp `tools.rs`:610/274; `comp.info` engine/src/commands/query.rs:206 |
| `effect_layer` | engine.execute `layer.tree` | live, read-only | keep (own MCP tool) | 96 | mcp `tools.rs`:617/300; `layer.tree` engine/src/commands/query.rs:207 |
| `effect_get` | engine.execute `prop.get` | live, read-only | keep (own MCP tool) | 78 | mcp `tools.rs`:634/311; `prop.get` engine/src/commands/prop.rs:1137 |
| `effect_set` | `prop.addKey \| prop.set` → `prop.setExpression` → `prop.get` | live | keep (own MCP tool) | 94 | mcp `tools.rs`:646/316; `prop.set` engine/src/commands/prop.rs:1138; `prop.addKey` engine/src/commands/prop.rs:1148; +1 more in toolkits.json |
| `effect_keys` | `prop.addKey` → `keys.select` → `keys.easyEase \| keys.interpolation` → `prop.get` | live | keep (own MCP tool) | 109 | mcp `tools.rs`:663/347; `prop.addKey` engine/src/commands/prop.rs:1148; `keys.easyEase` engine/src/commands/prop.rs:1199 |
| `effect_new_comp` | engine.execute `comp.new` | live | keep (new, from registry) | 85 | `comp.new` engine/src/commands/comp.rs:281 |
| `effect_add_layer` | by `kind`: text→`layer.newText`; solid→`layer.newSolid`; shape→`layer.newShape`; null→`layer.newNull`; adjustment→`layer.newAdjustment`; camera→`layer.newCamera`; light→`layer.newLight` | live | keep (new, from registry) | 156 | `layer.newText` engine/src/commands/layer.rs:1464; `layer.newSolid` engine/src/commands/layer.rs:1473; +5 more in toolkits.json |
| `effect_add_effect` | engine.execute `engine.batch` | live | keep (own MCP tool) | 106 | mcp `tools.rs`:682/218; `effect.apply` engine/src/commands/effect.rs:465; `engine.batch` engine/src/commands/batch.rs:107 |
| `effect_list_effects` | engine.execute `effect.list` | live, read-only | keep (own MCP tool) | 40 | mcp `tools.rs`:698/208; `effect.list` engine/src/commands/effect.rs:490 |
| `effect_fonts` | engine.execute `text.fonts` | live, read-only | keep (own MCP tool) | 44 | mcp `tools.rs`:705/212; `text.fonts` engine/src/commands/text_edit.rs:557 |
| `effect_frame` | `render.frame` — control METHOD, not an engine command (adapter has it viaEngine: see report) | live, read-only | keep (own MCP tool) | 77 | mcp `tools.rs`:727/393 |
| `effect_script` | engine.execute `script.run` | live | keep (own MCP tool) | 75 | mcp `tools.rs`:588/261; `script.run` engine/src/commands/file_more.rs:999 |
| `effect_batch` | engine.execute `engine.batch` | live | keep (own MCP tool) | 92 | mcp `tools.rs`:896; `engine.batch` engine/src/commands/batch.rs:107 |

**Cap:** 1510 ≤ 3000 — nothing to cut. If a future cap is tighter, drop in this order: `effect_fonts`, `effect_list_effects`, `effect_script`.

### DesignCraft 0.6.0 — prefix `design_`

MCP source: `crates/mcp/src/tools.rs` (+ `crates/mcp/src/*.rs`). Hand-written `tool()` table; remote and headless backends.
Control-channel facts used: `ui.render {page, scale, bleed}` (`crates/ui-egui/src/control.rs:326`) answers `pngBase64`; everything else is `engine.execute` (the "$N.path" back-references in `batch` are resolved by the MCP wrapper, not the app).

**A. The app's own MCP tools** (22 rows; 22 rows work against the running app)

| Own tool | Source (def/dispatch) | Live? | Decision | Maps to |
|---|---|---|---|---|
| `list_commands` | `tools.rs`:89/526 | both | cut → craft_commands | engine.commands |
| `execute` | `tools.rs`:104/531 | both | cut → craft_run | engine.execute |
| `batch` | `tools.rs`:115/536 | both | cut → craft_batch, which must resolve "$N.path" / "$last.path" and `script` lines | client-side (tools.rs batch) |
| `inspect_document` | `tools.rs`:138/537 | both | cut → craft_inspect | document.inspect |
| `get_story` | `tools.rs`:147/538 | both | keep → design_story | engine.execute story.get |
| `set_story_text` | `tools.rs`:156/539 | both | keep → design_set_story | story.get (to find the story) + story.setText + story.get |
| `new_document` | `tools.rs`:164/545 | both | keep → design_new | file.new \| file.newSample |
| `open_document` | `tools.rs`:187/553 | both | cut → craft_open | app.open |
| `save_document` | `tools.rs`:194/554 | both | cut → craft_save | file.save |
| `place_image` | `tools.rs`:201/555 | both | keep → design_place_image | file.place |
| `render_page` | `tools.rs`:222/561 | both | keep → design_render_page | ui.render {page, scale, bleed, path} |
| `export_png` | `tools.rs`:238/562 | both | cut → craft_save (adapter exports png) | app.export |
| `screenshot` | `tools.rs`:248/566 | app-only | cut → craft_screenshot | ui.screenshot |
| `select_tool` | `tools.rs`:256/567 | both | cut → craft_run ui.tool.select | ui.tool.select |
| `pointer` | `tools.rs`:264/568 | both | cut → craft_run ui.pointer | ui.pointer |
| `key` | `tools.rs`:291/569 | both | cut → craft_run ui.key | ui.key |
| `type_text` | `tools.rs`:306/573 | both | cut → craft_run ui.text | ui.text |
| `click / drag` | `tools.rs`:314/574, 332/574 | app-only | cut → craft_run ui.click / ui.drag | ui.click, ui.drag |
| `menu_list` | `tools.rs`:347/579 | app-only | cut → craft_run ui.menu.list | ui.menu.list |
| `ui_inspect` | `tools.rs`:354/583 | app-only | cut → craft_inspect {what:"ui"} | ui.inspect |
| `ui_set` | `tools.rs`:361/587 | app-only | cut → craft_run ui.set | ui.set |
| `dialog_set / dialog_confirm / dialog_cancel` | `tools.rs`:382/591, 388/595, 389/599 | app-only | cut → craft_run ui.dialog.* | ui.dialog.set, ui.dialog.confirm, ui.dialog.cancel |

**B. Proposed toolkit** — 12 tools, ~1058 tokens (~1418 with wrapper overhead)

| Tool | Maps to | Live? | Keep/Cut | ~tok | Source |
|---|---|---|---|---:|---|
| `design_new` | engine.execute `file.new \| file.newSample` | live | keep (own MCP tool) | 126 | mcp `tools.rs`:164/545; `file.new` engine/src/cmd/file.rs:15 |
| `design_frame` | engine.execute `frame.create` | live | keep (new, from registry) | 124 | `frame.create` engine/src/cmd/object.rs:19 |
| `design_story` | engine.execute `story.get` | live, read-only | keep (own MCP tool) | 66 | mcp `tools.rs`:147/538; `story.get` engine/src/cmd/text.rs:114 |
| `design_set_story` | `story.get` → `story.setText` → `story.get` | live | keep (own MCP tool) | 60 | mcp `tools.rs`:156/539; `story.setText` engine/src/cmd/text.rs:77 |
| `design_place_image` | engine.execute `file.place` | live | keep (own MCP tool) | 78 | mcp `tools.rs`:201/555; `file.place` engine/src/cmd/file.rs:98 |
| `design_style` | by `action`: apply→`style.paragraph.apply`; create→`style.paragraph.create` | live | keep (new, from registry) | 86 | `style.paragraph.apply` engine/src/cmd/style.rs:82; `style.paragraph.create` engine/src/cmd/style.rs:84 |
| `design_paint` | `swatch.create` → `object.fill` → `object.stroke` | live | keep (new, from registry) | 109 | `object.fill` engine/src/cmd/object.rs:163; `object.stroke` engine/src/cmd/object.rs:168; +1 more in toolkits.json |
| `design_move` | engine.execute `transform.move` | live | keep (new, from registry) | 74 | `transform.move` engine/src/cmd/object.rs:29 |
| `design_pages` | by `action`: insert→`layout.pages.insert`; delete→`layout.pages.delete`; move→`layout.pages.move` | live | keep (new, from registry) | 94 | `layout.pages.insert` engine/src/cmd/layout.rs:80; `layout.pages.delete` engine/src/cmd/layout.rs:117; +1 more in toolkits.json |
| `design_layer` | by `action`: new→`layer.new`; set→`layer.set`; delete→`layer.delete` | live | keep (new, from registry) | 90 | `layer.new` engine/src/cmd/layout.rs:454; `layer.set` engine/src/cmd/layout.rs:478; +1 more in toolkits.json |
| `design_render_page` | `ui.render` — reply holds pngBase64; path is written by the host (tools.rs:476-485) | live, read-only | keep (own MCP tool) | 69 | mcp `tools.rs`:222/561 |
| `design_export` | by `format`: pdf→`file.exportPdf`; epub→`file.exportEpub`; html→`file.exportHtml`; text→`file.exportText`; idml→`file.exportIdml` | live | keep (new, from registry) | 82 | `file.exportPdf` engine/src/cmd/export.rs:11; `file.exportEpub` engine/src/cmd/export.rs:14; +3 more in toolkits.json |

**Cap:** 1418 ≤ 3000 — nothing to cut. If a future cap is tighter, drop in this order: `design_layer`, `design_style`, `design_pages`.

### SoundCraft 0.5.0 — prefix `sound_`

MCP source: `crates/automation/src/mcp.rs`. Own JSON-RPC server (`mcp.rs`); `INSTRUCTIONS` explains the position syntax.
Control-channel facts used: positions are samples, `{"seconds": x}` or time strings like `bars_beats:5|1|000` / `0:12.500` (`crates/automation/src/mcp.rs:10-14`); tracks are addressed by id or name; `ui.screenshot` answers `png_base64`.

**A. The app's own MCP tools** (15 rows; 15 rows work against the running app)

| Own tool | Source (def/dispatch) | Live? | Decision | Maps to |
|---|---|---|---|---|
| `list_commands` | `mcp.rs`:27/123 | both | cut → craft_commands | engine.commands {filter} |
| `execute` | `mcp.rs`:33/124 | both | cut → craft_run | engine.execute |
| `batch` | `mcp.rs`:39/128 | both | cut → craft_batch | client-side loop (keep_going, max 1000) |
| `inspect_session` | `mcp.rs`:45/149 | both | cut → craft_inspect | session.inspect {detail} |
| `new_session` | `mcp.rs`:51/150 | both | cut → craft_run session.new | session.new |
| `open_session` | `mcp.rs`:56/151 | both | cut → craft_open | session.open |
| `save_session` | `mcp.rs`:57/152 | both | cut → craft_save | session.save |
| `import_audio` | `mcp.rs`:59/153 | both | keep → sound_import | file.import_audio |
| `bounce_mix` | `mcp.rs`:65/154 | both | keep → sound_bounce | file.bounce_mix |
| `parity` | `mcp.rs`:70/155 | both | cut | engine.parity (coverage report, not useful to models) |
| `screenshot` | `mcp.rs`:71/156 | app-only | cut → craft_screenshot | ui.screenshot (answers png_base64) |
| `ui_inspect` | `mcp.rs`:72/165 | app-only | cut → craft_inspect {what:"ui"} | ui.inspect |
| `ui_set` | `mcp.rs`:73/166 | app-only | cut → craft_run ui.set | ui.set |
| `menu_invoke` | `mcp.rs`:75/167 | app-only | cut (can open native file dialogs; adapter refuses it) | ui.menu.invoke |
| `click / drag / key` | `mcp.rs`:81/168, 87/169, 93/170 | app-only | cut → craft_run ui.click / ui.drag / ui.key | ui.click, ui.drag, ui.key |

**B. Proposed toolkit** — 15 tools, ~1268 tokens (~1718 with wrapper overhead)

| Tool | Maps to | Live? | Keep/Cut | ~tok | Source |
|---|---|---|---|---:|---|
| `sound_import` | engine.execute `file.import_audio` | live | keep (own MCP tool) | 87 | mcp `mcp.rs`:59/153; `file.import_audio` engine/src/cmd/file.rs:50 |
| `sound_bounce` | engine.execute `file.bounce_mix` | live | keep (own MCP tool) | 85 | mcp `mcp.rs`:65/154 |
| `sound_add_track` | engine.execute `track.new` | live | keep (new, from registry) | 90 | `track.new` engine/src/cmd/track.rs:10 |
| `sound_track` | by `action`: rename→`track.rename`; delete→`track.delete`; duplicate→`track.duplicate`; color→`track.color` | live | keep (new, from registry) | 98 | `track.rename` engine/src/cmd/track.rs:58; `track.delete` engine/src/cmd/track.rs:57; +2 more in toolkits.json |
| `sound_select` | engine.execute `edit.select` | live | keep (new, from registry) | 85 | `edit.select` engine/src/cmd/edit.rs:52 |
| `sound_edit` | by `action`: cut→`edit.cut`; copy→`edit.copy`; paste→`edit.paste`; duplicate→`edit.duplicate`; separate→`edit.separate`; trim→`edit.trim_to_selection`; delete→`edit.clear` | live | keep (new, from registry) | 96 | `edit.cut` engine/src/cmd/edit.rs:14; `edit.copy` engine/src/cmd/edit.rs:15; +5 more in toolkits.json |
| `sound_move_clips` | engine.execute `edit.move_clips` | live | keep (new, from registry) | 61 | `edit.move_clips` engine/src/cmd/edit.rs:138 |
| `sound_clip` | `clip.gain` → `clip.rename` → `clip.color` → `clip.loop` | live | keep (new, from registry) | 95 | `clip.gain` engine/src/cmd/clip.rs:70; `clip.rename` engine/src/cmd/clip.rs:69; +2 more in toolkits.json |
| `sound_mix` | `mix.volume` → `mix.pan` → `mix.mute` → `mix.solo` → `mix.record_arm` | live | keep (new, from registry) | 82 | `mix.volume` engine/src/cmd/mix.rs:10; `mix.pan` engine/src/cmd/mix.rs:11; +3 more in toolkits.json |
| `sound_insert` | `mix.insert` → `mix.insert_bypass` → `mix.insert_remove` | live | keep (new, from registry) | 88 | `mix.insert` engine/src/cmd/mix.rs:94; `mix.insert_bypass` engine/src/cmd/mix.rs:96; +1 more in toolkits.json |
| `sound_send` | engine.execute `mix.send` | live | keep (new, from registry) | 70 | `mix.send` engine/src/cmd/mix.rs:108 |
| `sound_automation` | `automation.set_point` → `automation.write_range` → `automation.clear` | live | keep (new, from registry) | 99 | `automation.set_point` engine/src/cmd/mix.rs:125; `automation.write_range` engine/src/cmd/mix.rs:134; +1 more in toolkits.json |
| `sound_transport` | engine.execute `transport.<action>` | live | keep (new, from registry) | 66 | `transport.play` engine/src/cmd/transport.rs:10; `transport.stop` engine/src/cmd/transport.rs:17; +2 more in toolkits.json |
| `sound_tempo` | `event.tempo` → `event.meter` → `markers.add` | live | keep (new, from registry) | 66 | `event.tempo` engine/src/cmd/event.rs:12; `event.meter` engine/src/cmd/event.rs:19; +1 more in toolkits.json |
| `sound_midi` | `midi.note_add` → `event.transpose` → `event.quantize` | live | keep (new, from registry) | 100 | `midi.note_add` engine/src/cmd/midi.rs:22; `event.transpose` engine/src/cmd/event.rs:37; +1 more in toolkits.json |

**Cap:** 1718 ≤ 3000 — nothing to cut. If a future cap is tighter, drop in this order: `sound_midi`, `sound_send`, `sound_tempo`.

### DeckCraft 0.5.0 — prefix `deck_`

MCP source: `crates/mcp/src/tools.rs` (+ `crates/mcp/src/*.rs`). Hand-written `tool()` table; remote and headless backends.
Control-channel facts used: `ui.render {slide, scale, edit}` (`crates/ui-egui/src/control.rs:247`) answers `png`; the MCP save/export tools call the engine commands `file.save` / `file.export`.

**A. The app's own MCP tools** (22 rows; 22 rows work against the running app)

| Own tool | Source (def/dispatch) | Live? | Decision | Maps to |
|---|---|---|---|---|
| `list_commands` | `tools.rs`:68/300 | both | cut → craft_commands | engine.commands |
| `run_command` | `tools.rs`:75/315 | both | cut → craft_run | engine.execute |
| `batch` | `tools.rs`:85/319 | both | cut → craft_batch | client-side loop (keepGoing) |
| `new_presentation` | `tools.rs`:95/336 | both | keep → deck_new | file.new {theme, blank} |
| `open_presentation` | `tools.rs`:102/337 | both | cut → craft_open | file.open |
| `save_presentation` | `tools.rs`:109/338 | both | cut → craft_save | file.save |
| `export` | `tools.rs`:116/339 | both | cut → craft_save (adapter exports pdf, png, jpg, outline) — keep only the PDF notes/handouts options as deck_export_pdf | file.export |
| `inspect_document` | `tools.rs`:139/340 | both | cut → craft_inspect | document.inspect |
| `inspect_slide` | `tools.rs`:146/341 | both | keep → deck_slide | slide.inspect |
| `render_slide` | `tools.rs`:153/342 | both | keep → deck_render_slide | ui.render {slide, scale, edit} (answers png) |
| `add_slide` | `tools.rs`:163/351 | both | keep → deck_add_slide | slide.new |
| `go_to_slide` | `tools.rs`:170/352 | both | keep → deck_go | slide.go |
| `add_shape` | `tools.rs`:177/353 | both | keep → deck_add_shape | shape.insert + shape.fill + shape.line |
| `add_text_box` | `tools.rs`:187/374 | both | keep → deck_add_text | insert.textBox + text.exit + edit.select + format.size/color/align |
| `set_text` | `tools.rs`:197/392 | both | keep → deck_set_text | text.set |
| `insert_picture` | `tools.rs`:204/393 | both | keep → deck_add_picture | insert.picture |
| `insert_table` | `tools.rs`:214/400 | both | keep → deck_add_table | insert.table |
| `insert_chart` | `tools.rs`:224/407 | both | keep → deck_add_chart | insert.chart |
| `select` | `tools.rs`:234/408 | both | cut → craft_run edit.select | edit.select |
| `pointer / select_tool / key / type_text` | `tools.rs`:241/409, 251/410, 258/411, 265/416 | both | cut → craft_run ui.pointer / ui.tool.select / ui.key / ui.text | ui.* |
| `screenshot` | `tools.rs`:271/417 | app-only | cut → craft_screenshot | ui.screenshot {base64:true} (answers png) |
| `call_app` | `tools.rs`:273/429 | app-only | cut → craft_run | any control method |

**B. Proposed toolkit** — 15 tools, ~1395 tokens (~1845 with wrapper overhead)

| Tool | Maps to | Live? | Keep/Cut | ~tok | Source |
|---|---|---|---|---:|---|
| `deck_new` | engine.execute `file.new` | live | keep (own MCP tool) | 62 | mcp `tools.rs`:95/336; `file.new` engine/src/cmd/file.rs:11 |
| `deck_slide` | engine.execute `slide.inspect` | live, read-only | keep (own MCP tool) | 60 | mcp `tools.rs`:146/341; `slide.inspect` engine/src/cmd/inspect.rs:13 |
| `deck_render_slide` | `ui.render` | live, read-only | keep (own MCP tool) | 56 | mcp `tools.rs`:153/342 |
| `deck_add_slide` | engine.execute `slide.new` | live | keep (own MCP tool) | 94 | mcp `tools.rs`:163/351; `slide.new` engine/src/cmd/slide.rs:14 |
| `deck_go` | engine.execute `slide.go` | live | keep (own MCP tool) | 44 | mcp `tools.rs`:170/352; `slide.go` engine/src/cmd/slide.rs:26 |
| `deck_slide_op` | by `action`: duplicate→`slide.duplicate`; delete→`slide.delete`; move→`slide.move`; hide→`slide.hide`; rename→`slide.rename`; layout→`slide.layout`; notes→`slide.notes` | live | keep (new, from registry) | 110 | `slide.duplicate` engine/src/cmd/slide.rs:23; `slide.delete` engine/src/cmd/slide.rs:24; +5 more in toolkits.json |
| `deck_add_shape` | `shape.insert` → `shape.fill` → `shape.line` | live | keep (own MCP tool) | 141 | mcp `tools.rs`:177/353; `shape.insert` engine/src/cmd/insert.rs:16; `shape.fill` engine/src/cmd/shape.rs:40; +1 more in toolkits.json |
| `deck_add_text` | `insert.textBox` → `text.exit` → `edit.select` → `format.size` → `format.color` → `format.align` | live | keep (own MCP tool) | 109 | mcp `tools.rs`:187/374; `insert.textBox` engine/src/cmd/insert.rs:26; `format.size` engine/src/cmd/format.rs:39; +2 more in toolkits.json |
| `deck_set_text` | engine.execute `text.set` | live | keep (own MCP tool) | 88 | mcp `tools.rs`:197/392; `text.set` engine/src/cmd/text.rs:25 |
| `deck_add_picture` | engine.execute `insert.picture` | live | keep (own MCP tool) | 69 | mcp `tools.rs`:204/393; `insert.picture` engine/src/cmd/insert.rs:27 |
| `deck_add_table` | engine.execute `insert.table` | live | keep (own MCP tool) | 101 | mcp `tools.rs`:214/400; `insert.table` engine/src/cmd/insert.rs:36 |
| `deck_add_chart` | engine.execute `insert.chart` | live | keep (own MCP tool) | 103 | mcp `tools.rs`:224/407; `insert.chart` engine/src/cmd/insert.rs:37 |
| `deck_format` | `edit.select` → `format.bold` → `format.size` → `format.color` → `format.align` → `shape.fill` → `shape.line` | live | keep (new, from registry) | 91 | `format.bold` engine/src/cmd/format.rs:16; `shape.fill` engine/src/cmd/shape.rs:40 |
| `deck_arrange` | by `action`: align→`arrange.align`; distribute→`arrange.distribute`; group→`arrange.group`; ungroup→`arrange.ungroup`; front→`arrange.bringToFront`; back→`arrange.sendToBack`; nudge→`arrange.nudge` | live | keep (new, from registry) | 125 | `arrange.align` engine/src/cmd/arrange.rs:20; `arrange.distribute` engine/src/cmd/arrange.rs:29; +2 more in toolkits.json |
| `deck_design` | `design.theme` → `design.background` → `transition.set` → `animation.add` | live | keep (new, from registry) | 142 | `design.theme` engine/src/cmd/design.rs:17; `design.background` engine/src/cmd/design.rs:21; +2 more in toolkits.json |

**Cap:** 1845 ≤ 3000 — nothing to cut. If a future cap is tighter, drop in this order: `deck_design`, `deck_arrange`, `deck_format`.

### CADCraft 0.5.0 — prefix `cad_`

MCP source: `crates/mcp/src/tools.rs` (+ `crates/mcp/src/*.rs`). `json!` tool list; UI tools are added only with `has_ui`.
Control-channel facts used: `cmdline.input` (`crates/ui-egui/src/control.rs:180`), `cmdline.script` (`:194`), `cmdline.key` (`:203`), `ui.render` (`:336`, answers `pngBase64`); a refused command-line input still answers `ok:true` with an `error` field (`docs/control-protocol.md`); the command registry carries param docs and aliases.

**A. The app's own MCP tools** (14 rows; 14 rows work against the running app)

| Own tool | Source (def/dispatch) | Live? | Decision | Maps to |
|---|---|---|---|---|
| `command_line` | `tools.rs`:9/107 | both | keep → cad_command_line | cmdline.input {text} |
| `script` | `tools.rs`:11/108 | both | keep → cad_script | cmdline.script {text} |
| `execute` | `tools.rs`:13/109 | both | cut → craft_run | engine.execute |
| `list_commands` | `tools.rs`:15/113 | both | cut → craft_commands (filter is client-side here) | engine.commands |
| `inspect_drawing` | `tools.rs`:17/120 | both | cut → craft_inspect | drawing.inspect {entities, limit} |
| `query_entities` | `tools.rs`:19/121 | both | keep → cad_query | engine.execute entities |
| `render` | `tools.rs`:23/129 | both | keep → cad_render | ui.render (answers pngBase64) |
| `new_drawing` | `tools.rs`:25/122 | both | keep → cad_new | engine.execute new {metric} |
| `open` | `tools.rs`:27/123 | both | cut → craft_open | app.open |
| `save` | `tools.rs`:28/124 | both | cut → craft_save | app.save |
| `cancel` | `tools.rs`:29/125 | both | keep → cad_cancel | cmdline.key {key:"escape"} |
| `screenshot` | `tools.rs`:32/126 | app-only | cut → craft_screenshot | ui.screenshot |
| `ui_inspect` | `tools.rs`:33/127 | app-only | cut → craft_inspect {what:"ui"} | ui.inspect |
| `ui_click` | `tools.rs`:34/128 | app-only | cut → craft_run ui.pointer | ui.pointer (world coordinates) |

**B. Proposed toolkit** — 16 tools, ~1534 tokens (~2014 with wrapper overhead)

| Tool | Maps to | Live? | Keep/Cut | ~tok | Source |
|---|---|---|---|---:|---|
| `cad_command_line` | `cmdline.input` | live | keep (own MCP tool) | 78 | mcp `tools.rs`:9/107 |
| `cad_script` | `cmdline.script` | live | keep (own MCP tool) | 49 | mcp `tools.rs`:11/108 |
| `cad_line` | engine.execute `line` | live | keep (new, from registry) | 72 | `line` engine/src/cmd/draw.rs:16 |
| `cad_polyline` | engine.execute `pline` | live | keep (new, from registry) | 70 | `pline` engine/src/cmd/draw.rs:21 |
| `cad_circle` | engine.execute `circle` | live | keep (new, from registry) | 124 | `circle` engine/src/cmd/draw.rs:26 |
| `cad_arc` | engine.execute `arc` | live | keep (new, from registry) | 127 | `arc` engine/src/cmd/draw.rs:31 |
| `cad_rect` | engine.execute `rectang` | live | keep (new, from registry) | 122 | `rectang` engine/src/cmd/draw.rs:36 |
| `cad_text` | engine.execute `text \| mtext` | live | keep (new, from registry) | 98 | `text` engine/src/cmd/draw.rs:79; `mtext` engine/src/cmd/draw.rs:84 |
| `cad_dimension` | engine.execute `dimlinear \| dimaligned` | live | keep (new, from registry) | 122 | `dimlinear` engine/src/cmd/annotate.rs:16; `dimaligned` engine/src/cmd/annotate.rs:21 |
| `cad_modify` | by `op`: move→`move`; copy→`copy`; rotate→`rotate`; erase→`erase` | live | keep (new, from registry) | 163 | `move` engine/src/cmd/modify.rs:23; `copy` engine/src/cmd/modify.rs:28; +2 more in toolkits.json |
| `cad_layer` | by `action`: new→`layer.new`; current→`layer.current`; set→`layer.set` | live | keep (new, from registry) | 114 | `layer.new` engine/src/cmd/layer.rs:20; `layer.current` engine/src/cmd/layer.rs:23 |
| `cad_hatch` | engine.execute `hatch` | live | keep (new, from registry) | 108 | `hatch` engine/src/cmd/hatch.rs:14 |
| `cad_zoom` | engine.execute `zoom` | live | keep (new, from registry) | 92 | `zoom` engine/src/cmd/view.rs:13 |
| `cad_query` | engine.execute `entities` | live, read-only | keep (own MCP tool) | 102 | mcp `tools.rs`:19/121 |
| `cad_render` | `ui.render` | live, read-only | keep (own MCP tool) | 55 | mcp `tools.rs`:23/129 |
| `cad_cancel` | `cmdline.key` | live | keep (own MCP tool) | 38 | mcp `tools.rs`:29/125 |

**Cap:** 2014 ≤ 3000 — nothing to cut. If a future cap is tighter, drop in this order: `cad_hatch`, `cad_zoom`, `cad_dimension`.

### WordCraft 0.5.0 — prefix `word_`

MCP source: `crates/mcp/src/tools.rs` (+ `crates/mcp/src/*.rs`). Hand-written `tool()` table; remote and headless backends.
Control-channel facts used: `ui.render {path, page, scale}` (`crates/ui-egui/src/control.rs:205`); `{method:"auth", key}` first on every connection (key file `control-key.local-<port>`); `engine.commands` entries carry `location` (`control.rs:124`).

**A. The app's own MCP tools** (15 rows; 15 rows work against the running app)

| Own tool | Source (def/dispatch) | Live? | Decision | Maps to |
|---|---|---|---|---|
| `list_commands` | `tools.rs`:50/163 | both | cut → craft_commands | engine.commands (filter `query` client-side) |
| `execute` | `tools.rs`:57/182 | both | cut → craft_run | engine.execute |
| `batch` | `tools.rs`:64/186 | both | cut → craft_batch | client-side loop (keepGoing) |
| `new_document` | `tools.rs`:74/203 | both | keep → word_new | file.new {template} |
| `open_document` | `tools.rs`:81/204 | both | cut → craft_open | file.open |
| `save_document` | `tools.rs`:88/205 | both | cut → craft_save | file.save \| file.exportPng for .png |
| `type_text` | `tools.rs`:95/221 | both | keep → word_type | text.insert {raw:true}; with paragraphs:true, text.newParagraph between lines |
| `select_text` | `tools.rs`:102/241 | both | keep → word_select | select.text |
| `get_text` | `tools.rs`:108/244 | both | keep → word_text | document.text |
| `inspect_document` | `tools.rs`:110/245 | both | cut → craft_inspect | document.inspect |
| `render_page` | `tools.rs`:117/247 | both | keep → word_render_page | ui.render {path, page, scale} then read file |
| `parity` | `tools.rs`:123/246 | both | cut | ui.parity (coverage report) |
| `screenshot` | `tools.rs`:124/268 | app-only | cut → craft_screenshot | ui.screenshot {path} |
| `click / key` | `tools.rs`:126/278, 133/279 | app-only | cut → craft_run ui.click / ui.key | ui.click, ui.key |
| `ui_inspect` | `tools.rs`:140/280 | app-only | cut → craft_inspect {what:"ui"} | ui.inspect |

**B. Proposed toolkit** — 11 tools, ~878 tokens (~1208 with wrapper overhead)

| Tool | Maps to | Live? | Keep/Cut | ~tok | Source |
|---|---|---|---|---:|---|
| `word_new` | engine.execute `file.new` | live | keep (own MCP tool) | 55 | mcp `tools.rs`:74/203; `file.new` engine/src/cmd/file.rs:31 |
| `word_type` | `text.insert` → `text.newParagraph` | live | keep (own MCP tool) | 64 | mcp `tools.rs`:95/221; `text.insert` engine/src/cmd/text.rs:13; `text.newParagraph` engine/src/cmd/text.rs:14 |
| `word_select` | engine.execute `select.text` | live | keep (own MCP tool) | 53 | mcp `tools.rs`:102/241; `select.text` engine/src/cmd/caret.rs:52 |
| `word_text` | engine.execute `document.text` | live, read-only | keep (own MCP tool) | 29 | mcp `tools.rs`:108/244; `document.text` engine/src/cmd/file.rs:81 |
| `word_format` | `format.bold` → `format.italic` → `format.underline` → `format.font` → `format.size` → `format.color` → `format.highlight` | live | keep (new, from registry) | 104 | `format.bold` engine/src/cmd/format.rs:16; `format.italic` engine/src/cmd/format.rs:31; +5 more in toolkits.json |
| `word_paragraph` | `para.style` → `para.align` → `para.lineSpacing` → `para.spacing` → `para.indents` → `para.bullets \| para.numbering` | live | keep (new, from registry) | 125 | `para.style` engine/src/cmd/para.rs:97; `para.align` engine/src/cmd/para.rs:19; +5 more in toolkits.json |
| `word_insert` | by `kind`: table→`insert.table`; link→`insert.link`; picture→`insert.picture`; page_break→`text.pageBreak`; header→`insert.header`; footer→`insert.footer`; shape→`insert.shape`; symbol→`insert.symbol` | live | keep (new, from registry) | 131 | `insert.table` engine/src/cmd/insert.rs:26; `insert.link` engine/src/cmd/insert.rs:37; +6 more in toolkits.json |
| `word_replace` | engine.execute `edit.replaceAll \| edit.replace` | live | keep (new, from registry) | 90 | `edit.replaceAll` engine/src/cmd/edit.rs:70; `edit.replace` engine/src/cmd/edit.rs:69 |
| `word_table` | by `action`: row_above→`table.insertRowAbove`; row_below→`table.insertRowBelow`; col_left→`table.insertColumnLeft`; col_right→`table.insertColumnRight`; delete_row→`table.deleteRow`; delete_col→`table.deleteColumn`; merge→`table.merge`; split→`table.split`; style→`table.style` | live | keep (new, from registry) | 88 | `table.insertRowAbove` engine/src/cmd/table.rs:17; `table.insertRowBelow` engine/src/cmd/table.rs:18; +7 more in toolkits.json |
| `word_review` | by `action`: track_on→`review.trackChanges`; track_off→`review.trackChanges`; comment→`review.newComment`; reply→`review.reply`; accept_all→`review.acceptAll`; reject_all→`review.rejectAll`; word_count→`review.wordCount` | live | keep (new, from registry) | 91 | `review.trackChanges` engine/src/cmd/review.rs:25; `review.newComment` engine/src/cmd/review.rs:12; +4 more in toolkits.json |
| `word_render_page` | `ui.render` | live, read-only | keep (own MCP tool) | 48 | mcp `tools.rs`:117/247 |

**Cap:** 1208 ≤ 3000 — nothing to cut. If a future cap is tighter, drop in this order: `word_review`, `word_table`.

### GridCraft 0.5.0 — prefix `grid_`

MCP source: `crates/mcp/src/tools.rs` (+ `crates/mcp/src/*.rs`). Hand-written `tool()` table; remote and headless backends.
Control-channel facts used: direct control methods `sheet.read`, `cell.get`, `document.inspect`, `selection.stats` (`crates/ui-egui/src/control.rs:186`); `engine.commands {search}` filters in the app (`control.rs:167`); everything else is `engine.execute`.

**A. The app's own MCP tools** (21 rows; 21 rows work against the running app)

| Own tool | Source (def/dispatch) | Live? | Decision | Maps to |
|---|---|---|---|---|
| `execute_command` | `tools.rs`:115/564 | both | cut → craft_run | engine.execute |
| `list_commands` | `tools.rs`:129/573 | both | cut → craft_commands | engine.commands {search} |
| `inspect_workbook` | `tools.rs`:138/574 | both | cut → craft_inspect | document.inspect |
| `read_range` | `tools.rs`:146/575 | both | keep → grid_read_range | sheet.read (control method) |
| `write_range` | `tools.rs`:163/576 | both | keep → grid_write_range | engine.execute range.setValues |
| `set_cell` | `tools.rs`:178/577 | both | keep → grid_set_cell | cell.set |
| `get_cell` | `tools.rs`:189/578 | both | keep → grid_get_cell | cell.get (control method) |
| `evaluate_formula` | `tools.rs`:196/579 | both | keep → grid_eval | formulas.evaluate (adds the leading =) |
| `select` | `tools.rs`:207/587 | both | cut → craft_run selection.set | selection.set |
| `format_range` | `tools.rs`:218/588 | both | keep → grid_format_range | up to 11 home.* commands in one call (client-side loop) |
| `insert_chart` | `tools.rs`:255/589 | both | keep → grid_insert_chart | insert.chart |
| `create_table` | `tools.rs`:271/590 | both | keep → grid_create_table | insert.table |
| `sort_range` | `tools.rs`:286/591 | both | keep → grid_sort | data.sort (normalises keys client-side) |
| `filter` | `tools.rs`:309/592 | both | keep → grid_filter | selection.set + data.filterBy |
| `open_workbook` | `tools.rs`:330/593 | both | cut → craft_open | file.open |
| `save_workbook` | `tools.rs`:337/594 | both | cut → craft_save | file.save |
| `new_workbook` | `tools.rs`:345/595 | both | cut → craft_run file.new | file.new |
| `undo` | `tools.rs`:352/596 | both | cut → craft_run edit.undo | edit.undo |
| `redo` | `tools.rs`:358/597 | both | cut → craft_run edit.redo | edit.redo |
| `screenshot` | `tools.rs`:360/598 | app-only | cut → craft_screenshot | ui.screenshot |
| `list_functions` | `tools.rs`:367/599 | both | keep → grid_list_functions | formulas.functions |

**B. Proposed toolkit** — 15 tools, ~1504 tokens (~1954 with wrapper overhead)

| Tool | Maps to | Live? | Keep/Cut | ~tok | Source |
|---|---|---|---|---:|---|
| `grid_read_range` | `sheet.read` | live, read-only | keep (own MCP tool) | 100 | mcp `tools.rs`:146/575; `sheet.read` engine/src/cmd/inspect.rs:11 |
| `grid_write_range` | engine.execute `range.setValues` | live | keep (own MCP tool) | 92 | mcp `tools.rs`:163/576; `range.setValues` engine/src/cmd/edit.rs:14 |
| `grid_set_cell` | engine.execute `cell.set` | live | keep (own MCP tool) | 64 | mcp `tools.rs`:178/577; `cell.set` engine/src/cmd/edit.rs:13 |
| `grid_get_cell` | `cell.get` | live, read-only | keep (own MCP tool) | 47 | mcp `tools.rs`:189/578; `cell.get` engine/src/cmd/inspect.rs:12 |
| `grid_eval` | engine.execute `formulas.evaluate` | live, read-only | keep (own MCP tool) | 74 | mcp `tools.rs`:196/579; `formulas.evaluate` engine/src/cmd/formulas.rs:56 |
| `grid_format_range` | `home.bold` → `home.italic` → `home.underline` → `home.fontName` → `home.fontSize` → `home.fontColor` → `home.fillColor` → `home.numberFormat` → `home.alignLeft\|alignCenter\|alignRight\|justify` → `home.wrapText` → `home.borders` | live | keep (own MCP tool) | 209 | mcp `tools.rs`:218/588; `home.bold` engine/src/cmd/format.rs:12; `home.fillColor` engine/src/cmd/format.rs:70; +2 more in toolkits.json |
| `grid_insert_chart` | engine.execute `insert.chart` | live | keep (own MCP tool) | 148 | mcp `tools.rs`:255/589; `insert.chart` engine/src/cmd/insert.rs:61 |
| `grid_create_table` | engine.execute `insert.table` | live | keep (own MCP tool) | 86 | mcp `tools.rs`:271/590; `insert.table` engine/src/cmd/insert.rs:13 |
| `grid_sort` | engine.execute `data.sort` | live | keep (own MCP tool) | 80 | mcp `tools.rs`:286/591; `data.sort` engine/src/cmd/data.rs:19 |
| `grid_filter` | `selection.set` → `data.filterBy` | live | keep (own MCP tool) | 120 | mcp `tools.rs`:309/592; `data.filterBy` engine/src/cmd/data.rs:37; `selection.set` engine/src/cmd/edit.rs:32 |
| `grid_list_functions` | engine.execute `formulas.functions` | live, read-only | keep (own MCP tool) | 48 | mcp `tools.rs`:367/599; `formulas.functions` engine/src/cmd/formulas.rs:29 |
| `grid_sheet` | by `action`: add→`home.insertSheet`; rename→`sheet.rename`; delete→`home.deleteSheet`; activate→`sheet.activate`; move→`sheet.move` | live | keep (new, from registry) | 92 | `home.insertSheet` engine/src/cmd/sheet.rs:40; `sheet.rename` engine/src/cmd/sheet.rs:42; +3 more in toolkits.json |
| `grid_conditional_format` | engine.execute `home.conditionalFormat` | live | keep (new, from registry) | 98 | `home.conditionalFormat` engine/src/cmd/insert.rs:161 |
| `grid_pivot` | engine.execute `insert.pivotTable` | live | keep (new, from registry) | 124 | `insert.pivotTable` engine/src/cmd/pivot.rs:19 |
| `grid_validation` | engine.execute `data.validation` | live | keep (new, from registry) | 122 | `data.validation` engine/src/cmd/data.rs:66 |

**Cap:** 1954 ≤ 3000 — nothing to cut. If a future cap is tighter, drop in this order: `grid_validation`, `grid_pivot`, `grid_conditional_format`, `grid_list_functions`.

## 6. How a toolkit is listed

A toolkit is attached only while its app is *launched* (running) in Craft Studio. Registering it is a lookup `toolkits[app]` at launch and a removal when the app exits; the core `craft_*` set is unchanged. A call is `{tool, args}` → build the control call(s) from `control` → send through the same host client that `craft_run` uses (so auth, idle reconnects, `refused` and path checks stay in one place). Nothing in the toolkit needs a new transport.

## 7. Open questions and assumptions (the orchestrator can overrule)

1. **PdfCraft file tools (`pdf_file_*`).** I assumed a one-shot `pdfcraft-cli <info|text|edit|combine|extract|split>` per call is acceptable, since the CLI ships in every release tarball (`bin/pdfcraft-cli`, `apps/pdfcraft-cli/src/main.rs` USAGE) and is not a bridge process. If one-shot processes are out, drop those six tools; the live toolkit (7 tools) stands alone. They act on files on disk, never on the open document, which the descriptions say.
2. **`pdf_page` (`ui.command page.*`) is unverified live.** `ui.command` "runs a registry command as the menu would" with no params (`control.rs:617-624`); whether rotate/delete act directly on the selected pages or open a dialog was not run. Needs a live check on a private Xvfb display before it ships.
3. **PhotoCraft flattened render.** No control method returns the flattened document as an image in bridge mode (the MCP tool just takes a window screenshot). If models need to look at the result without panels, a one-off decision is needed (export to a temp PNG via `app.save` inside the write root, then read it).
4. **Params I did not verify live.** All mappings are read from source at the pinned tags. Only GridCraft and PhotoCraft were live-checked by earlier work (`craft-adapters.ts` `checked`). The new (non-MCP) tools use registry param strings verbatim; the first live pass should run each tool once per app.
5. **Heading/list commands.** WordCraft `word_paragraph` assumes `para.style {style}` accepts "Heading 1" (registry: `{"style": string (name or id)}`, `para.rs:97`); not checked against the style names the app ships.
6. **Token numbers** are computed from the tool JSON only; the wrapper overhead (+30/tool) is an assumption.

## 8. Reproduce

```sh
# clones (pinned tags from src/shared/craft-apps.ts)
for a in "photocraft v0.7.0" "vectorcraft v0.9.0" "filmcraft v0.6.0" "lightcraft v0.6.0" "pdfcraft v0.6.0" "effectcraft v0.8.0" \
         "designcraft v0.6.0" "soundcraft v0.5.0" "deckcraft v0.5.0" "cadcraft v0.5.0" "wordcraft v0.5.0" "gridcraft v0.5.0"; do
  set -- $a; git clone -q --depth 1 --branch $2 https://github.com/storytold/$1 /tmp/craft-tk/$1; done
# MCP tool tables: <mcpfile> as listed per app; command registries: grep "cmd!(" / "CommandSpec" under crates/*/src/cmd
# evidence: docs/orchestrator/…/task-0016-evidence/commands-<app>.tsv  (id, file, line, param string)
```
