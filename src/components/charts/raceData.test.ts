import { describe, expect, it } from 'vitest';
import type { CarId, FlagStatus, LapRecord, PitStopRecord, TyreCompound } from '../../simulation/types';
import {
  analysePitStops,
  carStints,
  classificationAtLap,
  countLapRecords,
  flagSpans,
  latestLap,
  raceLapFlags,
  recordAt,
} from './raceData';
import type { LapsByCar } from './raceData';

interface LapSpec {
  position: number;
  gap?: number;
  compound?: TyreCompound;
  tyreAge?: number;
  pitIn?: boolean;
  pitOut?: boolean;
  flag?: FlagStatus;
}

function lapRecord(carId: CarId, lap: number, spec: LapSpec): LapRecord {
  const gap = spec.gap ?? (spec.position - 1) * 2;
  return {
    carId,
    lap,
    lapTime: 90,
    sectors: [30, 30, 30],
    raceTime: lap * 90 + gap,
    position: spec.position,
    gapToLeader: gap,
    compound: spec.compound ?? 'MEDIUM',
    tyreAge: spec.tyreAge ?? lap,
    tyreWear: 0.1,
    fuelKg: 50,
    pitIn: spec.pitIn ?? false,
    pitOut: spec.pitOut ?? false,
    flag: spec.flag ?? 'GREEN',
    trackWetness: 0,
  };
}

/** Builds lap records from a per-lap list of running orders (first = leader). */
function fromOrders(orders: CarId[][], pitLaps: Record<CarId, number[]> = {}): LapsByCar {
  const laps: LapsByCar = {};
  orders.forEach((order, index) => {
    const lap = index + 1;
    order.forEach((carId, i) => {
      (laps[carId] ??= []).push(lapRecord(carId, lap, { position: i + 1, pitIn: pitLaps[carId]?.includes(lap) ?? false }));
    });
  });
  return laps;
}

function stop(carId: CarId, lap: number, positionBefore: number, positionAfter: number | null = null): PitStopRecord {
  return {
    carId,
    lap,
    raceTime: lap * 90,
    fromCompound: 'MEDIUM',
    toCompound: 'HARD',
    toSetId: 'H1',
    reason: 'PLANNED',
    stationaryTime: 2.4,
    queueTime: 0,
    timeLost: 21,
    flag: 'GREEN',
    positionBefore,
    positionAfter,
  };
}

function repeat<T>(value: T, times: number): T[] {
  return Array.from({ length: times }, () => value);
}

describe('history basics', () => {
  const laps = fromOrders([['A', 'B', 'C'], ['A', 'B', 'C'], ['B', 'A']]);

  it('counts records and finds the latest lap', () => {
    expect(countLapRecords(laps)).toBe(8);
    expect(latestLap(laps)).toBe(3);
    expect(latestLap({})).toBe(0);
  });

  it('finds a record by lap number, including in a non-contiguous array', () => {
    expect(recordAt(laps.A, 2)?.position).toBe(1);
    expect(recordAt(laps.C, 3)).toBeUndefined();
    expect(recordAt(laps.A, 0)).toBeUndefined();
    const sparse = [lapRecord('Z', 4, { position: 7 }), lapRecord('Z', 6, { position: 5 })];
    expect(recordAt(sparse, 6)?.position).toBe(5);
    expect(recordAt(sparse, 5)).toBeUndefined();
  });
});

describe('raceLapFlags / flagSpans', () => {
  it('takes the flag of each lap from the first car across the line', () => {
    const laps: LapsByCar = {
      A: [1, 2, 3, 4, 5].map((lap) => lapRecord('A', lap, { position: 1, gap: 0, flag: lap === 3 || lap === 4 ? 'SC' : 'GREEN' })),
      // A lapped car completes its lap 2 while the safety car is out: lap 2 must stay green.
      B: [1, 2, 3].map((lap) => lapRecord('B', lap, { position: 2, gap: 95, flag: lap === 2 ? 'SC' : 'GREEN' })),
    };
    const flags = raceLapFlags(laps);
    expect(flags).toEqual(['GREEN', 'GREEN', 'GREEN', 'SC', 'SC', 'GREEN']);
    expect(flagSpans(flags)).toEqual([{ flag: 'SC', fromLap: 3, toLap: 4 }]);
  });

  it('separates adjacent periods under different flags and ignores green/chequered laps', () => {
    const flags: FlagStatus[] = ['GREEN', 'YELLOW', 'VSC', 'VSC', 'SC', 'GREEN', 'RED', 'CHEQUERED'];
    expect(flagSpans(flags)).toEqual([
      { flag: 'YELLOW', fromLap: 1, toLap: 1 },
      { flag: 'VSC', fromLap: 2, toLap: 3 },
      { flag: 'SC', fromLap: 4, toLap: 4 },
      { flag: 'RED', fromLap: 6, toLap: 6 },
    ]);
  });
});

describe('carStints', () => {
  it('splits on pit stops and reports the open stint', () => {
    const records = [
      ...[1, 2, 3].map((lap) => lapRecord('A', lap, { position: 1, compound: 'SOFT', tyreAge: lap + 2, pitIn: lap === 3 })),
      ...[4, 5, 6, 7].map((lap) => lapRecord('A', lap, { position: 1, compound: 'HARD', tyreAge: lap - 3, pitOut: lap === 4, pitIn: lap === 7 })),
      ...[8, 9].map((lap) => lapRecord('A', lap, { position: 1, compound: 'HARD', tyreAge: lap - 7, pitOut: lap === 8 })),
    ];
    const stints = carStints(records);
    expect(stints.map((s) => [s.compound, s.startLap, s.endLap, s.laps, s.endedByPit])).toEqual([
      ['SOFT', 1, 3, 3, true],
      ['HARD', 4, 7, 4, true],
      ['HARD', 8, 9, 2, false],
    ]);
    expect(stints[0]?.endAge).toBe(5);
    expect(stints.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('splits on a tyre change made without a stop (red flag)', () => {
    const records = [
      lapRecord('A', 1, { position: 1, compound: 'MEDIUM', tyreAge: 1 }),
      lapRecord('A', 2, { position: 1, compound: 'MEDIUM', tyreAge: 2 }),
      lapRecord('A', 3, { position: 1, compound: 'INTER', tyreAge: 1 }),
    ];
    expect(carStints(records).map((s) => [s.compound, s.startLap, s.endLap, s.endedByPit])).toEqual([
      ['MEDIUM', 1, 2, false],
      ['INTER', 3, 3, false],
    ]);
    expect(carStints([])).toEqual([]);
  });
});

describe('classificationAtLap', () => {
  const grid = ['A', 'B', 'C', 'D'];
  const laps = fromOrders([
    ['B', 'A', 'C', 'D'],
    ['B', 'A', 'D', 'C'],
    ['A', 'B', 'D'], // C retires after lap 2
    ['A', 'B'], // D has not completed lap 4 yet
  ]);

  it('returns the grid on lap 0 with the starting tyres', () => {
    const rows = classificationAtLap(grid, laps, 0, new Set());
    expect(rows.map((r) => r.carId)).toEqual(grid);
    expect(rows.every((r) => r.state === 'GRID' && r.record === null)).toBe(true);
    expect(rows[0]?.compound).toBe('MEDIUM');
    expect(rows[0]?.tyreAge).toBe(0);
  });

  it('orders cars on the lap by position and computes the places gained', () => {
    const rows = classificationAtLap(grid, laps, 1, new Set());
    expect(rows.map((r) => r.carId)).toEqual(['B', 'A', 'C', 'D']);
    expect(rows.map((r) => r.delta)).toEqual([1, -1, 0, 0]);
    const lap2 = classificationAtLap(grid, laps, 2, new Set());
    expect(lap2.map((r) => [r.carId, r.delta])).toEqual([['B', 0], ['A', 0], ['D', 1], ['C', -1]]);
  });

  it('ranks cars still on the previous lap behind, and retired cars last', () => {
    const rows = classificationAtLap(grid, laps, 4, new Set(['C']));
    expect(rows.map((r) => [r.carId, r.state, r.rank])).toEqual([
      ['A', 'ON_LAP', 1],
      ['B', 'ON_LAP', 2],
      ['D', 'BEHIND', 3],
      ['C', 'OUT', 4],
    ]);
    expect(rows[2]?.record?.lap).toBe(3);
    expect(rows[3]?.record?.lap).toBe(2);
  });
});

describe('analysePitStops', () => {
  const grid = ['A', 'B', 'C'];

  it('judges an undercut from both sides', () => {
    // B leads A and C. A stops on lap 10, C on 11, B on 12; A comes out ahead of B.
    const laps = fromOrders(
      [
        ...repeat(['B', 'A', 'C'], 10),
        ['B', 'C', 'A'], // lap 11: A on its out-lap
        ['B', 'A', 'C'], // lap 12: C on its out-lap, B's in-lap
        ['A', 'B', 'C'], // lap 13: B rejoins behind A
        ...repeat(['A', 'B', 'C'], 5),
      ],
      { A: [10], C: [11], B: [12] },
    );
    const impacts = analysePitStops([stop('A', 10, 2, 3), stop('C', 11, 2, 3), stop('B', 12, 1, 2)], laps, grid);
    expect(impacts.map((i) => i.stop.carId)).toEqual(['A', 'C', 'B']);

    const a = impacts[0]!;
    expect(a.stopNumber).toBe(1);
    expect(a.ahead).toMatchObject({ rivalId: 'B', relation: 'AHEAD', order: 'FIRST', rivalStopLap: 12, evalLap: 13, aheadAfter: true, outcome: 'UNDERCUT' });
    expect(a.ahead?.gapAfter).toBeCloseTo(2);
    expect(a.behind).toMatchObject({ rivalId: 'C', relation: 'BEHIND', order: 'FIRST', rivalStopLap: 11, evalLap: 12, aheadAfter: true, outcome: 'HELD' });
    expect(a).toMatchObject({ netLap: 15, netPosition: 1, netDelta: 1, netSettled: true });

    const b = impacts[2]!;
    // A was directly behind B and stopped first: from B's side this is an undercut suffered.
    expect(b.behind).toMatchObject({ rivalId: 'A', relation: 'BEHIND', order: 'LATER', rivalStopLap: 10, evalLap: 13, aheadAfter: false, outcome: 'LOST_UNDERCUT' });
    expect(b.ahead).toBeNull();
    expect(b).toMatchObject({ netLap: 17, netPosition: 2, netDelta: -1, netSettled: true });
  });

  it('judges an overcut and a same-lap stop', () => {
    // B (ahead) stops on lap 5; A stays out to lap 8 and rejoins ahead: overcut.
    const overcut = fromOrders(
      [...repeat(['B', 'A', 'C'], 5), ['A', 'C', 'B'], ['A', 'C', 'B'], ['A', 'C', 'B'], ['C', 'A', 'B'], ['C', 'A', 'B']],
      { B: [5], A: [8] },
    );
    const [first, second] = analysePitStops([stop('B', 5, 1, 3), stop('A', 8, 1, 2)], overcut, grid);
    expect(second?.stop.carId).toBe('A');
    expect(second?.ahead).toMatchObject({ rivalId: 'B', order: 'LATER', rivalStopLap: 5, evalLap: 9, outcome: 'OVERCUT' });
    expect(first?.behind).toMatchObject({ rivalId: 'A', order: 'FIRST', rivalStopLap: 8, evalLap: 9, aheadAfter: false, outcome: 'LOST_OVERCUT' });

    // Both stop on lap 4 (safety car): A leaves the pits ahead of B.
    const sameLap = fromOrders([...repeat(['B', 'A', 'C'], 4), ['C', 'A', 'B'], ['C', 'A', 'B']], { A: [4], B: [4] });
    const impacts = analysePitStops([stop('B', 4, 1, 3), stop('A', 4, 2, 2)], sameLap, grid);
    const a = impacts.find((i) => i.stop.carId === 'A');
    const b = impacts.find((i) => i.stop.carId === 'B');
    expect(a?.ahead).toMatchObject({ rivalId: 'B', order: 'SAME_LAP', evalLap: 5, outcome: 'JUMPED' });
    expect(b?.behind).toMatchObject({ rivalId: 'A', order: 'SAME_LAP', outcome: 'LOST' });
  });

  it('keeps a verdict pending until the rival stops, then judges on the flag if it never does', () => {
    const laps = fromOrders([...repeat(['B', 'A', 'C'], 6), ...repeat(['B', 'C', 'A'], 4)], { A: [6] });
    const live = analysePitStops([stop('A', 6, 2, 3)], laps, grid);
    expect(live[0]?.ahead).toMatchObject({ rivalId: 'B', outcome: 'PENDING', aheadAfter: null, evalLap: null });
    expect(live[0]).toMatchObject({ netLap: 10, netPosition: 3, netDelta: -1, netSettled: false });

    const final = analysePitStops([stop('A', 6, 2, 3)], laps, grid, { raceOver: true });
    expect(final[0]?.ahead).toMatchObject({ rivalId: 'B', outcome: 'NO_RIVAL_STOP', aheadAfter: false, evalLap: 10 });
    expect(final[0]?.behind).toMatchObject({ rivalId: 'C', outcome: 'NO_RIVAL_STOP', aheadAfter: false });
  });

  it('reports a stop the rival never answered before our next one, and waits for unfinished laps', () => {
    // A stops on laps 3 and 7; B (ahead) only stops on lap 9.
    const laps = fromOrders([...repeat(['B', 'A', 'C'], 3), ...repeat(['B', 'C', 'A'], 4), ...repeat(['B', 'C', 'A'], 2)], { A: [3, 7], B: [9] });
    const impacts = analysePitStops([stop('A', 3, 2, 3), stop('A', 7, 3, 3), stop('B', 9, 1, 2)], laps, grid);
    expect(impacts[0]?.ahead).toMatchObject({ rivalId: 'B', outcome: 'NO_RESPONSE', rivalStopLap: 9 });
    // Second stop: C is directly ahead and has not stopped; B is not the neighbour any more.
    expect(impacts[1]?.ahead).toMatchObject({ rivalId: 'C', outcome: 'PENDING' });
    expect(impacts[1]?.stopNumber).toBe(2);
    // B's own stop: the lap after it is not completed yet.
    expect(impacts[2]?.behind).toMatchObject({ rivalId: 'C', outcome: 'PENDING' });
    expect(impacts[2]).toMatchObject({ netLap: null, netPosition: null, netDelta: null, netSettled: false });

    // With a wider cycle window, A's stop on lap 3 from directly behind B is still B's opponent.
    const wide = analysePitStops([stop('A', 3, 2, 3), stop('A', 7, 3, 3), stop('B', 9, 1, 2)], laps, grid, { cycleWindow: 6 });
    expect(wide[2]?.behind).toMatchObject({ rivalId: 'A', order: 'LATER', rivalStopLap: 3, evalLap: 10, outcome: 'PENDING' });
  });

  it('flags a cycle interrupted by a retirement', () => {
    const laps = fromOrders([...repeat(['B', 'A', 'C'], 4), ['B', 'C', 'A'], ['C', 'A'], ['C', 'A']], { A: [4], B: [5] });
    const impacts = analysePitStops([stop('A', 4, 2, 3), stop('B', 5, 1, null)], laps, grid, { retired: new Set(['B']) });
    expect(impacts[0]?.ahead).toMatchObject({ rivalId: 'B', rivalStopLap: 5, evalLap: 6, outcome: 'RETIRED' });
  });

  it('uses the grid as the reference for a stop at the end of lap 1', () => {
    const laps = fromOrders([['A', 'B', 'C'], ['A', 'C', 'B'], ['A', 'C', 'B']], { B: [1] });
    const impacts = analysePitStops([stop('B', 1, 2, 3)], laps, grid);
    expect(impacts[0]?.ahead?.rivalId).toBe('A');
    expect(impacts[0]?.behind?.rivalId).toBe('C');
  });
});
