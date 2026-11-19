/**
 * Track geometry: turns a circuit's SVG centreline into everything the simulation and the radar need.
 *
 *  - a closed polyline sampled uniformly in arc length (GPS positions of the cars),
 *  - a reference speed profile obtained from a quasi-steady-state point-mass lap simulation
 *    (corner speed from curvature, traction/power-limited acceleration, aero-assisted braking),
 *    calibrated so that one lap takes exactly `track.baseLapTime`,
 *  - the mapping between lap distance fraction and lap time fraction. The race engine works in the time
 *    domain (so gaps are true time gaps) and uses this mapping to place cars on the map,
 *  - the pit-lane polyline (the centreline offset towards the pit side).
 *
 * Pure TypeScript (no DOM), so it runs identically in the Web Worker and on the main thread.
 */
import type { TrackDefinition } from './types';

export interface TrackPoint {
  x: number;
  y: number;
  /** Heading of travel in radians (SVG axes: x to the right, y down). */
  angle: number;
}

export interface Polyline {
  xs: Float32Array;
  ys: Float32Array;
  count: number;
}

export interface TrackGeometry {
  trackId: string;
  /** Samples along the lap, uniform in arc length. Sample i sits at lap distance fraction i / sampleCount. */
  sampleCount: number;
  /** Coordinates in SVG units; arrays have sampleCount + 1 entries (the last repeats the first). */
  xs: Float32Array;
  ys: Float32Array;
  /** Unit tangent (direction of travel) at each sample. */
  tx: Float32Array;
  ty: Float32Array;
  /** Curvature at each sample (1/m). */
  curvature: Float32Array;
  /** Reference speed at each sample (m/s) for a lap in `baseLapTime`. */
  speed: Float32Array;
  /** Cumulative lap-time fraction at each sample: timeAt[0] = 0 … timeAt[sampleCount] = 1. */
  timeAt: Float32Array;
  metresPerUnit: number;
  lengthUnits: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Pit lane from pit entry (progress 0) to pit exit (progress 1). */
  pitLane: Polyline;
  /** Lap distance fractions of the pit lane ends and the fraction of the lane that lies before the line. */
  pitEntry: number;
  pitExit: number;
  pitLineProgress: number;
  /** Top speed of the reference lap (m/s). */
  maxSpeed: number;
}

// ─────────────────────────────────────────────────────────── path parsing ──

interface Pt {
  x: number;
  y: number;
}

const COMMAND_RE = /([MLHVCSQTZmlhvcsqtz])([^MLHVCSQTZmlhvcsqtz]*)/g;
const NUMBER_RE = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

function cubicPoint(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

function quadPoint(p0: Pt, p1: Pt, p2: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y };
}

/**
 * Flattens SVG path data into a dense polyline. Supports M, L, H, V, C, S, Q, T and Z in absolute or
 * relative form (arcs are not supported – circuits are authored with Béziers).
 */
export function flattenSvgPath(d: string, curveSteps = 28): Pt[] {
  const points: Pt[] = [];
  let current: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  let lastControl: Pt | null = null;
  let lastCommand = '';

  const push = (p: Pt): void => {
    const last = points[points.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-9) points.push(p);
  };

  for (const match of d.matchAll(COMMAND_RE)) {
    const command = match[1] as string;
    const args = (match[2] ?? '').match(NUMBER_RE)?.map(Number) ?? [];
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();
    const abs = (x: number, y: number): Pt => (relative ? { x: current.x + x, y: current.y + y } : { x, y });

    switch (upper) {
      case 'M': {
        for (let i = 0; i + 1 < args.length; i += 2) {
          const p = abs(args[i]!, args[i + 1]!);
          if (i === 0) start = p;
          current = p;
          push(p);
        }
        lastControl = null;
        break;
      }
      case 'L': {
        for (let i = 0; i + 1 < args.length; i += 2) {
          current = abs(args[i]!, args[i + 1]!);
          push(current);
        }
        lastControl = null;
        break;
      }
      case 'H': {
        for (const v of args) {
          current = { x: relative ? current.x + v : v, y: current.y };
          push(current);
        }
        lastControl = null;
        break;
      }
      case 'V': {
        for (const v of args) {
          current = { x: current.x, y: relative ? current.y + v : v };
          push(current);
        }
        lastControl = null;
        break;
      }
      case 'C': {
        for (let i = 0; i + 5 < args.length; i += 6) {
          const p0 = current;
          const p1 = abs(args[i]!, args[i + 1]!);
          const p2 = abs(args[i + 2]!, args[i + 3]!);
          const p3 = abs(args[i + 4]!, args[i + 5]!);
          for (let s = 1; s <= curveSteps; s++) push(cubicPoint(p0, p1, p2, p3, s / curveSteps));
          current = p3;
          lastControl = p2;
        }
        break;
      }
      case 'S': {
        for (let i = 0; i + 3 < args.length; i += 4) {
          const p0 = current;
          const reflect: Pt =
            lastControl && (lastCommand === 'C' || lastCommand === 'S')
              ? { x: 2 * current.x - lastControl.x, y: 2 * current.y - lastControl.y }
              : current;
          const p2 = abs(args[i]!, args[i + 1]!);
          const p3 = abs(args[i + 2]!, args[i + 3]!);
          for (let s = 1; s <= curveSteps; s++) push(cubicPoint(p0, reflect, p2, p3, s / curveSteps));
          current = p3;
          lastControl = p2;
          lastCommand = 'S';
        }
        break;
      }
      case 'Q': {
        for (let i = 0; i + 3 < args.length; i += 4) {
          const p0 = current;
          const p1 = abs(args[i]!, args[i + 1]!);
          const p2 = abs(args[i + 2]!, args[i + 3]!);
          for (let s = 1; s <= curveSteps; s++) push(quadPoint(p0, p1, p2, s / curveSteps));
          current = p2;
          lastControl = p1;
        }
        break;
      }
      case 'T': {
        for (let i = 0; i + 1 < args.length; i += 2) {
          const p0 = current;
          const reflect: Pt =
            lastControl && (lastCommand === 'Q' || lastCommand === 'T')
              ? { x: 2 * current.x - lastControl.x, y: 2 * current.y - lastControl.y }
              : current;
          const p2 = abs(args[i]!, args[i + 1]!);
          for (let s = 1; s <= curveSteps; s++) push(quadPoint(p0, reflect, p2, s / curveSteps));
          current = p2;
          lastControl = reflect;
          lastCommand = 'T';
        }
        break;
      }
      case 'Z': {
        current = start;
        push(start);
        lastControl = null;
        break;
      }
      default:
        break;
    }
    lastCommand = upper;
  }
  return points;
}

// ─────────────────────────────────────────────────────────────── sampling ──

function wrap01(f: number): number {
  const r = f % 1;
  return r < 0 ? r + 1 : r;
}

/** Resamples a closed polyline to `count` points, uniform in arc length (point 0 = start of the path). */
function resampleClosed(points: Pt[], count: number): { xs: Float32Array; ys: Float32Array; length: number } {
  const closed = points.slice();
  const first = closed[0]!;
  const last = closed[closed.length - 1]!;
  if (Math.hypot(first.x - last.x, first.y - last.y) > 1e-6) closed.push({ ...first });

  const cumulative = new Float64Array(closed.length);
  for (let i = 1; i < closed.length; i++) {
    cumulative[i] = cumulative[i - 1]! + Math.hypot(closed[i]!.x - closed[i - 1]!.x, closed[i]!.y - closed[i - 1]!.y);
  }
  const total = cumulative[closed.length - 1]!;
  const xs = new Float32Array(count + 1);
  const ys = new Float32Array(count + 1);
  let seg = 1;
  for (let i = 0; i < count; i++) {
    const target = (i / count) * total;
    while (seg < closed.length - 1 && cumulative[seg]! < target) seg++;
    const a = closed[seg - 1]!;
    const b = closed[seg]!;
    const span = cumulative[seg]! - cumulative[seg - 1]!;
    const t = span > 0 ? (target - cumulative[seg - 1]!) / span : 0;
    xs[i] = a.x + (b.x - a.x) * t;
    ys[i] = a.y + (b.y - a.y) * t;
  }
  xs[count] = xs[0]!;
  ys[count] = ys[0]!;
  return { xs, ys, length: total };
}

// ───────────────────────────────────────────────────────── speed profile ──

/** Longitudinal acceleration available at speed v (m/s²): traction-limited, then power-limited, minus drag. */
function accelerationAt(v: number): number {
  return Math.max(0.2, Math.min(12, 875 / Math.max(v, 15)) - 0.00098 * v * v);
}

/** Braking deceleration at speed v (m/s²): mechanical grip plus downforce and drag. */
function brakingAt(v: number): number {
  return 14 + 0.0035 * v * v;
}

function lapProfile(
  curvature: Float32Array,
  ds: number,
  lateralGrip: number,
  vMax: number,
  out: Float32Array,
): number {
  const n = curvature.length;
  for (let i = 0; i < n; i++) {
    const k = Math.max(curvature[i]!, 1e-6);
    // Downforce raises the cornering limit with speed: v² = a·r / (1 − c·a·r) capped at vMax.
    const r = 1 / k;
    const denom = 1 - 0.00011 * lateralGrip * r;
    const v = denom > 0.02 ? Math.sqrt((lateralGrip * r) / denom) : vMax;
    out[i] = Math.min(vMax, v);
  }
  // Two passes around the loop so the periodic boundary settles.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const reachable = Math.sqrt(out[i]! * out[i]! + 2 * accelerationAt(out[i]!) * ds);
      if (reachable < out[j]!) out[j] = reachable;
    }
    for (let i = n - 1; i >= 0; i--) {
      const j = (i + 1) % n;
      const reachable = Math.sqrt(out[j]! * out[j]! + 2 * brakingAt(out[j]!) * ds);
      if (reachable < out[i]!) out[i] = reachable;
    }
  }
  let time = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    time += ds / (0.5 * (out[i]! + out[j]!));
  }
  return time;
}

// ─────────────────────────────────────────────────────────────── builder ──

const DEFAULT_SAMPLES = 1200;
const PIT_SAMPLES = 96;

export function buildTrackGeometry(track: TrackDefinition, sampleCount: number = DEFAULT_SAMPLES): TrackGeometry {
  const flat = flattenSvgPath(track.svgPath);
  if (flat.length < 4) throw new Error(`Track ${track.id}: svgPath has too few points`);
  const { xs, ys, length } = resampleClosed(flat, sampleCount);
  const n = sampleCount;
  const lengthMetres = track.lengthKm * 1000;
  const metresPerUnit = lengthMetres / length;
  const ds = lengthMetres / n;

  // Tangents by central differences on the closed loop.
  const tx = new Float32Array(n + 1);
  const ty = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const b = (i + 1) % n;
    const dx = xs[b]! - xs[a]!;
    const dy = ys[b]! - ys[a]!;
    const norm = Math.hypot(dx, dy) || 1;
    tx[i] = dx / norm;
    ty[i] = dy / norm;
  }
  tx[n] = tx[0]!;
  ty[n] = ty[0]!;

  // Curvature = |dθ/ds|, measured across ±span samples then smoothed.
  const span = Math.max(2, Math.round(n / 400));
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - span + n) % n;
    const b = (i + span) % n;
    const cross = tx[a]! * ty[b]! - ty[a]! * tx[b]!;
    const dot = tx[a]! * tx[b]! + ty[a]! * ty[b]!;
    raw[i] = Math.abs(Math.atan2(cross, dot)) / (2 * span * ds);
  }
  const curvature = new Float32Array(n);
  const window = Math.max(1, Math.round(n / 600));
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -window; k <= window; k++) sum += raw[(i + k + n) % n]!;
    curvature[i] = sum / (2 * window + 1);
  }

  // Calibrate the lateral grip so the reference lap takes exactly baseLapTime.
  const average = lengthMetres / track.baseLapTime;
  const vMax = Math.min(98, Math.max(78, average * 1.48));
  const profile = new Float32Array(n);
  let lo = 2;
  let hi = 140;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (lapProfile(curvature, ds, mid, vMax, profile) > track.baseLapTime) lo = mid;
    else hi = mid;
  }
  const lapSeconds = lapProfile(curvature, ds, (lo + hi) / 2, vMax, profile);
  const correction = lapSeconds / track.baseLapTime;

  const speed = new Float32Array(n + 1);
  let maxSpeed = 0;
  for (let i = 0; i < n; i++) {
    speed[i] = profile[i]! * correction;
    if (speed[i]! > maxSpeed) maxSpeed = speed[i]!;
  }
  speed[n] = speed[0]!;

  const timeAt = new Float32Array(n + 1);
  let cumulative = 0;
  const segmentTimes = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    segmentTimes[i] = ds / (0.5 * (speed[i]! + speed[i + 1]!));
    cumulative += segmentTimes[i]!;
  }
  let running = 0;
  for (let i = 0; i < n; i++) {
    timeAt[i] = running / cumulative;
    running += segmentTimes[i]!;
  }
  timeAt[n] = 1;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (xs[i]! < minX) minX = xs[i]!;
    if (xs[i]! > maxX) maxX = xs[i]!;
    if (ys[i]! < minY) minY = ys[i]!;
    if (ys[i]! > maxY) maxY = ys[i]!;
  }

  // Pit lane: the centreline pushed sideways, tapering in and out at both ends.
  const pitEntry = wrap01(track.pitEntry);
  const pitExit = wrap01(track.pitExit);
  const pitSpan = wrap01(pitExit - pitEntry) || 1;
  const offset = 0.03 * Math.max(track.svgViewBox.width, track.svgViewBox.height);
  const side = track.pitSide === 'RIGHT' ? 1 : -1;
  const pxs = new Float32Array(PIT_SAMPLES);
  const pys = new Float32Array(PIT_SAMPLES);
  for (let j = 0; j < PIT_SAMPLES; j++) {
    const p = j / (PIT_SAMPLES - 1);
    const f = wrap01(pitEntry + pitSpan * p);
    const idx = f * n;
    const i0 = Math.floor(idx) % n;
    const t = idx - Math.floor(idx);
    const x = xs[i0]! + (xs[i0 + 1]! - xs[i0]!) * t;
    const y = ys[i0]! + (ys[i0 + 1]! - ys[i0]!) * t;
    const ramp = Math.min(1, Math.min(p, 1 - p) / 0.16);
    const taper = ramp * ramp * (3 - 2 * ramp);
    // Right-hand normal of the heading (x right, y down): (−ty, tx).
    pxs[j] = x + -ty[i0]! * offset * taper * side;
    pys[j] = y + tx[i0]! * offset * taper * side;
  }

  return {
    trackId: track.id,
    sampleCount: n,
    xs,
    ys,
    tx,
    ty,
    curvature,
    speed,
    timeAt,
    metresPerUnit,
    lengthUnits: length,
    bounds: { minX, minY, maxX, maxY },
    pitLane: { xs: pxs, ys: pys, count: PIT_SAMPLES },
    pitEntry,
    pitExit,
    pitLineProgress: wrap01(1 - pitEntry) / pitSpan,
    maxSpeed,
  };
}

const cache = new Map<string, TrackGeometry>();

/** Memoised geometry for a track (keyed by id and path, so edited tracks are rebuilt). */
export function getTrackGeometry(track: TrackDefinition): TrackGeometry {
  const key = `${track.id}:${track.baseLapTime}:${track.lengthKm}:${track.pitEntry}:${track.pitExit}:${track.svgPath}`;
  let geometry = cache.get(key);
  if (!geometry) {
    geometry = buildTrackGeometry(track);
    cache.set(key, geometry);
  }
  return geometry;
}

// ──────────────────────────────────────────────────────────────── lookups ──

/** Point on the racing line at a lap distance fraction. */
export function pointAt(geometry: TrackGeometry, fraction: number): TrackPoint {
  const n = geometry.sampleCount;
  const idx = wrap01(fraction) * n;
  const i = Math.floor(idx) % n;
  const t = idx - Math.floor(idx);
  return {
    x: geometry.xs[i]! + (geometry.xs[i + 1]! - geometry.xs[i]!) * t,
    y: geometry.ys[i]! + (geometry.ys[i + 1]! - geometry.ys[i]!) * t,
    angle: Math.atan2(geometry.ty[i]!, geometry.tx[i]!),
  };
}

/** Point in the pit lane for a progress in [0, 1] (0 = pit entry, 1 = pit exit). */
export function pitPointAt(geometry: TrackGeometry, progress: number): TrackPoint {
  const lane = geometry.pitLane;
  const p = Math.min(1, Math.max(0, progress)) * (lane.count - 1);
  const i = Math.min(lane.count - 2, Math.floor(p));
  const t = p - i;
  const dx = lane.xs[i + 1]! - lane.xs[i]!;
  const dy = lane.ys[i + 1]! - lane.ys[i]!;
  return { x: lane.xs[i]! + dx * t, y: lane.ys[i]! + dy * t, angle: Math.atan2(dy, dx) };
}

/** Reference speed (m/s) at a lap distance fraction. */
export function speedAt(geometry: TrackGeometry, fraction: number): number {
  const n = geometry.sampleCount;
  const idx = wrap01(fraction) * n;
  const i = Math.floor(idx) % n;
  const t = idx - Math.floor(idx);
  return geometry.speed[i]! + (geometry.speed[i + 1]! - geometry.speed[i]!) * t;
}

/** Lap distance fraction → fraction of the reference lap time elapsed at that point. */
export function distanceToTime(geometry: TrackGeometry, fraction: number): number {
  const n = geometry.sampleCount;
  const idx = wrap01(fraction) * n;
  const i = Math.floor(idx) % n;
  const t = idx - Math.floor(idx);
  return geometry.timeAt[i]! + (geometry.timeAt[i + 1]! - geometry.timeAt[i]!) * t;
}

/** Fraction of the reference lap time → lap distance fraction (inverse of `distanceToTime`). */
export function timeToDistance(geometry: TrackGeometry, timeFraction: number): number {
  const n = geometry.sampleCount;
  const target = wrap01(timeFraction);
  let lo = 0;
  let hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (geometry.timeAt[mid]! <= target) lo = mid;
    else hi = mid;
  }
  const a = geometry.timeAt[lo]!;
  const b = geometry.timeAt[lo + 1]!;
  const t = b > a ? (target - a) / (b - a) : 0;
  return (lo + t) / n;
}

/** True when lap distance fraction `f` lies in [start, end), handling ranges that wrap the line. */
export function fractionInRange(f: number, start: number, end: number): boolean {
  const x = wrap01(f);
  const s = wrap01(start);
  const e = wrap01(end);
  return s <= e ? x >= s && x < e : x >= s || x < e;
}

/** Sector index (0, 1, 2) of a lap distance fraction. */
export function sectorAt(track: TrackDefinition, fraction: number): 0 | 1 | 2 {
  const f = wrap01(fraction);
  if (f < track.sectors[0]) return 0;
  if (f < track.sectors[1]) return 1;
  return 2;
}

/** Polyline of the racing line between two lap distance fractions (wrap-aware), for sector / DRS overlays. */
export function trackSlice(geometry: TrackGeometry, start: number, end: number): { x: number; y: number }[] {
  const n = geometry.sampleCount;
  const s = wrap01(start);
  const length = wrap01(end - start) || 1;
  const steps = Math.max(2, Math.ceil(length * n));
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = pointAt(geometry, s + (length * i) / steps);
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/** SVG path data ("M … L … Z") of the sampled centreline, handy for static SVG rendering. */
export function geometryToSvgPath(geometry: TrackGeometry, step = 4): string {
  const parts: string[] = [];
  for (let i = 0; i < geometry.sampleCount; i += step) {
    parts.push(`${i === 0 ? 'M' : 'L'}${geometry.xs[i]!.toFixed(1)} ${geometry.ys[i]!.toFixed(1)}`);
  }
  return `${parts.join(' ')} Z`;
}
