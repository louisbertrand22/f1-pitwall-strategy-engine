/** SVG path builders. Coordinates are rounded to 0.1 px to keep the `d` strings short. */

export type XY = readonly [number, number];

function fmt(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** Polyline through `points`; a `null` entry lifts the pen (gap in the data). */
export function linePath(points: readonly (XY | null)[]): string {
  let d = '';
  let penDown = false;
  for (const p of points) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      penDown = false;
      continue;
    }
    d += `${penDown ? 'L' : 'M'}${fmt(p[0])} ${fmt(p[1])}`;
    penDown = true;
  }
  return d;
}

/** Closed area between a polyline and a horizontal baseline. */
export function areaPath(points: readonly XY[], baselineY: number): string {
  if (points.length < 2) return '';
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return `${linePath(points)}L${fmt(last[0])} ${fmt(baselineY)}L${fmt(first[0])} ${fmt(baselineY)}Z`;
}

/** Closed band between an upper and a lower polyline sharing the same x positions. */
export function bandPath(upper: readonly XY[], lower: readonly XY[]): string {
  if (upper.length < 2 || lower.length < 2) return '';
  let d = linePath(upper);
  for (let i = lower.length - 1; i >= 0; i--) {
    const p = lower[i]!;
    d += `L${fmt(p[0])} ${fmt(p[1])}`;
  }
  return `${d}Z`;
}

/** Annular sector (ring segment) between two radii and two angles in radians, clockwise from `a0` to `a1`. */
export function sectorPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  const x = (r: number, a: number): string => fmt(cx + r * Math.cos(a));
  const y = (r: number, a: number): string => fmt(cy + r * Math.sin(a));
  return (
    `M${x(r1, a0)} ${y(r1, a0)}A${fmt(r1)} ${fmt(r1)} 0 ${large} 1 ${x(r1, a1)} ${y(r1, a1)}` +
    `L${x(r0, a1)} ${y(r0, a1)}A${fmt(r0)} ${fmt(r0)} 0 ${large} 0 ${x(r0, a0)} ${y(r0, a0)}Z`
  );
}
