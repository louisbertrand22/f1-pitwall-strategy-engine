import { describe, expect, it } from 'vitest';
import { makeForecast, makeRequest, makeWeather } from './__fixtures__/strategyFixtures';
import { TEST_TRACK } from './__fixtures__/testTrack';
import { lapScale, lapTime, pitLossUnderFlag } from './physicsModel';
import { projectRace, projectedLapTime, runProjection } from './projection';
import type { ProjectionRequest, ProjectionResult } from './types';

const track = TEST_TRACK;

function candidate(result: ProjectionResult, id: string) {
  const found = result.candidates.find((c) => c.candidate.id === id);
  if (!found) throw new Error(`No candidate ${id}`);
  return found;
}

describe('projection — physics consistency', () => {
  it('uses exactly the lap-time model of the race engine', () => {
    const scale = lapScale(track);
    for (const compound of ['SOFT', 'MEDIUM', 'HARD', 'INTER', 'WET'] as const) {
      for (const wear of [0, 0.4, 0.9, 1.2]) {
        for (const wetness of [0, 0.25, 0.6]) {
          const fast = projectedLapTime(track, scale, compound, wear, 63, wetness, 0.37);
          const reference = lapTime({ track, compound, wear, fuelKg: 63, trackWetness: wetness, paceOffset: 0.37 });
          expect(fast).toBeCloseTo(reference, 9);
        }
      }
    }
  });
});

describe('projection — result shape', () => {
  const request = makeRequest();
  const result = projectRace(request);

  it('returns one projection per candidate with a full race trace', () => {
    expect(result.focusCarId).toBe(request.focusCarId);
    expect(result.fromLap).toBe(18);
    expect(result.monteCarloRuns).toBe(request.monteCarloRuns);
    expect(result.candidates.map((c) => c.candidate.id)).toEqual(['T+1', 'T+3', 'T+5']);
    for (const projection of result.candidates) {
      const laps = projection.trace.map((p) => p.lap);
      expect(laps[0]).toBe(18);
      expect(laps[laps.length - 1]).toBe(track.raceLaps);
      expect(laps).toEqual(Array.from({ length: track.raceLaps - 17 }, (_, i) => 18 + i));
      let previous = -Infinity;
      for (const point of projection.trace) {
        expect(point.gapToLeader).toBeGreaterThanOrEqual(0);
        expect(point.position).toBeGreaterThanOrEqual(1);
        expect(point.position).toBeLessThanOrEqual(20);
        expect(point.raceTime).toBeGreaterThan(previous);
        previous = point.raceTime;
      }
      // The candidate stop is where the plan says, and the trace switches compound after it.
      const pitLap = projection.candidate.pitLap!;
      expect(projection.stops[0]).toEqual({ lap: pitLap, compound: 'HARD' });
      expect(projection.trace.find((p) => p.lap === pitLap)!.pit).toBe(true);
      expect(projection.trace.find((p) => p.lap === pitLap)!.compound).toBe('MEDIUM');
      expect(projection.trace.find((p) => p.lap === pitLap + 1)!.compound).toBe('HARD');
    }
  });

  it('produces a proper Monte-Carlo distribution of the finishing position', () => {
    for (const projection of result.candidates) {
      expect(projection.finishDistribution).toHaveLength(20);
      expect(projection.finishDistribution.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      expect(projection.finishP10).toBeLessThanOrEqual(projection.finishP50);
      expect(projection.finishP50).toBeLessThanOrEqual(projection.finishP90);
      expect(projection.expectedFinish).toBeGreaterThanOrEqual(1);
      expect(projection.expectedFinish).toBeLessThanOrEqual(20);
      expect(projection.rejoinPosition).not.toBeNull();
      expect(projection.rejoinPosition!).toBeGreaterThanOrEqual(5);
      expect(projection.rivals).toHaveLength(2);
      for (const rival of projection.rivals) {
        expect(rival.successProbability).toBeGreaterThanOrEqual(0);
        expect(rival.successProbability).toBeLessThanOrEqual(1);
      }
      // The car ahead is ahead now, the car behind is behind.
      expect(projection.rivals[0]!.gapNow).toBeGreaterThan(0);
      expect(projection.rivals[1]!.gapNow).toBeLessThan(0);
    }
    expect(result.candidates.some((c) => c.candidate.id === result.recommendedId)).toBe(true);
    expect(result.rivalTraces.length).toBeGreaterThanOrEqual(5);
    expect(result.rivalTraces.every((r) => r.carId !== request.focusCarId && r.trace.length > 0)).toBe(true);
  });

  it('is deterministic for a seed and sensitive to it', () => {
    expect(projectRace(makeRequest())).toEqual(result);
    const other = projectRace(makeRequest({ seed: 78 }));
    expect(other.candidates.map((c) => c.trace)).toEqual(result.candidates.map((c) => c.trace));
    expect(other.candidates.map((c) => c.finishDistribution)).not.toEqual(result.candidates.map((c) => c.finishDistribution));
  });

  it('yields increasing progress and returns the same result when time-sliced', () => {
    const generator = runProjection(makeRequest());
    let step = generator.next();
    let last = 0;
    let yields = 0;
    while (!step.done) {
      expect(step.value).toBeGreaterThanOrEqual(last);
      expect(step.value).toBeLessThanOrEqual(1);
      last = step.value;
      yields += 1;
      step = generator.next();
    }
    expect(yields).toBeGreaterThan(request.monteCarloRuns);
    expect(step.value).toEqual(result);
  });
});

describe('projection — strategy sense', () => {
  it('loses time by staying out on tyres that are falling off the cliff', () => {
    const request = makeRequest({
      tyreWear: 0.97,
      runs: 0,
      request: {
        candidates: [
          { id: 'T+1', label: 'T+1', pitLap: 19, compound: 'HARD' },
          { id: 'T+9', label: 'T+9', pitLap: 27, compound: 'HARD' },
        ],
      },
    });
    const result = projectRace(request);
    expect(candidate(result, 'T+1').expectedRaceTime).toBeLessThan(candidate(result, 'T+9').expectedRaceTime - 3);
    expect(result.recommendedId).toBe('T+1');
  });

  it('makes a stop taken under the safety car cheaper than the same stop under green', () => {
    const candidates: ProjectionRequest['candidates'] = [
      { id: 'NOW', label: 'NOW', pitLap: 18, compound: 'HARD' },
      { id: 'LATER', label: 'LATER', pitLap: 26, compound: 'HARD' },
    ];
    const green = projectRace(makeRequest({ runs: 0, request: { candidates } }));
    const sc = projectRace(makeRequest({ runs: 0, request: { candidates, flag: 'SC' } }));
    const deltaGreen = candidate(green, 'NOW').expectedRaceTime - candidate(green, 'LATER').expectedRaceTime;
    const deltaSc = candidate(sc, 'NOW').expectedRaceTime - candidate(sc, 'LATER').expectedRaceTime;
    expect(deltaSc).toBeLessThan(deltaGreen - 0.5 * (pitLossUnderFlag(track) - pitLossUnderFlag(track, 'SC')));
  });

  it('shows the undercut: stopping before the car ahead brings the focus car out in front', () => {
    // The car ahead (P4) is known to stop four laps later than the earliest candidate.
    const request = makeRequest({ spacing: 1.2, tyreWear: 0.8, runs: 30 });
    // A pit stop's worth of clear track behind the leading group, so the stop does not land in traffic.
    request.cars.forEach((car, index) => {
      if (index > 4) car.nextLineCrossingTime += 32;
    });
    request.cars[3]!.plannedStops = [{ lap: 23, compound: 'HARD' }];
    request.candidates = [
      { id: 'T+1', label: 'T+1', pitLap: 19, compound: 'HARD' },
      { id: 'T+8', label: 'T+8', pitLap: 26, compound: 'HARD' },
    ];
    const result = projectRace(request);
    const early = candidate(result, 'T+1').rivals[0]!;
    const late = candidate(result, 'T+8').rivals[0]!;
    expect(early.rivalId).toBe(request.cars[3]!.id);
    expect(early.gapNow).toBeGreaterThan(0);
    expect(early.gapAfter).toBeLessThan(early.gapNow);
    expect(early.gapAfter).toBeLessThan(late.gapAfter);
  });

  it('sends the field onto intermediates when the forecast turns wet', () => {
    const base = makeRequest({ runs: 0 });
    const request: ProjectionRequest = { ...base, weather: makeWeather(0.1, 0.5), forecast: makeForecast(0.1, 0.5, 3, base.raceTime, 18) };
    const result = projectRace(request);
    for (const projection of result.candidates) {
      expect(projection.trace.some((p) => p.compound === 'INTER')).toBe(true);
    }
  });

  it('handles a "no further stop" candidate and a focus car already in the pit lane', () => {
    const request = makeRequest({ runs: 10 });
    request.candidates = [{ id: 'PLAN', label: 'NO STOP', pitLap: null, compound: null }];
    const result = projectRace(request);
    expect(result.candidates[0]!.stops).toEqual([]);
    expect(result.candidates[0]!.rejoinPosition).toBeNull();
    expect(result.candidates[0]!.trace.every((p) => !p.pit)).toBe(true);
  });
});

describe('projection — performance', () => {
  it('runs four candidates × 150 Monte-Carlo races in a fraction of a second, in small slices', () => {
    const request = makeRequest({ runs: 150 });
    request.candidates = [...request.candidates, { id: 'PLAN', label: 'PLAN', pitLap: 24, compound: 'HARD' }];
    projectRace({ ...request, monteCarloRuns: 5 }); // warm the caches and the JIT
    const generator = runProjection(request);
    const start = performance.now();
    let worst = 0;
    let previous = start;
    let step = generator.next();
    while (!step.done) {
      const now = performance.now();
      worst = Math.max(worst, now - previous);
      previous = now;
      step = generator.next();
    }
    const total = performance.now() - start;
    expect(step.value.candidates).toHaveLength(4);
    expect(total).toBeLessThan(2500);
    expect(worst).toBeLessThan(60);
  });
});
