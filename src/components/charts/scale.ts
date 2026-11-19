/** Minimal scale / tick helpers for the hand-rolled SVG charts (no chart library). */

export interface LinearScale {
  (value: number): number;
  /** Pixel → data value. */
  invert(pixel: number): number;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Linear map of `domain` onto `range`. Either interval may be descending (inverted axis). */
export function linearScale(domain: readonly [number, number], range: readonly [number, number]): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  // A degenerate domain maps everything to the middle of the range instead of dividing by zero.
  const k = span === 0 ? 0 : (r1 - r0) / span;
  const mid = (r0 + r1) / 2;
  const scale = (value: number): number => (span === 0 ? mid : r0 + (value - d0) * k);
  const invert = (pixel: number): number => (k === 0 ? d0 : d0 + (pixel - r0) / k);
  return Object.assign(scale, { invert, domain, range });
}

/** Largest "nice" step (1, 2, 2.5, 5 × 10ⁿ) giving at most ~`targetTicks` intervals over `span`. */
export function niceStep(span: number, targetTicks: number): number {
  if (!(span > 0) || !(targetTicks > 0)) return 1;
  const raw = span / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const residual = raw / magnitude;
  const factor = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10;
  return factor * magnitude;
}

/** Tick values on multiples of a nice step inside [min, max]. */
export function niceTicks(min: number, max: number, targetTicks: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (lo === hi) return [lo];
  const step = niceStep(hi - lo, targetTicks);
  const ticks: number[] = [];
  const first = Math.ceil(lo / step - 1e-9);
  const last = Math.floor(hi / step + 1e-9);
  for (let i = first; i <= last; i++) {
    // Multiplying an integer index avoids the 0.30000000000000004 drift of repeated addition.
    ticks.push(Number((i * step).toPrecision(12)));
  }
  return ticks;
}

/** Expands [min, max] outwards to the surrounding multiples of the nice step. */
export function niceDomain(min: number, max: number, targetTicks: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const step = niceStep(hi - lo, targetTicks);
  return [Math.floor(lo / step + 1e-9) * step, Math.ceil(hi / step - 1e-9) * step];
}

const LAP_STEPS = [1, 2, 5, 10, 20, 25, 50] as const;

/**
 * Integer lap ticks for a lap axis `pixelWidth` wide: the finest step of 1/2/5/10/20… laps that keeps
 * labels at least `minSpacing` px apart.
 */
export function lapTicks(minLap: number, maxLap: number, pixelWidth: number, minSpacing = 34): number[] {
  const span = maxLap - minLap;
  if (!(span > 0) || !(pixelWidth > 0)) return [];
  const pxPerLap = pixelWidth / span;
  let step: number = LAP_STEPS[LAP_STEPS.length - 1];
  for (const candidate of LAP_STEPS) {
    if (candidate * pxPerLap >= minSpacing) {
      step = candidate;
      break;
    }
  }
  const ticks: number[] = [];
  for (let lap = Math.ceil(minLap / step) * step; lap <= maxLap + 1e-9; lap += step) ticks.push(lap);
  return ticks;
}

/** [min, max] of the finite values, or null when there is none. */
export function extent(values: Iterable<number | null | undefined>): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : null;
}
