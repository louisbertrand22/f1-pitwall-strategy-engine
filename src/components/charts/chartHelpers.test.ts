import { describe, expect, it } from 'vitest';
import { WEATHER_CROSSOVER } from '../../simulation/physicsModel';
import type {
  CandidateProjection,
  CarStrategy,
  ProjectionPoint,
  StrategyPlan,
  TyreCompound,
  WeatherForecastPoint,
  WeatherSample,
} from '../../simulation/types';
import { spreadLabels } from './layout';
import { areaPath, bandPath, linePath } from './path';
import { extent, lapTicks, linearScale, niceDomain, niceStep, niceTicks } from './scale';
import {
  buildAdoptedStrategy,
  candidateSlots,
  candidateStopSequence,
  isCandidateAdopted,
  resolveCandidateCompound,
} from './strategyData';
import {
  detectLapBase,
  findCrossovers,
  forecastPoints,
  interpolateAtTime,
  lapNumberAt,
  observedPoints,
  thinOut,
} from './weatherData';

describe('scale', () => {
  it('maps and inverts, including on an inverted range', () => {
    const y = linearScale([0, 100], [200, 0]);
    expect(y(0)).toBe(200);
    expect(y(25)).toBe(150);
    expect(y.invert(150)).toBe(25);
    const flat = linearScale([5, 5], [0, 10]);
    expect(flat(5)).toBe(5);
    expect(flat.invert(3)).toBe(5);
  });

  it('produces nice steps, ticks and domains', () => {
    expect(niceStep(47, 5)).toBe(10);
    expect(niceStep(0.9, 4)).toBe(0.25);
    expect(niceTicks(0, 47, 5)).toEqual([0, 10, 20, 30, 40]);
    expect(niceTicks(-0.3, 0.3, 6)).toEqual([-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3]);
    expect(niceDomain(3, 47, 5)).toEqual([0, 50]);
    expect(niceDomain(4, 4, 5)).toEqual([3, 5]);
    expect(extent([3, null, -2, undefined, Number.NaN, 8])).toEqual([-2, 8]);
    expect(extent([])).toBeNull();
  });

  it('chooses lap ticks that keep the labels apart', () => {
    expect(lapTicks(0, 50, 650)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
    expect(lapTicks(0, 50, 300)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(lapTicks(27, 50, 650)).toEqual([28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50]);
    expect(lapTicks(10, 10, 300)).toEqual([]);
  });
});

describe('path', () => {
  it('builds polylines with gaps, areas and bands', () => {
    expect(linePath([[0, 0], [10, 5.04], null, [20, 1], [30, 2]])).toBe('M0 0L10 5M20 1L30 2');
    expect(areaPath([[0, 4], [10, 2]], 20)).toBe('M0 4L10 2L10 20L0 20Z');
    expect(bandPath([[0, 1], [10, 2]], [[0, 5], [10, 6]])).toBe('M0 1L10 2L10 6L0 5Z');
    expect(areaPath([[0, 0]], 10)).toBe('');
  });
});

describe('spreadLabels', () => {
  it('leaves separated labels on their anchors', () => {
    expect(spreadLabels([10, 40, 80], 12, 0, 100)).toEqual([10, 40, 80]);
  });

  it('pushes colliding labels apart symmetrically and keeps the input order', () => {
    const result = spreadLabels([50, 52, 20], 12, 0, 100);
    expect(result[2]).toBe(20);
    expect(result[1]! - result[0]!).toBeCloseTo(12);
    expect((result[0]! + result[1]!) / 2).toBeCloseTo(51);
  });

  it('respects the bounds and compresses the gap when there is not enough room', () => {
    const bottom = spreadLabels([98, 99, 100], 10, 0, 100);
    expect(bottom).toEqual([80, 90, 100]);
    const top = spreadLabels([0, 1], 10, 0, 100);
    expect(top).toEqual([0, 10]);
    const crowded = spreadLabels([5, 5, 5, 5], 10, 0, 15);
    expect(crowded).toEqual([0, 5, 10, 15]);
    expect(spreadLabels([], 10, 0, 100)).toEqual([]);
  });
});

function sample(raceTime: number, lap: number, rain: number, wetness: number): WeatherSample {
  return { raceTime, lap, rainIntensity: rain, trackWetness: wetness };
}

function forecastPoint(raceTime: number, lap: number, rain: number, wetness: number): WeatherForecastPoint {
  return { raceTime, lap, rainIntensity: rain, rainLow: rain * 0.5, rainHigh: Math.min(1, rain * 1.5), trackWetness: wetness };
}

describe('weatherData', () => {
  const s2i = WEATHER_CROSSOVER.slickToInter;
  const i2w = WEATHER_CROSSOVER.interToWet;

  it('finds the crossovers of a shower and interpolates their lap', () => {
    const points = [
      { lap: 20, raceTime: 1800, wetness: 0 },
      { lap: 22, raceTime: 1980, wetness: s2i * 2 },
      { lap: 24, raceTime: 2160, wetness: s2i * 2 },
      { lap: 28, raceTime: 2520, wetness: 0 },
    ];
    const crossovers = findCrossovers(points);
    expect(crossovers.map((c) => [c.from, c.to])).toEqual([['SLICK', 'INTER'], ['INTER', 'SLICK']]);
    expect(crossovers[0]?.lap).toBeCloseTo(21);
    expect(crossovers[0]?.raceTime).toBeCloseTo(1890);
    expect(crossovers[1]?.lap).toBeCloseTo(26);
  });

  it('reports both thresholds in order when one step jumps over them', () => {
    const up = findCrossovers([
      { lap: 10, raceTime: 0, wetness: 0 },
      { lap: 11, raceTime: 90, wetness: 1 },
    ]);
    expect(up.map((c) => c.to)).toEqual(['INTER', 'WET']);
    expect(up[0]!.lap).toBeLessThan(up[1]!.lap);
    expect(up[1]?.lap).toBeCloseTo(10 + i2w);
    const down = findCrossovers([
      { lap: 10, raceTime: 0, wetness: 1 },
      { lap: 11, raceTime: 90, wetness: 0 },
    ]);
    expect(down.map((c) => [c.from, c.to])).toEqual([['WET', 'INTER'], ['INTER', 'SLICK']]);
    expect(findCrossovers([{ lap: 1, raceTime: 0, wetness: 0.1 }, { lap: 2, raceTime: 90, wetness: 0.1 }])).toEqual([]);
  });

  it('treats a point exactly on the threshold like bestTyreClass does', () => {
    const exact = findCrossovers([
      { lap: 5, raceTime: 0, wetness: 0 },
      { lap: 6, raceTime: 90, wetness: s2i },
      { lap: 7, raceTime: 180, wetness: s2i },
    ]);
    expect(exact).toHaveLength(1);
    expect(exact[0]).toMatchObject({ from: 'SLICK', to: 'INTER' });
    expect(exact[0]?.lap).toBeCloseTo(6);
  });

  it('detects whether weather laps count from 0 or from 1', () => {
    const zeroBased = [sample(880, 9.78, 0, 0), sample(900, 10, 0, 0)];
    const oneBased = [sample(880, 10.78, 0, 0), sample(900, 11, 0, 0)];
    expect(detectLapBase(zeroBased, [], 909, 10.1, 90)).toBe(0);
    expect(detectLapBase(oneBased, [], 909, 10.1, 90)).toBe(1);
    expect(detectLapBase([], [forecastPoint(60, 1.67, 0, 0)], 0, 0, 90)).toBe(1);
    expect(detectLapBase([], [forecastPoint(60, 0.67, 0, 0)], 0, 0, 90)).toBe(0);
    expect(detectLapBase([], [], 0, 0, 90)).toBe(0);
    expect(observedPoints(oneBased, 1)[1]?.lap).toBe(10);
    const converted = forecastPoints([forecastPoint(960, 11.7, 0.4, 0.2)], 1)[0];
    expect(converted?.lap).toBeCloseTo(10.7);
    expect(converted).toMatchObject({ rain: 0.4, rainLow: 0.2, forecast: true });
    expect(converted?.rainHigh).toBeCloseTo(0.6);
  });

  it('interpolates a series in time and thins out long series', () => {
    const points = forecastPoints([forecastPoint(0, 0, 0, 0), forecastPoint(100, 1, 0.4, 0.2)], 0);
    const mid = interpolateAtTime(points, 25);
    expect(mid?.rain).toBeCloseTo(0.1);
    expect(mid?.wetness).toBeCloseTo(0.05);
    expect(mid?.lap).toBeCloseTo(0.25);
    expect(interpolateAtTime(points, 101)).toBeNull();
    expect(interpolateAtTime([], 0)).toBeNull();

    const many = Array.from({ length: 1000 }, (_, i) => i);
    const thinned = thinOut(many, 11);
    expect(thinned).toHaveLength(11);
    expect(thinned[0]).toBe(0);
    expect(thinned[10]).toBe(999);
    expect(thinOut([1, 2, 3], 10)).toEqual([1, 2, 3]);
    expect(lapNumberAt(22.4, 50)).toBe(23);
    expect(lapNumberAt(50, 50)).toBe(50);
    expect(lapNumberAt(-1, 50)).toBe(1);
  });
});

function tracePoint(lap: number, compound: TyreCompound, pit = false): ProjectionPoint {
  return { lap, gapToLeader: 10, raceTime: lap * 90, position: 5, compound, pit };
}

function projection(
  id: string,
  pitLap: number | null,
  compound: TyreCompound | null,
  stops: { lap: number; compound: TyreCompound }[],
  trace: ProjectionPoint[] = [],
): CandidateProjection {
  return {
    candidate: { id, label: id, pitLap, compound },
    trace,
    stops,
    expectedRaceTime: 4600,
    expectedFinish: 5,
    finishP10: 4,
    finishP50: 5,
    finishP90: 7,
    finishDistribution: [],
    rejoinPosition: 8,
    rejoinGapAhead: 1.5,
    rejoinGapBehind: 2,
    rivals: [],
  };
}

function plan(id: 'A' | 'B' | 'C', stints: { compound: TyreCompound; endLap: number }[]): StrategyPlan {
  return { id, label: `Plan ${id}`, stints };
}

describe('strategyData', () => {
  it('gives each candidate a slot that depends on its id only', () => {
    const all = candidateSlots(['T+5', 'PLAN', 'T+1', 'T+3']);
    expect([all.get('T+1'), all.get('T+3'), all.get('T+5'), all.get('PLAN')]).toEqual([0, 1, 2, 3]);
    const partial = candidateSlots(['T+5', 'STAY', 'PLAN']);
    expect([partial.get('T+5'), partial.get('PLAN'), partial.get('STAY')]).toEqual([2, 3, 4]);
    const many = candidateSlots(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(Math.max(...many.values())).toBe(7);
  });

  it('resolves the candidate compound from the candidate, its stops or its trace', () => {
    expect(resolveCandidateCompound(projection('T+1', 20, 'HARD', []))).toBe('HARD');
    expect(resolveCandidateCompound(projection('T+1', 20, null, [{ lap: 20, compound: 'SOFT' }]))).toBe('SOFT');
    const fromTrace = projection('T+1', 20, null, [], [tracePoint(20, 'MEDIUM', true), tracePoint(21, 'INTER')]);
    expect(resolveCandidateCompound(fromTrace)).toBe('INTER');
    expect(resolveCandidateCompound(projection('STAY', null, null, []))).toBeNull();
  });

  it('lists the stop sequence whether or not the engine repeats the candidate stop', () => {
    const repeated = projection('T+3', 24, 'MEDIUM', [{ lap: 24, compound: 'MEDIUM' }, { lap: 41, compound: 'SOFT' }]);
    const laterOnly = projection('T+3', 24, 'MEDIUM', [{ lap: 41, compound: 'SOFT' }]);
    const expected = [{ lap: 24, compound: 'MEDIUM' }, { lap: 41, compound: 'SOFT' }];
    expect(candidateStopSequence(repeated)).toEqual(expected);
    expect(candidateStopSequence(laterOnly)).toEqual(expected);
    expect(candidateStopSequence(projection('STAY', null, null, []))).toEqual([]);
  });

  const strategy: CarStrategy = {
    activePlan: 'B',
    autoBox: true,
    plans: {
      A: plan('A', [{ compound: 'MEDIUM', endLap: 25 }, { compound: 'HARD', endLap: 50 }]),
      B: plan('B', [{ compound: 'SOFT', endLap: 14 }, { compound: 'MEDIUM', endLap: 32 }, { compound: 'SOFT', endLap: 50 }]),
      C: plan('C', [{ compound: 'HARD', endLap: 30 }, { compound: 'MEDIUM', endLap: 50 }]),
    },
  };

  it('rewrites only the remaining stints of the active plan', () => {
    const candidate = projection('T+3', 24, 'HARD', [{ lap: 24, compound: 'HARD' }, { lap: 41, compound: 'SOFT' }]);
    const adopted = buildAdoptedStrategy({
      strategy,
      stintIndex: 1,
      currentCompound: 'MEDIUM',
      completedStints: [{ compound: 'SOFT', endLap: 14 }],
      candidate,
      raceLaps: 50,
    });
    expect(adopted.activePlan).toBe('B');
    expect(adopted.autoBox).toBe(true);
    expect(adopted.plans.B.stints).toEqual([
      { compound: 'SOFT', endLap: 14 },
      { compound: 'MEDIUM', endLap: 24 },
      { compound: 'HARD', endLap: 41 },
      { compound: 'SOFT', endLap: 50 },
    ]);
    expect(adopted.plans.B.label).toBe('Plan B');
    expect(adopted.plans.A).toBe(strategy.plans.A);
    expect(adopted.plans.C).toBe(strategy.plans.C);
    // The input is not mutated.
    expect(strategy.plans.B.stints).toHaveLength(3);
  });

  it('handles a single remaining stop, a stay-out and a plan shorter than the stops already made', () => {
    const oneStop = buildAdoptedStrategy({
      strategy,
      stintIndex: 0,
      currentCompound: 'SOFT',
      completedStints: [],
      candidate: projection('T+1', 12, 'MEDIUM', []),
      raceLaps: 50,
    });
    expect(oneStop.plans.B.stints).toEqual([{ compound: 'SOFT', endLap: 12 }, { compound: 'MEDIUM', endLap: 50 }]);

    const stayOut = buildAdoptedStrategy({
      strategy,
      stintIndex: 2,
      currentCompound: 'SOFT',
      completedStints: [],
      candidate: projection('STAY', null, null, []),
      raceLaps: 50,
    });
    expect(stayOut.plans.B.stints).toEqual([
      { compound: 'SOFT', endLap: 14 },
      { compound: 'MEDIUM', endLap: 32 },
      { compound: 'SOFT', endLap: 50 },
    ]);

    // Three stops made on a two-stop plan: the past stints are what was actually run.
    const overrun = buildAdoptedStrategy({
      strategy: { ...strategy, activePlan: 'A' },
      stintIndex: 3,
      currentCompound: 'INTER',
      completedStints: [{ compound: 'MEDIUM', endLap: 20 }, { compound: 'HARD', endLap: 30 }, { compound: 'SOFT', endLap: 38 }],
      candidate: projection('T+1', 44, 'SOFT', [{ lap: 50, compound: 'SOFT' }, { lap: 36, compound: 'WET' }]),
      raceLaps: 50,
    });
    expect(overrun.plans.A.stints).toEqual([
      { compound: 'MEDIUM', endLap: 20 },
      { compound: 'HARD', endLap: 30 },
      { compound: 'SOFT', endLap: 38 },
      { compound: 'INTER', endLap: 44 },
      { compound: 'SOFT', endLap: 50 },
    ]);
  });

  it('recognises a candidate that is already the next planned stop', () => {
    const candidate = projection('T+3', 24, null, [{ lap: 24, compound: 'HARD' }]);
    expect(isCandidateAdopted({ lap: 24, compound: 'HARD' }, candidate)).toBe(true);
    expect(isCandidateAdopted({ lap: 24, compound: 'SOFT' }, candidate)).toBe(false);
    expect(isCandidateAdopted({ lap: 25, compound: 'HARD' }, candidate)).toBe(false);
    expect(isCandidateAdopted(null, candidate)).toBe(false);
    expect(isCandidateAdopted(null, projection('STAY', null, null, []))).toBe(true);
  });
});
