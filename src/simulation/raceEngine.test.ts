import { describe, expect, it } from 'vitest';
import type { WorkerCommand } from '../workers/protocol';
import * as stub from './__fixtures__/stubStrategist';
import { TEST_TRACK } from './__fixtures__/testTrack';
import { NOMINAL_STATIONARY_TIME, pitLossUnderFlag, simulateStint, startingFuelKg } from './physicsModel';
import { ENGINE_DT, RaceEngine } from './raceEngine';
import type { ClassificationEntry, LapRecord, PitStopRecord, RaceEvent, RadioMessage, RaceSnapshot, SessionConfig } from './types';

const track = TEST_TRACK;

interface RaceLog {
  engine: RaceEngine;
  laps: LapRecord[];
  pitStops: PitStopRecord[];
  events: RaceEvent[];
  radio: RadioMessage[];
  classification: ClassificationEntry[] | null;
  steps: number;
}

type Script = (engine: RaceEngine, send: (command: WorkerCommand) => void, log: RaceLog) => void;

function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return { trackId: 'silverstone', seed: 2024, playerTeamId: 'kestrel', weatherMode: 'DRY', incidentLevel: 0, ...overrides };
}

/** Runs a race headlessly; `script` is called once per simulated second and may send commands. */
function race(cfg: SessionConfig, script?: Script, maxSeconds = 4 * 3600): RaceLog {
  const engine = new RaceEngine(cfg, { track, ...stub });
  const log: RaceLog = { engine, laps: [], pitStops: [], events: [], radio: [], classification: null, steps: 0 };
  const collect = (): void => {
    const out = engine.drain();
    log.laps.push(...out.laps);
    log.pitStops.push(...out.pitStops);
    log.events.push(...out.events);
    log.radio.push(...out.radio);
    if (out.classification) log.classification = out.classification;
  };
  engine.start();
  const perSecond = Math.round(1 / ENGINE_DT);
  while (!engine.isFinished && log.steps < maxSeconds * perSecond) {
    engine.step();
    log.steps += 1;
    if (log.steps % perSecond === 0) {
      collect();
      script?.(engine, (command) => engine.command(command), log);
    }
  }
  collect();
  return log;
}

function expectValidSnapshot(snapshot: RaceSnapshot): void {
  const positions = snapshot.cars.map((c) => c.position).sort((a, b) => a - b);
  expect(positions).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  for (const car of snapshot.cars) {
    expect(car.lapFraction).toBeGreaterThanOrEqual(0);
    expect(car.lapFraction).toBeLessThan(1);
    expect(Number.isFinite(car.speedKph)).toBe(true);
    if (car.gapToLeader !== null) expect(car.gapToLeader).toBeGreaterThanOrEqual(0);
    if (car.interval !== null) expect(car.interval).toBeGreaterThanOrEqual(0);
    expect(car.tyre.wear).toBeGreaterThanOrEqual(0);
  }
}

describe('race engine — full race', () => {
  const log = race(config({ incidentLevel: 1, seed: 7 }));

  it('runs to the chequered flag and classifies all twenty cars', () => {
    expect(log.engine.isFinished).toBe(true);
    const classification = log.classification;
    expect(classification).not.toBeNull();
    expect(classification).toHaveLength(20);
    expect(classification!.map((c) => c.position)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const winner = classification![0]!;
    expect(winner.status).toBe('FINISHED');
    expect(winner.lapsCompleted).toBe(track.raceLaps);
    expect(winner.points).toBe(25);
    expect(new Set(classification!.map((c) => c.carId)).size).toBe(20);
  });

  it('records one lap per car and per lap, with plausible lap times and a consistent order', () => {
    const winner = log.classification![0]!;
    const winnerLaps = log.laps.filter((l) => l.carId === winner.carId);
    expect(winnerLaps.map((l) => l.lap)).toEqual(Array.from({ length: track.raceLaps }, (_, i) => i + 1));
    for (const lap of log.laps) {
      expect(lap.lapTime).toBeGreaterThan(track.baseLapTime - 0.5);
      expect(lap.lapTime).toBeLessThan(track.baseLapTime * 3);
      expect(lap.sectors[0] + lap.sectors[1] + lap.sectors[2]).toBeCloseTo(lap.lapTime, 6);
      expect(lap.gapToLeader).toBeGreaterThanOrEqual(0);
    }
    // The race clock at the line increases lap after lap for every car.
    const byCar = new Map<string, LapRecord[]>();
    for (const lap of log.laps) byCar.set(lap.carId, [...(byCar.get(lap.carId) ?? []), lap]);
    for (const laps of byCar.values()) {
      for (let i = 1; i < laps.length; i++) {
        expect(laps[i]!.raceTime - laps[i - 1]!.raceTime).toBeCloseTo(laps[i]!.lapTime, 6);
      }
    }
  });

  it('keeps green-flag race pace consistent with the lap-time model', () => {
    const winner = log.classification![0]!;
    const quickest = Math.min(...log.laps.filter((l) => l.carId === winner.carId).map((l) => l.lapTime));
    // Best case of the model: fresh softs on fumes. Worst reasonable case: worn hards, full tank, in traffic.
    const floor = simulateStint({ track, compound: 'SOFT', laps: 2, startFuelKg: 2 }).lapTimes[1]!;
    const ceiling = simulateStint({ track, compound: 'HARD', laps: 2, startFuelKg: startingFuelKg(track, track.raceLaps), paceOffset: 2 }).lapTimes[1]! + 2;
    expect(quickest).toBeGreaterThan(floor - 1);
    expect(quickest).toBeLessThan(ceiling);
  });
});

describe('race engine — determinism', () => {
  it('replays the same race for the same seed and commands', () => {
    const script: Script = (engine, send) => {
      if (Math.round(engine.clock) === 300) send({ type: 'SET_PACE_MODE', carId: engine.session.playerCarIds[0], mode: 'PUSH' });
      if (Math.round(engine.clock) === 600) send({ type: 'RACE_CONTROL', action: 'VIRTUAL_SAFETY_CAR' });
    };
    const cfg = config({ incidentLevel: 1, seed: 99, raceLaps: 16 });
    const a = race(cfg, script);
    const b = race(cfg, script);
    expect(a.steps).toBe(b.steps);
    expect(a.classification).toEqual(b.classification);
    expect(a.laps).toEqual(b.laps);
    expect(a.pitStops).toEqual(b.pitStops);
    const c = race({ ...cfg, seed: 100 });
    expect(c.laps).not.toEqual(a.laps);
  });
});

describe('race engine — pit stops', () => {
  it('charges the circuit pit loss for a green-flag stop', () => {
    const log = race(config({ raceLaps: 30, seed: 3 }));
    const green = log.pitStops.filter((p) => p.flag === 'GREEN' && p.queueTime === 0);
    expect(green.length).toBeGreaterThan(10);
    for (const stop of green) {
      const expected = pitLossUnderFlag(track, 'GREEN') - NOMINAL_STATIONARY_TIME + stop.stationaryTime;
      expect(stop.timeLost).toBeGreaterThan(expected - 0.6);
      expect(stop.timeLost).toBeLessThan(expected + 0.6);
      expect(stop.positionAfter).not.toBeNull();
      expect(stop.positionAfter!).toBeGreaterThanOrEqual(stop.positionBefore);
    }
  });

  it('executes a manual box call with the requested set, and a cancelled call keeps the car out', () => {
    let boxedSet: string | null = null;
    const log = race(config({ raceLaps: 12 }), (engine, send) => {
      const [first, second] = engine.session.playerCarIds;
      const t = Math.round(engine.clock);
      if (t === 200) {
        const snapshot = engine.snapshot(1, false);
        const soft = snapshot.player.cars[0].tyreSets.find((s) => s.compound === 'SOFT' && !s.fitted);
        boxedSet = soft?.id ?? null;
        if (soft) send({ type: 'BOX', carId: first, setId: soft.id });
        const hard = snapshot.player.cars[1].tyreSets.find((s) => s.compound === 'HARD' && !s.fitted);
        if (hard) send({ type: 'BOX', carId: second, setId: hard.id });
        send({ type: 'SET_AUTO_BOX', carId: first, enabled: false });
        send({ type: 'SET_AUTO_BOX', carId: second, enabled: false });
      }
      if (t === 205) {
        expect(engine.snapshot(1, false).player.cars[0].boxCall?.setId).toBe(boxedSet);
        send({ type: 'CANCEL_BOX', carId: second });
      }
    });
    const [first, second] = log.engine.session.playerCarIds;
    const stops = log.pitStops.filter((p) => p.carId === first);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.toSetId).toBe(boxedSet);
    expect(stops[0]!.reason).toBe('MANUAL');
    expect(stops[0]!.lap).toBe(3);
    expect(log.pitStops.filter((p) => p.carId === second)).toHaveLength(0);
  });

  it('makes the second car of a double stack queue behind its team-mate', () => {
    const log = race(config({ raceLaps: 10, seed: 5 }), (engine, send) => {
      const t = Math.round(engine.clock);
      if (t === 60) {
        for (const carId of engine.session.playerCarIds) send({ type: 'SET_AUTO_BOX', carId, enabled: false });
        send({ type: 'SET_TEAM_ORDER', order: 'HOLD' });
      }
      if (t === 400) {
        const snapshot = engine.snapshot(1, false);
        const estimate = snapshot.player.doubleStack;
        expect(estimate).not.toBeNull();
        const sets = snapshot.player.cars.map((c) => c.tyreSets.find((s) => s.compound === 'HARD' && !s.fitted)!.id) as [string, string];
        send({ type: 'DOUBLE_STACK', setIds: sets });
      }
    });
    const stops = log.pitStops.filter((p) => log.engine.session.playerCarIds.includes(p.carId));
    expect(stops).toHaveLength(2);
    expect(stops[0]!.lap).toBe(stops[1]!.lap);
    const [lead, trail] = stops[0]!.raceTime <= stops[1]!.raceTime ? [stops[0]!, stops[1]!] : [stops[1]!, stops[0]!];
    expect(lead.queueTime).toBe(0);
    // The trail car arrives while the crew is still busy unless it was more than a stop length behind.
    const gap = trail.raceTime - lead.raceTime;
    if (gap < lead.stationaryTime + 1) expect(trail.queueTime).toBeGreaterThan(0);
    else expect(trail.queueTime).toBeLessThan(1.5);
  });
});

describe('race engine — neutralisations and weather', () => {
  it('bunches the field behind the safety car, makes stops cheaper, then goes green again', () => {
    const flags = new Set<string>();
    let spreadBefore = 0;
    let spreadUnderSc = Infinity;
    const log = race(config({ raceLaps: 20, seed: 21 }), (engine, send) => {
      const t = Math.round(engine.clock);
      const snapshot = engine.snapshot(1, false);
      flags.add(snapshot.raceControl.flag);
      expectValidSnapshot(snapshot);
      const tenth = snapshot.cars[9]!;
      if (t === 1095) spreadBefore = tenth.gapToLeader ?? 0;
      if (t === 1100) send({ type: 'RACE_CONTROL', action: 'SAFETY_CAR' });
      if (snapshot.raceControl.flag === 'SC' && t > 1300 && tenth.gapToLeader !== null && tenth.lapsDown === 0) {
        spreadUnderSc = Math.min(spreadUnderSc, tenth.gapToLeader);
      }
    });
    expect(flags.has('SC')).toBe(true);
    expect(flags.has('CHEQUERED')).toBe(true);
    // Twelve laps in, the midfield is well adrift; behind the safety car it closes right up.
    expect(spreadBefore).toBeGreaterThan(14);
    expect(spreadUnderSc).toBeLessThan(spreadBefore - 3);
    const underSc = log.pitStops.filter((p) => p.flag === 'SC' && p.queueTime === 0);
    expect(underSc.length).toBeGreaterThan(0);
    for (const stop of underSc) expect(stop.timeLost).toBeLessThan(pitLossUnderFlag(track, 'GREEN') - 4);
    expect(log.events.some((e) => e.message.includes('SAFETY CAR IN THIS LAP'))).toBe(true);
    expect(log.engine.isFinished).toBe(true);
  });

  it('suspends the race under a red flag and restarts it from the grid', () => {
    const phases = new Set<string>();
    const log = race(config({ raceLaps: 12, seed: 8 }), (engine, send) => {
      const t = Math.round(engine.clock);
      phases.add(engine.currentPhase);
      if (t === 300) send({ type: 'RACE_CONTROL', action: 'RED_FLAG' });
    });
    expect(phases.has('SUSPENDED')).toBe(true);
    expect(log.events.some((e) => e.message.includes('STANDING RESTART'))).toBe(true);
    expect(log.engine.isFinished).toBe(true);
    expect(log.classification![0]!.lapsCompleted).toBe(12);
  });

  it('wets the track when it rains, disables DRS and sends the field onto wet-weather tyres', () => {
    let maxWetness = 0;
    let drsWhileWet = false;
    const log = race(config({ raceLaps: 18, seed: 13 }), (engine, send) => {
      const t = Math.round(engine.clock);
      if (t === 250) send({ type: 'RACE_CONTROL', action: 'RAIN_SHOWER' });
      const snapshot = engine.snapshot(1, false);
      maxWetness = Math.max(maxWetness, snapshot.weather.trackWetness);
      if (snapshot.weather.trackWetness > 0.3 && snapshot.raceControl.drsEnabled) drsWhileWet = true;
    });
    expect(maxWetness).toBeGreaterThan(0.35);
    expect(drsWhileWet).toBe(false);
    expect(log.pitStops.some((p) => p.toCompound === 'INTER' && p.reason === 'WEATHER')).toBe(true);
    expect(log.events.some((e) => e.type === 'WEATHER')).toBe(true);
    // The user's engineer makes the weather call himself when nobody answers the radio.
    const mine = log.pitStops.filter((p) => log.engine.session.playerCarIds.includes(p.carId) && p.toCompound === 'INTER');
    expect(mine.length).toBeGreaterThan(0);
  });

  it('builds a projection request for the user cars with the requested candidates', () => {
    let checked = false;
    race(config({ raceLaps: 20 }), (engine) => {
      if (Math.round(engine.clock) !== 500 || checked) return;
      checked = true;
      const carId = engine.session.playerCarIds[0];
      const request = engine.buildProjectionRequest(carId, 'HARD', [1, 3, 5], 50);
      expect(request).not.toBeNull();
      expect(request!.cars).toHaveLength(20);
      expect(request!.candidates.map((c) => c.id)).toEqual(expect.arrayContaining(['T+1', 'T+3', 'T+5']));
      const lap = request!.cars.find((c) => c.id === carId)!.lapsCompleted + 1;
      expect(request!.candidates.find((c) => c.id === 'T+3')!.pitLap).toBe(lap + 3);
      for (const car of request!.cars) expect(car.nextLineCrossingTime).toBeGreaterThan(request!.raceTime);
      expect(request!.cars.find((c) => c.id === carId)!.plannedStops).not.toBeNull();
      expect(request!.cars.find((c) => !engine.session.playerCarIds.includes(c.id))!.plannedStops).toBeNull();
    }, 700);
    expect(checked).toBe(true);
  });
});
