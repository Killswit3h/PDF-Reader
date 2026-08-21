# Research brief — markups and measurements must survive a save/reopen

Phase 1 of the build pipeline. Scope is the reported defect only: marks stop
being movable after save → close → reopen. The five feature requests captured
alongside it (radius measure, page orientation, bookmarks, compare-rotate, zoom
accuracy) are deliberately out of scope and tracked separately.

## The report

> "Making markups and measurements on a PDF, saving it, closing the document,
> opening it again, then not being able to move or adjust measurements or
> markups. It looks like it combines the document into one instead of layers."

Confirmed to happen **both** in FieldMark itself and in Bluebeam/Acrobat. Those
are two different failures with two different causes, and they need separating.

## How the round-trip is supposed to work

The mechanism already exists and predates this work. `save.js` embeds two
attachments into every saved PDF:

| Attachment | Contents |
|---|---|
| `pdfsigner-model.json` | every placement, measurement and annotation, as data |
| `pdfsigner-base.pdf` | the original document with form edits applied and our marks **not** flattened |

On open, `viewer.js` reads both, throws away the flattened file it was handed,
reopens the *pristine base* as the working document, and rehydrates the marks as
live objects. Done correctly this is a clean design: other viewers see normal
flattened content and ignore the attachments, while FieldMark gets full fidelity.

There is a passing e2e scenario for it — *"round-trip — saved marks reopen as
editable objects (not baked in)"* — which is why this went unnoticed.

## Cause 1 — the save path can write half a sidecar

`save.js` attaches the model first, then builds and attaches the base:

```js
await pdfDoc.attach(json, App.SIDECAR.MODEL, …);          // model lands here
const baseDoc = await PDFDocument.load(App.state.pdfBytes); // ← can throw
await applyFormEdits(baseDoc);                              // ← can throw
await pdfDoc.attach(…, App.SIDECAR.BASE, …);                // ← can throw
```

All four calls sit in one `try`. If any of the last three throws, the `catch`
fires — but **the model is already attached to `pdfDoc`**, and the function
still returns `await pdfDoc.save()`. The result is a file carrying a complete
record of the user's marks and no base to lay them over.

`App.state.pdfBytes` being null is one concrete way in (it is set to null by
`_clearState`), and any malformed or unusual source PDF that pdf-lib can render
but not re-load is another.

## Cause 2 — the open path discards a half sidecar silently

`viewer.js:524`:

```js
if (sidecar && sidecar.base) Viewer._rehydrate(sidecar.data);
```

Requiring the base is **correct**: `_readSidecar` may legitimately return
`{data, base: null}`, and rehydrating marks over the flattened page without
swapping in the base would draw every mark twice.

The defect is what happens next — nothing. The marks are right there in
`sidecar.data`, fully recoverable, and the user is told nothing. The file simply
opens flat. Every other failure in this area toasts an explanation; this path,
the one that actually loses work, is the quiet one.

## Cause 3 — `saveAnnots` defaults to off, which explains the other half

`util.js:60`, `tabs.js:59` and `markup.js:786` all default `saveAnnots` to
`false`. With it off, marks are flattened into page content for every consumer;
only the sidecar keeps them alive, and only inside FieldMark.

So "dead in Bluebeam/Acrobat" is not the same bug at all — it is the default. The
recently added real-annotation export (Square/Circle/Line/PolyLine/Polygon/Ink/
FreeText/Highlight/Underline/StrikeOut plus calibrated dimensions) already makes
that path correct; it is simply not on unless the user finds the checkbox.

## Cause 4 — signing drops the sidecar by design

`digisign.js:354` calls `buildBytes({ noSidecar: true })`. Signing a document
therefore flattens its marks permanently, with no warning at the moment of
signing. This is defensible — a signed document should not carry a mutable
shadow copy that disagrees with what was signed — but it is currently invisible
to the user, who discovers it only on reopen.

## Cause 5 — attachments are fragile in transit

Any tool that rewrites the PDF may drop embedded files. A file round-tripped
through another editor, some email gateways, or "print to PDF" comes back
without its sidecar and therefore without editable marks. Nothing can fully
prevent this; it argues for real annotations (Cause 3) being the durable path
and the sidecar being the fidelity bonus, rather than the only mechanism.

## Why the existing test did not catch it

The e2e scenario exercises the happy path: save a document whose base loads
cleanly, reopen, confirm marks are live. Nothing constructs the half-written
state, and nothing asserts that a model without a base is reported to the user.

## Integration points

- `src/renderer/js/save.js` — sidecar embed block, `serializeModel`, `buildBytes`
- `src/renderer/js/viewer.js` — `_readSidecar`, `_rehydrate`, the load flow
- `src/renderer/js/util.js`, `tabs.js`, `markup.js` — `saveAnnots` default
- `src/renderer/js/digisign.js` — the `noSidecar` call
- `test/e2e/run.js` + `src/main.js` — a `SMOKE_*` scenario per repo convention

## Regression boundary — must not change

- Files without a sidecar keep opening exactly as they do now.
- Other viewers must keep seeing correct flattened content; no double-drawing.
- The existing `round-trip` e2e scenario must keep passing unmodified.
- Signing must keep producing a document whose visible content is what was
  signed.
