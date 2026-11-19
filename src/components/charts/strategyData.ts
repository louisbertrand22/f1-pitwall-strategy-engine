/** Pure helpers of the undercut/overcut simulator: candidate identity, stop sequences, plan adoption. */
import type {
  CandidateProjection,
  CarStrategy,
  PlannedStop,
  StintPlan,
  TyreCompound,
} from '../../simulation/types';

/** Offsets (laps from now) of the candidate stops requested from the predictive engine. */
export const CANDIDATE_OFFSETS: readonly number[] = [1, 3, 5];

const FIXED_SLOTS: Record<string, number> = { 'T+1': 0, 'T+3': 1, 'T+5': 2 };
/** The categorical palette has eight validated slots; anything beyond shares the last one. */
const MAX_SLOT = 7;

/**
 * Series slot (0-based) of every candidate. T+1 / T+3 / T+5 always own slots 0–2; any other candidate
 * (PLAN, STAY OUT…) takes the following slots in alphabetical order of its id. The slot depends on the id
 * only, so a colour never moves when candidates appear, disappear or are dimmed.
 */
export function candidateSlots(ids: readonly string[]): Map<string, number> {
  const slots = new Map<string, number>();
  const others: string[] = [];
  for (const id of ids) {
    const fixed = FIXED_SLOTS[id];
    if (fixed !== undefined) slots.set(id, fixed);
    else if (!others.includes(id)) others.push(id);
  }
  others.sort();
  others.forEach((id, index) => slots.set(id, Math.min(MAX_SLOT, 3 + index)));
  return slots;
}

/** Compound fitted at the candidate stop: the candidate's own, else read from its stop list or its trace. */
export function resolveCandidateCompound(projection: CandidateProjection): TyreCompound | null {
  const { candidate } = projection;
  if (candidate.compound !== null) return candidate.compound;
  if (candidate.pitLap === null) return null;
  const pitLap = candidate.pitLap;
  const listed = projection.stops.find((stop) => stop.lap === pitLap);
  if (listed) return listed.compound;
  const after = projection.trace.find((point) => point.lap > pitLap);
  return after ? after.compound : null;
}

/** Complete remaining stop sequence of a candidate: its own stop first, then the stops assumed after it. */
export function candidateStopSequence(projection: CandidateProjection): PlannedStop[] {
  const pitLap = projection.candidate.pitLap;
  const later = projection.stops
    .filter((stop) => pitLap === null || stop.lap > pitLap)
    .sort((a, b) => a.lap - b.lap);
  if (pitLap === null) return later;
  const compound = resolveCandidateCompound(projection);
  return compound === null ? later : [{ lap: pitLap, compound }, ...later];
}

export interface AdoptInput {
  strategy: CarStrategy;
  /** Index of the stint being run = number of pit stops already made. */
  stintIndex: number;
  /** Compound currently fitted. */
  currentCompound: TyreCompound;
  /**
   * Stints actually completed so far (from the pit-stop history). They take precedence over the plan's
   * own past stints, so an adopted plan always tells the truth about what has been run.
   */
  completedStints: readonly StintPlan[];
  candidate: CandidateProjection;
  raceLaps: number;
}

/**
 * Rewrites the ACTIVE plan so that its next stop is the candidate: the current stint ends on the
 * candidate's pit lap, the next stint runs the candidate compound, later stints follow the candidate's
 * assumed stops and the last stint ends at the flag. The other plans are left untouched.
 */
export function buildAdoptedStrategy(input: AdoptInput): CarStrategy {
  const { strategy, stintIndex, currentCompound, completedStints, candidate, raceLaps } = input;
  const plan = strategy.plans[strategy.activePlan];

  const past: StintPlan[] = [];
  for (let i = 0; i < stintIndex; i++) {
    const actual = completedStints[i];
    const planned = plan.stints[i];
    past.push(actual ? { ...actual } : planned ? { ...planned } : { compound: currentCompound, endLap: 0 });
  }
  const lastPastLap = past.length > 0 ? past[past.length - 1]!.endLap : 0;

  // A stop on the last lap or outside the race is not a stop; laps must strictly increase.
  const stops: PlannedStop[] = [];
  let previousLap = lastPastLap;
  for (const stop of candidateStopSequence(candidate)) {
    if (stop.lap <= previousLap || stop.lap >= raceLaps) continue;
    stops.push(stop);
    previousLap = stop.lap;
  }

  const first = stops[0];
  const stints: StintPlan[] = [...past, { compound: currentCompound, endLap: first ? first.lap : raceLaps }];
  stops.forEach((stop, index) => {
    const next = stops[index + 1];
    stints.push({ compound: stop.compound, endLap: next ? next.lap : raceLaps });
  });

  return {
    ...strategy,
    plans: { ...strategy.plans, [strategy.activePlan]: { ...plan, stints } },
  };
}

/** True when the car's next planned stop already is the candidate (or "no further stop" for a stay-out). */
export function isCandidateAdopted(nextPlannedStop: PlannedStop | null, projection: CandidateProjection): boolean {
  const pitLap = projection.candidate.pitLap;
  if (pitLap === null) return nextPlannedStop === null;
  if (nextPlannedStop === null) return false;
  return nextPlannedStop.lap === pitLap && nextPlannedStop.compound === resolveCandidateCompound(projection);
}
