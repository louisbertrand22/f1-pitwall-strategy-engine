import { describe, expect, it } from 'vitest';
import { TEST_TRACK } from './__fixtures__/testTrack';
import {
  buildTrackGeometry,
  distanceToTime,
  flattenSvgPath,
  fractionInRange,
  pitPointAt,
  pointAt,
  sectorAt,
  speedAt,
  timeToDistance,
} from './trackGeometry';

const geometry = buildTrackGeometry(TEST_TRACK);

describe('track geometry', () => {
  it('parses absolute and relative path commands', () => {
    const pts = flattenSvgPath('M 0 0 L 10 0 l 0 10 H 0 Z');
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 0, y: 0 });
    expect(pts).toContainEqual({ x: 10, y: 10 });
  });

  it('samples a closed loop that starts on the start/finish line', () => {
    const start = pointAt(geometry, 0);
    const end = pointAt(geometry, 0.999999);
    expect(start.x).toBeCloseTo(420, 0);
    expect(start.y).toBeCloseTo(560, 0);
    expect(Math.hypot(start.x - end.x, start.y - end.y)).toBeLessThan(1);
    expect(geometry.metresPerUnit * geometry.lengthUnits).toBeCloseTo(TEST_TRACK.lengthKm * 1000, 3);
  });

  it('calibrates the reference speed profile to the base lap time', () => {
    const ds = (TEST_TRACK.lengthKm * 1000) / geometry.sampleCount;
    let time = 0;
    for (let i = 0; i < geometry.sampleCount; i++) time += ds / (0.5 * (geometry.speed[i]! + geometry.speed[i + 1]!));
    expect(time).toBeCloseTo(TEST_TRACK.baseLapTime, 2);
    // slower in the hairpin than on the main straight
    expect(speedAt(geometry, 0.02)).toBeGreaterThan(1.4 * Math.min(...Array.from(geometry.speed)));
    expect(geometry.maxSpeed * 3.6).toBeLessThan(380);
    expect(geometry.maxSpeed * 3.6).toBeGreaterThan(250);
  });

  it('maps distance to time monotonically and inverts it', () => {
    let previous = -1;
    for (let f = 0; f < 1; f += 0.01) {
      const t = distanceToTime(geometry, f);
      expect(t).toBeGreaterThan(previous);
      previous = t;
      expect(timeToDistance(geometry, t)).toBeCloseTo(f, 4);
    }
  });

  it('builds a pit lane that leaves and rejoins the racing line', () => {
    const entry = pitPointAt(geometry, 0);
    const exit = pitPointAt(geometry, 1);
    const onTrackEntry = pointAt(geometry, TEST_TRACK.pitEntry);
    const onTrackExit = pointAt(geometry, TEST_TRACK.pitExit);
    expect(Math.hypot(entry.x - onTrackEntry.x, entry.y - onTrackEntry.y)).toBeLessThan(1);
    expect(Math.hypot(exit.x - onTrackExit.x, exit.y - onTrackExit.y)).toBeLessThan(1);
    const mid = pitPointAt(geometry, 0.5);
    const line = pointAt(geometry, 0);
    expect(Math.hypot(mid.x - line.x, mid.y - line.y)).toBeGreaterThan(10);
    expect(geometry.pitLineProgress).toBeCloseTo(0.5, 6);
  });

  it('handles wrapping ranges and sectors', () => {
    expect(fractionInRange(0.98, 0.96, 0.1)).toBe(true);
    expect(fractionInRange(0.05, 0.96, 0.1)).toBe(true);
    expect(fractionInRange(0.5, 0.96, 0.1)).toBe(false);
    expect(sectorAt(TEST_TRACK, 0.1)).toBe(0);
    expect(sectorAt(TEST_TRACK, 0.5)).toBe(1);
    expect(sectorAt(TEST_TRACK, 0.9)).toBe(2);
  });
});
