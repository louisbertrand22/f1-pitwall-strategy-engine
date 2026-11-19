import { describe, expect, it } from 'vitest';
import { DEFAULT_TRACK_ID, TRACKS, TRACK_LIST, getTrack } from './trackData';
import { buildTrackGeometry, distanceToTime, pitPointAt } from './trackGeometry';
import type { TrackGeometry } from './trackGeometry';
import type { TrackDefinition, TrackId } from './types';

const CALENDAR: TrackId[] = ['monaco', 'silverstone', 'spa', 'monza', 'suzuka'];

/** Values the tyre and strategy models were balanced against (must not drift). */
const REFERENCE: Record<TrackId, { lengthKm: number; raceLaps: number; baseLapTime: number; pitLoss: number; drsZones: number }> = {
  silverstone: { lengthKm: 5.891, raceLaps: 52, baseLapTime: 87.5, pitLoss: 20.5, drsZones: 2 },
  spa: { lengthKm: 7.004, raceLaps: 44, baseLapTime: 104.5, pitLoss: 18.5, drsZones: 2 },
  monaco: { lengthKm: 3.337, raceLaps: 78, baseLapTime: 72, pitLoss: 19.5, drsZones: 1 },
  monza: { lengthKm: 5.793, raceLaps: 53, baseLapTime: 80.5, pitLoss: 24, drsZones: 2 },
  suzuka: { lengthKm: 5.807, raceLaps: 53, baseLapTime: 89.5, pitLoss: 22.5, drsZones: 1 },
};

const geometries = new Map<TrackId, TrackGeometry>();
function geometryOf(track: TrackDefinition): TrackGeometry {
  let geometry = geometries.get(track.id);
  if (!geometry) {
    geometry = buildTrackGeometry(track);
    geometries.set(track.id, geometry);
  }
  return geometry;
}

const isFraction = (f: number): boolean => Number.isFinite(f) && f >= 0 && f < 1;
const wrap01 = (f: number): number => ((f % 1) + 1) % 1;

function speedRange(geometry: TrackGeometry): { min: number; max: number } {
  let min = Infinity;
  let max = 0;
  for (let i = 0; i < geometry.sampleCount; i++) {
    const kph = geometry.speed[i]! * 3.6;
    if (kph < min) min = kph;
    if (kph > max) max = kph;
  }
  return { min, max };
}

/** Number of times the sampled centreline crosses itself. */
function selfIntersections(geometry: TrackGeometry): number {
  const { xs, ys, sampleCount: n } = geometry;
  const side = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean =>
    (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const ax = xs[i]!;
      const ay = ys[i]!;
      const bx = xs[i + 1]!;
      const by = ys[i + 1]!;
      const cx = xs[j]!;
      const cy = ys[j]!;
      const dx = xs[j + 1]!;
      const dy = ys[j + 1]!;
      if (side(ax, ay, cx, cy, dx, dy) !== side(bx, by, cx, cy, dx, dy) && side(ax, ay, bx, by, cx, cy) !== side(ax, ay, bx, by, dx, dy)) count++;
    }
  }
  return count;
}

describe('track database', () => {
  it('lists the five circuits in calendar order under unique ids', () => {
    expect(TRACK_LIST.map((track) => track.id)).toEqual(CALENDAR);
    expect(new Set(TRACK_LIST.map((track) => track.id)).size).toBe(TRACK_LIST.length);
    expect(Object.keys(TRACKS).sort()).toEqual([...CALENDAR].sort());
    for (const id of CALENDAR) {
      expect(TRACKS[id].id).toBe(id);
      expect(getTrack(id)).toBe(TRACKS[id]);
      expect(TRACK_LIST).toContain(TRACKS[id]);
    }
    expect(DEFAULT_TRACK_ID).toBe('silverstone');
    expect(getTrack(DEFAULT_TRACK_ID).shortName).toBe('SILVERSTONE');
  });

  it('throws on an unknown id', () => {
    expect(() => getTrack('imola' as TrackId)).toThrow(/imola/);
    expect(() => getTrack('toString' as TrackId)).toThrow();
  });
});

describe.each(TRACK_LIST.map((track) => [track.shortName, track] as const))('%s', (_name, track) => {
  const geometry = geometryOf(track);
  const n = geometry.sampleCount;
  const reference = REFERENCE[track.id];

  it('keeps the balanced reference values', () => {
    expect(track.lengthKm).toBe(reference.lengthKm);
    expect(track.raceLaps).toBe(reference.raceLaps);
    expect(track.baseLapTime).toBe(reference.baseLapTime);
    expect(track.pitLossSeconds).toBe(reference.pitLoss);
    expect(track.pitSpeedLimitKph).toBe(track.id === 'monaco' ? 60 : 80);
    expect(track.drsZones).toHaveLength(reference.drsZones);
    expect(track.compoundGap).toHaveLength(2);
    expect(track.country).toMatch(/^[A-Z]{3}$/);
    expect(track.shortName).toBe(track.shortName.toUpperCase());
  });

  it('has every lap distance fraction in [0, 1)', () => {
    const fractions = [
      track.pitEntry,
      track.pitExit,
      ...track.sectors,
      ...track.overtakingSpots,
      ...track.corners.map((corner) => corner.at),
      ...track.drsZones.flatMap((zone) => [zone.detection, zone.start, zone.end]),
    ];
    for (const fraction of fractions) expect(isFraction(fraction)).toBe(true);
  });

  it('draws a closed path with absolute M/L/C/Q/Z commands inside its viewBox', () => {
    expect(track.svgPath.startsWith('M')).toBe(true);
    expect(track.svgPath.trimEnd().endsWith('Z')).toBe(true);
    expect(track.svgPath).toMatch(/^[MLCQZ0-9.\s-]+$/);
    expect(n).toBeGreaterThan(100);
    // first and last sampled points coincide: the loop is closed
    expect(Math.hypot(geometry.xs[n]! - geometry.xs[0]!, geometry.ys[n]! - geometry.ys[0]!)).toBeLessThan(1e-6);
    // uniform sampling: no jump between consecutive samples, including across the line
    const step = geometry.lengthUnits / n;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(geometry.xs[i + 1]! - geometry.xs[i]!, geometry.ys[i + 1]! - geometry.ys[i]!);
      expect(d).toBeLessThan(step * 1.05);
    }
    expect(geometry.metresPerUnit * geometry.lengthUnits).toBeCloseTo(track.lengthKm * 1000, 3);
    const { width, height } = track.svgViewBox;
    expect(geometry.bounds.minX).toBeGreaterThan(0.03 * width);
    expect(geometry.bounds.maxX).toBeLessThan(0.97 * width);
    expect(geometry.bounds.minY).toBeGreaterThan(0.03 * height);
    expect(geometry.bounds.maxY).toBeLessThan(0.97 * height);
  });

  it('crosses itself only at the Suzuka overpass', () => {
    expect(selfIntersections(geometry)).toBe(track.id === 'suzuka' ? 1 : 0);
  });

  it('starts on a straight piece of track running in the racing direction', () => {
    // heading barely changes across the line (the path starts on the start/finish straight)
    const before = Math.atan2(geometry.ty[n - 4]!, geometry.tx[n - 4]!);
    const after = Math.atan2(geometry.ty[4]!, geometry.tx[4]!);
    const turn = Math.abs(Math.atan2(Math.sin(after - before), Math.cos(after - before)));
    expect(turn).toBeLessThan(0.05);
  });

  it('calibrates the reference lap to the base lap time', () => {
    const ds = (track.lengthKm * 1000) / n;
    let time = 0;
    for (let i = 0; i < n; i++) time += ds / (0.5 * (geometry.speed[i]! + geometry.speed[i + 1]!));
    expect(Math.abs(time - track.baseLapTime)).toBeLessThan(0.05);
  });

  it('has a believable speed profile', () => {
    const { min, max } = speedRange(geometry);
    if (track.id === 'monaco') {
      expect(max).toBeGreaterThanOrEqual(265);
      expect(max).toBeLessThan(300);
      expect(min).toBeGreaterThan(42);
      expect(min).toBeLessThan(66);
    } else {
      expect(max).toBeGreaterThanOrEqual(300);
      expect(max).toBeLessThanOrEqual(352);
      expect(min).toBeGreaterThan(45);
      expect(min).toBeLessThan(110);
    }
  });

  it('splits the lap into three balanced sectors', () => {
    expect(track.sectors[0]).toBeLessThan(track.sectors[1]);
    const t1 = distanceToTime(geometry, track.sectors[0]);
    const t2 = distanceToTime(geometry, track.sectors[1]);
    for (const share of [t1, t2 - t1, 1 - t2]) {
      expect(share).toBeGreaterThan(0.22);
      expect(share).toBeLessThan(0.45);
    }
  });

  it('places every DRS zone on a fast stretch after its detection point', () => {
    const lapMean = (track.lengthKm * 1000) / track.baseLapTime;
    for (const zone of track.drsZones) {
      const length = wrap01(zone.end - zone.start);
      expect(length).toBeGreaterThanOrEqual(0.02);
      expect(length).toBeLessThanOrEqual(0.18);
      // detection comes before the activation point (Monza's main-straight zone is detected before the
      // Parabolica and only opens after the line, hence the generous upper bound)
      const lead = wrap01(zone.start - zone.detection);
      expect(lead).toBeGreaterThan(0);
      expect(lead).toBeLessThan(0.25);
      let sum = 0;
      const steps = Math.max(2, Math.round(length * n));
      for (let k = 0; k <= steps; k++) sum += geometry.speed[Math.round(wrap01(zone.start + (length * k) / steps) * n) % n]!;
      expect(sum / (steps + 1)).toBeGreaterThan(lapMean);
      // the zone ends where the cars are still quick: it stops at the braking point, not in the corner
      expect(geometry.speed[Math.round(zone.end * n) % n]!).toBeGreaterThan(lapMean);
    }
  });

  it('wraps the start/finish line with the pit lane, clear of the racing line', () => {
    expect(track.pitEntry).toBeGreaterThan(0.88);
    expect(track.pitExit).toBeGreaterThan(0);
    expect(track.pitExit).toBeLessThan(0.12);
    expect(geometry.pitLineProgress).toBeGreaterThan(0.2);
    expect(geometry.pitLineProgress).toBeLessThan(0.8);
    // the middle of the lane is well clear of every part of the racing line
    for (const progress of [0.35, 0.5, 0.65]) {
      const p = pitPointAt(geometry, progress);
      let nearest = Infinity;
      for (let i = 0; i < n; i++) nearest = Math.min(nearest, Math.hypot(geometry.xs[i]! - p.x, geometry.ys[i]! - p.y));
      expect(nearest).toBeGreaterThan(15);
    }
    // and the lane stays inside the viewBox
    for (let j = 0; j < geometry.pitLane.count; j++) {
      expect(geometry.pitLane.xs[j]!).toBeGreaterThan(0);
      expect(geometry.pitLane.xs[j]!).toBeLessThan(track.svgViewBox.width);
      expect(geometry.pitLane.ys[j]!).toBeGreaterThan(0);
      expect(geometry.pitLane.ys[j]!).toBeLessThan(track.svgViewBox.height);
    }
  });

  it('names 8 to 14 corners in lap order', () => {
    expect(track.corners.length).toBeGreaterThanOrEqual(8);
    expect(track.corners.length).toBeLessThanOrEqual(14);
    expect(new Set(track.corners.map((corner) => corner.name)).size).toBe(track.corners.length);
    for (let i = 1; i < track.corners.length; i++) expect(track.corners[i]!.at).toBeGreaterThan(track.corners[i - 1]!.at);
  });

  it('puts the overtaking spots in braking zones away from the DRS zone ends', () => {
    const lapMax = geometry.maxSpeed;
    expect(track.overtakingSpots.length).toBeGreaterThan(0);
    for (const spot of track.overtakingSpots) {
      expect(geometry.speed[Math.round(spot * n) % n]!).toBeLessThan(0.75 * lapMax);
      for (const zone of track.drsZones) {
        const gap = Math.abs(wrap01(spot - zone.end + 0.5) - 0.5);
        expect(gap).toBeGreaterThan(0.02);
      }
    }
  });
});
