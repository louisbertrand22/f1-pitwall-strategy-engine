/**
 * Pit-wall AI: the strategist of the nine rival teams, and the adviser that speaks in the user's ear.
 *
 * Three layers, all pure functions of their inputs (no hidden state, every random draw comes from the
 * seeded source passed in):
 *
 *  1. `optimiseStrategy` – exhaustive search of the remaining stop sequence (0 to 3 stops, any available
 *     compound) on top of cached stint-cost tables built from the lap-time physics. The objective is the
 *     clean-air race time plus a track-position penalty per stop that grows with how hard the circuit is
 *     to overtake on.
 *  2. `planRace` / `buildDefaultPlans` – pre-race plans: the rival teams commit to one (with some
 *     personality), the user gets three to choose from and edit.
 *  3. `decideStrategy` – the in-race call, once per lap before pit entry and on every flag change:
 *     emergency wear → weather crossover → neutralisation → planned stop → undercut → cover → tyre
 *     management, plus the pace and ERS modes for the lap.
 */
import {
  CLIFF_WEAR,
  COMPOUNDS,
  LIFT_AND_COAST_SAVING,
  WEATHER_CROSSOVER,
  bestTyreClass,
  clamp,
  compoundPaceDelta,
  fuelBurnPerLap,
  fuelPenalty,
  isSlick,
  lapScale,
  lapTime,
  meanWarmupPenaltyOverLap,
  pitLossUnderFlag,
  readinessAfter,
  startingFuelKg,
  tyreDegradation,
  warmupTimeConstant,
  wearPerLap,
  wetnessPenalty,
} from './physicsModel';
import type {
  CarStrategy,
  ErsMode,
  PaceMode,
  PitReason,
  PlanId,
  PlannedStop,
  RacePlan,
  RacePlanInput,
  StintPlan,
  StrategicCarView,
  StrategyContext,
  StrategyDecision,
  StrategyPlan,
  TrackDefinition,
  TyreClass,
  TyreCompound,
  TyreSet,
  WeatherForecastPoint,
} from './types';

// ─────────────────────────────────────────────────────────── set selection ──

/** Best available (not fitted) set of a compound: least wear, new before used. Null if none. */
export function pickSet(sets: readonly TyreSet[], compound: TyreCompound): TyreSet | null {
  let best: TyreSet | null = null;
  for (const set of sets) {
    if (set.compound !== compound || set.fitted) continue;
    if (!best || set.wear < best.wear || (set.wear === best.wear && set.isNew && !best.isNew)) best = set;
  }
  return best;
}

// ────────────────────────────────────────────────────────── stint cost model ──

const COMPOUND_ORDER: readonly TyreCompound[] = ['SOFT', 'MEDIUM', 'HARD', 'INTER', 'WET'];
const DRY: readonly TyreCompound[] = ['SOFT', 'MEDIUM', 'HARD'];
const WET_WEATHER: readonly TyreCompound[] = ['INTER', 'WET'];
const WEAR_BUCKET = 0.05;
/** Sets worn beyond this are not considered worth fitting by the optimiser. */
const MAX_USABLE_WEAR = 0.65;

interface CostModel {
  track: TrackDefinition;
  raceLaps: number;
  scale: number;
  wetness: number;
  wearFactor: number;
  /** Nominal fuel on board at the start of lap L (index L). */
  fuelAt: Float64Array;
  /** `${compound}:${wearBucket}` → cum[startLap][k] = cost of the first k laps of a fresh-from-the-pits stint. */
  tables: Map<string, Float64Array[]>;
}

const models = new Map<string, CostModel>();

function costModel(track: TrackDefinition, raceLaps: number, wetness: number, wearFactor: number): CostModel {
  const wet = Math.round(clamp(wetness, 0, 1) * 20) / 20;
  const wf = Math.round(clamp(wearFactor, 0.7, 1.4) * 20) / 20;
  const key = `${track.id}|${track.baseLapTime}|${track.abrasiveness}|${track.tyreStress}|${raceLaps}|${wet}|${wf}`;
  let model = models.get(key);
  if (!model) {
    if (models.size > 96) models.clear();
    const fuelAt = new Float64Array(raceLaps + 3);
    const start = startingFuelKg(track, raceLaps);
    const burn = fuelBurnPerLap(track);
    for (let lap = 0; lap < fuelAt.length; lap++) fuelAt[lap] = Math.max(0, start - Math.max(0, lap - 1) * burn);
    model = { track, raceLaps, scale: lapScale(track), wetness: wet, wearFactor: wf, fuelAt, tables: new Map() };
    models.set(key, model);
  }
  return model;
}

/** Strategy-dependent part of a lap time: everything that changes with the tyre fitted. */
function tyreLapCost(model: CostModel, compound: TyreCompound, wear: number): number {
  return (
    compoundPaceDelta(model.track, compound) +
    (tyreDegradation(compound, wear) + wetnessPenalty(compound, model.wetness)) * model.scale
  );
}

function stintTable(model: CostModel, compound: TyreCompound, wearBucket: number): Float64Array[] {
  const key = `${compound}:${wearBucket}`;
  let table = model.tables.get(key);
  if (table) return table;
  const R = model.raceLaps;
  const tau = warmupTimeConstant(compound, model.track.trackTempC, model.wetness);
  table = new Array<Float64Array>(R + 2);
  table[0] = new Float64Array(1);
  for (let start = 1; start <= R + 1; start++) {
    const laps = R - start + 1;
    const cum = new Float64Array(Math.max(1, laps + 1));
    let wear = wearBucket;
    let readiness = COMPOUNDS[compound].blanketReadiness;
    let cost = 0;
    for (let k = 1; k <= laps; k++) {
      const lap = start + k - 1;
      const rate = wearPerLap({
        track: model.track,
        compound,
        fuelKg: model.fuelAt[lap]!,
        wearFactor: model.wearFactor,
        trackWetness: model.wetness,
      });
      cost += tyreLapCost(model, compound, wear + rate / 2);
      if (readiness < 0.995) {
        cost += meanWarmupPenaltyOverLap(compound, readiness, tau) * model.scale;
        readiness = readinessAfter(readiness, 1, tau, 1);
      }
      wear += rate;
      cum[k] = cost;
    }
    table[start] = cum;
  }
  model.tables.set(key, table);
  return table;
}

// ─────────────────────────────────────────────────────────────── optimiser ──

export interface OptimiserInput {
  track: TrackDefinition;
  raceLaps: number;
  /** First lap still to be run (1-based). The current stint continues from here on `compound` with `tyreWear`. */
  fromLap: number;
  compound: TyreCompound;
  tyreWear: number;
  fuelKg: number;
  paceOffset: number;
  wearFactor: number;
  /** Sets that can still be fitted (used sets start with their wear). */
  availableSets: readonly TyreSet[];
  compoundsUsed: readonly TyreCompound[];
  mustUseTwoCompounds: boolean;
  /** Expected track wetness over the horizon (0 for a dry plan). */
  trackWetness: number;
  /** Pit loss charged per stop (s). */
  pitLoss: number;
  /** Loss of a stop made right now, i.e. at the end of lap `fromLap − 1` (defaults to `pitLoss`). */
  firstStopLoss?: number;
  /** Force the first stop at the end of this lap (`fromLap − 1` = stop now). */
  forcedFirstStopLap?: number;
  /** Compound fitted at the forced first stop. */
  forcedFirstCompound?: TyreCompound;
  /** Exclude an immediate stop (to price "stay out"). */
  disallowImmediateStop?: boolean;
  /** Allow a stop at the end of lap `fromLap − 1` without forcing it. */
  allowImmediateStop?: boolean;
  maxStops?: number;
}

export interface OptimisedStrategy {
  /** Remaining stops, earliest first. */
  stops: PlannedStop[];
  /** Clean-air time from `fromLap` to the flag, pit losses included (s). */
  totalTime: number;
  /** `totalTime` plus the track-position penalty used for ranking. */
  score: number;
}

/** Time a stop is worth in lost track position (s): traffic the car will not be able to clear. */
export function trackPositionPenalty(track: TrackDefinition): number {
  const d = clamp(track.overtakingDifficulty, 0, 1);
  return 2 + 22 * d * d * d;
}

interface Candidate {
  cost: number;
  stops: PlannedStop[];
}

const results = new Map<string, { strategies: { stops: PlannedStop[]; cost: number; score: number }[] }>();

function wearBucketOf(wear: number): number {
  return Math.round(clamp(wear, 0, 2) / WEAR_BUCKET) * WEAR_BUCKET;
}

/** Wear buckets of the usable sets of each compound, least worn first. */
function setBuckets(sets: readonly TyreSet[]): Record<TyreCompound, number[]> {
  const buckets: Record<TyreCompound, number[]> = { SOFT: [], MEDIUM: [], HARD: [], INTER: [], WET: [] };
  for (const set of sets) {
    if (set.fitted || set.wear > MAX_USABLE_WEAR) continue;
    buckets[set.compound].push(wearBucketOf(set.wear));
  }
  for (const compound of COMPOUND_ORDER) buckets[compound].sort((a, b) => a - b);
  return buckets;
}

/** Ranked list (best first) of the fastest distinct stop sequences from the given state to the flag. */
export function optimiseStrategy(input: OptimiserInput, limit = 6): OptimisedStrategy[] {
  const R = input.raceLaps;
  const first = Math.round(clamp(input.fromLap, 1, R + 1));
  const remaining = R - first + 1;
  const burn = fuelBurnPerLap(input.track);

  // Part of the race time that no strategy can change: base lap, car pace and the fuel being carried.
  let constant = 0;
  for (let lap = first; lap <= R; lap++) {
    constant += input.track.baseLapTime + input.paceOffset + fuelPenalty(input.track, input.fuelKg - (lap - first) * burn);
  }
  if (remaining <= 0) return [{ stops: [], totalTime: 0, score: 0 }];

  const model = costModel(input.track, R, input.trackWetness, input.wearFactor);
  const buckets = setBuckets(input.availableSets);
  const maxStops = Math.min(3, Math.max(0, input.maxStops ?? 3));
  const wetRace = model.wetness >= WEATHER_CROSSOVER.slickToInter;
  const allowed = (wetRace ? WET_WEATHER : DRY).filter((c) => buckets[c].length > 0);
  const lossNow = input.firstStopLoss ?? input.pitLoss;
  const forced = input.forcedFirstStopLap !== undefined ? Math.round(clamp(input.forcedFirstStopLap, first - 1, R - 1)) : null;
  const immediateAllowed = !input.disallowImmediateStop && (input.allowImmediateStop === true || forced === first - 1);

  const memoKey = [
    input.track.id, R, model.wetness, model.wearFactor, first, input.compound, wearBucketOf(input.tyreWear).toFixed(2),
    COMPOUND_ORDER.map((c) => buckets[c].map((b) => b.toFixed(2)).join(',')).join(';'),
    input.compoundsUsed.slice().sort().join(''), input.mustUseTwoCompounds ? 1 : 0, input.pitLoss.toFixed(1), lossNow.toFixed(1),
    forced ?? '-', input.forcedFirstCompound ?? '-', immediateAllowed ? 1 : 0, maxStops, limit, Math.round(input.fuelKg / 4),
  ].join('|');
  const cached = results.get(memoKey);
  if (cached) {
    return cached.strategies.map((s) => ({ stops: s.stops.map((x) => ({ ...x })), totalTime: s.cost + constant, score: s.score + constant }));
  }

  // Cost of staying on the current tyres for k more laps (already up to temperature).
  const current = new Float64Array(remaining + 1);
  {
    let wear = input.tyreWear;
    let cost = 0;
    for (let k = 1; k <= remaining; k++) {
      const lap = first + k - 1;
      const rate = wearPerLap({
        track: input.track,
        compound: input.compound,
        fuelKg: Math.max(0, input.fuelKg - (lap - first) * burn),
        wearFactor: model.wearFactor,
        trackWetness: model.wetness,
      });
      cost += tyreLapCost(model, input.compound, wear + rate / 2);
      wear += rate;
      current[k] = cost;
    }
  }

  const penalty = trackPositionPenalty(input.track);
  const usedDry = new Set<TyreCompound>(input.compoundsUsed.filter((c) => isSlick(c)));
  if (isSlick(input.compound)) usedDry.add(input.compound);
  const ruleVoid = !input.mustUseTwoCompounds || wetRace || !isSlick(input.compound) || input.compoundsUsed.some((c) => !isSlick(c));
  const satisfies = (a?: TyreCompound, b?: TyreCompound, c?: TyreCompound): boolean => {
    if (ruleVoid || usedDry.size >= 2) return true;
    const only = input.compound;
    return (a !== undefined && a !== only) || (b !== undefined && b !== only) || (c !== undefined && c !== only);
  };

  const best = new Map<string, Candidate>();
  const offer = (signature: string, cost: number, stops: () => PlannedStop[]): void => {
    const existing = best.get(signature);
    if (!existing || cost < existing.cost) best.set(signature, { cost, stops: stops() });
  };

  const tableOf = (compound: TyreCompound, use: number): Float64Array[] | null => {
    const bucket = buckets[compound][use];
    return bucket === undefined ? null : stintTable(model, compound, bucket);
  };
  const lossAt = (stopLap: number): number => (stopLap === first - 1 ? lossNow : input.pitLoss);
  const firstStops: number[] = [];
  if (forced !== null) firstStops.push(forced);
  else for (let s = immediateAllowed ? first - 1 : first; s <= R - 1; s++) firstStops.push(s);

  // No stop.
  if (forced === null && satisfies()) offer('0', current[remaining]!, () => []);

  if (maxStops >= 1 && allowed.length > 0) {
    for (const s1 of firstStops) {
      const head = current[s1 - first + 1]! + lossAt(s1);
      for (const c2 of allowed) {
        if (input.forcedFirstCompound && forced !== null && c2 !== input.forcedFirstCompound) continue;
        const t2 = tableOf(c2, 0);
        if (!t2) continue;
        const cum2 = t2[s1 + 1]!;
        // One stop.
        if (satisfies(c2)) {
          const cost = head + cum2[R - s1]!;
          offer(`1${c2}`, cost, () => [{ lap: s1, compound: c2 }]);
        }
        if (maxStops < 2 || R - s1 < 4) continue;
        for (const c3 of allowed) {
          const t3 = tableOf(c3, c3 === c2 ? 1 : 0);
          if (!t3) continue;
          const ok3 = satisfies(c2, c3);
          let bestCost = Infinity;
          let bestS2 = -1;
          for (let s2 = s1 + 2; s2 <= R - 1; s2++) {
            const cost = head + cum2[s2 - s1]! + input.pitLoss + t3[s2 + 1]![R - s2]!;
            if (cost < bestCost) {
              bestCost = cost;
              bestS2 = s2;
            }
          }
          if (ok3 && bestS2 > 0) {
            const s2 = bestS2;
            offer(`2${c2}${c3}`, bestCost, () => [
              { lap: s1, compound: c2 },
              { lap: s2, compound: c3 },
            ]);
          }
          // Three stops: only worth searching over a long distance, on a coarser grid.
          if (maxStops < 3 || R - s1 < 24) continue;
          for (const c4 of allowed) {
            const use4 = (c4 === c2 ? 1 : 0) + (c4 === c3 ? 1 : 0);
            const t4 = tableOf(c4, use4);
            if (!t4 || !satisfies(c2, c3, c4)) continue;
            let best3 = Infinity;
            let b2 = -1;
            let b3 = -1;
            for (let s2 = s1 + 4; s2 <= R - 8; s2 += 2) {
              const mid = head + cum2[s2 - s1]! + input.pitLoss;
              const cum3 = t3[s2 + 1]!;
              for (let s3 = s2 + 4; s3 <= R - 3; s3 += 2) {
                const cost = mid + cum3[s3 - s2]! + input.pitLoss + t4[s3 + 1]![R - s3]!;
                if (cost < best3) {
                  best3 = cost;
                  b2 = s2;
                  b3 = s3;
                }
              }
            }
            if (b2 > 0) {
              const s2 = b2;
              const s3 = b3;
              offer(`3${c2}${c3}${c4}`, best3, () => [
                { lap: s1, compound: c2 },
                { lap: s2, compound: c3 },
                { lap: s3, compound: c4 },
              ]);
            }
          }
        }
      }
    }
  }

  // Nothing legal (e.g. no set left to satisfy the two-compound rule): fall back to the least bad option.
  if (best.size === 0) {
    if (forced !== null && allowed.length > 0) {
      const c2 = input.forcedFirstCompound && allowed.includes(input.forcedFirstCompound) ? input.forcedFirstCompound : allowed[0]!;
      const t2 = tableOf(c2, 0);
      if (t2) offer(`1${c2}`, current[forced - first + 1]! + lossAt(forced) + t2[forced + 1]![R - forced]!, () => [{ lap: forced, compound: c2 }]);
    }
    if (best.size === 0) offer('0', current[remaining]!, () => []);
  }

  const ranked = [...best.values()]
    .map((c) => ({ stops: c.stops, cost: c.cost, score: c.cost + c.stops.length * penalty }))
    .sort((a, b) => a.score - b.score)
    .slice(0, Math.max(1, limit));
  if (results.size > 1500) results.clear();
  results.set(memoKey, { strategies: ranked });
  return ranked.map((s) => ({ stops: s.stops.map((x) => ({ ...x })), totalTime: s.cost + constant, score: s.score + constant }));
}

// ──────────────────────────────────────────────────────────── pre-race plans ──

interface StartOption {
  startCompound: TyreCompound;
  stops: PlannedStop[];
  totalTime: number;
  score: number;
}

/** Lap at which the forecast first takes the track across `threshold` (in the given direction), or null. */
function forecastCrossingLap(forecast: readonly WeatherForecastPoint[], threshold: number, direction: 'RISING' | 'FALLING'): number | null {
  for (const point of forecast) {
    if (direction === 'RISING' ? point.trackWetness >= threshold : point.trackWetness <= threshold) return point.lap;
  }
  return null;
}

/** Forecast track wetness `laps` laps from now (the first forecast point is "now"). */
function wetnessInLaps(forecast: readonly WeatherForecastPoint[], laps: number, fallback: number): number {
  const origin = forecast[0];
  if (!origin) return fallback;
  const target = origin.lap + laps;
  let previous = origin;
  for (const point of forecast) {
    if (point.lap >= target) {
      const span = point.lap - previous.lap;
      const t = span > 0 ? (target - previous.lap) / span : 0;
      return previous.trackWetness + (point.trackWetness - previous.trackWetness) * t;
    }
    previous = point;
  }
  return previous.trackWetness;
}

function wetCompoundFor(wetness: number): TyreCompound {
  return wetness >= WEATHER_CROSSOVER.interToWet ? 'WET' : 'INTER';
}

/** Every sensible way to start the race, each with its best continuation, best first. */
function startOptions(input: RacePlanInput): StartOption[] {
  const { track, raceLaps, sets } = input;
  const wetness = input.weather.trackWetness;
  const options: StartOption[] = [];
  const wetStart = wetness >= WEATHER_CROSSOVER.slickToInter;
  const pitLoss = pitLossUnderFlag(track, 'GREEN');

  if (!wetStart) {
    for (const compound of DRY) {
      const set = pickSet(sets, compound);
      if (!set) continue;
      const strategies = optimiseStrategy({
        track, raceLaps, fromLap: 1, compound, tyreWear: set.wear, fuelKg: input.startFuelKg, paceOffset: input.paceOffset,
        wearFactor: input.wearFactor, availableSets: sets.filter((s) => s.id !== set.id), compoundsUsed: [], mustUseTwoCompounds: true,
        trackWetness: 0, pitLoss, maxStops: 3,
      }, 4);
      for (const s of strategies) options.push({ startCompound: compound, stops: s.stops, totalTime: s.totalTime, score: s.score });
    }
  } else {
    // Wet start: begin on the tyre the track asks for; if the forecast dries, plan the switch to slicks.
    const dryLap = forecastCrossingLap(input.forecast, WEATHER_CROSSOVER.slickToInter - 0.03, 'FALLING');
    const candidates: TyreCompound[] = bestTyreClass(wetness) === 'WET' ? ['WET', 'INTER'] : ['INTER', 'WET'];
    for (const compound of candidates) {
      const set = pickSet(sets, compound);
      if (!set) continue;
      const others = sets.filter((s) => s.id !== set.id);
      if (dryLap !== null && dryLap < raceLaps - 3) {
        const switchLap = Math.round(clamp(dryLap, 2, raceLaps - 2));
        // The slick part of the race is planned as a dry race from the switch lap on.
        for (const slick of DRY) {
          const slickSet = pickSet(others, slick);
          if (!slickSet) continue;
          const tail = optimiseStrategy({
            track, raceLaps, fromLap: switchLap + 1, compound: slick, tyreWear: slickSet.wear,
            fuelKg: Math.max(0, input.startFuelKg - switchLap * fuelBurnPerLap(track)), paceOffset: input.paceOffset,
            wearFactor: input.wearFactor, availableSets: others.filter((s) => s.id !== slickSet.id), compoundsUsed: [compound],
            mustUseTwoCompounds: false, trackWetness: 0, pitLoss, maxStops: 2,
          }, 1)[0];
          if (!tail) continue;
          const opening = optimiseStrategy({
            track, raceLaps: switchLap, fromLap: 1, compound, tyreWear: set.wear, fuelKg: input.startFuelKg, paceOffset: input.paceOffset,
            wearFactor: input.wearFactor, availableSets: [], compoundsUsed: [], mustUseTwoCompounds: false, trackWetness: wetness, pitLoss, maxStops: 0,
          }, 1)[0];
          const openingTime = opening ? opening.totalTime : 0;
          options.push({
            startCompound: compound,
            stops: [{ lap: switchLap, compound: slick }, ...tail.stops],
            totalTime: openingTime + pitLoss + tail.totalTime,
            score: openingTime + pitLoss + tail.score + trackPositionPenalty(track),
          });
        }
      } else {
        const strategies = optimiseStrategy({
          track, raceLaps, fromLap: 1, compound, tyreWear: set.wear, fuelKg: input.startFuelKg, paceOffset: input.paceOffset,
          wearFactor: input.wearFactor, availableSets: others, compoundsUsed: [], mustUseTwoCompounds: false, trackWetness: wetness, pitLoss, maxStops: 2,
        }, 3);
        for (const s of strategies) options.push({ startCompound: compound, stops: s.stops, totalTime: s.totalTime, score: s.score });
      }
    }
  }

  if (options.length === 0) {
    // Degenerate allocation: start on whatever is there and run to the flag.
    const any = sets.find((s) => !s.fitted) ?? sets[0];
    if (any) options.push({ startCompound: any.compound, stops: [], totalTime: 0, score: 0 });
  }
  return options.sort((a, b) => a.score - b.score);
}

function signature(option: StartOption): string {
  return `${option.startCompound}>${option.stops.map((s) => s.compound).join('>')}`;
}

/** Pre-race plan of an AI car: starting set + stops. */
export function planRace(input: RacePlanInput): RacePlan {
  const options = startOptions(input);
  const best = options[0];
  if (!best) throw new Error(`planRace: car ${input.carId} has no tyre set`);
  const { aggression } = input.profile;

  // Front-runners take the fastest strategy; the further back, the more attractive an alternative becomes.
  let chosen = best;
  const tolerance = 5 + 9 * aggression;
  const alternatives = options.filter(
    (o) => o !== best && o.score - best.score <= tolerance && (o.startCompound !== best.startCompound || o.stops.length !== best.stops.length),
  );
  const gamble = input.gridPosition <= 6 ? 0.1 * aggression : input.gridPosition <= 12 ? 0.12 + 0.3 * aggression : 0.22 + 0.5 * aggression;
  if (alternatives.length > 0 && input.rng.chance(gamble)) {
    // Prefer the better alternatives without always taking the same one.
    const index = Math.min(alternatives.length - 1, Math.floor(input.rng.next() * input.rng.next() * alternatives.length));
    chosen = alternatives[index]!;
  }

  // A lap or two of spread so the field does not pit in unison.
  const stops: PlannedStop[] = [];
  let previous = 0;
  chosen.stops.forEach((stop, index) => {
    const jitter = input.rng.int(-1, 1) + (input.rng.chance(0.25) ? input.rng.int(-1, 1) : 0);
    const stopsAfter = chosen.stops.length - 1 - index;
    const lap = Math.round(clamp(stop.lap + jitter, previous + 2, input.raceLaps - 1 - 2 * stopsAfter));
    stops.push({ lap, compound: stop.compound });
    previous = lap;
  });

  const startSet = pickSet(input.sets, chosen.startCompound) ?? input.sets.find((s) => !s.fitted) ?? input.sets[0];
  if (!startSet) throw new Error(`planRace: car ${input.carId} has no tyre set`);
  return { startSetId: startSet.id, stops, expectedRaceTime: chosen.totalTime };
}

function describePlan(startCompound: TyreCompound, stops: readonly PlannedStop[]): string {
  const letters = [startCompound, ...stops.map((s) => s.compound)].map((c) => COMPOUNDS[c].letter).join('→');
  return `${stops.length}-STOP ${letters}`;
}

function toStints(option: StartOption, raceLaps: number): StintPlan[] {
  const stints: StintPlan[] = [];
  let compound = option.startCompound;
  for (const stop of option.stops) {
    stints.push({ compound, endLap: stop.lap });
    compound = stop.compound;
  }
  stints.push({ compound, endLap: raceLaps });
  return stints;
}

/** Plans A / B / C offered to the user before the start. */
export function buildDefaultPlans(input: RacePlanInput): CarStrategy {
  const options = startOptions(input);
  const best = options[0];
  if (!best) throw new Error(`buildDefaultPlans: car ${input.carId} has no tyre set`);

  // A: fastest. B: fastest with a different number of stops. C: fastest starting on another compound.
  const picked: StartOption[] = [best];
  const taken = new Set<string>([signature(best)]);
  const take = (predicate: (o: StartOption) => boolean): void => {
    const option = options.find((o) => !taken.has(signature(o)) && predicate(o));
    if (option) {
      picked.push(option);
      taken.add(signature(option));
    }
  };
  take((o) => o.stops.length !== best.stops.length);
  take((o) => o.startCompound !== best.startCompound);
  // Fill up with whatever distinct options remain, then with timing variants of the best plan.
  while (picked.length < 3 && options.some((o) => !taken.has(signature(o)))) take(() => true);
  let shift = 4;
  while (picked.length < 3) {
    const base = picked[0]!;
    const stops = base.stops.map((s, i) => ({ lap: Math.round(clamp(s.lap + shift, i + 2, input.raceLaps - 1 - (base.stops.length - 1 - i))), compound: s.compound }));
    picked.push({ ...base, stops });
    shift = -shift + (shift < 0 ? 2 : 0);
  }

  const ids: readonly PlanId[] = ['A', 'B', 'C'];
  const plans = {} as Record<PlanId, StrategyPlan>;
  ids.forEach((id, index) => {
    const option = picked[index]!;
    const stints = toStints(option, input.raceLaps);
    // Keep stints strictly ordered whatever the option contained.
    let previous = 0;
    stints.forEach((stint, i) => {
      const after = stints.length - 1 - i;
      stint.endLap = i === stints.length - 1 ? input.raceLaps : Math.round(clamp(stint.endLap, previous + 1, input.raceLaps - after));
      previous = stint.endLap;
    });
    plans[id] = { id, label: describePlan(option.startCompound, option.stops), stints };
  });
  return { activePlan: 'A', plans, autoBox: true };
}

// ───────────────────────────────────────────────────────── in-race decisions ──

const UNDERCUT_RANGE = 2.2;
/** Safety margin on an undercut: pit stop scatter and traffic on the out-lap (s). */
const UNDERCUT_MARGIN = 0.3;
const COVER_RANGE = 3;

function classOf(compound: TyreCompound): TyreClass {
  return COMPOUNDS[compound].tyreClass;
}

function availableWithout(sets: readonly TyreSet[], setId: string): TyreSet[] {
  return sets.filter((s) => s.id !== setId);
}

function fighting(car: StrategicCarView): { attacking: boolean; defending: boolean } {
  return {
    attacking: car.gapAhead !== null && car.gapAhead < 1.2,
    defending: car.gapBehind !== null && car.gapBehind < 0.8,
  };
}

function chooseModes(ctx: StrategyContext, boxing: boolean, nursing: boolean): { paceMode: PaceMode; ersMode: ErsMode } {
  const { car } = ctx;
  const neutral = ctx.flag === 'SC' || ctx.flag === 'VSC' || ctx.flag === 'RED';
  const { attacking, defending } = fighting(car);
  const inFight = attacking || defending;

  // Fuel: share of the remaining laps that must be driven in lift-and-coast to reach the flag.
  const lapsLeft = Math.max(1, ctx.raceLaps - ctx.lap);
  const shortfall = Math.max(0, -ctx.fuelMarginLaps);
  const duty = shortfall / (LIFT_AND_COAST_SAVING * Math.max(1, lapsLeft - 1));

  let paceMode: PaceMode = 'BALANCED';
  if (neutral) paceMode = 'CONSERVE';
  else if (duty >= 0.75) paceMode = 'CONSERVE';
  else if (boxing) paceMode = 'PUSH';
  // Save when it is cheap: out of a fight, once the opening laps are done.
  else if (duty > 0.12 && !inFight && ctx.lap > 5) paceMode = 'CONSERVE';
  else if (inFight && car.tyreWear < 0.88 && duty < 0.5) paceMode = 'PUSH';
  else if (nursing) paceMode = 'CONSERVE';

  let ersMode: ErsMode = 'BALANCED';
  const alone = (car.gapAhead === null || car.gapAhead > 3) && (car.gapBehind === null || car.gapBehind > 3);
  if (!neutral && inFight && ctx.ersCharge > 0.25) ersMode = 'OVERTAKE';
  else if (ctx.ersCharge < 0.35 || (alone && ctx.ersCharge < 0.9)) ersMode = 'HARVEST';
  return { paceMode, ersMode };
}

/** Wear added per lap by this car in its present state. */
function wearRate(ctx: StrategyContext): number {
  return wearPerLap({
    track: ctx.track,
    compound: ctx.car.compound,
    fuelKg: ctx.car.fuelKg,
    wearFactor: ctx.car.wearFactor,
    trackWetness: ctx.weather.trackWetness,
    trackTempC: ctx.weather.trackTempC,
  });
}

function baseOptimiserInput(ctx: StrategyContext, expectedWetness: number): OptimiserInput {
  const burn = fuelBurnPerLap(ctx.track);
  return {
    track: ctx.track,
    raceLaps: ctx.raceLaps,
    fromLap: ctx.lap + 1,
    compound: ctx.car.compound,
    tyreWear: ctx.car.tyreWear + wearRate(ctx) * (1 - ctx.car.lapProgress),
    fuelKg: Math.max(0, ctx.car.fuelKg - burn * (1 - ctx.car.lapProgress)),
    paceOffset: ctx.car.paceOffset,
    wearFactor: ctx.car.wearFactor,
    availableSets: ctx.availableSets,
    compoundsUsed: ctx.car.compoundsUsed,
    mustUseTwoCompounds: ctx.mustUseTwoCompounds,
    trackWetness: expectedWetness,
    pitLoss: pitLossUnderFlag(ctx.track, 'GREEN'),
    maxStops: ctx.raceLaps - ctx.lap > 34 ? 3 : 2,
  };
}

/** Best stop sequence after fitting `set` at the end of the current lap. */
function planAfterStop(ctx: StrategyContext, set: TyreSet, expectedWetness: number): PlannedStop[] {
  if (ctx.raceLaps - ctx.lap < 6) return [];
  const used = ctx.car.compoundsUsed.includes(ctx.car.compound) ? ctx.car.compoundsUsed : [...ctx.car.compoundsUsed, ctx.car.compound];
  const best = optimiseStrategy({
    ...baseOptimiserInput(ctx, expectedWetness),
    compound: set.compound,
    tyreWear: set.wear,
    availableSets: availableWithout(ctx.availableSets, set.id),
    compoundsUsed: used,
    maxStops: 2,
  }, 1)[0];
  return best ? best.stops : [];
}

/** Dry compound that gets the car to the flag in the least time from a stop now. */
function slickForTheRun(ctx: StrategyContext): TyreSet | null {
  const strategies = optimiseStrategy({
    ...baseOptimiserInput(ctx, 0),
    forcedFirstStopLap: ctx.lap,
    maxStops: 2,
  }, 3);
  for (const strategy of strategies) {
    const first = strategy.stops[0];
    if (!first) continue;
    const set = pickSet(ctx.availableSets, first.compound);
    if (set) return set;
  }
  return pickSet(ctx.availableSets, 'MEDIUM') ?? pickSet(ctx.availableSets, 'HARD') ?? pickSet(ctx.availableSets, 'SOFT');
}

/** Compound the weather calls for right now, or null when the tyres on the car are the right family. */
function weatherCall(ctx: StrategyContext): { compound: TyreCompound | 'SLICK'; why: string } | null {
  const now = ctx.weather.trackWetness;
  const soon = wetnessInLaps(ctx.forecast, 1.5, now);
  const later = wetnessInLaps(ctx.forecast, 3, now);
  // Gamblers hang on to the tyre they have a little longer in both directions.
  const lean = (ctx.profile.weatherRisk - 0.5) * 0.08;
  const own = classOf(ctx.car.compound);
  const { slickToInter, interToWet } = WEATHER_CROSSOVER;
  const percent = (w: number): string => `${Math.round(w * 100)}%`;

  if (own === 'SLICK') {
    const threshold = slickToInter + lean;
    const there = now >= threshold - 0.02 && soon >= threshold - 0.02;
    const arriving = now >= threshold - 0.09 && soon >= threshold + 0.04;
    if (there || arriving) {
      const compound: TyreCompound = Math.max(soon, later) >= interToWet + 0.02 ? 'WET' : 'INTER';
      return { compound, why: `track at ${percent(now)} and rising, crossover to ${compound === 'WET' ? 'full wets' : 'inters'}` };
    }
    return null;
  }
  if (own === 'INTER') {
    if (now >= interToWet + 0.03 + lean && soon >= interToWet + 0.02) return { compound: 'WET', why: `standing water at ${percent(now)}, full wets are faster` };
    const threshold = slickToInter - 0.03 + lean;
    if (now <= threshold && soon <= threshold) return { compound: 'SLICK', why: `track down to ${percent(now)} and drying, slicks are faster` };
    return null;
  }
  // Full wets.
  if (now <= slickToInter - 0.04 && soon <= slickToInter - 0.04) return { compound: 'SLICK', why: `track down to ${percent(now)}, straight to slicks` };
  const threshold = interToWet - 0.04 - lean;
  if (now <= threshold && soon <= threshold) return { compound: 'INTER', why: `water clearing at ${percent(now)}, inters are faster` };
  return null;
}

/** Cars that would be just ahead of us on track if we stopped now (traffic at pit exit). */
function trafficAtPitExit(ctx: StrategyContext): number {
  const mine = ctx.car.gapToLeader + ctx.pitLossNow;
  let count = 0;
  for (const other of ctx.field) {
    if (other.id === ctx.car.id || other.inPitLane) continue;
    const delta = mine - other.gapToLeader;
    if (delta > -0.3 && delta < 1.6) count += 1;
  }
  return count;
}

/** Pace of a rival on its current tyres next lap, in clean air. */
function rivalNextLap(ctx: StrategyContext, rival: StrategicCarView): number {
  const rate = wearPerLap({ track: ctx.track, compound: rival.compound, fuelKg: rival.fuelKg, wearFactor: rival.wearFactor, trackWetness: ctx.weather.trackWetness });
  return lapTime({
    track: ctx.track,
    compound: rival.compound,
    wear: rival.tyreWear + rate,
    fuelKg: rival.fuelKg,
    trackWetness: ctx.weather.trackWetness,
    paceOffset: rival.paceOffset,
    gripLevel: ctx.weather.gripLevel,
  });
}

/** Our lap times over the first two laps on a new set, warm-up included. */
function freshTyreLaps(ctx: StrategyContext, set: TyreSet): [number, number] {
  const wetness = ctx.weather.trackWetness;
  const tau = warmupTimeConstant(set.compound, ctx.weather.trackTempC, wetness);
  const scale = lapScale(ctx.track);
  const burn = fuelBurnPerLap(ctx.track);
  const rate = wearPerLap({ track: ctx.track, compound: set.compound, fuelKg: ctx.car.fuelKg, wearFactor: ctx.car.wearFactor, trackWetness: wetness });
  const blanket = COMPOUNDS[set.compound].blanketReadiness;
  const lap = (index: number): number =>
    lapTime({
      track: ctx.track,
      compound: set.compound,
      wear: set.wear + rate * (index + 0.5),
      fuelKg: Math.max(0, ctx.car.fuelKg - burn * (index + 1)),
      trackWetness: wetness,
      paceOffset: ctx.car.paceOffset,
      gripLevel: ctx.weather.gripLevel,
    }) + meanWarmupPenaltyOverLap(set.compound, readinessAfter(blanket, index, tau, 1), tau) * scale;
  return [lap(0), lap(1)];
}

/** In-race decision for one car. Pure function of the context: all state travels in `ctx.plan`. */
export function decideStrategy(ctx: StrategyContext): StrategyDecision {
  const { car, lap, raceLaps } = ctx;
  const lapsLeft = raceLaps - lap;
  let plan: PlannedStop[] = ctx.plan
    .filter((s) => s.lap < raceLaps)
    .map((s) => ({ lap: Math.max(s.lap, lap), compound: s.compound }))
    .sort((a, b) => a.lap - b.lap);

  const rate = wearRate(ctx);
  const lapsToCliff = rate > 0 ? Math.max(0, (CLIFF_WEAR - car.tyreWear) / rate) : Infinity;
  const next = plan[0];
  const nursing = next !== undefined && lapsToCliff < next.lap - lap && car.tyreWear < 1.05;

  const stay = (rationale: string): StrategyDecision => ({ box: null, ...chooseModes(ctx, false, nursing), plan, rationale });
  const box = (set: TyreSet, reason: PitReason, rationale: string, newPlan: PlannedStop[]): StrategyDecision => ({
    box: { setId: set.id, reason },
    ...chooseModes(ctx, true, false),
    plan: newPlan,
    rationale,
  });

  if (car.status !== 'RACING') return stay('Not on track');
  if (lapsLeft < 1) return stay('Last lap, bring it home');

  const justStopped = car.lastPitLap !== null && lap - car.lastPitLap <= 1;
  const neutral = ctx.flag === 'SC' || ctx.flag === 'VSC';
  const expectedWetness = Math.max(0, wetnessInLaps(ctx.forecast, 4, ctx.weather.trackWetness));
  const planningWetness = classOf(car.compound) === 'SLICK' ? Math.min(expectedWetness, WEATHER_CROSSOVER.slickToInter - 0.06) : expectedWetness;

  // 1 ── Tyres far beyond the cliff: the car has to come in.
  if (car.tyreWear >= 1.2 && lapsLeft >= 2) {
    const wanted = bestTyreClass(ctx.weather.trackWetness);
    const set = wanted === 'SLICK' ? slickForTheRun(ctx) : (pickSet(ctx.availableSets, wetCompoundFor(ctx.weather.trackWetness)) ?? pickSet(ctx.availableSets, 'INTER'));
    if (set) return box(set, 'TYRE_WEAR', `Tyres are finished (${Math.round(car.tyreWear * 100)}% of life used), box for ${COMPOUNDS[set.compound].label.toLowerCase()}s`, planAfterStop(ctx, set, planningWetness));
  }

  // 2 ── Weather: the wrong tyre family costs seconds a lap.
  const weather = weatherCall(ctx);
  if (weather && lapsLeft >= 1) {
    const set = weather.compound === 'SLICK' ? slickForTheRun(ctx) : (pickSet(ctx.availableSets, weather.compound) ?? pickSet(ctx.availableSets, weather.compound === 'WET' ? 'INTER' : 'WET'));
    if (set && classOf(set.compound) !== classOf(car.compound)) {
      const wetnessAfter = weather.compound === 'SLICK' ? 0 : expectedWetness;
      return box(set, 'WEATHER', `Box for ${COMPOUNDS[set.compound].label.toLowerCase()}s: ${weather.why}`, planAfterStop(ctx, set, wetnessAfter));
    }
  }

  if (lapsLeft < 2) return stay('Two laps to go, staying out');
  if (justStopped) return stay('Fresh tyres, building the stint');

  // Rain about to arrive on slicks: hold any routine stop so that one stop fits the wet-weather tyre.
  const rainComing =
    classOf(car.compound) === 'SLICK' &&
    Math.max(wetnessInLaps(ctx.forecast, 1.5, 0), wetnessInLaps(ctx.forecast, 2.5, 0)) >= WEATHER_CROSSOVER.slickToInter - 0.02;

  // 3 ── Neutralisation: a stop is cheap, is it worth taking now?
  if (neutral && lapsLeft >= 3 && !rainComing) {
    const base = baseOptimiserInput(ctx, planningWetness);
    const now = optimiseStrategy({ ...base, forcedFirstStopLap: lap, firstStopLoss: ctx.pitLossNow, maxStops: 2 }, 1)[0];
    const later = optimiseStrategy({ ...base, disallowImmediateStop: true, maxStops: 2 }, 1)[0];
    const first = now?.stops[0];
    if (now && later && first) {
      const gain = later.score - now.score - ctx.doubleStackWait;
      const due = next !== undefined && next.lap - lap <= 12;
      const worn = car.tyreWear >= 0.42;
      const margin = due || worn ? 1.5 : 5;
      const set = pickSet(ctx.availableSets, first.compound);
      if (set && gain > margin && (due || worn || gain > 8)) {
        const label = ctx.flag === 'SC' ? 'safety car' : 'VSC';
        return box(set, 'SAFETY_CAR', `Cheap stop under the ${label}: ${ctx.pitLossNow.toFixed(0)} s instead of ${base.pitLoss.toFixed(0)} s, saves ~${gain.toFixed(0)} s`, now.stops.slice(1));
      }
    }
    return stay(ctx.teammateBoxingAhead && ctx.doubleStackWait > 1 ? 'Not worth stacking behind the sister car' : 'A stop now does not pay back');
  }
  if (neutral) return stay('Holding position behind the safety car');

  // 4 ── Planned stop.
  if (next !== undefined && next.lap <= lap) {
    if (rainComing && car.tyreWear < 1.05) {
      plan = [{ lap: lap + 1, compound: next.compound }, ...plan.slice(1).map((s) => ({ ...s, lap: Math.max(s.lap, lap + 2) }))];
      return stay('Holding the planned stop: rain is about to arrive');
    }
    const wanted = bestTyreClass(ctx.weather.trackWetness);
    if (classOf(next.compound) !== wanted && classOf(car.compound) === wanted && car.tyreWear < 0.85) {
      // The stop was planned for other conditions (e.g. slicks for a track that has not dried yet).
      plan = [{ lap: lap + 1, compound: next.compound }, ...plan.slice(1).map((s) => ({ ...s, lap: Math.max(s.lap, lap + 2) }))];
      return stay('Planned tyre change postponed: the track is not ready for it');
    }
    let set = classOf(next.compound) === wanted ? pickSet(ctx.availableSets, next.compound) : null;
    if (!set) set = wanted === 'SLICK' ? slickForTheRun(ctx) : (pickSet(ctx.availableSets, wetCompoundFor(ctx.weather.trackWetness)) ?? pickSet(ctx.availableSets, 'INTER'));
    if (set) {
      const rest = set.compound === next.compound ? plan.slice(1) : planAfterStop(ctx, set, planningWetness);
      return box(set, 'PLANNED', `Planned stop: ${COMPOUNDS[set.compound].label.toLowerCase()}s on lap ${lap}`, rest);
    }
    plan = plan.slice(1);
  }

  const green = ctx.flag === 'GREEN' || ctx.flag === 'YELLOW';
  const window = next !== undefined ? next.lap - lap : Infinity;
  // Tactical stops only make sense for a tyre of the family the track currently asks for.
  const tacticalStop = next !== undefined && classOf(next.compound) === classOf(car.compound) && classOf(car.compound) === bestTyreClass(ctx.weather.trackWetness);

  // 5 ── Undercut: stuck behind a car on old tyres with our stop coming up.
  if (green && next !== undefined && tacticalStop && window <= 2 + Math.round(3 * ctx.profile.aggression) && lapsLeft >= 5 && !rainComing) {
    const ahead = car.carAheadId ? ctx.field.find((c) => c.id === car.carAheadId) : undefined;
    if (ahead && car.gapAhead !== null && car.gapAhead <= UNDERCUT_RANGE && ahead.teamId !== car.teamId && !ahead.inPitLane && ahead.tyreAgeLaps >= 5) {
      const set = pickSet(ctx.availableSets, next.compound);
      if (set) {
        // Undercut power if the rival answers one lap later: our out-lap against its worn tyres, then our
        // second lap against its own out-lap on cold tyres.
        const [out, second] = freshTyreLaps(ctx, set);
        const rivalLap = rivalNextLap(ctx, ahead);
        const rivalOut = out + (ahead.paceOffset - car.paceOffset);
        const achieved = rivalLap - out + (rivalOut - second);
        const traffic = trafficAtPitExit(ctx);
        const clear = traffic === 0 || ctx.track.overtakingDifficulty < 0.4 || ctx.profile.aggression > 0.8;
        if (achieved > car.gapAhead + UNDERCUT_MARGIN && clear && ctx.rng.chance(0.45 + 0.5 * ctx.profile.aggression)) {
          return box(set, 'UNDERCUT', `Undercut on ${ahead.id}: gap ${car.gapAhead.toFixed(1)} s, fresh ${COMPOUNDS[set.compound].label.toLowerCase()}s are worth ~${achieved.toFixed(1)} s`, plan.slice(1));
        }
      }
    }
  }

  // 6 ── Cover: the car behind has just stopped.
  if (green && next !== undefined && tacticalStop && window <= 7 && lapsLeft >= 4 && car.tyreAgeLaps >= 5 && !rainComing) {
    const rival = ctx.field.find(
      (c) =>
        c.id !== car.id &&
        c.teamId !== car.teamId &&
        c.position > car.position &&
        (c.inPitLane || c.lastPitLap === lap - 1 || c.lastPitLap === lap) &&
        c.gapToLeader - car.gapToLeader < ctx.pitLossNow + COVER_RANGE,
    );
    if (rival) {
      const set = pickSet(ctx.availableSets, next.compound);
      // Overcut instead: our tyres are still alive and the rival is on a compound that is slow to come in.
      const overcut = car.tyreWear < 0.5 && rival.compound === 'HARD' && lapsToCliff > 4;
      if (set && !overcut && ctx.rng.chance(ctx.profile.reactivity)) {
        return box(set, 'COVER', `Covering ${rival.id}, who has just stopped behind us`, plan.slice(1));
      }
      if (overcut) return stay(`Staying out against ${rival.id}: going for the overcut`);
    }
  }

  // 7 ── Tyre management and rule keeping.
  if (car.tyreWear >= 1.06 && lapsLeft >= 3) {
    const wanted = next !== undefined ? pickSet(ctx.availableSets, next.compound) : null;
    const set = wanted ?? slickForTheRun(ctx);
    if (set && classOf(set.compound) === bestTyreClass(ctx.weather.trackWetness)) {
      const rest = next !== undefined && set.compound === next.compound ? plan.slice(1) : planAfterStop(ctx, set, planningWetness);
      return box(set, 'TYRE_WEAR', `Tyres past the cliff (${Math.round(car.tyreWear * 100)}%), stopping now`, rest);
    }
  }
  if (next !== undefined && next.lap - lap > lapsToCliff + 2) {
    // The tyres will not make the planned lap: bring the stop forward.
    const pulled = Math.max(lap + 1, Math.floor(lap + lapsToCliff + 1));
    plan = [{ lap: pulled, compound: next.compound }, ...plan.slice(1).map((s) => ({ ...s, lap: Math.max(s.lap, pulled + 2) }))];
    return stay(`Tyres fading faster than planned: stop moved to lap ${pulled}`);
  }
  if (next === undefined && lapsLeft >= 4) {
    const needsRule = ctx.mustUseTwoCompounds && isSlick(car.compound) && new Set([...car.compoundsUsed, car.compound].filter((c) => isSlick(c))).size < 2;
    const willDie = lapsLeft > lapsToCliff + 3;
    if (needsRule || willDie) {
      const best = optimiseStrategy({ ...baseOptimiserInput(ctx, planningWetness), disallowImmediateStop: true, maxStops: 2 }, 1)[0];
      if (best && best.stops.length > 0) {
        plan = best.stops;
        return stay(needsRule ? `Second compound still to run: stop planned on lap ${best.stops[0]!.lap}` : `These tyres will not reach the flag: stop planned on lap ${best.stops[0]!.lap}`);
      }
    }
  }

  return stay(next !== undefined ? `On plan: next stop lap ${next.lap} for ${COMPOUNDS[next.compound].label.toLowerCase()}s` : 'On plan: running to the flag');
}
