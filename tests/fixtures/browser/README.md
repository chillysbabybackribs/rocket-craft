# Browser fixtures

Static pages used by `tests/ui/browser-capabilities.spec.ts` (Phase 0 baseline).

## `spa.html`

Minimal **hash-routed SPA**:

- List at `#/list` (default): heading **Records**, links to `#/record/alpha` and `#/record/beta`.
- Detail: loads **`GET /spa/api/records/{id}`** and shows `name` + `note`.
- **Rerender list** replaces list DOM nodes (same labels) to exercise stale control refs.

Notes in the API records: `ALPHA-42`, `BETA-99`.

Served from the UI test fixture HTTP server at `{origin}/spa` (see `tests/ui/app.ts`).

Query `?slow=ms` delays the detail API fetch so reads can catch **Loading…** before `ALPHA-42` appears (models the Espo-style URL-ahead-of-content gap).
