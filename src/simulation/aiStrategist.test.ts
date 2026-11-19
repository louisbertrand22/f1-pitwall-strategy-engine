import { describe, expect, it } from 'vitest';
import { makeContext, makeForecast, makeSet, makeSets, makeWeather, planInput } from './__fixtures__/strategyFixtures';
import { TEST_TRACK } from './__fixtures__/testTrack';
import { buildDefaultPlans, decideStrategy, optimiseStrategy, pickSet, planRace, trackPositionPenalty } from './aiStrategist';
import type { OptimiserInput } from './aiStrategist';
import { COMPOUNDS, evaluateStrategy, isSlick, pitLossUnderFlag, startingFuelKg } from './physicsModel';
import { SeededRandom } from './rng';
import type { StintPlan, TyreCompound } from './types';

const track = TEST_TRACK;

function optimiserInput(overrides: Partial<OptimiserInput> = {}): OptimiserInput {
  const sets = makeSets().filter((s) => s.id !== 'M1');
  return {
    track,
    raceLaps: track.raceLaps,
    fromLap: 1,
    compound: 'MEDIUM',
    tyreWear: 0,
    fuelKg: startingFuelKg(track, track.raceLaps),
    paceOffset: 0,
    wearFactor: 1,
    availableSets: sets,
    compoundsUsed: [],
    mustUseTwoCompounds: true,
    trackWetness: 0,
    pitLoss: pitLossUnderFlag(track),
    ...overrides,
  };
}

describe('pickSet', () => {
  it('returns the least worn unfitted set of the compound', () => {
    const sets = makeSets();
    expect(pickSet(sets, 'SOFT')!.id).toBe('S1');
    expect(pickSet(sets, 'MEDIUM')!.id).toBe('M1');
    sets.find((s) => s.id === 'M1')!.fitted = true;
    expect(pickSet(sets, 'MEDIUM')!.id).toBe('M2');
    expect(pickSet([makeSet('X', 'HARD')], 'WET')).toBeNull();
  });
});

describe('optimiseStrategy', () => {
  it('finds a legal, ranked strategy that uses two dry compounds', () => {
    const strategies = optimiseStrategy(optimiserInput());
    expect(strategies.length).toBeGreaterThan(1);
    const best = strategies[0]!;
    expect(best.stops.length).toBeGreaterThanOrEqual(1);
    expect(best.stops.some((s) => s.compound !== 'MEDIUM')).toBe(true);
    for (let i = 1; i < strategies.length; i++) expect(strategies[i]!.score).toBeGreaterThanOrEqual(strategies[i - 1]!.score);
    for (const s of strategies) {
      expect(s.score).toBeCloseTo(s.totalTime + s.stops.length * trackPositionPenalty(track), 6);
      let previous = 0;
      for (const stop of s.stops) {
        expect(stop.lap).toBeGreaterThan(previous);
        expect(stop.lap).toBeLessThan(track.raceLaps);
        expect(isSlick(stop.compound)).toBe(true);
        previous = stop.lap;
      }
    }
  });

  it('agrees with the reference strategy evaluation of the physics model', () => {
    const best = optimiseStrategy(optimiserInput())[0]!;
    const stints: StintPlan[] = [];
    let compound: TyreCompound = 'MEDIUM';
    for (const stop of best.stops) {
      stints.push({ compound, endLap: stop.lap });
      compound = stop.compound;
    }
    stints.push({ compound, endLap: track.raceLaps });
    const reference = evaluateStrategy(track, track.raceLaps, stints);
    expect(reference.valid).toBe(true);
    // The optimiser assumes the opening stint starts fully up to temperature: a fraction of a second apart.
    expect(Math.abs(reference.totalTime - best.totalTime)).toBeLessThan(2.5);
  });

  it('is at least as fast as any hand-picked one-stop', () => {
    const best = optimiseStrategy(optimiserInput())[0]!;
    for (const lap of [14, 20, 26, 32]) {
      const manual = evaluateStrategy(track, track.raceLaps, [
        { compound: 'MEDIUM', endLap: lap },
        { compound: 'HARD', endLap: track.raceLaps },
      ]);
      expect(best.score).toBeLessThan(manual.totalTime + trackPositionPenalty(track) + 2.5);
    }
  });

  it('honours a forced first stop and its compound', () => {
    const strategies = optimiseStrategy(optimiserInput({ fromLap: 11, tyreWear: 0.35, forcedFirstStopLap: 13, forcedFirstCompound: 'SOFT' }));
    for (const s of strategies) {
      expect(s.stops[0]).toEqual({ lap: 13, compound: 'SOFT' });
    }
    const now = optimiseStrategy(optimiserInput({ fromLap: 11, tyreWear: 0.35, forcedFirstStopLap: 10 }))[0]!;
    expect(now.stops[0]!.lap).toBe(10);
  });

  it('never plans more stints on a compound than there are sets', () => {
    const sets = [makeSet('H1', 'HARD'), makeSet('S1', 'SOFT', 0.2)];
    const strategies = optimiseStrategy(optimiserInput({ availableSets: sets }), 12);
    for (const s of strategies) {
      expect(s.stops.filter((x) => x.compound === 'HARD').length).toBeLessThanOrEqual(1);
      expect(s.stops.filter((x) => x.compound === 'SOFT').length).toBeLessThanOrEqual(1);
      expect(s.stops.every((x) => x.compound !== 'MEDIUM')).toBe(true);
    }
  });

  it('prefers a single stop where overtaking is all but impossible', () => {
    const street = { ...track, id: 'monaco' as const, overtakingDifficulty: 0.98, abrasiveness: 0.75, tyreStress: 0.9 };
    const best = optimiseStrategy(optimiserInput({ track: street }))[0]!;
    expect(best.stops).toHaveLength(1);
    expect(trackPositionPenalty(street)).toBeGreaterThan(trackPositionPenalty(track) + 10);
  });

  it('prices a stop made right now with the reduced loss', () => {
    const base = optimiserInput({ fromLap: 16, tyreWear: 0.5, forcedFirstStopLap: 15 });
    const green = optimiseStrategy(base)[0]!;
    const sc = optimiseStrategy({ ...base, firstStopLoss: pitLossUnderFlag(track, 'SC') })[0]!;
    expect(green.totalTime - sc.totalTime).toBeCloseTo(pitLossUnderFlag(track) - pitLossUnderFlag(track, 'SC'), 6);
  });

  it('plans on wet-weather tyres when the track is wet', () => {
    const best = optimiseStrategy(optimiserInput({ compound: 'INTER', trackWetness: 0.45, mustUseTwoCompounds: false }))[0]!;
    expect(best.stops.every((s) => !isSlick(s.compound))).toBe(true);
  });
});

describe('pre-race plans', () => {
  it('gives every car a deterministic plan that starts on a set it owns', () => {
    const a = planRace(planInput({ rng: new SeededRandom(3) }));
    const b = planRace(planInput({ rng: new SeededRandom(3) }));
    expect(a).toEqual(b);
    const sets = makeSets();
    expect(sets.some((s) => s.id === a.startSetId)).toBe(true);
    expect(a.expectedRaceTime).toBeGreaterThan(track.raceLaps * track.baseLapTime);
    let previous = 0;
    for (const stop of a.stops) {
      expect(stop.lap).toBeGreaterThan(previous);
      expect(stop.lap).toBeLessThan(track.raceLaps);
      previous = stop.lap;
    }
    // The plan must satisfy the two-compound rule.
    const start = sets.find((s) => s.id === a.startSetId)!.compound;
    expect(new Set([start, ...a.stops.map((s) => s.compound)]).size).toBeGreaterThanOrEqual(2);
  });

  it('spreads strategies across the grid', () => {
    const signatures = new Set<string>();
    for (let grid = 1; grid <= 20; grid++) {
      const plan = planRace(planInput({ gridPosition: grid, profile: { aggression: 0.8, weatherRisk: 0.5, reactivity: 0.6 }, rng: new SeededRandom(100 + grid) }));
      signatures.add(`${plan.startSetId[0]}:${plan.stops.map((s) => `${s.lap}${s.compound[0]}`).join(',')}`);
    }
    expect(signatures.size).toBeGreaterThan(4);
  });

  it('offers three distinct, valid plans A, B and C', () => {
    const strategy = buildDefaultPlans(planInput());
    expect(strategy.activePlan).toBe('A');
    expect(strategy.autoBox).toBe(true);
    const seen = new Set<string>();
    for (const id of ['A', 'B', 'C'] as const) {
      const plan = strategy.plans[id];
      expect(plan.id).toBe(id);
      expect(plan.stints.length).toBeGreaterThan(0);
      expect(plan.stints[plan.stints.length - 1]!.endLap).toBe(track.raceLaps);
      const evaluation = evaluateStrategy(track, track.raceLaps, plan.stints);
      expect(evaluation.valid).toBe(true);
      expect(plan.label).toMatch(/^\d-STOP /);
      seen.add(JSON.stringify(plan.stints));
    }
    expect(seen.size).toBe(3);
    const timeA = evaluateStrategy(track, track.raceLaps, strategy.plans.A.stints).totalTime;
    const timeB = evaluateStrategy(track, track.raceLaps, strategy.plans.B.stints).totalTime;
    expect(Math.abs(timeA - timeB)).toBeLessThan(40);
  });

  it('starts on wet-weather tyres when the track is wet', () => {
    const wet = planInput({ weather: makeWeather(0.5, 0.4), forecast: makeForecast(0.5) });
    const plan = planRace(wet);
    expect(plan.startSetId.startsWith('I')).toBe(true);
    const strategy = buildDefaultPlans(planInput({ weather: makeWeather(0.5, 0.4), forecast: makeForecast(0.5, 0.05, 14) }));
    expect(strategy.plans.A.stints[0]!.compound).toBe('INTER');
    // The forecast dries: plan A moves to slicks.
    expect(strategy.plans.A.stints.some((s) => isSlick(s.compound))).toBe(true);
  });
});

describe('decideStrategy', () => {
  it('stays out before the planned lap and boxes on it', () => {
    const early = decideStrategy(makeContext({ lap: 20, context: { plan: [{ lap: 24, compound: 'HARD' }] }, car: { gapAhead: 6, gapBehind: 6 } }));
    expect(early.box).toBeNull();
    expect(early.plan).toEqual([{ lap: 24, compound: 'HARD' }]);
    const due = decideStrategy(makeContext({ lap: 24, context: { plan: [{ lap: 24, compound: 'HARD' }] } }));
    expect(due.box).not.toBeNull();
    expect(due.box!.reason).toBe('PLANNED');
    expect(due.box!.setId.startsWith('H')).toBe(true);
    expect(due.plan).toEqual([]);
    expect(due.paceMode).toBe('PUSH');
    expect(due.rationale.length).toBeGreaterThan(5);
  });

  it('never stops on the last lap and ignores cars that are not racing', () => {
    const last = decideStrategy(makeContext({ lap: track.raceLaps, context: { plan: [{ lap: track.raceLaps, compound: 'HARD' }] } }));
    expect(last.box).toBeNull();
    const pit = decideStrategy(makeContext({ lap: 24, car: { status: 'PIT_LANE' }, context: { plan: [{ lap: 24, compound: 'HARD' }] } }));
    expect(pit.box).toBeNull();
  });

  it('takes the cheap stop under the safety car when one was due, but not on fresh tyres', () => {
    const sc = { flag: 'SC' as const, pitLossNow: pitLossUnderFlag(track, 'SC') };
    const due = decideStrategy(makeContext({ lap: 20, tyreWear: 0.62, context: { ...sc, plan: [{ lap: 25, compound: 'HARD' }] } }));
    expect(due.box).not.toBeNull();
    expect(due.box!.reason).toBe('SAFETY_CAR');
    const fresh = decideStrategy(
      makeContext({ lap: 20, compound: 'HARD', tyreWear: 0.06, tyreAge: 2, car: { compoundsUsed: ['MEDIUM', 'HARD'], pitStops: 1, lastPitLap: 17 }, context: { ...sc, plan: [] } }),
    );
    expect(fresh.box).toBeNull();
  });

  it('declines a double stack that costs more than it gains', () => {
    const sc = { flag: 'SC' as const, pitLossNow: pitLossUnderFlag(track, 'SC') };
    const alone = decideStrategy(makeContext({ lap: 20, tyreWear: 0.5, context: { ...sc, plan: [{ lap: 30, compound: 'HARD' }] } }));
    const stacked = decideStrategy(
      makeContext({ lap: 20, tyreWear: 0.5, context: { ...sc, plan: [{ lap: 30, compound: 'HARD' }], teammateBoxingAhead: true, doubleStackWait: 14 } }),
    );
    expect(alone.box).not.toBeNull();
    expect(stacked.box).toBeNull();
  });

  it('switches to intermediates when the rain arrives and back to slicks when the track dries', () => {
    const rain = decideStrategy(makeContext({ lap: 20, context: { weather: makeWeather(0.33, 0.5), forecast: makeForecast(0.33, 0.55, 4, 1800, 20) } }));
    expect(rain.box).not.toBeNull();
    expect(rain.box!.reason).toBe('WEATHER');
    expect(rain.box!.setId.startsWith('I')).toBe(true);

    const drying = decideStrategy(
      makeContext({
        lap: 30,
        compound: 'INTER',
        tyreWear: 0.4,
        car: { compoundsUsed: ['MEDIUM', 'INTER'] },
        context: { weather: makeWeather(0.2, 0), forecast: makeForecast(0.2, 0.02, 5, 2700, 30), plan: [], mustUseTwoCompounds: false },
      }),
    );
    expect(drying.box).not.toBeNull();
    expect(drying.box!.reason).toBe('WEATHER');
    expect(COMPOUNDS[(['SOFT', 'MEDIUM', 'HARD'] as const).find((c) => drying.box!.setId.startsWith(COMPOUNDS[c].letter))!].tyreClass).toBe('SLICK');

    const steady = decideStrategy(
      makeContext({ lap: 30, compound: 'INTER', tyreWear: 0.4, context: { weather: makeWeather(0.45, 0.4), forecast: makeForecast(0.45, 0.45, 5, 2700, 30), plan: [], mustUseTwoCompounds: false } }),
    );
    expect(steady.box).toBeNull();
  });

  it('holds a routine stop when rain is about to arrive', () => {
    const decision = decideStrategy(
      makeContext({ lap: 24, context: { plan: [{ lap: 24, compound: 'HARD' }], weather: makeWeather(0.08, 0.5), forecast: makeForecast(0.08, 0.6, 3, 2100, 24) } }),
    );
    expect(decision.box).toBeNull();
    expect(decision.plan[0]!.lap).toBe(25);
  });

  it('goes for the undercut when stuck behind a car on old tyres with the stop coming up', () => {
    const scenario = (gapAhead: number, compound: 'SOFT' | 'HARD', tyreWear: number) =>
      decideStrategy(
        makeContext({
          lap: 36,
          tyreWear,
          car: { gapAhead, gapBehind: 6 },
          context: { plan: [{ lap: 38, compound }], profile: { aggression: 1, weatherRisk: 0.5, reactivity: 1 }, rng: new SeededRandom(1) },
          spacing: 30,
        }),
      );
    // Onto softs the out-lap is immediately quick: a 0.9 s gap is well within reach.
    const decision = scenario(0.9, 'SOFT', 0.8);
    expect(decision.box).not.toBeNull();
    expect(decision.box!.reason).toBe('UNDERCUT');
    expect(decision.rationale).toContain('Undercut');
    expect(decision.plan).toEqual([]);
    // Onto hards the warm-up eats the advantage: the same gap is out of reach on healthy tyres.
    expect(scenario(1.6, 'HARD', 0.45).box).toBeNull();
  });

  it('covers a rival that has just stopped from close behind', () => {
    const ctx = makeContext({ lap: 22, tyreWear: 0.7, car: { gapAhead: 8 }, context: { plan: [{ lap: 26, compound: 'HARD' }] }, spacing: 2 });
    const rival = ctx.field[5]!;
    rival.inPitLane = true;
    rival.gapToLeader = ctx.car.gapToLeader + 2 + 6;
    const decision = decideStrategy(ctx);
    expect(decision.box).not.toBeNull();
    expect(decision.box!.reason).toBe('COVER');
  });

  it('brings the stop forward when the tyres will not make the planned lap, and stops when they are gone', () => {
    const fading = decideStrategy(makeContext({ lap: 20, tyreWear: 0.93, car: { gapAhead: 6, gapBehind: 6 }, context: { plan: [{ lap: 34, compound: 'HARD' }] } }));
    expect(fading.box).toBeNull();
    expect(fading.plan[0]!.lap).toBeLessThan(28);
    const gone = decideStrategy(makeContext({ lap: 20, tyreWear: 1.25, context: { plan: [{ lap: 34, compound: 'HARD' }] } }));
    expect(gone.box).not.toBeNull();
    expect(gone.box!.reason).toBe('TYRE_WEAR');
  });

  it('schedules the mandatory second compound when no stop is planned', () => {
    const decision = decideStrategy(makeContext({ lap: 20, tyreWear: 0.3, car: { gapAhead: 6, gapBehind: 6 }, context: { plan: [] } }));
    expect(decision.box).toBeNull();
    expect(decision.plan.length).toBeGreaterThan(0);
    expect(decision.plan[0]!.compound).not.toBe('MEDIUM');
  });

  it('manages pace and energy: saves fuel when short, deploys in a fight, harvests when alone', () => {
    const saving = decideStrategy(makeContext({ car: { gapAhead: 8, gapBehind: 8 }, context: { fuelMarginLaps: -0.5 } }));
    expect(saving.paceMode).toBe('CONSERVE');
    const attacking = decideStrategy(makeContext({ tyreWear: 0.4, car: { gapAhead: 0.6, gapBehind: 5 }, context: { ersCharge: 0.8, plan: [{ lap: 40, compound: 'HARD' }] } }));
    expect(attacking.ersMode).toBe('OVERTAKE');
    expect(attacking.paceMode).toBe('PUSH');
    const alone = decideStrategy(makeContext({ car: { gapAhead: 9, gapBehind: 9 }, context: { ersCharge: 0.5 } }));
    expect(alone.ersMode).toBe('HARVEST');
  });

  it('is fast enough to run for twenty cars every lap', () => {
    planRace(planInput());
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) planRace(planInput({ gridPosition: i + 1, rng: new SeededRandom(i) }));
    const planMs = (performance.now() - t0) / 20;
    const t1 = performance.now();
    let count = 0;
    for (let lap = 5; lap < 45; lap++) {
      for (let index = 0; index < 20; index++) {
        decideStrategy(makeContext({ lap, index, tyreWear: 0.2 + lap * 0.015, context: { plan: [{ lap: 26, compound: 'HARD' }] } }));
        count += 1;
      }
    }
    const decideMs = (performance.now() - t1) / count;
    expect(planMs).toBeLessThan(60);
    expect(decideMs).toBeLessThan(5);
  });
});
