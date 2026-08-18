# Build Plan — Single-open rail menus

**Phase 3 (dev-project-manager) · slug `rail-menu-exclusivity`**

## Stack decision

None to make. Existing conventions govern: vanilla JS on the global `App` object,
no bundler, no new dependency, renderer-only. Frontend track only —
`backend-agent` and `security-agent` have no surface here (no file I/O, no
`window.api` change, no network, no new persisted state).

## Branch

`feat/rail-menu-exclusivity` off latest `origin/main`. Working tree confirmed
clean. Merge to `main` is **not** performed by the pipeline — draft PR, maintainer
merges (per CLAUDE.md).

## Design — one controller, four registrations

New module-private helper in `src/renderer/js/app.js`, placed just above
`setupMeasureMenu()`:

```js
// Every rail/header flyout is a .tb-dropdown wrapping a trigger button and a
// .tb-menu. They all live in the same sliver of screen (see styles.css:764), so
// two open at once means one draws on top of the other. This registry keeps
// exactly one open: opening any menu closes the rest, Esc closes the current one
// and hands focus back to its trigger.
const Dropdowns = { list: [], open: null };
```

API (module-private, plus one narrow export for the harness):

| Function | Behaviour |
|---|---|
| `registerDropdown(btn, menu)` | Wires trigger click + returns `{ open, close, isOpen }`; pushes onto `Dropdowns.list` |
| `closeAllDropdowns(except)` | Closes every registered menu except the passed one |
| `App.Dropdowns.closeAll()` | Thin export so `SMOKE_DROPDOWN` and future code can reset state |

Trigger click handler (replaces the four copies):

```js
btn.addEventListener('click', (e) => {
  e.stopPropagation();           // kept: keeps this click from re-entering the
                                 // document-level handler below and instantly
                                 // re-closing what we just opened
  if (btn.disabled) return;
  const willOpen = menu.classList.contains('hidden');
  closeAllDropdowns();           // FR-1: proactively close siblings, since
                                 // stopPropagation means they never see the click
  if (willOpen) setOpen(true);   // FR-2: else it stays closed — plain toggle
});
```

`setOpen(on)` toggles `.hidden`, syncs `aria-expanded` (FR-5), and updates
`Dropdowns.open`.

**One** document-level listener replaces the four (FR-3):

```js
document.addEventListener('click', (e) => {
  const inside = e.target.closest('.tb-dropdown');
  Dropdowns.list.forEach((d) => { if (inside !== d.root) d.close(); });
});
```

Scoping on the *owning* `.tb-dropdown` element — not the selector — is what makes
FR-6 work: the Measure colour input and the two checkboxes resolve `closest()` to
their own root, so their menu survives while every other menu closes.

`aria-haspopup="true"` is set programmatically at registration so no HTML edit is
needed (FR-5).

## Escape (FR-4)

Insert in `setupKeys()` **after** the modal-dismiss block (`app.js:363-373`) and
**before** the mode-cancel block (`app.js:435`):

```js
if (e.key === 'Escape' && Dropdowns.open) {
  e.preventDefault();
  const trigger = Dropdowns.open.btn;
  closeAllDropdowns();
  if (trigger) trigger.focus();
  return;                        // must not fall through to mode cancel (R-8)
}
```

Placed after the modal check so a modal opened *from* a menu still wins; the
early `return` is what protects R-8.

## Work orders

| # | Task | Files | FRs |
|---|---|---|---|
| WO-1 | Add the `Dropdowns` registry + `registerDropdown` / `closeAllDropdowns` helpers and the single document listener | `src/renderer/js/app.js` | FR-1, FR-3, FR-5, FR-6, FR-7 |
| WO-2 | Convert all four `setup*Menu()` functions to use the registry; delete the four duplicated trigger handlers and the four document listeners | `src/renderer/js/app.js` | FR-1, FR-2, R-1…R-4 |
| WO-3 | Escape handling in `setupKeys()` | `src/renderer/js/app.js` | FR-4, R-8 |
| WO-4 | `SMOKE_DROPDOWN` scenario | `src/main.js` | acceptance 1-8 |
| WO-5 | Matching e2e assertion | `test/e2e/run.js` | acceptance 1-8 |

WO-1→WO-3 land as one commit (they are a single mechanical refactor that is not
independently valid); WO-4+WO-5 land as a second commit. Conventional Commits,
referencing FR numbers.

## Integration contract

- **No** new `window.api` method. **No** preload / `platform-web.js` change.
- **No** new persisted pref, so nothing to migrate.
- **No** HTML or CSS change; ARIA attributes are set from JS.
- New global surface: `App.Dropdowns = { closeAll() }` — additive only.

## Verification gates

1. `npm test` — unaffected (no `src/shared` change), must stay green.
2. `npm run test:e2e` — must pass including new `SMOKE_DROPDOWN`, plus
   `SMOKE_RAIL` (R-6), `SMOKE_MRAIL` (R-7), `SMOKE_MEASURE`, `SMOKE_MARKUP`,
   `SMOKE_ORGANIZE`, `SMOKE_STAMP` (R-1…R-3).
3. `npm run verify:web` — Android/WebView parity (R-10).
4. Manual read-through of the mobile bottom-bar CSS path (R-9) — JS is
   layout-agnostic, so this is a reasoning check, not a new test.

## Rollback

Single-file revert of the `app.js` commit restores prior behaviour exactly.
