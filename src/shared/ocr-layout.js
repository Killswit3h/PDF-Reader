'use strict';

/*
 * OCR layout math, shared by ocr.js and unit-tested in Node.
 *
 * Tesseract works in raster pixels with a top-left origin; the rest of this app
 * works in *scale-1 viewport points*, top-left origin (see save.js's coordinate
 * note). One scale-1 viewport point == one PDF point == 1/72 in, so a page
 * rasterized at `scale` is exactly `72 * scale` DPI.
 *
 * Everything here is pure — no DOM, no PDF.js, no App.state — so the numbers
 * that decide raster size and glyph placement can be tested without booting
 * Electron. Dual export → { OcrLayout } in Node, App.OcrLayout in the browser.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.App = root.App || {};
    Object.assign(root.App, factory());
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // A page rasterized at scale s is 72*s DPI, because a scale-1 viewport point
  // is a PDF point and there are 72 of those per inch.
  const DPI_PER_SCALE = 72;

  // Defaults enforce FR-A-7. 300 DPI is the practical ceiling for OCR accuracy
  // (Tesseract's own guidance is 300; beyond that cost grows and accuracy does
  // not), and 40 MP keeps a single page's RGBA buffer near 160 MB, which is what
  // keeps the WASM heap inside NFR-4 on a tablet.
  const MAX_DPI = 300;
  const MAX_PIXELS = 40e6;

  // Below this the raster is too coarse for recognition to be worth running; a
  // page that cannot reach it under the pixel cap is reported as failed (E4)
  // rather than silently recognized into garbage. 72 DPI == scale 1.
  const MIN_SCALE = 1;

  /**
   * The render scale for a page, honouring both caps in FR-A-7.
   * Returns scale as a PDF.js viewport multiplier (1 == 72 DPI).
   * Compare the result against MIN_SCALE to detect a page that is too large.
   */
  function rasterScale(vpWidth, vpHeight, maxDpi, maxPixels) {
    const dpiCap = (maxDpi == null ? MAX_DPI : maxDpi) / DPI_PER_SCALE;
    const pxCap = maxPixels == null ? MAX_PIXELS : maxPixels;
    const area = (vpWidth || 0) * (vpHeight || 0);
    if (!(area > 0)) return dpiCap;
    // width*s * height*s <= pxCap  =>  s <= sqrt(pxCap / area)
    const pixelCap = Math.sqrt(pxCap / area);
    return Math.min(dpiCap, pixelCap);
  }

  // The DPI a given render scale corresponds to — for reporting and assertions.
  function dpiOf(scale) { return scale * DPI_PER_SCALE; }

  /**
   * Tesseract word bbox (raster px, top-left origin) -> scale-1 viewport points.
   * `bbox` is Tesseract's { x0, y0, x1, y1 }.
   */
  function wordToViewport(bbox, scale) {
    const s = scale || 1;
    const x0 = Math.min(bbox.x0, bbox.x1);
    const x1 = Math.max(bbox.x0, bbox.x1);
    const y0 = Math.min(bbox.y0, bbox.y1);
    const y1 = Math.max(bbox.y0, bbox.y1);
    return {
      vx: x0 / s,
      vy: y0 / s,
      vw: (x1 - x0) / s,
      vh: (y1 - y0) / s
    };
  }

  // Tesseract's word box is tight around the ink, so its bottom edge sits at the
  // descender for a word like "page" but at the baseline for one like "TOP".
  // Placing the invisible baseline a little above the box bottom splits that
  // difference: it keeps selection rectangles aligned with the printed line for
  // both cases, which is what makes a searchable PDF feel correct rather than
  // subtly offset.
  const BASELINE_RATIO = 0.88;

  /** Baseline y (scale-1 viewport points, top-left origin) for a word box. */
  function baselineY(box, ratio) {
    const r = ratio == null ? BASELINE_RATIO : ratio;
    return box.vy + box.vh * r;
  }

  // Font size for the invisible run. Using the box height directly makes the
  // selection rectangle the same height as the recognized word, which is the
  // behaviour a reader expects when dragging across OCR'd text.
  function fontSizeFor(box, ratio) {
    const r = ratio == null ? 1 : ratio;
    const size = box.vh * r;
    // A zero/absurd size would make pdf-lib emit a degenerate text run.
    return size > 0.01 ? size : 0.01;
  }

  /**
   * Horizontal scaling percentage (the PDF `Tz` operator) that stretches a run
   * of natural width `naturalWidth` to exactly span `boxWidth`.
   *
   * Without this the invisible glyphs drift out from under the ink they belong
   * to, and find-match highlights land beside the word instead of on it.
   */
  function squeeze(boxWidth, naturalWidth) {
    if (!(naturalWidth > 0) || !(boxWidth > 0)) return 100;
    const pct = (boxWidth / naturalWidth) * 100;
    // Clamp so one pathological measurement cannot emit a wild Tz value.
    return Math.max(1, Math.min(1000, pct));
  }

  /** Words below this confidence are discarded (FR-A-9). */
  const MIN_CONFIDENCE = 30;

  /**
   * Keep only words worth writing: confident enough, non-empty, and with a real
   * box. Tesseract routinely returns zero-area boxes and whitespace-only "words"
   * on noisy scans; writing those produces invisible runs that catch selections
   * where there is no ink.
   */
  function usableWord(w, minConf) {
    if (!w) return false;
    const text = typeof w.text === 'string' ? w.text.trim() : '';
    if (!text) return false;
    const conf = typeof w.confidence === 'number' ? w.confidence : 0;
    if (conf < (minConf == null ? MIN_CONFIDENCE : minConf)) return false;
    const b = w.bbox;
    if (!b) return false;
    return Math.abs(b.x1 - b.x0) > 0 && Math.abs(b.y1 - b.y0) > 0;
  }

  // The characters outside Latin-1 that WinAnsiEncoding still covers (the
  // 0x80–0x9F block: smart quotes, dashes, bullet, ellipsis and friends).
  const WINANSI_EXTRA =
    '€‚ƒ„…†‡ˆ‰Š‹Œ' +
    'Ž‘’“”•–—˜™š›' +
    'œžŸ';

  /**
   * Drop characters a standard PDF font cannot encode.
   *
   * pdf-lib throws on the first character WinAnsiEncoding cannot represent, so
   * a single stray glyph hallucinated from scanner noise — a CJK character, an
   * emoji — would abort the export of the whole document. Recognition runs on
   * unpredictable input, so filter rather than trust it.
   */
  function sanitizeText(s) {
    const str = s == null ? '' : String(s);
    let out = '';
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (c >= 0x20 && c <= 0x7e) out += ch;            // printable ASCII
      else if (c >= 0xa0 && c <= 0xff) out += ch;       // Latin-1 supplement
      else if (WINANSI_EXTRA.indexOf(ch) !== -1) out += ch;
      // control characters, CJK, emoji and the rest are dropped
    }
    return out;
  }

  return {
    OcrLayout: {
      DPI_PER_SCALE, MAX_DPI, MAX_PIXELS, MIN_SCALE, MIN_CONFIDENCE,
      BASELINE_RATIO,
      rasterScale, dpiOf, wordToViewport, baselineY, fontSizeFor, squeeze,
      usableWord, sanitizeText
    }
  };
});
