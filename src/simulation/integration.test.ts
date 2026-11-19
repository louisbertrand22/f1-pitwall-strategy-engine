/**
 * End-to-end races with the real circuits, the real pit-wall AI and the projection engine: the same
 * wiring as the Web Worker, driven headlessly.
 */
import { describe, expect, it } from 'vitest';
import { buildDefaultPlans, decideStrategy, planRace } from './aiStrategist';
import { isSlick } from './physicsModel';
import { projectRace } from './projection';
import { ENGINE_DT, RaceEngine } from './raceEngine';
import { TRACK_LIST, getTrack } from './trackData';
import type { ClassificationEntry, LapRecord, PitStopRecord, ProjectionResult, RaceEvent, SessionConfig } from './types';

interface Outcome {
  classification: ClassificationEntry[];
  laps: LapRecord[];
  pitStops: PitStopRecord[];
  events: RaceEvent[];
  projection: ProjectionResult | null;
}

function runRace(config: SessionConfig, projectAt?: number): Outcome {
  const track = getTrack(config.trackId);
  const engine = new RaceEngine(config, { track, planRace, buildDefaultPlans, decideStrategy });
  const outcome: Outcome = { classification: [], laps: [], pitStops: [], events: [], projection: null };
  engine.start();
  let steps = 0;
  const perSecond = Math.round(1 / ENGINE_DT);
  while (!engine.isFinished && steps < 4 * 3600 * perSecond) {
    engine.step();
    steps += 1;
    if (steps % perSecond !== 0) continue;
    const out = engine.drain();
    outcome.laps.push(...out.laps);
    outcome.pitStops.push(...out.pitStops);
    outcome.events.push(...out.events);
    if (out.classification) outcome.classification = out.classification;
    if (projectAt !== undefined && outcome.projection === null && engine.clock >= projectAt) {
      const request = engine.buildProjectionRequest(engine.session.playerCarIds[0], null, [1, 3, 5], 40);
      if (request) outcome.projection = projectRace(request);
    }
  }
  const out = engine.drain();
  outcome.laps.push(...out.laps);
  if (out.classification) outcome.classification = out.classification;
  expect(engine.isFinished).toBe(true);
  return outcome;
}

function config(overrides: Partial<SessionConfig>): SessionConfig {
  return { trackId: 'silverstone', seed: 31337, playerTeamId: 'kestrel', weatherMode: 'DRY', incidentLevel: 1, ...overrides };
}

describe('full races with the real AI', () => {
  for (const trackId of ['silverstone', 'monaco'] as const) {
    it(`runs a sane dry ${trackId} grand prix`, () => {
      const track = getTrack(trackId);
      const race = runRace(config({ trackId }), trackId === 'silverstone' ? 1500 : undefined);
      const { classification } = race;
      expect(classification).toHaveLength(20);
      const finishers = classification.filter((c) => c.status === 'FINISHED');
      expect(finishers.length).toBeGreaterThanOrEqual(12);

      // Nobody parks an AI car with an empty tank, and nobody laps faster than physics allows.
      expect(classification.filter((c) => c.retiredReason === 'Out of fuel')).toHaveLength(0);
      for (const lap of race.laps) expect(lap.lapTime).toBeGreaterThan(track.baseLapTime - 0.3);

      // Rule keeping: every classified car made its mandatory compound change.
      for (const entry of finishers) {
        expect(entry.penaltySeconds).toBe(0);
        expect(entry.pitStops).toBeGreaterThanOrEqual(1);
        expect(entry.pitStops).toBeLessThanOrEqual(4);
        const compounds = new Set(race.laps.filter((l) => l.carId === entry.carId).map((l) => l.compound));
        expect([...compounds].filter((c) => isSlick(c)).length).toBeGreaterThanOrEqual(2);
      }

      // The last lap record of every finisher carries its final position.
      for (const entry of finishers) {
        const laps = race.laps.filter((l) => l.carId === entry.carId);
        expect(laps[laps.length - 1]!.position).toBe(entry.position);
      }

      const winner = classification[0]!;
      expect(winner.lapsCompleted).toBe(track.raceLaps);
      expect(winner.totalTime!).toBeGreaterThan(track.raceLaps * track.baseLapTime);
      expect(winner.totalTime!).toBeLessThan(track.raceLaps * track.baseLapTime * 1.3);

      // Monaco is a procession; Silverstone is not.
      const overtakes = race.events.filter((e) => e.type === 'OVERTAKE').length;
      if (trackId === 'monaco') expect(overtakes).toBeLessThan(15);
      else expect(overtakes).toBeGreaterThan(10);

      if (trackId === 'silverstone') {
        const projection = race.projection;
        expect(projection).not.toBeNull();
        expect(projection!.candidates.length).toBeGreaterThanOrEqual(3);
        for (const candidate of projection!.candidates) {
          expect(candidate.finishDistribution.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
          expect(candidate.trace.length).toBeGreaterThan(5);
        }
      }
    });
  }

  it('replays the same race from the same seed', () => {
    const a = runRace(config({ trackId: 'monza', seed: 99, raceLaps: 18 }));
    const b = runRace(config({ trackId: 'monza', seed: 99, raceLaps: 18 }));
    expect(a.classification).toEqual(b.classification);
    expect(a.pitStops).toEqual(b.pitStops);
    expect(a.laps.length).toBe(b.laps.length);
  });

  it('copes with changing weather: the field moves to wet-weather tyres and nobody runs dry', () => {
    const race = runRace(config({ trackId: 'spa', seed: 2024, weatherMode: 'MIXED' }));
    expect(race.classification).toHaveLength(20);
    expect(race.classification.filter((c) => c.retiredReason === 'Out of fuel')).toHaveLength(0);
    expect(race.pitStops.some((p) => p.toCompound === 'INTER' || p.toCompound === 'WET')).toBe(true);
    expect(race.events.some((e) => e.type === 'WEATHER')).toBe(true);
    // Lap history is gap-free for every car, even across a suspension.
    const byCar = new Map<string, number[]>();
    for (const lap of race.laps) byCar.set(lap.carId, [...(byCar.get(lap.carId) ?? []), lap.lap]);
    for (const laps of byCar.values()) expect(laps).toEqual(Array.from({ length: laps.length }, (_, i) => i + 1));
  });

  it('plans a wet start on wet-weather tyres for everybody', () => {
    const track = getTrack('suzuka');
    const engine = new RaceEngine(config({ trackId: 'suzuka', weatherMode: 'WET', seed: 5 }), { track, planRace, buildDefaultPlans, decideStrategy });
    const snapshot = engine.snapshot(1, false);
    expect(snapshot.weather.trackWetness).toBeGreaterThan(0.3);
    for (const car of snapshot.cars) expect(isSlick(car.tyre.compound)).toBe(false);
    for (const telemetry of snapshot.player.cars) {
      expect(isSlick(telemetry.strategy.plans.A.stints[0]!.compound)).toBe(false);
    }
  });

  it('gives the two team cars different stop laps in their default plans', () => {
    for (const track of TRACK_LIST) {
      const engine = new RaceEngine(config({ trackId: track.id }), { track, planRace, buildDefaultPlans, decideStrategy });
      const [first, second] = engine.snapshot(1, false).player.cars;
      const a = first.strategy.plans.A.stints;
      const b = second.strategy.plans.A.stints;
      if (a.length > 1 && b.length > 1) expect(a[0]!.endLap).not.toBe(b[0]!.endLap);
    }
  });
});
