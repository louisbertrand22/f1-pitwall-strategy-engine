/** Pure helpers of the weather radar: series preparation, tyre crossover detection, lap mapping. */
import { WEATHER_CROSSOVER } from '../../simulation/physicsModel';
import type { TyreClass, WeatherForecastPoint, WeatherSample } from '../../simulation/types';

export interface WeatherPoint {
  /** Leader progress in laps completed (0 at lights out). */
  lap: number;
  raceTime: number;
  rain: number;
  wetness: number;
  /** Rain uncertainty band; equal to `rain` for an observation. */
  rainLow: number;
  rainHigh: number;
  forecast: boolean;
}

/** Keeps at most `maxPoints` evenly spaced items, always including the first and the last. */
export function thinOut<T>(items: readonly T[], maxPoints: number): T[] {
  if (items.length <= maxPoints || maxPoints < 2) return [...items];
  const result: T[] = [];
  const step = (items.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) result.push(items[Math.round(i * step)]!);
  return result;
}

/**
 * The contract gives weather laps as the "leader's lap (fractional)" without saying whether lights out is
 * 0.0 (laps completed) or 1.0 (lap number). The charts work in laps completed, so the base is read off
 * the data: the offset between the series' lap at `raceTime` and the leader's actual progress.
 */
export function detectLapBase(
  samples: readonly WeatherSample[],
  forecast: readonly WeatherForecastPoint[],
  raceTime: number,
  leaderProgress: number,
  typicalLapTime: number,
): 0 | 1 {
  const lapTime = Math.max(1, typicalLapTime);
  const sample = samples.length > 0 ? samples[samples.length - 1] : undefined;
  const first = forecast.length > 0 ? forecast[0] : undefined;
  let estimate: number;
  if (sample) estimate = sample.lap + (raceTime - sample.raceTime) / lapTime;
  else if (first) estimate = first.lap - (first.raceTime - raceTime) / lapTime;
  else return 0;
  return estimate - leaderProgress > 0.5 ? 1 : 0;
}

export function observedPoints(samples: readonly WeatherSample[], lapBase: number): WeatherPoint[] {
  return samples.map((s) => ({
    lap: s.lap - lapBase,
    raceTime: s.raceTime,
    rain: s.rainIntensity,
    wetness: s.trackWetness,
    rainLow: s.rainIntensity,
    rainHigh: s.rainIntensity,
    forecast: false,
  }));
}

export function forecastPoints(forecast: readonly WeatherForecastPoint[], lapBase: number): WeatherPoint[] {
  return forecast.map((f) => ({
    lap: f.lap - lapBase,
    raceTime: f.raceTime,
    rain: f.rainIntensity,
    wetness: f.trackWetness,
    rainLow: Math.min(f.rainLow, f.rainIntensity),
    rainHigh: Math.max(f.rainHigh, f.rainIntensity),
    forecast: true,
  }));
}

/** Linear interpolation of a chronological series at `raceTime`; null outside its time span. */
export function interpolateAtTime(points: readonly WeatherPoint[], raceTime: number): WeatherPoint | null {
  if (points.length === 0) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (raceTime < first.raceTime || raceTime > last.raceTime) return null;
  for (let i = 1; i < points.length; i++) {
    const b = points[i]!;
    if (raceTime > b.raceTime) continue;
    const a = points[i - 1]!;
    const span = b.raceTime - a.raceTime;
    const f = span > 0 ? (raceTime - a.raceTime) / span : 0;
    const mix = (x: number, y: number): number => x + (y - x) * f;
    return {
      lap: mix(a.lap, b.lap),
      raceTime,
      rain: mix(a.rain, b.rain),
      wetness: mix(a.wetness, b.wetness),
      rainLow: mix(a.rainLow, b.rainLow),
      rainHigh: mix(a.rainHigh, b.rainHigh),
      forecast: a.forecast || b.forecast,
    };
  }
  return first;
}

export interface Crossover {
  from: TyreClass;
  to: TyreClass;
  /** Leader progress (laps completed) at which the wetness crosses the threshold. */
  lap: number;
  raceTime: number;
}

/**
 * Tyre-family crossovers along a wetness curve: every point where the track wetness passes
 * `WEATHER_CROSSOVER.slickToInter` or `.interToWet`, linearly interpolated between samples. A step that
 * jumps over both thresholds yields both crossings in order.
 */
export function findCrossovers(points: readonly Pick<WeatherPoint, 'lap' | 'raceTime' | 'wetness'>[]): Crossover[] {
  const thresholds: { value: number; below: TyreClass; above: TyreClass }[] = [
    { value: WEATHER_CROSSOVER.slickToInter, below: 'SLICK', above: 'INTER' },
    { value: WEATHER_CROSSOVER.interToWet, below: 'INTER', above: 'WET' },
  ];
  const crossovers: Crossover[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a.wetness === b.wetness) continue;
    const rising = b.wetness > a.wetness;
    const ordered = rising ? thresholds : [...thresholds].reverse();
    for (const t of ordered) {
      // Same convention as bestTyreClass(): the wetter family applies from the threshold upwards.
      const crossed = rising ? a.wetness < t.value && b.wetness >= t.value : a.wetness >= t.value && b.wetness < t.value;
      if (!crossed) continue;
      const f = (t.value - a.wetness) / (b.wetness - a.wetness);
      crossovers.push({
        from: rising ? t.below : t.above,
        to: rising ? t.above : t.below,
        lap: a.lap + (b.lap - a.lap) * f,
        raceTime: a.raceTime + (b.raceTime - a.raceTime) * f,
      });
    }
  }
  return crossovers;
}

/** Number of the lap in progress at a given leader progress (laps completed), clamped to the race distance. */
export function lapNumberAt(progress: number, raceLaps: number): number {
  return Math.min(Math.max(1, raceLaps), Math.max(1, Math.floor(progress) + 1));
}
