/**
 * Deliberately simple strategist used as a test double for the race engine: one planned stop, reacts to
 * the weather and to worn-out tyres. The real pit-wall AI lives in ../aiStrategist.ts.
 */
import { bestTyreClass, COMPOUNDS } from '../physicsModel';
import type { CarStrategy, RacePlan, RacePlanInput, StrategyContext, StrategyDecision, TyreCompound, TyreSet } from '../types';

function pick(sets: readonly TyreSet[], compound: TyreCompound): TyreSet | null {
  let best: TyreSet | null = null;
  for (const s of sets) if (s.compound === compound && !s.fitted && (!best || s.wear < best.wear)) best = s;
  return best;
}

export function planRace(input: RacePlanInput): RacePlan {
  const wet = bestTyreClass(input.weather.trackWetness);
  const start: TyreCompound = wet === 'SLICK' ? (input.gridPosition % 3 === 0 ? 'HARD' : 'MEDIUM') : wet === 'INTER' ? 'INTER' : 'WET';
  const set = pick(input.sets, start) ?? input.sets[0]!;
  const stopLap = Math.round(input.raceLaps * (start === 'HARD' ? 0.55 : 0.42)) + input.rng.int(-2, 2);
  return { startSetId: set.id, stops: [{ lap: stopLap, compound: start === 'HARD' ? 'MEDIUM' : 'HARD' }], expectedRaceTime: 0 };
}

export function buildDefaultPlans(input: RacePlanInput): CarStrategy {
  const L = input.raceLaps;
  return {
    activePlan: 'A',
    autoBox: true,
    plans: {
      A: { id: 'A', label: '1-STOP M→H', stints: [{ compound: 'MEDIUM', endLap: Math.round(L * 0.42) }, { compound: 'HARD', endLap: L }] },
      B: { id: 'B', label: '2-STOP M→M→S', stints: [{ compound: 'MEDIUM', endLap: Math.round(L * 0.3) }, { compound: 'MEDIUM', endLap: Math.round(L * 0.65) }, { compound: 'SOFT', endLap: L }] },
      C: { id: 'C', label: '1-STOP H→M', stints: [{ compound: 'HARD', endLap: Math.round(L * 0.58) }, { compound: 'MEDIUM', endLap: L }] },
    },
  };
}

export function decideStrategy(ctx: StrategyContext): StrategyDecision {
  const plan = ctx.plan.slice();
  const stay: StrategyDecision = { box: null, paceMode: ctx.fuelMarginLaps < 0 ? 'CONSERVE' : 'BALANCED', ersMode: 'BALANCED', plan, rationale: 'Stay out' };
  if (ctx.car.status !== 'RACING' || ctx.raceLaps - ctx.lap < 2) return stay;
  const wanted = bestTyreClass(ctx.weather.trackWetness);
  const own = COMPOUNDS[ctx.car.compound].tyreClass;
  if (wanted !== own) {
    const compound: TyreCompound = wanted === 'WET' ? 'WET' : wanted === 'INTER' ? 'INTER' : 'MEDIUM';
    const set = pick(ctx.availableSets, compound) ?? pick(ctx.availableSets, 'HARD') ?? pick(ctx.availableSets, 'SOFT');
    if (set) return { ...stay, box: { setId: set.id, reason: 'WEATHER' }, rationale: `Crossover to ${compound}` };
  }
  const next = plan[0];
  const due = next && (next.lap <= ctx.lap || ((ctx.flag === 'SC' || ctx.flag === 'VSC') && next.lap - ctx.lap < 10));
  if (next && due) {
    const set = pick(ctx.availableSets, next.compound) ?? pick(ctx.availableSets, 'MEDIUM') ?? pick(ctx.availableSets, 'HARD');
    if (set) return { ...stay, box: { setId: set.id, reason: next.lap <= ctx.lap ? 'PLANNED' : 'SAFETY_CAR' }, plan: plan.slice(1), paceMode: 'PUSH', rationale: 'Planned stop' };
  }
  if (ctx.car.tyreWear > 1.1) {
    const set = pick(ctx.availableSets, 'MEDIUM') ?? pick(ctx.availableSets, 'HARD') ?? pick(ctx.availableSets, 'SOFT');
    if (set) return { ...stay, box: { setId: set.id, reason: 'TYRE_WEAR' }, rationale: 'Tyres gone' };
  }
  return stay;
}
