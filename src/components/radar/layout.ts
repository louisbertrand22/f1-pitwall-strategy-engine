/**
 * Pure layout maths of the track radar: fitting the circuit into the canvas while keeping it clear of
 * the HUD boxes, and the rectangle helpers used to de-clutter labels. No DOM, so it is unit-testable.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Uniform scale + translation from track units to CSS pixels: `screen = unit · scale + offset`. */
export interface Viewport {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** A run of points in track units (same shape as `Polyline` of the track geometry). */
export interface PointSet {
  xs: Float32Array;
  ys: Float32Array;
  count: number;
}

export interface FitInput {
  width: number;
  height: number;
  /** Everything that has to be visible, in track units. */
  bounds: Bounds;
  padding: Insets;
  /** Screen rectangles (HUD boxes) the circuit should not run underneath. */
  obstacles: readonly Rect[];
  /** Points of the circuit tested against the obstacles. */
  points: readonly PointSet[];
  /** Distance (px) the points must keep from an obstacle. */
  clearance: number;
}

/** Candidate anchors, most centred first: at equal scale the earliest clean one wins. */
const ALIGNMENTS: readonly (readonly [number, number])[] = [
  [0.5, 0.5],
  [0, 0.5],
  [1, 0.5],
  [0.5, 1],
  [0.5, 0],
  [0, 1],
  [1, 1],
  [0, 0],
  [1, 0],
];
/** The circuit is never drawn smaller than this share of the plain "fit to padding" size. */
const MIN_SCALE_SHARE = 0.76;
const SCALE_STEPS = 12;
/** Only every n-th point is tested: plenty for boxes that are tens of pixels wide. */
const POINT_STRIDE = 3;

function countHits(input: FitInput, scale: number, offsetX: number, offsetY: number, giveUpAt: number): number {
  const { obstacles, points, clearance } = input;
  let hits = 0;
  for (const set of points) {
    for (let i = 0; i < set.count; i += POINT_STRIDE) {
      const x = set.xs[i]! * scale + offsetX;
      const y = set.ys[i]! * scale + offsetY;
      for (const r of obstacles) {
        if (x > r.x - clearance && x < r.x + r.w + clearance && y > r.y - clearance && y < r.y + r.h + clearance) {
          hits++;
          if (hits >= giveUpAt) return hits;
          break;
        }
      }
    }
  }
  return hits;
}

/**
 * Largest uniform scale (aspect ratio preserved) at which the circuit fits inside the padded canvas and
 * runs under none of the obstacles. The search trades a little size (at most `1 − MIN_SCALE_SHARE`) and
 * the centring for a clean HUD; when no clean placement exists the least overlapping one is returned.
 */
export function fitViewport(input: FitInput): Viewport {
  const { width, height, bounds, padding } = input;
  const availableW = Math.max(1, width - padding.left - padding.right);
  const availableH = Math.max(1, height - padding.top - padding.bottom);
  const boundsW = Math.max(1e-6, bounds.maxX - bounds.minX);
  const boundsH = Math.max(1e-6, bounds.maxY - bounds.minY);
  const fullScale = Math.min(availableW / boundsW, availableH / boundsH);

  let best: Viewport | null = null;
  let bestHits = Number.POSITIVE_INFINITY;
  for (let step = 0; step <= SCALE_STEPS; step++) {
    const scale = fullScale * (1 - ((1 - MIN_SCALE_SHARE) * step) / SCALE_STEPS);
    for (const [ax, ay] of ALIGNMENTS) {
      const offsetX = padding.left + (availableW - boundsW * scale) * ax - bounds.minX * scale;
      const offsetY = padding.top + (availableH - boundsH * scale) * ay - bounds.minY * scale;
      const hits = input.obstacles.length === 0 ? 0 : countHits(input, scale, offsetX, offsetY, bestHits);
      if (hits === 0) return { scale, offsetX, offsetY };
      if (hits < bestHits) {
        bestHits = hits;
        best = { scale, offsetX, offsetY };
      }
    }
  }
  return (
    best ?? {
      scale: fullScale,
      offsetX: padding.left + (availableW - boundsW * fullScale) / 2 - bounds.minX * fullScale,
      offsetY: padding.top + (availableH - boundsH * fullScale) / 2 - bounds.minY * fullScale,
    }
  );
}

/** True when two rectangles given by centre and half-extents overlap (with `pad` extra margin). */
export function boxesOverlap(
  ax: number,
  ay: number,
  ahw: number,
  ahh: number,
  bx: number,
  by: number,
  bhw: number,
  bhh: number,
  pad = 0,
): boolean {
  return Math.abs(ax - bx) < ahw + bhw + pad && Math.abs(ay - by) < ahh + bhh + pad;
}

/**
 * Distance from an anchor point to the centre of a `w × h` label pushed away from it along the unit
 * direction (nx, ny), so that the label's nearest edge sits `gap` pixels from the anchor.
 */
export function labelReach(nx: number, ny: number, w: number, h: number, gap: number): number {
  return gap + (Math.abs(nx) * w) / 2 + (Math.abs(ny) * h) / 2;
}

/** Wraps a lap fraction difference into (−0.5, 0.5]. */
export function wrapSigned(delta: number): number {
  const r = delta - Math.floor(delta);
  return r > 0.5 ? r - 1 : r;
}
