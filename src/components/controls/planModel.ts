/**
 * Pure editing model of a stint plan (Plan A / B / C) for the strategy planner.
 *
 * A plan is an ordered list of stints; stint k covers the laps `end(k-1) + 1 … end(k)` and its `endLap`
 * is the in-lap of stop k + 1. "Boundary i" is the stop between stint i and stint i + 1, i.e. the
 * `endLap` of stint i. Every function returns a new array and never mutates its input.
 */
import { COMPOUNDS } from '../../simulation/physicsModel';
import type { PlannedStop, StintPlan, TyreCompound, TyreSet } from '../../simulation/types';

/** Shortest stint the editor lets the user build (laps). */
export const MIN_STINT_LAPS = 2;
/** Most stints a plan may hold (three stops). */
export const MAX_STINTS = 4;

/** Preference order when the editor has to pick a compound itself (splitting a stint). */
const SPLIT_PREFERENCE: readonly TyreCompound[] = ['MEDIUM', 'HARD', 'SOFT', 'INTER', 'WET'];

/**
 * What the race has already consumed of a plan.
 *  - `live: false` (pre-race): nothing is locked.
 *  - `live: true`: stints before `currentStint` are history, stint `currentStint` is on the car (its
 *    compound is fixed, its end can still move) and no stop can be planned before `nowLap`.
 */
export interface PlanLock {
  live: boolean;
  /** Index of the stint the car is running = number of pit stops made. */
  currentStint: number;
  /** Lap the car is on (1-based). */
  nowLap: number;
}

export const NO_LOCK: PlanLock = { live: false, currentStint: 0, nowLap: 0 };

export type CompoundCounts = Record<TyreCompound, number>;

function emptyCounts(): CompoundCounts {
  return { SOFT: 0, MEDIUM: 0, HARD: 0, INTER: 0, WET: 0 };
}

/** Compact signature of a plan, e.g. "M18-H50". Two plans are equal iff their keys are. */
export function stintsKey(stints: readonly StintPlan[]): string {
  return stints.map((s) => `${COMPOUNDS[s.compound].letter}${s.endLap}`).join('-');
}

export function sameStints(a: readonly StintPlan[], b: readonly StintPlan[]): boolean {
  return a === b || stintsKey(a) === stintsKey(b);
}

/** First lap of stint `index`. */
export function stintStartLap(stints: readonly StintPlan[], index: number): number {
  const previous = index > 0 ? stints[index - 1] : undefined;
  return previous ? previous.endLap + 1 : 1;
}

/** Last lap of stint `index`; the final stint always runs to the flag. */
export function stintEndLap(stints: readonly StintPlan[], index: number, raceLaps: number): number {
  const stint = stints[index];
  if (!stint || index >= stints.length - 1) return raceLaps;
  return stint.endLap;
}

export function stintLapCount(stints: readonly StintPlan[], index: number, raceLaps: number): number {
  return stintEndLap(stints, index, raceLaps) - stintStartLap(stints, index) + 1;
}

// ───────────────────────────────────────────────────────────── boundaries ──

export interface BoundaryRange {
  /** Earliest / latest in-lap this stop may be moved to. */
  min: number;
  max: number;
  /** The stop cannot be moved at all (history, or no room on either side). */
  locked: boolean;
}

/** Laps the stop between stint `index` and stint `index + 1` may be moved to. */
export function boundaryRange(
  stints: readonly StintPlan[],
  index: number,
  raceLaps: number,
  lock: PlanLock = NO_LOCK,
): BoundaryRange {
  const stint = stints[index];
  if (!stint || index >= stints.length - 1) return { min: 0, max: 0, locked: true };
  const previousEnd = index > 0 ? stintEndLap(stints, index - 1, raceLaps) : 0;
  const nextEnd = stintEndLap(stints, index + 1, raceLaps);
  let min = previousEnd + MIN_STINT_LAPS;
  const max = nextEnd - MIN_STINT_LAPS;
  let locked = false;
  if (lock.live) {
    // History: stops already made, and stops whose lap has gone by without being made.
    if (index < lock.currentStint || stint.endLap < lock.nowLap) locked = true;
    min = Math.max(min, lock.nowLap);
  }
  if (min > max) locked = true;
  return { min, max, locked };
}

/** Moves stop `index` to the end of `lap` (snapped to a whole lap and clamped to its range). */
export function moveBoundary(
  stints: readonly StintPlan[],
  index: number,
  lap: number,
  raceLaps: number,
  lock: PlanLock = NO_LOCK,
): StintPlan[] {
  const range = boundaryRange(stints, index, raceLaps, lock);
  const copy = stints.map((s) => ({ ...s }));
  const target = copy[index];
  if (range.locked || !target || !Number.isFinite(lap)) return copy;
  target.endLap = Math.min(range.max, Math.max(range.min, Math.round(lap)));
  return copy;
}

// ─────────────────────────────────────────────────────────────── compounds ──

/** The compound of a stint can be chosen unless the stint is history or already on the car. */
export function canEditCompound(index: number, lock: PlanLock = NO_LOCK): boolean {
  return !lock.live || index > lock.currentStint;
}

export function setStintCompound(stints: readonly StintPlan[], index: number, compound: TyreCompound): StintPlan[] {
  return stints.map((s, i) => (i === index ? { ...s, compound } : { ...s }));
}

/** First stint that still needs a set from the pool: every stint pre-race, the future ones in the race. */
function firstOpenStint(lock: PlanLock): number {
  return lock.live ? lock.currentStint + 1 : 0;
}

/** Sets a plan can still draw on: the whole allocation pre-race, everything not bolted on in the race. */
export function setPool(sets: readonly TyreSet[], lock: PlanLock = NO_LOCK): CompoundCounts {
  const counts = emptyCounts();
  for (const set of sets) {
    if (lock.live && set.fitted) continue;
    counts[set.compound] += 1;
  }
  return counts;
}

/**
 * Sets of each compound still free for stint `index`, once the earlier stints of the same plan have
 * taken theirs.
 */
export function setsLeftForStint(
  sets: readonly TyreSet[],
  stints: readonly StintPlan[],
  index: number,
  lock: PlanLock = NO_LOCK,
): CompoundCounts {
  const counts = setPool(sets, lock);
  for (let i = firstOpenStint(lock); i < index && i < stints.length; i++) {
    const stint = stints[i];
    if (stint) counts[stint.compound] -= 1;
  }
  return counts;
}

/** Stints the allocation cannot serve, as planner issues ("No Soft set left for stint 3"). */
export function allocationIssues(sets: readonly TyreSet[], stints: readonly StintPlan[], lock: PlanLock = NO_LOCK): string[] {
  const counts = setPool(sets, lock);
  const issues: string[] = [];
  for (let i = firstOpenStint(lock); i < stints.length; i++) {
    const stint = stints[i];
    if (!stint) continue;
    if (counts[stint.compound] <= 0) issues.push(`No ${COMPOUNDS[stint.compound].label} set left for stint ${i + 1}`);
    counts[stint.compound] -= 1;
  }
  return issues;
}

// ──────────────────────────────────────────────────────── adding / removing ──

/** A stint can be removed when it is neither history nor on the car, and the plan keeps one stint. */
export function canRemoveStint(stints: readonly StintPlan[], index: number, lock: PlanLock = NO_LOCK): boolean {
  if (stints.length <= 1 || index < 0 || index >= stints.length) return false;
  return !lock.live || index > lock.currentStint;
}

/**
 * Removes stint `index` and the stop that led to it: the previous stint runs on to the removed stint's
 * end. Removing the first stint cancels the first stop instead (the second stint starts the race).
 */
export function removeStint(stints: readonly StintPlan[], index: number, raceLaps: number, lock: PlanLock = NO_LOCK): StintPlan[] {
  const copy = stints.map((s) => ({ ...s }));
  if (!canRemoveStint(stints, index, lock)) return copy;
  const removed = copy[index];
  const previous = index > 0 ? copy[index - 1] : undefined;
  if (removed && previous) previous.endLap = removed.endLap;
  copy.splice(index, 1);
  const last = copy[copy.length - 1];
  if (last) last.endLap = raceLaps;
  return copy;
}

interface SplitTarget {
  index: number;
  /** In-lap of the new stop. */
  lap: number;
  /** Laps of the stint still open to planning (what "longest" is measured on). */
  span: number;
}

function findSplit(stints: readonly StintPlan[], raceLaps: number, lock: PlanLock): SplitTarget | null {
  if (stints.length === 0 || stints.length >= MAX_STINTS) return null;
  let best: SplitTarget | null = null;
  for (let i = lock.live ? Math.max(0, lock.currentStint) : 0; i < stints.length; i++) {
    const start = stintStartLap(stints, i);
    const end = stintEndLap(stints, i, raceLaps);
    // Only the part of the running stint that is still ahead of the car can be re-cut.
    const from = lock.live ? Math.max(start, lock.nowLap) : start;
    const span = end - from + 1;
    const lowest = Math.max(from, start + MIN_STINT_LAPS - 1);
    const highest = end - MIN_STINT_LAPS;
    if (lowest > highest) continue;
    const lap = Math.min(highest, Math.max(lowest, from - 1 + Math.floor(span / 2)));
    if (!best || span > best.span) best = { index: i, lap, span };
  }
  return best;
}

export function canSplit(stints: readonly StintPlan[], raceLaps: number, lock: PlanLock = NO_LOCK): boolean {
  return findSplit(stints, raceLaps, lock) !== null;
}

/**
 * Adds a stop in the middle of the longest stint. The new (second) half keeps the compound when another
 * set of it is free, otherwise takes the first compound of the same family that still has one.
 * Returns null when the plan is full or no stint is long enough.
 */
export function splitLongestStint(
  stints: readonly StintPlan[],
  raceLaps: number,
  lock: PlanLock = NO_LOCK,
  sets: readonly TyreSet[] = [],
): StintPlan[] | null {
  const target = findSplit(stints, raceLaps, lock);
  if (!target) return null;
  const source = stints[target.index];
  if (!source) return null;

  // Sets still free once every open stint of the plan has taken its own.
  const free = setPool(sets, lock);
  for (let i = firstOpenStint(lock); i < stints.length; i++) {
    const stint = stints[i];
    if (stint) free[stint.compound] -= 1;
  }
  const family = COMPOUNDS[source.compound].tyreClass;
  const candidates = [source.compound, ...SPLIT_PREFERENCE.filter((c) => c !== source.compound)];
  const compound =
    candidates.find((c) => COMPOUNDS[c].tyreClass === family && free[c] > 0) ??
    candidates.find((c) => free[c] > 0) ??
    source.compound;

  const copy = stints.map((s) => ({ ...s }));
  const end = stintEndLap(stints, target.index, raceLaps);
  copy.splice(target.index, 1, { compound: source.compound, endLap: target.lap }, { compound, endLap: end });
  return copy;
}

// ─────────────────────────────────────────────────────── remaining picture ──

/** Stops of the plan that are still to be made. */
export function stopsRemaining(stints: readonly StintPlan[], lock: PlanLock = NO_LOCK): number {
  const done = lock.live ? lock.currentStint : 0;
  return Math.max(0, stints.length - 1 - done);
}

/** Next stop of the plan given what has already been run, or null when none is left. */
export function nextStop(stints: readonly StintPlan[], lock: PlanLock = NO_LOCK): PlannedStop | null {
  const index = lock.live ? lock.currentStint : 0;
  const current = stints[index];
  const following = stints[index + 1];
  if (!current || !following) return null;
  return { lap: current.endLap, compound: following.compound };
}
