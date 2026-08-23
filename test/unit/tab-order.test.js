import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { TabOrder } = require('../../src/shared/tab-order.js');
const { moveTab, shiftTab, moveTabToEdge, sameOrder } = TabOrder;

describe('moveTab — drag a tab onto another tab', () => {
  it('drops a tab before the target when the cursor is on its left half', () => {
    expect(moveTab([1, 2, 3, 4], 4, 1, true)).toEqual([4, 1, 2, 3]);
  });

  it('drops a tab after the target when the cursor is on its right half', () => {
    expect(moveTab([1, 2, 3, 4], 1, 4, false)).toEqual([2, 3, 4, 1]);
  });

  // The classic off-by-one: pulling the dragged id out shifts every later
  // index down by one, so the target index must be re-read after the removal.
  it('moves left-to-right without an off-by-one', () => {
    expect(moveTab([1, 2, 3, 4], 1, 3, false)).toEqual([2, 3, 1, 4]);
    expect(moveTab([1, 2, 3, 4], 1, 3, true)).toEqual([2, 1, 3, 4]);
  });

  it('moves right-to-left through the same code path', () => {
    expect(moveTab([1, 2, 3, 4], 4, 2, true)).toEqual([1, 4, 2, 3]);
    expect(moveTab([1, 2, 3, 4], 4, 2, false)).toEqual([1, 2, 4, 3]);
  });

  it('is a no-op when a tab is dropped onto the edge it already occupies', () => {
    expect(moveTab([1, 2, 3], 1, 2, true)).toEqual([1, 2, 3]);
    expect(moveTab([1, 2, 3], 3, 2, false)).toEqual([1, 2, 3]);
  });

  it('leaves the order alone when a tab is dropped onto itself', () => {
    expect(moveTab([1, 2, 3], 2, 2, true)).toEqual([1, 2, 3]);
  });

  // A tab closed by a background window (or torn off) mid-drag must not
  // silently drop the dragged tab out of the strip.
  it('leaves the order intact when either id is gone', () => {
    expect(moveTab([1, 2, 3], 9, 2, true)).toEqual([1, 2, 3]);
    expect(moveTab([1, 2, 3], 2, 9, true)).toEqual([1, 2, 3]);
  });

  it('never mutates the array it was given', () => {
    const order = [1, 2, 3];
    moveTab(order, 3, 1, true);
    expect(order).toEqual([1, 2, 3]);
  });

  it('survives a missing or non-array order', () => {
    expect(moveTab(undefined, 1, 2, true)).toEqual([]);
    expect(moveTab(null, 1, 2, false)).toEqual([]);
  });
});

describe('shiftTab — nudge a tab with the keyboard', () => {
  it('moves one slot left and right', () => {
    expect(shiftTab([1, 2, 3], 2, -1)).toEqual([2, 1, 3]);
    expect(shiftTab([1, 2, 3], 2, 1)).toEqual([1, 3, 2]);
  });

  it('clamps at both ends instead of wrapping around', () => {
    expect(shiftTab([1, 2, 3], 1, -1)).toEqual([1, 2, 3]);
    expect(shiftTab([1, 2, 3], 3, 1)).toEqual([1, 2, 3]);
    expect(shiftTab([1, 2, 3], 1, -5)).toEqual([1, 2, 3]);
    expect(shiftTab([1, 2, 3], 1, 99)).toEqual([2, 3, 1]);
  });

  it('handles multi-slot jumps', () => {
    expect(shiftTab([1, 2, 3, 4], 1, 2)).toEqual([2, 3, 1, 4]);
  });

  it('is a no-op for a zero delta or an unknown id', () => {
    expect(shiftTab([1, 2, 3], 2, 0)).toEqual([1, 2, 3]);
    expect(shiftTab([1, 2, 3], 9, 1)).toEqual([1, 2, 3]);
  });

  it('never mutates its input', () => {
    const order = [1, 2, 3];
    shiftTab(order, 1, 1);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('moveTabToEdge — send a tab to the far end of the strip', () => {
  it('moves a tab to the start', () => {
    expect(moveTabToEdge([1, 2, 3], 3, 'start')).toEqual([3, 1, 2]);
  });

  it('moves a tab to the end', () => {
    expect(moveTabToEdge([1, 2, 3], 1, 'end')).toEqual([2, 3, 1]);
  });

  it('is stable when the tab is already at that edge', () => {
    expect(moveTabToEdge([1, 2, 3], 1, 'start')).toEqual([1, 2, 3]);
    expect(moveTabToEdge([1, 2, 3], 3, 'end')).toEqual([1, 2, 3]);
  });

  it('ignores an unknown id', () => {
    expect(moveTabToEdge([1, 2, 3], 9, 'start')).toEqual([1, 2, 3]);
  });
});

describe('sameOrder', () => {
  it('detects an unchanged order', () => {
    expect(sameOrder([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(sameOrder([1, 2, 3], [1, 3, 2])).toBe(false);
    expect(sameOrder([1, 2], [1, 2, 3])).toBe(false);
  });

  it('reports a no-op move as unchanged', () => {
    const order = [1, 2, 3];
    expect(sameOrder(order, moveTab(order, 1, 2, true))).toBe(true);
    expect(sameOrder(order, moveTab(order, 1, 2, false))).toBe(false);
  });
});

describe('a full rearrangement round-trip', () => {
  // Eight open documents, dragged into a deliberately chosen order — the
  // real-world case this feature exists for.
  it('reaches an arbitrary target order and keeps every tab', () => {
    let order = [1, 2, 3, 4, 5, 6, 7, 8];
    order = moveTab(order, 8, 1, true);        // 8 to the front
    order = moveTab(order, 3, 7, false);       // 3 after 7
    order = shiftTab(order, 5, -2);            // nudge 5 two slots left
    order = moveTabToEdge(order, 2, 'end');    // 2 to the very end
    expect(order.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(order).toEqual([8, 1, 5, 4, 6, 7, 3, 2]);
  });
});
