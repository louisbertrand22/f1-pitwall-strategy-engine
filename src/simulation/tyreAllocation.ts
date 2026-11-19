/**
 * Race-day tyre allocation: what is left of the weekend's sets on Sunday. Front-runners used their
 * softs in qualifying; cars that missed Q3 kept a new set. Some teams saved two hards, others two mediums.
 */
import { COMPOUNDS, wearPerLap } from './physicsModel';
import type { RandomSource, TrackDefinition, TyreCompound, TyreSet } from './types';

function makeSet(track: TrackDefinition, compound: TyreCompound, index: number, usedLaps: number): TyreSet {
  const wear = usedLaps > 0 ? usedLaps * wearPerLap({ track, compound, fuelKg: 20, paceMode: 'PUSH' }) : 0;
  return {
    id: `${COMPOUNDS[compound].letter}${index}`,
    compound,
    laps: usedLaps,
    wear,
    isNew: usedLaps === 0,
    fitted: false,
  };
}

export function buildTyreAllocation(track: TrackDefinition, gridPosition: number, rng: RandomSource): TyreSet[] {
  const sets: TyreSet[] = [];
  const savedTwoHards = rng.chance(0.55);

  // Softs: two qualifying sets, plus a fresh one for those who did not reach Q3.
  let s = 1;
  if (gridPosition > 10) sets.push(makeSet(track, 'SOFT', s++, 0));
  sets.push(makeSet(track, 'SOFT', s++, rng.int(2, 3)));
  sets.push(makeSet(track, 'SOFT', s++, rng.int(3, 5)));

  // Mediums.
  sets.push(makeSet(track, 'MEDIUM', 1, 0));
  if (savedTwoHards) sets.push(makeSet(track, 'MEDIUM', 2, rng.int(2, 4)));
  else sets.push(makeSet(track, 'MEDIUM', 2, 0));

  // Hards.
  sets.push(makeSet(track, 'HARD', 1, 0));
  if (savedTwoHards) sets.push(makeSet(track, 'HARD', 2, 0));

  // Wet-weather tyres.
  sets.push(makeSet(track, 'INTER', 1, 0));
  sets.push(makeSet(track, 'INTER', 2, 0));
  sets.push(makeSet(track, 'INTER', 3, 0));
  sets.push(makeSet(track, 'WET', 1, 0));
  sets.push(makeSet(track, 'WET', 2, 0));
  return sets;
}
