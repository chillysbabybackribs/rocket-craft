# FilmCraft 0.6.0 live test: real editing workflows (2026-10-11)

Driven through the `craft_*` model tools against the running FilmCraft in Craft Studio. Read-only
checks used FilmCraft's loopback control port directly, and the rendered output was checked with
ffprobe, ffmpeg and ImageMagick. The scenario: cut a 17-second promo ("Golden Hour") from the demo
project's footage in its empty "Rough Cut" sequence. Evidence is in `/tmp/fc-test/` (MP4, EDL,
FCPXML, OTIO, markers CSV, `.fcproj`, frame grabs).

The demo project now has a file: it was saved to `/tmp/fc-test/golden_hour_promo.fcproj` and
reopened from there. "Main Edit" was not touched.

## Result: 9 workflows, all completed; 7 defects found

| # | Workflow | Commands | Result |
|---|----------|----------|--------|
| 1 | Assemble 4 shots with source in-points | `sequence.open`, `timeline.place` | Works; linked A/V, in-points kept. Off-grid edges (D1) |
| 2 | Tighten: ripple trim, razor, ripple delete | `timeline.trim`, `timeline.razor`, `edit.rippleDelete` | Works. Sync-lock refusal had a clear error saying how to proceed |
| 3 | Transitions: fade in, dissolve, Cross Zoom, fade out, audio crossfades | `sequence.applyVideoTransition`, `applyAudioTransition` | Works; transitions move with later ripples. Missing-handle Cross Zoom renders cleanly |
| 4 | Opening title, centred, and a lower third | `graphics.newText`, `graphics.align` | Works after centring (`position` is the left edge, which a model can easily get wrong) |
| 5 | Grade, 50% slow motion with ripple, keyframed push-in | `lumetri.applyPreset`, `clip.speedDuration`, `effects.setParam` | Works; sync lock carries V2 titles along. A/B on scopes: R 8.45→6.93, B 11.92→9.82 |
| 6 | Music bed, nat sound −18 dB, music fade-out, auto-ducking | `timeline.place`, `clip.audioGain`, `timeline.setTrack`, `essentialSound.*` | Works except ducking region (D2) |
| 7 | Chapter, comment and range markers, CSV export, undo/redo | `markers.*`, `history.list`, `edit.undo/redo` | Undo history clean (one named step per edit). Colours ignored (D3) |
| 8 | Deliver: H.264 MP4, EDL, FCPXML, OTIO | `craft_save .mp4`, `file.exportInterchange` | MP4 correct (1080p23.976, AAC 48k, 17.02 s) but has a flash frame (D1). Honest conversion reports |
| 9 | Save, reopen, compare | `craft_save .fcproj`, `craft_open` | Identical: clips, speeds, effects, keyframes, markers, 8 transitions, audio types |

## Defects

**D1. Placing by `seconds` leaves clip edges between frames, and the delivered file gets a flash
frame.** (FilmCraft, high) `timeline.place {seconds: 4}` at 23.976 fps keeps 4.000 s (frame 95.904)
instead of snapping to a frame, and the next clip starts there. Transitions are then centred on the
rounded frame rather than the real cut. The closing Dip to Black ends at frame 406 while City ends
at frame 407.67. The export writes 408 frames, so **frame 406 of the MP4 cuts from black back to
full picture**. The EDL export confirms it: "sub-frame clip positions were rounded to frames (×8)".
Placing by `frame` lands exactly on the grid, and so do `graphics.newText` and `file.exportFrame`.
Fix: snap `seconds` and tick positions to the sequence's frame grid in `timeline.place`.
Workaround for models: place by `frame`.

**D2. Auto-ducking ignores clip speed.** (FilmCraft, medium) With Aurora at 50% (6 s on the
timeline, 3 s of source) tagged as dialogue, `essentialSound.generateDucking` ducks only
3.99–6.87 s. A City clip at 100% is covered end to end (12.98–17.02 s). In the render, the music
comes back up from 7 to 9 s while the "dialogue" is still playing.

**D3. Unknown marker colours are accepted and silently ignored.** (FilmCraft, medium)
`markers.add/edit {color: "Red"}` (also "red", 1, "Banana") returns ok and leaves the marker
Green. Valid values are the label names (Rose, Mango, Cerulean, Forest…), which the parameter list
only calls `label`. It should refuse unknown names and list the valid ones.

**D4. `craft_save` to .mp4 returns before the render exists.** (Craft Studio adapter, medium)
`file.exportMedia` runs as a job (115 s here). The tool answers `exported: true` with "no file is at
… yet". `file.exportMedia` takes `wait: bool=false`. The adapter should pass `wait: true` with a
long enough timeout, or poll `jobs.list` until `finished`, and report the job's result.

**D5. Razor on one track splits only that track and re-links nothing.** (FilmCraft, low)
`timeline.razor {track: "V1"}` on a linked clip cut only the video, and the new half got a link id
no audio clip shares. After cutting A1 too, the halves stayed in separate link groups. Premiere
keeps the cut halves linked.

**D6. Commands take parameters they don't list, and indices are fragile.** (FilmCraft, low)
`sequence.applyAudioTransition` accepts `edge: "out"`, but its parameter list doesn't mention it,
so a model can't learn how to fade out a clip's audio. `lumetri.applyPreset` inserts Lumetri at
effect index 0, ahead of motion, opacity and time_remap. An `effects.toggleEnabled {index}`
assuming "applied effects come after the built-in ones" disabled the clip's speed effect instead.

**D7. A JSON id loses precision, and the UI breaks at narrow widths.** (FilmCraft, low)
`mixer.inspect` gives the Mix strip id as `18446744073709552000`: u64::MAX rounded to a JSON
double, which won't match if sent back. At 917 px wide, the menu bar overlaps the Discord and
EDITING badges, and the Program monitor's Fit and 1/2 dropdowns cover the timecodes. Also, there
is no timeline zoom command, and `ui.key Backslash` (zoom to fit) did nothing.

## Worth keeping
- Refusals are full sentences that say what to do (sync lock, ducking needing Music clips).
- The export reports say exactly what each interchange format lost.
- Rendering runs at about 3.5 fps for 1080p H.264, so a model has to wait for or poll the job.
- Times are Premiere ticks: 254,016,000,000 per second, 10,594,584,000 per frame at 23.976.
