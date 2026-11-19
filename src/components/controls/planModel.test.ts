import { describe, expect, it } from 'vitest';
import type { StintPlan, TyreCompound, TyreSet } from '../../simulation/types';
import {
  MAX_STINTS,
  MIN_STINT_LAPS,
  NO_LOCK,
  allocationIssues,
  boundaryRange,
  canEditCompound,
  canRemoveStint,
  canSplit,
  moveBoundary,
  nextStop,
  removeStint,
  sameStints,
  setStintCompound,
  setsLeftForStint,
  splitLongestStint,
  stintLapCount,
  stintStartLap,
  stintsKey,
  stopsRemaining,
} from './planModel';
import type { PlanLock } from './planModel';

const RACE_LAPS = 50;

function plan(...stints: [TyreCompound, number][]): StintPlan[] {
  return stints.map(([compound, endLap]) => ({ compound, endLap }));
}

function set(id: string, compound: TyreCompound, opts: Partial<TyreSet> = {}): TyreSet {
  return { id, compound, laps: 0, wear: 0, isNew: true, fitted: false, ...opts };
}

/** 2 HARD, 2 MEDIUM (M1 fitted), 2 SOFT, 2 INTER, 1 WET. */
const ALLOCATION: TyreSet[] = [
  set('H1', 'HARD'),
  set('H2', 'HARD'),
  set('M1', 'MEDIUM', { fitted: true }),
  set('M2', 'MEDIUM', { isNew: false, laps: 3, wear: 0.11 }),
  set('S1', 'SOFT', { isNew: false, laps: 2, wear: 0.13 }),
  set('S2', 'SOFT', { isNew: false, laps: 4, wear: 0.26 }),
  set('I1', 'INTER'),
  set('I2', 'INTER'),
  set('W1', 'WET'),
];

const live = (currentStint: number, nowLap: number): PlanLock => ({ live: true, currentStint, nowLap });

describe('stint geometry', () => {
  const stints = plan(['SOFT', 12], ['MEDIUM', 31], ['HARD', 50]);

  it('derives start laps and lap counts from the end laps', () => {
    expect(stintStartLap(stints, 0)).toBe(1);
    expect(stintStartLap(stints, 1)).toBe(13);
    expect(stintLapCount(stints, 0, RACE_LAPS)).toBe(12);
    expect(stintLapCount(stints, 1, RACE_LAPS)).toBe(19);
    expect(stintLapCount(stints, 2, RACE_LAPS)).toBe(19);
  });

  it('runs the final stint to the flag whatever its stored end lap', () => {
    expect(stintLapCount(plan(['MEDIUM', 20], ['HARD', 44]), 1, RACE_LAPS)).toBe(30);
  });

  it('keys plans by content', () => {
    expect(stintsKey(stints)).toBe('S12-M31-H50');
    expect(sameStints(stints, plan(['SOFT', 12], ['MEDIUM', 31], ['HARD', 50]))).toBe(true);
    expect(sameStints(stints, plan(['SOFT', 13], ['MEDIUM', 31], ['HARD', 50]))).toBe(false);
  });
});

describe('moving a stop', () => {
  const stints = plan(['SOFT', 12], ['MEDIUM', 31], ['HARD', 50]);

  it('keeps every stint at least the minimum length', () => {
    expect(boundaryRange(stints, 0, RACE_LAPS)).toEqual({ min: MIN_STINT_LAPS, max: 31 - MIN_STINT_LAPS, locked: false });
    expect(boundaryRange(stints, 1, RACE_LAPS)).toEqual({ min: 12 + MIN_STINT_LAPS, max: RACE_LAPS - MIN_STINT_LAPS, locked: false });
    expect(moveBoundary(stints, 0, 0, RACE_LAPS)[0]?.endLap).toBe(2);
    expect(moveBoundary(stints, 0, 45, RACE_LAPS)[0]?.endLap).toBe(29);
    expect(moveBoundary(stints, 1, 99, RACE_LAPS)[1]?.endLap).toBe(48);
  });

  it('snaps to whole laps and never mutates its input', () => {
    const moved = moveBoundary(stints, 0, 17.6, RACE_LAPS);
    expect(moved[0]?.endLap).toBe(18);
    expect(stints[0]?.endLap).toBe(12);
    expect(moved).not.toBe(stints);
  });

  it('has no boundary after the last stint', () => {
    expect(boundaryRange(stints, 2, RACE_LAPS).locked).toBe(true);
    expect(moveBoundary(stints, 2, 30, RACE_LAPS)).toEqual(stints);
  });

  it('locks stops that are history once the race is live', () => {
    // One stop made (lap 12), car on lap 20 of its second stint.
    const lock = live(1, 20);
    expect(boundaryRange(stints, 0, RACE_LAPS, lock).locked).toBe(true);
    expect(moveBoundary(stints, 0, 5, RACE_LAPS, lock)).toEqual(stints);
    const current = boundaryRange(stints, 1, RACE_LAPS, lock);
    expect(current).toEqual({ min: 20, max: 48, locked: false });
    // The running stint cannot be ended before the lap the car is on.
    expect(moveBoundary(stints, 1, 15, RACE_LAPS, lock)[1]?.endLap).toBe(20);
  });

  it('locks a planned stop whose lap has gone by', () => {
    // No stop made although lap 12 was planned; the car is on lap 15.
    expect(boundaryRange(stints, 0, RACE_LAPS, live(0, 15)).locked).toBe(true);
    // The following stop is still free, but not before the current lap.
    expect(boundaryRange(stints, 1, RACE_LAPS, live(0, 15))).toEqual({ min: 15, max: 48, locked: false });
  });

  it('locks a stop that has no room left', () => {
    const tight = plan(['SOFT', 46], ['MEDIUM', 48], ['HARD', 50]);
    expect(boundaryRange(tight, 1, RACE_LAPS).locked).toBe(false);
    expect(boundaryRange(tight, 1, RACE_LAPS)).toMatchObject({ min: 48, max: 48 });
    expect(boundaryRange(tight, 1, RACE_LAPS, live(1, 49)).locked).toBe(true);
  });
});

describe('compounds and the tyre allocation', () => {
  const stints = plan(['MEDIUM', 18], ['HARD', 34], ['HARD', 50]);

  it('counts the sets earlier stints of the plan already use (pre-race: the whole allocation)', () => {
    expect(setsLeftForStint(ALLOCATION, stints, 0)).toEqual({ SOFT: 2, MEDIUM: 2, HARD: 2, INTER: 2, WET: 1 });
    expect(setsLeftForStint(ALLOCATION, stints, 1)).toEqual({ SOFT: 2, MEDIUM: 1, HARD: 2, INTER: 2, WET: 1 });
    expect(setsLeftForStint(ALLOCATION, stints, 2)).toEqual({ SOFT: 2, MEDIUM: 1, HARD: 1, INTER: 2, WET: 1 });
  });

  it('ignores the fitted set and the stints already run once live', () => {
    const lock = live(0, 10);
    expect(setsLeftForStint(ALLOCATION, stints, 1, lock)).toEqual({ SOFT: 2, MEDIUM: 1, HARD: 2, INTER: 2, WET: 1 });
    expect(setsLeftForStint(ALLOCATION, stints, 2, lock)).toEqual({ SOFT: 2, MEDIUM: 1, HARD: 1, INTER: 2, WET: 1 });
  });

  it('reports stints the allocation cannot serve', () => {
    expect(allocationIssues(ALLOCATION, stints)).toEqual([]);
    const greedy = plan(['HARD', 15], ['HARD', 30], ['HARD', 50]);
    expect(allocationIssues(ALLOCATION, greedy)).toEqual(['No Hard set left for stint 3']);
    // Live with the medium bolted on: only one other medium set remains.
    const mediums = plan(['MEDIUM', 15], ['MEDIUM', 30], ['MEDIUM', 50]);
    expect(allocationIssues(ALLOCATION, mediums, live(0, 5))).toEqual(['No Medium set left for stint 3']);
  });

  it('only lets future stints change compound in the race', () => {
    expect(canEditCompound(0)).toBe(true);
    expect(canEditCompound(0, live(1, 20))).toBe(false);
    expect(canEditCompound(1, live(1, 20))).toBe(false);
    expect(canEditCompound(2, live(1, 20))).toBe(true);
    expect(setStintCompound(stints, 2, 'SOFT').map((s) => s.compound)).toEqual(['MEDIUM', 'HARD', 'SOFT']);
    expect(stints[2]?.compound).toBe('HARD');
  });
});

describe('adding and removing stops', () => {
  it('splits the longest stint in two halves', () => {
    const split = splitLongestStint(plan(['MEDIUM', 18], ['HARD', 50]), RACE_LAPS, NO_LOCK, ALLOCATION);
    expect(split).toEqual(plan(['MEDIUM', 18], ['HARD', 34], ['HARD', 50]));
  });

  it('falls back to another compound of the family when no set of the same one is free', () => {
    const split = splitLongestStint(plan(['HARD', 15], ['HARD', 50]), RACE_LAPS, NO_LOCK, ALLOCATION);
    expect(split).toEqual(plan(['HARD', 15], ['HARD', 32], ['MEDIUM', 50]));
  });

  it('stops at four stints and refuses stints too short to cut', () => {
    const full = plan(['SOFT', 10], ['MEDIUM', 25], ['HARD', 40], ['SOFT', 50]);
    expect(full).toHaveLength(MAX_STINTS);
    expect(canSplit(full, RACE_LAPS)).toBe(false);
    expect(splitLongestStint(full, RACE_LAPS, NO_LOCK, ALLOCATION)).toBeNull();
    expect(canSplit(plan(['SOFT', 3]), 3)).toBe(false);
    expect(canSplit(plan(['SOFT', 4]), 4)).toBe(true);
  });

  it('only cuts what is still ahead of the car when live', () => {
    // Car on lap 40 of a 1-stop plan: the first stint is history, the second has 11 laps left.
    const split = splitLongestStint(plan(['MEDIUM', 18], ['HARD', 50]), RACE_LAPS, live(1, 40), ALLOCATION);
    expect(split).toEqual(plan(['MEDIUM', 18], ['HARD', 44], ['HARD', 50]));
    // Too late to add a stop: fewer than two laps would remain on either side.
    expect(canSplit(plan(['MEDIUM', 18], ['HARD', 50]), RACE_LAPS, live(1, 49))).toBe(false);
  });

  it('removes a stint by letting the previous one run on', () => {
    const stints = plan(['SOFT', 12], ['MEDIUM', 31], ['HARD', 50]);
    expect(removeStint(stints, 1, RACE_LAPS)).toEqual(plan(['SOFT', 31], ['HARD', 50]));
    expect(removeStint(stints, 2, RACE_LAPS)).toEqual(plan(['SOFT', 12], ['MEDIUM', 50]));
    expect(removeStint(stints, 0, RACE_LAPS)).toEqual(plan(['MEDIUM', 31], ['HARD', 50]));
  });

  it('keeps one stint and protects history', () => {
    expect(canRemoveStint(plan(['HARD', 50]), 0)).toBe(false);
    expect(removeStint(plan(['HARD', 50]), 0, RACE_LAPS)).toEqual(plan(['HARD', 50]));
    const stints = plan(['SOFT', 12], ['MEDIUM', 31], ['HARD', 50]);
    expect(canRemoveStint(stints, 0, live(1, 20))).toBe(false);
    expect(canRemoveStint(stints, 1, live(1, 20))).toBe(false);
    expect(canRemoveStint(stints, 2, live(1, 20))).toBe(true);
  });
});

describe('remaining race picture', () => {
  const stints = plan(['SOFT', 12], ['MEDIUM', 31], ['HARD', 50]);

  it('counts the stops still to make', () => {
    expect(stopsRemaining(stints)).toBe(2);
    expect(stopsRemaining(stints, live(1, 20))).toBe(1);
    expect(stopsRemaining(stints, live(2, 40))).toBe(0);
    expect(stopsRemaining(stints, live(5, 45))).toBe(0);
  });

  it('gives the next stop of the plan', () => {
    expect(nextStop(stints)).toEqual({ lap: 12, compound: 'MEDIUM' });
    expect(nextStop(stints, live(1, 20))).toEqual({ lap: 31, compound: 'HARD' });
    expect(nextStop(stints, live(2, 40))).toBeNull();
  });
});
