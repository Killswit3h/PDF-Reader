# Build plan — markups and measurements survive save/reopen

Phase 3. Implements `feature-editable-roundtrip-spec.md`. No stack decision:
vanilla JS on the global `App` object, no bundler, renderer-only, per CLAUDE.md.

## Design note — full atomicity is not available, so this layers

FR-1 asks that the two attachments be written as a pair. pdf-lib's `attach()`
has no detach and no transaction, so a literal all-or-nothing guarantee is not
purchasable cheaply. The plan therefore layers two defences:

1. **Reorder so the failure cannot happen in practice.** Build the base bytes
   *before* attaching anything. Every operation that realistically throws —
   loading `pdfBytes`, applying form edits, re-saving the base — then runs while
   nothing is attached yet, so a failure leaves a clean file with no sidecar.
2. **Make the half state survivable if it ever occurs.** The open path stops
   discarding a model that has no base, and says so.

Defence 1 removes the cause; defence 2 removes the silence. Together they satisfy
the spec's intent. Claiming true atomicity would be dishonest, so the code
comment will say what it actually guarantees.

## Integration contract

### `src/renderer/js/save.js`
- Restructure the sidecar block: produce `baseBytes` first, then attach model and
  base back to back. (FR-1, FR-2)
- Keep the existing `catch` and its toast, and make the message accurate about
  what was and was not written. (FR-3)
- Add `/CreationDate` and `/M` to exported annotations — **deferred to the change
  log feature**, not this branch. Noted here so it is not accidentally folded in.

### `src/renderer/js/viewer.js`
- `_readSidecar` already returns `{data, base}` with a possibly-null base; leave
  it alone.
- At the load site, split the two conditions. Base present → today's behaviour.
  Model present, base absent → open flat, do **not** rehydrate (the guard stays;
  double-drawing is still wrong), and raise a clear message. (FR-4)
- Add `Viewer.exportOrphanModel(data)` writing the model to a JSON file via the
  existing `window.api` save contract. (FR-5)

### `src/renderer/js/util.js`, `tabs.js`, `markup.js`
- Flip the `saveAnnots` default from `false` to `true` in all three places: the
  initial state (`util.js:60`), the per-tab default (`tabs.js:59`), and the
  preference fallback (`markup.js:786`). (FR-6)
- A user who has explicitly set the preference keeps their choice; only the
  fallback changes.

### `src/renderer/js/digisign.js`
- Before signing, warn that the signed copy's marks will not reopen as editable,
  with a cancel. (FR-8)

## Work order

| # | Task | FRs |
|---|---|---|
| 1 | Reorder the sidecar embed so the base is built before any attach | FR-1, FR-2 |
| 2 | Correct the failure toast to state what was written | FR-3 |
| 3 | Split the load-site condition; report a model with no base | FR-4 |
| 4 | Add the orphan-model JSON export and wire it to the message | FR-5 |
| 5 | Flip the three `saveAnnots` defaults | FR-6 |
| 6 | Surface flattening at save time when the setting is off | FR-7 |
| 7 | Pre-sign warning with cancel | FR-8 |
| 8 | Tests — unit, `SMOKE_ROUNDTRIP`, e2e assertions | AC-1..7 |

Tasks 1–4 are the data-loss fix and are independent of 5–7; if anything in the
default flip proves contentious, 1–4 still ship on their own.

## Risk — FR-6 will move existing e2e scenarios

Flipping `saveAnnots` to on changes what `buildBytes` produces **by default**,
and several existing scenarios assert flattened output — `wysiwyg` (a clicked
text mark flattens where it shows on screen), `text rotation`, `trot`, and the
`markup` export checks are the likely ones. They currently pass because the
default is off.

These must be triaged one at a time, and each decided deliberately:

- If a scenario is *about* flattening, it should set `saveAnnots = false`
  explicitly rather than relying on the default. That is a better test anyway.
- If a scenario merely assumed the default, its expectation changes.

**No scenario gets relaxed to make it pass.** Any that cannot be resolved this
way is a signal the default flip has a real consequence, and it comes back to the
checkpoint rather than being papered over.

## Regression boundary — verified before merge

- The existing `round-trip — saved marks reopen as editable objects` scenario
  passes **unmodified**.
- A PDF that never passed through FieldMark opens exactly as it does today, with
  no new messages.
- No double-drawing in any path: the `sidecar.base` guard is not removed.
- Signed documents still show exactly what was signed.
- `verify:tools` stays green — it sets `saveAnnots` explicitly, so the default
  flip must not affect it.

## Test plan

**Unit** (`test/unit/`) — `serializeModel` shape and the `__count` gate, which is
what decides whether a sidecar is attempted at all.

**New `SMOKE_ROUNDTRIP` scenario** in `src/main.js` per repo convention, with
assertions in `test/e2e/run.js`:
- AC-1: mark up, export, reopen the bytes, confirm marks are live and counts match.
- AC-2: force the base to fail, confirm the saved file carries **neither**
  attachment and the warning fired.
- AC-3: construct a model-without-base file deliberately — nothing does this
  today — and confirm opening it reports the problem instead of silently
  flattening.

**Gates** — `npm run verify`, `npm run verify:web`, `npm run verify:tools`.

## Branching

Fresh from `origin/main` per CLAUDE.md, not stacked on
`feat/production-hardening`, whose PR is still open. Branch `fix/editable-roundtrip`.
Draft PR on inspection PASS; the maintainer merges.
