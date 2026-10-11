# Craft Studio design language

Craft Studio is a compact desktop workspace: quiet dark surfaces, clear content hierarchy, and
restrained color. Linear is the user's reference direction; Craft Studio's implemented tokens remain
its source of truth.

## Existing foundations

[styles.css](src/renderer/src/styles.css) defines Inter Variable for UI, Geist Mono Variable
for code, a 13px body, an 8px layout gap, and 12px card radii. Use semantic variables such as
`--canvas`, `--panel`, `--raised`, `--text`, `--text-2`, `--line`, `--accent`, `--ok`, and `--warn`.
The accent is indigo; external reference palettes do not override it.

## Components and interaction

Reuse [Tabs](src/renderer/src/components/Tabs.tsx),
[PlanDrawer](src/renderer/src/components/PlanDrawer.tsx), and the layouts in
[App](src/renderer/src/App.tsx). A side pane (the plan drawer) splits inside the chat, and the
browser is independently toggleable. Follow existing controls and focus treatment.

## Reference direction

Linear: use quiet hierarchy, compact metadata, and subtle boundaries. Inspect specific examples
when a change needs them; a marketing screenshot does not prove interactive behavior.

## Verification

Inspect the rendered result, including long content and relevant loading, empty, error, and
completed states. For split layouts, check resizing with the browser open and closed. Exercise
keyboard access and visible focus. Test the user flow as well as appearance.

## Open decisions

No new palette, universal spacing scale, or component replacement is approved by this document.
Record selected future directions separately from observed conventions, preserve user edits,
and cite actual implementation files when documenting new foundations.
