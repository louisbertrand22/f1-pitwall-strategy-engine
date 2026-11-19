import { describe, expect, it } from 'vitest';
import { buildBattleMarkers, computeRowLayout, MAX_ROW_HEIGHT, MIN_ROW_HEIGHT } from '../timing/rowModel';
import type { TimingRowModel } from '../timing/rowModel';
import { boxesOverlap, fitViewport, labelReach, wrapSigned } from './layout';
import type { FitInput } from './layout';

/** A 100 × 50 rectangle of points (track units). */
function rectangle(): { xs: Float32Array; ys: Float32Array; count: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i <= 100; i += 2) xs.push(i, i), ys.push(0, 50);
  for (let j = 0; j <= 50; j += 2) xs.push(0, 100), ys.push(j, j);
  return { xs: Float32Array.from(xs), ys: Float32Array.from(ys), count: xs.length };
}

const base: FitInput = {
  width: 800,
  height: 400,
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 50 },
  padding: { top: 20, right: 20, bottom: 20, left: 20 },
  obstacles: [],
  points: [rectangle()],
  clearance: 10,
};

describe('radar layout', () => {
  it('fits the circuit to the padded canvas, centred, keeping the aspect ratio', () => {
    const view = fitViewport(base);
    expect(view.scale).toBeCloseTo(7.2, 5); // height-limited: 360 / 50
    expect(view.offsetX).toBeCloseTo(20 + (760 - 720) / 2, 5);
    expect(view.offsetY).toBeCloseTo(20, 5);
  });

  it('moves or shrinks the circuit to keep it clear of a HUD box', () => {
    const obstacle = { x: 620, y: 0, w: 180, h: 60 };
    const view = fitViewport({ ...base, obstacles: [obstacle] });
    const set = base.points[0]!;
    for (let i = 0; i < set.count; i += 3) {
      const x = set.xs[i]! * view.scale + view.offsetX;
      const y = set.ys[i]! * view.scale + view.offsetY;
      const inside = x > obstacle.x - 10 && x < obstacle.x + obstacle.w + 10 && y > obstacle.y - 10 && y < obstacle.y + obstacle.h + 10;
      expect(inside).toBe(false);
    }
    expect(view.scale).toBeGreaterThan(7.2 * 0.75);
  });

  it('has consistent rectangle helpers', () => {
    expect(boxesOverlap(0, 0, 5, 5, 9, 0, 5, 5)).toBe(true);
    expect(boxesOverlap(0, 0, 5, 5, 11, 0, 5, 5)).toBe(false);
    expect(boxesOverlap(0, 0, 5, 5, 11, 0, 5, 5, 2)).toBe(true);
    expect(labelReach(1, 0, 30, 10, 4)).toBe(19);
    expect(labelReach(0, -1, 30, 10, 4)).toBe(9);
    expect(wrapSigned(0.98 - 0.02)).toBeCloseTo(-0.04, 6);
    expect(wrapSigned(0.02 - 0.98)).toBeCloseTo(0.04, 6);
  });
});

describe('timing tower layout', () => {
  it('fills the body exactly with whole-pixel rows', () => {
    const layout = computeRowLayout(823, 20);
    expect(layout.scrolls).toBe(false);
    expect(layout.tops[0]).toBe(0);
    expect(layout.tops[20]).toBe(823);
    for (let i = 0; i < 20; i++) expect([41, 42]).toContain(layout.tops[i + 1]! - layout.tops[i]!);
  });

  it('clamps the row height and scrolls when the body is too short', () => {
    expect(computeRowLayout(300, 20)).toMatchObject({ scrolls: true });
    expect(computeRowLayout(300, 20).tops[20]).toBe(20 * MIN_ROW_HEIGHT);
    expect(computeRowLayout(2000, 20).tops[20]).toBe(20 * MAX_ROW_HEIGHT);
  });

  it('draws one marker per fight', () => {
    const row = (id: string, slot: number, battleWith: string | null): TimingRowModel =>
      ({ id, slot, battleWith }) as TimingRowModel;
    const markers = buildBattleMarkers([row('AAA', 0, null), row('BBB', 1, 'CCC'), row('CCC', 2, 'BBB'), row('DDD', 3, null), row('EEE', 4, 'AAA')]);
    expect(markers.map((m) => m.key)).toEqual(['link-2', 'solo-EEE']);
  });
});
