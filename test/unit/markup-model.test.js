import { describe, it, expect } from 'vitest';
import { serializeMarkupModel, MARKUP_MODEL_VERSION } from '../../src/shared/markup-model.js';

// This shape is the editable round-trip contract: save.js embeds it and
// tabs.js reads it back on open. A silent change here means saved files stop
// reopening as editable, which is exactly the defect fixed in #98.
describe('serializeMarkupModel', () => {
  const state = () => ({
    placementSeq: 3, measureSeq: 2, viewportSeq: 1, annoSeq: 7,
    saveAnnots: true,
    scales: { 1: { factor: 0.5, unit: 'ft' } },
    viewports: { 1: { w: 100 } },
    placements: [{ id: 1, page: 1 }],
    measurements: [{ id: 2, page: 1, pts: [{ vx: 1, vy: 2 }] }],
    annotations: [{ id: 7, page: 2, type: 'rect' }]
  });

  it('carries every field the reader consumes', () => {
    const m = serializeMarkupModel(state());
    expect(m.v).toBe(MARKUP_MODEL_VERSION);
    expect(m.seqs).toEqual({ placementSeq: 3, measureSeq: 2, viewportSeq: 1, annoSeq: 7 });
    expect(m.saveAnnots).toBe(true);
    expect(m.scales).toEqual({ 1: { factor: 0.5, unit: 'ft' } });
    expect(m.viewports).toEqual({ 1: { w: 100 } });
    expect(m.placements).toHaveLength(1);
    expect(m.measurements).toHaveLength(1);
    expect(m.annotations).toHaveLength(1);
  });

  // __count is the gate deciding whether a sidecar is attached at all. If it
  // ever counted wrong, a document with marks would save without the sidecar
  // and reopen flat -- silently, which is the failure mode that hurts most.
  describe('__count gate', () => {
    it('sums all three mark layers', () => {
      expect(serializeMarkupModel(state()).__count).toBe(3);
    });

    it('is 0 for a document with no marks, so no sidecar is attached', () => {
      const m = serializeMarkupModel({ scales: { 1: { factor: 2 } }, saveAnnots: true });
      expect(m.__count).toBe(0);
    });

    it('counts a layer that is populated while the others are empty', () => {
      const m = serializeMarkupModel({ annotations: [{ id: 1 }, { id: 2 }] });
      expect(m.__count).toBe(2);
    });
  });

  // The model is handed to the encoder and the app keeps running; a later edit
  // to App.state must not reach back into bytes already being written.
  it('deep clones, so mutating the source cannot alter the model', () => {
    const st = state();
    const m = serializeMarkupModel(st);
    st.annotations[0].type = 'ellipse';
    st.annotations.push({ id: 8 });
    st.scales[1].unit = 'm';
    expect(m.annotations).toHaveLength(1);
    expect(m.annotations[0].type).toBe('rect');
    expect(m.scales[1].unit).toBe('ft');
  });

  describe('degenerate input', () => {
    it('survives no state at all', () => {
      const m = serializeMarkupModel(undefined);
      expect(m.__count).toBe(0);
      expect(m.placements).toEqual([]);
      expect(m.seqs.annoSeq).toBe(0);
      expect(m.saveAnnots).toBe(false);
    });

    it('coerces non-array mark layers to empty arrays rather than throwing', () => {
      const m = serializeMarkupModel({ placements: null, measurements: 'nope', annotations: { a: 1 } });
      expect(m.placements).toEqual([]);
      expect(m.measurements).toEqual([]);
      expect(m.annotations).toEqual([]);
      expect(m.__count).toBe(0);
    });

    it('coerces a non-object scales/viewports to {}', () => {
      const m = serializeMarkupModel({ scales: [1, 2], viewports: null });
      expect(m.scales).toEqual({});
      expect(m.viewports).toEqual({});
    });

    it('normalises saveAnnots to a real boolean', () => {
      expect(serializeMarkupModel({ saveAnnots: 1 }).saveAnnots).toBe(true);
      expect(serializeMarkupModel({ saveAnnots: undefined }).saveAnnots).toBe(false);
    });
  });
});
