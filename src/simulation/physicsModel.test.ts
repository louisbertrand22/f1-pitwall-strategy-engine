import { describe, expect, it } from 'vitest';
import { TEST_TRACK } from './__fixtures__/testTrack';
import {
  COMPOUNDS,
  NOMINAL_STATIONARY_TIME,
  WEATHER_CROSSOVER,
  bestTyreClass,
  computeLapTime,
  dirtyAirPenalty,
  doubleStackRisk,
  doubleStackWait,
  drsLapGain,
  evaluateStrategy,
  fuelPenalty,
  incidentRates,
  lapTime,
  overtakeProbability,
  pitLossUnderFlag,
  pitStopTimeLoss,
  readinessAfter,
  simulateStint,
  startingFuelKg,
  tyreDegradation,
  warmupPenalty,
  wearPerLap,
  wetnessPenalty,
} from './physicsModel';
import { createRng } from './rng';

const track = TEST_TRACK;

describe('lap time model', () => {
  it('reduces to the base lap time for a new soft, empty tank, clean air', () => {
    const breakdown = computeLapTime({ track, compound: 'SOFT', wear: 0, fuelKg: 0 });
    expect(breakdown.total).toBeCloseTo(track.baseLapTime, 9);
  });

  it('is the exact sum of its additive terms', () => {
    const b = computeLapTime({
      track,
      compound: 'MEDIUM',
      wear: 0.6,
      readiness: 0.7,
      fuelKg: 80,
      trackWetness: 0.1,
      paceOffset: 0.4,
      paceMode: 'PUSH',
      ersMode: 'HARVEST',
      gapAhead: 0.6,
      drsFraction: 1,
      gripLevel: 0.8,
    });
    const sum =
      b.base + b.car + b.fuel + b.compound + b.degradation + b.warmup + b.wetness + b.dirtyAir + b.paceMode + b.ers + b.evolution - b.drs;
    expect(b.total).toBeCloseTo(sum, 9);
  });

  it('charges about 0.03 s per kilogram of fuel', () => {
    const heavy = lapTime({ track, compound: 'MEDIUM', wear: 0.2, fuelKg: 100 });
    const light = lapTime({ track, compound: 'MEDIUM', wear: 0.2, fuelKg: 0 });
    expect(heavy - light).toBeCloseTo(100 * track.fuelEffectPerKg, 9);
    expect(fuelPenalty(track, 10)).toBeCloseTo(0.3, 9);
  });

  it('orders the dry compounds soft < medium < hard when new', () => {
    const t = (compound: 'SOFT' | 'MEDIUM' | 'HARD') => lapTime({ track, compound, wear: 0, fuelKg: 50 });
    expect(t('SOFT')).toBeLessThan(t('MEDIUM'));
    expect(t('MEDIUM')).toBeLessThan(t('HARD'));
    expect(t('MEDIUM') - t('SOFT')).toBeCloseTo(track.compoundGap[0], 9);
  });

  it('gets slower lap after lap on worn tyres despite the fuel burning off once past the cliff', () => {
    const stint = simulateStint({ track, compound: 'SOFT', laps: 34, startFuelKg: 100 });
    const laps = stint.lapTimes;
    expect(stint.endWear).toBeGreaterThan(1.2);
    expect(laps[laps.length - 1]!).toBeGreaterThan(laps[10]! + 2);
  });
});

describe('tyre model', () => {
  it('degradation is monotonic, convex and falls off a cliff past wear 1', () => {
    for (const compound of ['SOFT', 'MEDIUM', 'HARD', 'INTER', 'WET'] as const) {
      let previous = -1;
      for (let w = 0; w <= 1.4; w += 0.05) {
        const d = tyreDegradation(compound, w);
        expect(d).toBeGreaterThan(previous);
        previous = d;
      }
      const slopeInWindow = tyreDegradation(compound, 0.9) - tyreDegradation(compound, 0.8);
      const slopePastCliff = tyreDegradation(compound, 1.3) - tyreDegradation(compound, 1.2);
      expect(slopePastCliff).toBeGreaterThan(4 * slopeInWindow);
    }
  });

  it('has a warm-up phase that fades exponentially and lasts longer on harder compounds', () => {
    expect(warmupPenalty('SOFT', 1)).toBe(0);
    expect(warmupPenalty('HARD', 0.5)).toBeGreaterThan(warmupPenalty('SOFT', 0.5));
    const soft = readinessAfter(COMPOUNDS.SOFT.blanketReadiness, 1, COMPOUNDS.SOFT.warmupLaps);
    const hard = readinessAfter(COMPOUNDS.HARD.blanketReadiness, 1, COMPOUNDS.HARD.warmupLaps);
    expect(soft).toBeGreaterThan(hard);
    expect(soft).toBeGreaterThan(0.98);
    // exact composition property of the closed form
    const twoHalves = readinessAfter(readinessAfter(0.4, 0.5, 0.6), 0.5, 0.6);
    expect(twoHalves).toBeCloseTo(readinessAfter(0.4, 1, 0.6), 12);
  });

  it('wears softer compounds faster, more when pushing, on abrasive asphalt and with a full tank', () => {
    const base = { track, fuelKg: 60 } as const;
    expect(wearPerLap({ ...base, compound: 'SOFT' })).toBeGreaterThan(wearPerLap({ ...base, compound: 'MEDIUM' }));
    expect(wearPerLap({ ...base, compound: 'MEDIUM' })).toBeGreaterThan(wearPerLap({ ...base, compound: 'HARD' }));
    expect(wearPerLap({ ...base, compound: 'MEDIUM', paceMode: 'PUSH' })).toBeGreaterThan(
      wearPerLap({ ...base, compound: 'MEDIUM', paceMode: 'CONSERVE' }),
    );
    expect(wearPerLap({ track: { ...track, abrasiveness: 1.3 }, fuelKg: 60, compound: 'MEDIUM' })).toBeGreaterThan(
      wearPerLap({ ...base, compound: 'MEDIUM' }),
    );
    expect(wearPerLap({ track, fuelKg: 105, compound: 'MEDIUM' })).toBeGreaterThan(wearPerLap({ track, fuelKg: 5, compound: 'MEDIUM' }));
    // An intermediate is destroyed on a dry track.
    expect(wearPerLap({ ...base, compound: 'INTER', trackWetness: 0 })).toBeGreaterThan(
      3 * wearPerLap({ ...base, compound: 'INTER', trackWetness: 0.4 }),
    );
  });
});

describe('weather crossovers', () => {
  it('places the slick → inter → wet crossovers in order and consistently with the penalty curves', () => {
    const { slickToInter, interToWet } = WEATHER_CROSSOVER;
    expect(slickToInter).toBeGreaterThan(0.15);
    expect(slickToInter).toBeLessThan(0.45);
    expect(interToWet).toBeGreaterThan(slickToInter + 0.2);
    expect(interToWet).toBeLessThan(0.9);
    expect(wetnessPenalty('SOFT', slickToInter)).toBeCloseTo(wetnessPenalty('INTER', slickToInter), 6);
    expect(wetnessPenalty('INTER', interToWet)).toBeCloseTo(wetnessPenalty('WET', interToWet), 6);
    expect(bestTyreClass(0)).toBe('SLICK');
    expect(bestTyreClass((slickToInter + interToWet) / 2)).toBe('INTER');
    expect(bestTyreClass(0.95)).toBe('WET');
  });

  it('makes each family the fastest inside its own window', () => {
    const t = (compound: 'SOFT' | 'INTER' | 'WET', w: number) => lapTime({ track, compound, wear: 0.2, fuelKg: 50, trackWetness: w });
    expect(t('SOFT', 0.05)).toBeLessThan(t('INTER', 0.05));
    expect(t('INTER', 0.45)).toBeLessThan(t('SOFT', 0.45));
    expect(t('INTER', 0.45)).toBeLessThan(t('WET', 0.45));
    expect(t('WET', 0.9)).toBeLessThan(t('INTER', 0.9));
  });
});

describe('traffic effects', () => {
  it('applies dirty air only inside 1.2 s and more the closer the car follows', () => {
    expect(dirtyAirPenalty(track, 1.3)).toBe(0);
    expect(dirtyAirPenalty(track, null)).toBe(0);
    expect(dirtyAirPenalty(track, 1.0)).toBeGreaterThan(0);
    expect(dirtyAirPenalty(track, 0.4)).toBeGreaterThan(dirtyAirPenalty(track, 1.0));
    expect(dirtyAirPenalty(track, 0.2)).toBeCloseTo(0.55, 6);
  });

  it('gives a DRS gain of a few tenths per lap', () => {
    const gain = drsLapGain(track);
    expect(gain).toBeGreaterThan(0.2);
    expect(gain).toBeLessThan(1.2);
    const withDrs = lapTime({ track, compound: 'SOFT', wear: 0, fuelKg: 0, drsFraction: 1 });
    expect(track.baseLapTime - withDrs).toBeCloseTo(gain, 9);
  });

  it('makes a pass more likely with a bigger pace advantage, DRS and an easier circuit', () => {
    const p = (adv: number, drs = false) => overtakeProbability(track, adv, { drs });
    expect(p(1.5)).toBeGreaterThan(p(0.2));
    expect(p(0.5, true)).toBeGreaterThan(p(0.5, false));
    const street = { ...track, overtakingDifficulty: 0.98 };
    expect(overtakeProbability(street, 1.0)).toBeLessThan(0.1);
    expect(overtakeProbability({ ...track, overtakingDifficulty: 0.2 }, 1.0)).toBeGreaterThan(0.8);
  });
});

describe('pit loss', () => {
  it('equals the circuit pit loss for a nominal green-flag stop', () => {
    expect(pitLossUnderFlag(track, 'GREEN')).toBe(track.pitLossSeconds);
    expect(pitStopTimeLoss(track, 'GREEN')).toBeCloseTo(track.pitLossSeconds, 9);
    expect(pitStopTimeLoss(track, 'GREEN', NOMINAL_STATIONARY_TIME + 1.5)).toBeCloseTo(track.pitLossSeconds + 1.5, 9);
    expect(pitStopTimeLoss(track, 'GREEN', NOMINAL_STATIONARY_TIME, 2)).toBeCloseTo(track.pitLossSeconds + 2, 9);
  });

  it('is cheaper under VSC and cheapest under the safety car', () => {
    const green = pitLossUnderFlag(track, 'GREEN');
    const vsc = pitLossUnderFlag(track, 'VSC');
    const sc = pitLossUnderFlag(track, 'SC');
    expect(vsc).toBeLessThan(green);
    expect(sc).toBeLessThan(vsc);
    expect(sc).toBeGreaterThan(0.4 * green);
  });

  it('adds exactly one pit loss per stop to a strategy, split between the in-lap and the out-lap', () => {
    const fuel = startingFuelKg(track, track.raceLaps);
    const oneStop = evaluateStrategy(track, track.raceLaps, [
      { compound: 'MEDIUM', endLap: 22 },
      { compound: 'HARD', endLap: track.raceLaps },
    ]);
    const first = simulateStint({ track, compound: 'MEDIUM', laps: 22, startFuelKg: fuel, initialReadiness: 0.85 });
    const second = simulateStint({ track, compound: 'HARD', laps: track.raceLaps - 22, startFuelKg: first.endFuelKg });
    expect(oneStop.pitStops).toBe(1);
    expect(oneStop.pitTime).toBeCloseTo(track.pitLossSeconds, 9);
    expect(oneStop.totalTime).toBeCloseTo(first.total + second.total + track.pitLossSeconds, 6);
    expect(oneStop.lapTimes).toHaveLength(track.raceLaps);
    expect(oneStop.lapTimes.reduce((a, b) => a + b, 0)).toBeCloseTo(oneStop.totalTime, 6);
    // in-lap and out-lap both carry part of the loss
    expect(oneStop.lapTimes[21]!).toBeGreaterThan(first.lapTimes[21]! + 5);
    expect(oneStop.lapTimes[22]!).toBeGreaterThan(second.lapTimes[0]! + 5);
    expect(oneStop.valid).toBe(true);
  });

  it('flags a plan that uses a single dry compound or runs far past the cliff', () => {
    const single = evaluateStrategy(track, track.raceLaps, [
      { compound: 'MEDIUM', endLap: 25 },
      { compound: 'MEDIUM', endLap: track.raceLaps },
    ]);
    expect(single.valid).toBe(false);
    const noStop = evaluateStrategy(track, track.raceLaps, [{ compound: 'SOFT', endLap: track.raceLaps }]);
    expect(noStop.issues.some((i) => i.includes('past the cliff'))).toBe(true);
  });

  it('quantifies the double-stack queueing risk from the gap between the two cars', () => {
    expect(doubleStackWait(10, 2.4)).toBe(0);
    expect(doubleStackWait(1, 2.4)).toBeCloseTo(2.6, 9);
    const tight = doubleStackRisk(1.0, 2.3);
    const safe = doubleStackRisk(6.0, 2.3);
    expect(tight.queueProbability).toBeGreaterThan(0.95);
    expect(tight.expectedWait).toBeGreaterThan(2);
    expect(safe.queueProbability).toBeLessThan(0.08);
    expect(safe.expectedWait).toBeLessThan(0.2);
    expect(doubleStackRisk(3.4, 2.3).queueProbability).toBeGreaterThan(safe.queueProbability);
  });
});

describe('incident calibration', () => {
  it('reproduces the circuit safety-car probability over a race distance', () => {
    const { safetyCar, vsc } = incidentRates(track, track.raceLaps);
    const exposure = 20 * track.raceLaps;
    expect(1 - Math.exp(-safetyCar * exposure)).toBeCloseTo(track.safetyCarProbability, 9);
    expect(1 - Math.exp(-vsc * exposure)).toBeCloseTo(track.vscProbability, 9);
  });
});

describe('determinism', () => {
  it('produces the same random stream for the same seed and independent forks', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 8 }, () => a.next());
    const seqB = Array.from({ length: 8 }, () => b.next());
    expect(seqA).toEqual(seqB);
    expect(createRng(43).next()).not.toBe(createRng(42).next());
    expect(createRng(42).fork('weather').next()).toBe(createRng(42).fork('weather').next());
    expect(createRng(42).fork('weather').next()).not.toBe(createRng(42).fork('pit').next());
  });
});
