/**
 * Evolving weather: seeded rain cells drive the rain intensity, the track wetness follows with its own
 * inertia, and the pit wall only ever sees an imperfect forecast whose errors shrink as a shower nears.
 */
import { clamp, equilibriumWetness, stepTrackWetness } from './physicsModel';
import type { RandomSource, TrackDefinition, WeatherForecastPoint, WeatherMode, WeatherState } from './types';

export interface RainCell {
  /** Race clock at which the rain starts (s). Negative = already raining at lights out. */
  start: number;
  rampUp: number;
  plateau: number;
  rampDown: number;
  /** Peak intensity 0..1. */
  peak: number;
  /** Standardised forecast errors on the arrival time and on the peak (fixed per cell). */
  startError: number;
  peakError: number;
}

function cellIntensity(cell: RainCell, t: number, startShift = 0, peakScale = 1): number {
  const start = cell.start + startShift;
  const x = t - start;
  if (x <= 0) return 0;
  const peak = clamp(cell.peak * peakScale, 0, 1);
  if (x < cell.rampUp) return peak * (x / cell.rampUp);
  if (x < cell.rampUp + cell.plateau) return peak;
  const y = x - cell.rampUp - cell.plateau;
  if (y < cell.rampDown) return peak * (1 - y / cell.rampDown);
  return 0;
}

export class WeatherSystem {
  readonly cells: RainCell[] = [];
  private readonly track: TrackDefinition;
  private readonly rng: RandomSource;
  private readonly noisePhase: [number, number, number];
  private wetness = 0;
  private grip = 0.8;
  private rain = 0;

  constructor(track: TrackDefinition, mode: WeatherMode, rng: RandomSource, raceDuration: number) {
    this.track = track;
    this.rng = rng;
    this.noisePhase = [rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28)];

    let resolved: Exclude<WeatherMode, 'AUTO'> = mode === 'AUTO' ? 'DRY' : mode;
    if (mode === 'AUTO' && rng.chance(track.rainProbability)) resolved = rng.chance(0.25) ? 'WET' : 'MIXED';

    if (resolved === 'WET') {
      // Raining since before the start, easing off (or not) part-way through.
      const peak = rng.range(0.35, 0.8);
      this.cells.push(this.makeCell(-900, rng.range(200, 400), raceDuration * rng.range(0.25, 0.7) + 900, rng.range(300, 700), peak));
      if (rng.chance(0.45)) {
        this.cells.push(
          this.makeCell(raceDuration * rng.range(0.6, 0.9), rng.range(150, 360), rng.range(300, 900), rng.range(240, 600), rng.range(0.2, 0.6)),
        );
      }
      this.wetness = equilibriumWetness(peak) * rng.range(0.85, 1);
      this.grip = 0.35;
    } else if (resolved === 'MIXED') {
      const count = rng.chance(0.4) ? 2 : 1;
      let cursor = raceDuration * rng.range(0.12, 0.45);
      for (let i = 0; i < count; i++) {
        const plateau = rng.range(240, 1100);
        this.cells.push(this.makeCell(cursor, rng.range(120, 360), plateau, rng.range(240, 600), rng.range(0.22, 0.8)));
        cursor += plateau + raceDuration * rng.range(0.2, 0.4);
      }
    }
    this.rain = this.intensityAt(0);
  }

  private makeCell(start: number, rampUp: number, plateau: number, rampDown: number, peak: number): RainCell {
    return { start, rampUp, plateau, rampDown, peak, startError: this.rng.normal(), peakError: this.rng.normal() };
  }

  /** True rain intensity at race clock `t`. */
  intensityAt(t: number): number {
    let total = 0;
    for (const cell of this.cells) total += cellIntensity(cell, t);
    if (total <= 0) return 0;
    // Gusts: smooth deterministic modulation of an active shower.
    const [a, b, c] = this.noisePhase;
    const gust = 1 + 0.08 * Math.sin(t / 71 + a) + 0.05 * Math.sin(t / 37 + b) + 0.02 * Math.sin(t / 17 + c);
    return clamp(total * gust, 0, 1);
  }

  /** Forecast rain intensity for race clock `t`, as seen from `now` (arrival and peak errors grow with lead time). */
  private forecastIntensity(now: number, t: number, sigma: number): number {
    let total = 0;
    for (const cell of this.cells) {
      const lead = Math.max(0, cell.start - now);
      const startShift = (cell.startError + sigma) * 0.2 * lead;
      const peakScale = 1 + (cell.peakError + sigma) * 0.3 * Math.min(1, lead / 900);
      total += cellIntensity(cell, t, startShift, peakScale);
    }
    return clamp(total, 0, 1);
  }

  step(dt: number, raceTime: number, carsOnTrack: number): void {
    this.rain = this.intensityAt(raceTime);
    const trackTemp = this.trackTempC();
    this.wetness = stepTrackWetness(this.wetness, this.rain, dt, { trackTempC: trackTemp, carsOnTrack });
    if (this.wetness > 0.06 || this.rain > 0.05) {
      // Rain washes the rubber away.
      this.grip = Math.max(0.25, this.grip - (0.004 + 0.02 * this.rain) * dt);
    } else {
      this.grip = Math.min(1, this.grip + ((1 - this.grip) * dt * Math.max(4, carsOnTrack)) / 14000);
    }
  }

  private trackTempC(): number {
    return this.track.trackTempC - 11 * this.wetness - 5 * this.rain;
  }

  get state(): WeatherState {
    return {
      rainIntensity: this.rain,
      trackWetness: this.wetness,
      airTempC: this.track.airTempC - 3 * this.rain - 1.5 * this.wetness,
      trackTempC: this.trackTempC(),
      gripLevel: this.grip,
    };
  }

  /**
   * Forecast from `now` over `horizon` seconds. `lapAt(raceTime)` converts a race clock into the
   * (fractional) lap the leader is expected to be on.
   */
  forecast(now: number, horizon: number, step: number, lapAt: (raceTime: number) => number): WeatherForecastPoint[] {
    const points: WeatherForecastPoint[] = [];
    let wetness = this.wetness;
    const trackTemp = this.track.trackTempC;
    for (let t = now; t <= now + horizon + 1e-6; t += step) {
      const expected = this.forecastIntensity(now, t, 0);
      const early = this.forecastIntensity(now, t, -1);
      const late = this.forecastIntensity(now, t, 1);
      if (t > now) wetness = stepTrackWetness(wetness, expected, step, { trackTempC: trackTemp - 10 * wetness, carsOnTrack: 18 });
      points.push({
        raceTime: t,
        lap: lapAt(t),
        rainIntensity: expected,
        rainLow: Math.min(expected, early, late),
        rainHigh: Math.max(expected, early, late),
        trackWetness: wetness,
      });
    }
    return points;
  }

  /** Sandbox: a shower arriving in about a minute. */
  injectShower(now: number, peak = 0.6): void {
    this.cells.push({ start: now + 45, rampUp: 150, plateau: 600, rampDown: 420, peak, startError: 0, peakError: 0 });
  }

  /** Sandbox: stop every active or future shower. */
  dryUp(now: number): void {
    for (const cell of this.cells) {
      if (cell.start > now) {
        cell.peak = 0;
        continue;
      }
      // End the plateau now and let the cell ramp down.
      const elapsed = now - cell.start;
      if (elapsed < cell.rampUp) {
        cell.peak *= elapsed / cell.rampUp;
        cell.rampUp = Math.max(1, elapsed);
        cell.plateau = 0;
      } else if (elapsed < cell.rampUp + cell.plateau) {
        cell.plateau = elapsed - cell.rampUp;
      }
      cell.rampDown = Math.min(cell.rampDown, 240);
    }
  }
}
