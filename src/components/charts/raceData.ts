/**
 * Pure transformations of the append-only race history into chart-ready structures: per-lap flags,
 * stints, the classification at a given lap and the impact analysis of every pit stop.
 */
import type { CarId, FlagStatus, LapRecord, PitStopRecord, TyreCompound } from '../../simulation/types';

export type LapsByCar = Record<CarId, LapRecord[]>;

/** Cheap change signature of the lap history, used as a memo key (the arrays are append-only). */
export function countLapRecords(laps: LapsByCar): number {
  let total = 0;
  for (const id in laps) total += laps[id]?.length ?? 0;
  return total;
}

/** Signature of the pit-stop list: a record is re-sent once `positionAfter` is known. */
export function pitStopsSignature(stops: readonly PitStopRecord[]): number {
  let resolved = 0;
  for (const stop of stops) if (stop.positionAfter !== null) resolved++;
  return stops.length * 1000 + resolved;
}

/** Highest lap number completed by any car (0 before the first line crossing). */
export function latestLap(laps: LapsByCar): number {
  let latest = 0;
  for (const id in laps) {
    const records = laps[id];
    const last = records && records.length > 0 ? records[records.length - 1] : undefined;
    if (last && last.lap > latest) latest = last.lap;
  }
  return latest;
}

/** Record of lap `lap`. O(1) for the usual contiguous array, with a search fallback. */
export function recordAt(records: readonly LapRecord[] | undefined, lap: number): LapRecord | undefined {
  if (!records || lap < 1) return undefined;
  const guess = records[lap - 1];
  if (guess && guess.lap === lap) return guess;
  for (const record of records) if (record.lap === lap) return record;
  return undefined;
}

export function lastRecord(records: readonly LapRecord[] | undefined): LapRecord | undefined {
  return records && records.length > 0 ? records[records.length - 1] : undefined;
}

// ─────────────────────────────────────────────────────────────────── flags ──

const FLAG_SEVERITY: Record<FlagStatus, number> = { GREEN: 0, CHEQUERED: 0, YELLOW: 1, VSC: 2, SC: 3, RED: 4 };

export type NeutralFlag = 'YELLOW' | 'VSC' | 'SC' | 'RED';

export function isNeutralFlag(flag: FlagStatus): flag is NeutralFlag {
  return FLAG_SEVERITY[flag] > 0;
}

/**
 * Flag of each race lap (index = lap number, index 0 is unused). A race lap is the leader's lap, so the
 * flag comes from the first car across the line: a lapped car completing "lap 15" two minutes later
 * must not paint lap 15 with the safety car that came out on lap 16.
 */
export function raceLapFlags(laps: LapsByCar): FlagStatus[] {
  const flags: FlagStatus[] = ['GREEN'];
  const firstAcross: number[] = [0];
  for (const id in laps) {
    for (const record of laps[id] ?? []) {
      const known = firstAcross[record.lap];
      if (known === undefined || record.raceTime < known) {
        firstAcross[record.lap] = record.raceTime;
        flags[record.lap] = record.flag;
      }
    }
  }
  for (let lap = 0; lap < flags.length; lap++) if (flags[lap] === undefined) flags[lap] = 'GREEN';
  return flags;
}

export interface FlagSpan {
  flag: NeutralFlag;
  /** First and last lap of the period (inclusive). On a "laps completed" axis the span covers [fromLap − 1, toLap]. */
  fromLap: number;
  toLap: number;
}

/** Runs of consecutive laps under the same non-green flag. */
export function flagSpans(flags: readonly FlagStatus[]): FlagSpan[] {
  const spans: FlagSpan[] = [];
  let current: FlagSpan | null = null;
  for (let lap = 1; lap < flags.length; lap++) {
    const flag = flags[lap] ?? 'GREEN';
    if (isNeutralFlag(flag)) {
      if (current && current.flag === flag && current.toLap === lap - 1) {
        current.toLap = lap;
      } else {
        current = { flag, fromLap: lap, toLap: lap };
        spans.push(current);
      }
    } else {
      current = null;
    }
  }
  return spans;
}

// ────────────────────────────────────────────────────────────────── stints ──

export interface Stint {
  carId: CarId;
  /** 0-based stint number. */
  index: number;
  compound: TyreCompound;
  startLap: number;
  endLap: number;
  laps: number;
  /** Tyre age at the end of the stint, laps done before the race on a used set included. */
  endAge: number;
  /** The stint ended with a pit stop (false for the stint still being run and for a retirement). */
  endedByPit: boolean;
}

/** Splits a car's lap records into stints (pit stops, plus tyre changes without a stop under a red flag). */
export function carStints(records: readonly LapRecord[]): Stint[] {
  const stints: Stint[] = [];
  let current: Stint | null = null;
  let previous: LapRecord | null = null;
  for (const record of records) {
    const changed: boolean =
      previous !== null &&
      (previous.pitIn || record.compound !== previous.compound || record.tyreAge < previous.tyreAge);
    if (current === null || changed) {
      if (current && previous) current.endedByPit = previous.pitIn;
      current = {
        carId: record.carId,
        index: stints.length,
        compound: record.compound,
        startLap: record.lap,
        endLap: record.lap,
        laps: 1,
        endAge: record.tyreAge,
        endedByPit: false,
      };
      stints.push(current);
    } else {
      current.endLap = record.lap;
      current.laps = current.endLap - current.startLap + 1;
      current.endAge = record.tyreAge;
    }
    previous = record;
  }
  if (current && previous) current.endedByPit = previous.pitIn;
  return stints;
}

// ────────────────────────────────────────────────────────── classification ──

/**
 * GRID: before the start · ON_LAP: has completed the lap · BEHIND: still running but has not completed
 * it yet (lapped, or the lap is in progress) · OUT: retired before it.
 */
export type ClassificationState = 'GRID' | 'ON_LAP' | 'BEHIND' | 'OUT';

export interface ClassificationRow {
  carId: CarId;
  /** 1-based row order. */
  rank: number;
  state: ClassificationState;
  /** Record of the lap, or the car's last record before it; null on the grid. */
  record: LapRecord | null;
  /** Places gained (+) or lost (−) since the previous lap (since the grid on lap 1). */
  delta: number | null;
  compound: TyreCompound | null;
  tyreAge: number | null;
}

/** Running order at the end of lap `lap` (lap 0 = the starting grid). */
export function classificationAtLap(
  grid: readonly CarId[],
  laps: LapsByCar,
  lap: number,
  retired: ReadonlySet<CarId>,
): ClassificationRow[] {
  const gridPosition = new Map<CarId, number>();
  grid.forEach((id, index) => gridPosition.set(id, index + 1));
  const ids: CarId[] = [...grid];
  for (const id in laps) if (!gridPosition.has(id)) ids.push(id);

  if (lap <= 0) {
    return ids.map((carId, index) => {
      const first = laps[carId]?.[0];
      return {
        carId,
        rank: index + 1,
        state: 'GRID' as const,
        record: null,
        delta: null,
        compound: first ? first.compound : null,
        // Scrubbed sets start the race with laps already on them.
        tyreAge: first ? Math.max(0, first.tyreAge - 1) : null,
      };
    });
  }

  interface Entry {
    carId: CarId;
    state: ClassificationState;
    record: LapRecord | null;
    order: number;
    delta: number | null;
  }
  const entries: Entry[] = ids.map((carId) => {
    const records = laps[carId];
    const at = recordAt(records, lap);
    if (at) {
      const before = lap === 1 ? gridPosition.get(carId) : recordAt(records, lap - 1)?.position;
      return { carId, state: 'ON_LAP', record: at, order: at.position, delta: before === undefined ? null : before - at.position };
    }
    let last: LapRecord | null = null;
    for (const record of records ?? []) if (record.lap < lap) last = record;
    const out = retired.has(carId);
    // Cars that have not completed the lap rank behind those that have, by laps done then by position.
    const lapsShort = lap - (last ? last.lap : 0);
    const position = last ? last.position : (gridPosition.get(carId) ?? ids.length);
    return { carId, state: out ? 'OUT' : 'BEHIND', record: last, order: (out ? 100000 : 1000) + lapsShort * 100 + position, delta: null };
  });
  entries.sort((a, b) => a.order - b.order);
  return entries.map((entry, index) => ({
    carId: entry.carId,
    rank: index + 1,
    state: entry.state,
    record: entry.record,
    delta: entry.delta,
    compound: entry.record ? entry.record.compound : null,
    tyreAge: entry.record ? entry.record.tyreAge : null,
  }));
}

// ─────────────────────────────────────────────────────── pit-stop impact ──

export type RivalRelation = 'AHEAD' | 'BEHIND';

/** Who stopped first in the pit cycle, seen from the analysed car. */
export type StopOrder = 'FIRST' | 'SAME_LAP' | 'LATER';

export type VerdictOutcome =
  /** Rival was ahead, we stopped first and came out ahead once it had stopped. */
  | 'UNDERCUT'
  /** Rival was ahead, we stayed out longer and came out ahead. */
  | 'OVERCUT'
  /** Rival was ahead, both stopped on the same lap and we left the pits ahead. */
  | 'JUMPED'
  /** Rival was ahead and still is. */
  | 'NO_GAIN'
  /** Rival was behind and still is. */
  | 'HELD'
  /** Rival was behind, stopped first and came out ahead of us. */
  | 'LOST_UNDERCUT'
  /** Rival was behind, stayed out longer and came out ahead of us. */
  | 'LOST_OVERCUT'
  /** Rival was behind, both stopped on the same lap and it left the pits ahead. */
  | 'LOST'
  /** The rival has not made its stop of this cycle yet, or the laps needed are not completed. */
  | 'PENDING'
  /** We stopped again before the rival answered: this stop was never part of a cycle with it. */
  | 'NO_RESPONSE'
  /** The rival never stopped again; judged on the order at the flag. */
  | 'NO_RIVAL_STOP'
  /** One of the two cars retired before the cycle was complete. */
  | 'RETIRED';

export interface RivalVerdict {
  rivalId: CarId;
  /** Where the rival was relative to us before the pit cycle. */
  relation: RivalRelation;
  /** In-lap of the rival's stop paired with ours, if any. */
  rivalStopLap: number | null;
  order: StopOrder | null;
  /** Lap at whose end the two cars are compared (the lap after the later in-lap). */
  evalLap: number | null;
  /** True when we are ahead of the rival at `evalLap`; null while unknown. */
  aheadAfter: boolean | null;
  /** Gap to the rival at `evalLap` (s): positive when we are ahead. */
  gapAfter: number | null;
  outcome: VerdictOutcome;
}

export interface PitStopImpact {
  stop: PitStopRecord;
  /** 1-based number of the stop for this car. */
  stopNumber: number;
  /** Lap at which the net position is read: `netHorizon` laps after the in-lap, or the car's latest lap. */
  netLap: number | null;
  netPosition: number | null;
  /** Places gained (+) or lost (−) between `positionBefore` and `netPosition`. */
  netDelta: number | null;
  /** True when `netLap` is the full horizon (false = latest lap available, still provisional). */
  netSettled: boolean;
  ahead: RivalVerdict | null;
  behind: RivalVerdict | null;
}

export interface PitImpactOptions {
  /** Laps after the in-lap at which the net position is read (default 5). */
  netHorizon?: number;
  /** Laps before our stop in which a neighbour that stopped first still counts as the same cycle (default 5). */
  cycleWindow?: number;
  /** The race is over: unanswered stops are judged on the final order. */
  raceOver?: boolean;
  retired?: ReadonlySet<CarId>;
}

/**
 * Impact of every pit stop: net position a few laps later and, against the cars that were directly ahead
 * and behind before the pit cycle, who came out ahead once both had stopped.
 *
 * Pairing rule for a rival: a neighbour that stopped within `cycleWindow` laps before us while it was
 * directly ahead/behind is the cycle's opponent (it tried the undercut, we answer with the overcut).
 * Otherwise the opponent is the car directly ahead/behind on the lap before our stop, paired with its
 * next stop – or with its previous one when it has already stopped more often than we have.
 */
export function analysePitStops(
  stops: readonly PitStopRecord[],
  laps: LapsByCar,
  grid: readonly CarId[],
  options: PitImpactOptions = {},
): PitStopImpact[] {
  const netHorizon = options.netHorizon ?? 5;
  const cycleWindow = options.cycleWindow ?? 5;
  const retired = options.retired ?? new Set<CarId>();
  const raceOver = options.raceOver ?? false;

  const gridPosition = new Map<CarId, number>();
  grid.forEach((id, index) => gridPosition.set(id, index + 1));
  const carIds = new Set<CarId>(grid);
  for (const id in laps) carIds.add(id);

  const stopsByCar = new Map<CarId, PitStopRecord[]>();
  for (const stop of stops) {
    const list = stopsByCar.get(stop.carId);
    if (list) list.push(stop);
    else stopsByCar.set(stop.carId, [stop]);
  }
  for (const list of stopsByCar.values()) list.sort((a, b) => a.lap - b.lap);

  const positionAt = (carId: CarId, lap: number): number | null => {
    if (lap <= 0) return gridPosition.get(carId) ?? null;
    return recordAt(laps[carId], lap)?.position ?? null;
  };
  const carAtPosition = (lap: number, position: number, except: CarId): CarId | null => {
    if (position < 1) return null;
    for (const id of carIds) if (id !== except && positionAt(id, lap) === position) return id;
    return null;
  };
  const lastLapOf = (carId: CarId): number => lastRecord(laps[carId])?.lap ?? 0;

  const judge = (
    me: CarId,
    rivalId: CarId,
    relation: RivalRelation,
    order: StopOrder | null,
    rivalStopLap: number | null,
    evalLap: number | null,
    fallback: VerdictOutcome,
  ): RivalVerdict => {
    const base: RivalVerdict = { rivalId, relation, rivalStopLap, order, evalLap, aheadAfter: null, gapAfter: null, outcome: fallback };
    if (evalLap === null) return base;
    const mine = recordAt(laps[me], evalLap);
    const theirs = recordAt(laps[rivalId], evalLap);
    if (!mine || !theirs) {
      const meOut = !mine && retired.has(me) && lastLapOf(me) < evalLap;
      const rivalOut = !theirs && retired.has(rivalId) && lastLapOf(rivalId) < evalLap;
      return { ...base, outcome: meOut || rivalOut ? 'RETIRED' : 'PENDING' };
    }
    const aheadAfter = mine.position < theirs.position;
    const gapAfter = theirs.gapToLeader - mine.gapToLeader;
    let outcome: VerdictOutcome;
    if (order === null) outcome = 'NO_RIVAL_STOP';
    else if (relation === 'AHEAD') {
      outcome = !aheadAfter ? 'NO_GAIN' : order === 'FIRST' ? 'UNDERCUT' : order === 'LATER' ? 'OVERCUT' : 'JUMPED';
    } else {
      outcome = aheadAfter ? 'HELD' : order === 'FIRST' ? 'LOST_OVERCUT' : order === 'LATER' ? 'LOST_UNDERCUT' : 'LOST';
    }
    return { ...base, aheadAfter, gapAfter, outcome };
  };

  const verdictFor = (
    stop: PitStopRecord,
    stopNumber: number,
    previousOwnStopLap: number,
    nextOwnStopLap: number | null,
    relation: RivalRelation,
  ): RivalVerdict | null => {
    const me = stop.carId;
    const offset = relation === 'AHEAD' ? -1 : 1;

    // 1. A neighbour that stopped first, within the cycle window (and since our own previous stop),
    //    while it was directly ahead/behind.
    const windowStart = Math.max(1, stop.lap - cycleWindow, previousOwnStopLap + 1);
    for (let lap = stop.lap - 1; lap >= windowStart; lap--) {
      const myPosition = positionAt(me, lap - 1);
      if (myPosition === null) continue;
      const neighbour = carAtPosition(lap - 1, myPosition + offset, me);
      if (neighbour === null) continue;
      const stopped = stopsByCar.get(neighbour)?.some((s) => s.lap === lap) ?? false;
      if (stopped) return judge(me, neighbour, relation, 'LATER', lap, stop.lap + 1, 'PENDING');
    }

    // 2. The car directly ahead/behind on the lap before our stop.
    const reference = stop.lap - 1;
    const myPosition = positionAt(me, reference) ?? stop.positionBefore;
    const rivalId = carAtPosition(reference, myPosition + offset, me);
    if (rivalId === null) return null;
    const rivalStops = stopsByCar.get(rivalId) ?? [];
    const before = rivalStops.filter((s) => s.lap < stop.lap);
    if (before.length >= stopNumber) {
      // The rival has already made this cycle's stop.
      const paired = before[before.length - 1]!;
      return judge(me, rivalId, relation, 'LATER', paired.lap, stop.lap + 1, 'PENDING');
    }
    const next = rivalStops.find((s) => s.lap >= stop.lap);
    if (next) {
      if (nextOwnStopLap !== null && nextOwnStopLap < next.lap) {
        return { rivalId, relation, rivalStopLap: next.lap, order: null, evalLap: null, aheadAfter: null, gapAfter: null, outcome: 'NO_RESPONSE' };
      }
      return judge(me, rivalId, relation, next.lap === stop.lap ? 'SAME_LAP' : 'FIRST', next.lap, next.lap + 1, 'PENDING');
    }
    if (nextOwnStopLap !== null) {
      return { rivalId, relation, rivalStopLap: null, order: null, evalLap: null, aheadAfter: null, gapAfter: null, outcome: 'NO_RESPONSE' };
    }
    if (raceOver) {
      // No answer before the flag: compare on the last lap both cars completed.
      const finalLap = Math.min(lastLapOf(me), lastLapOf(rivalId));
      return judge(me, rivalId, relation, null, null, finalLap > stop.lap ? finalLap : null, 'NO_RIVAL_STOP');
    }
    return { rivalId, relation, rivalStopLap: null, order: null, evalLap: null, aheadAfter: null, gapAfter: null, outcome: 'PENDING' };
  };

  const impacts: PitStopImpact[] = [];
  for (const [carId, list] of stopsByCar) {
    list.forEach((stop, index) => {
      const stopNumber = index + 1;
      const nextOwn = list[index + 1];
      const nextOwnStopLap = nextOwn ? nextOwn.lap : null;
      const previousOwn = index > 0 ? list[index - 1] : undefined;
      const previousOwnStopLap = previousOwn ? previousOwn.lap : 0;

      const last = lastLapOf(carId);
      const target = stop.lap + netHorizon;
      const netLap = last > stop.lap ? Math.min(target, last) : null;
      const netPosition = netLap === null ? null : positionAt(carId, netLap);
      impacts.push({
        stop,
        stopNumber,
        netLap,
        netPosition,
        netDelta: netPosition === null ? null : stop.positionBefore - netPosition,
        netSettled: netLap !== null && netLap >= target,
        ahead: verdictFor(stop, stopNumber, previousOwnStopLap, nextOwnStopLap, 'AHEAD'),
        behind: verdictFor(stop, stopNumber, previousOwnStopLap, nextOwnStopLap, 'BEHIND'),
      });
    });
  }
  impacts.sort((a, b) => a.stop.lap - b.stop.lap || a.stop.raceTime - b.stop.raceTime);
  return impacts;
}
