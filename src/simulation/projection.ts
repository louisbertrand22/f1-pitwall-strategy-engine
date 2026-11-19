/**
 * Predictive engine of the pit wall: the undercut / overcut simulator.
 *
 * A lap-by-lap simulation of the whole field from "now" to the chequered flag, built on the same physics
 * as the live race (tyre degradation and warm-up, fuel burn, pit loss, dirty air, DRS, overtaking odds,
 * weather crossovers). For each candidate stop lap of the focus car it is run
 *   • once without noise  → the expected race trace (gap to the leader lap by lap),
 *   • N times with noise  → a Monte-Carlo distribution of the finishing position: lap-time scatter, pit
 *     stop times, rivals stopping a lap or two off their predicted lap, safety cars and VSCs drawn from the
 *     circuit's statistics.
 * Every candidate sees the same random draws (common random numbers), so differences between candidates
 * come from the strategy, not from luck.
 *
 * `runProjection` is a generator yielding between small units of work so the simulation worker can
 * time-slice it; it only ever uses its own seeded random stream.
 */
import { optimiseStrategy } from './aiStrategist';
import {
  COMPOUNDS,
  NEUTRALISED_PACE,
  NOMINAL_STATIONARY_TIME,
  PIT_LOSS_IN_LAP_SHARE,
  WEATHER_CROSSOVER,
  bestTyreClass,
  clamp,
  compoundPaceDelta,
  dirtyAirPenalty,
  drsLapGain,
  fuelBurnPerLap,
  fuelPenalty,
  incidentRates,
  isSlick,
  lapScale,
  meanWarmupPenaltyOverLap,
  overtakeProbability,
  pitLossUnderFlag,
  pitStopTimeLoss,
  readinessAfter,
  sampleStationaryTime,
  tyreDegradation,
  warmupTimeConstant,
  wearPerLap,
  wetnessPenalty,
} from './physicsModel';
import { SeededRandom } from './rng';
import type {
  CandidateProjection,
  CarId,
  FlagStatus,
  PlannedStop,
  ProjectionCarInput,
  ProjectionPoint,
  ProjectionRequest,
  ProjectionResult,
  TrackDefinition,
  TyreCompound,
  UndercutOutcome,
  WeatherForecastPoint,
} from './types';

/** Gap behind which a car that failed to pass sits (s). */
const HELD_GAP = 0.35;
/** Spacing of the train behind the safety car at the line (s). */
const SC_SPACING = 1.0;
/** Lap-to-lap pace scatter of a driver (s per reference lap). */
const PACE_NOISE = 0.2;
/** Run-to-run uncertainty on a car's underlying pace (s per reference lap). */
const PACE_BIAS = 0.06;
const AVERAGE_CREW_TIME = 2.4;

interface Neutralisation {
  kind: 'SC' | 'VSC';
  start: number;
  end: number;
}

/** Strategy-dependent lap time in clean air with tyres up to temperature (no allocation). */
export function projectedLapTime(
  track: TrackDefinition,
  scale: number,
  compound: TyreCompound,
  wear: number,
  fuelKg: number,
  wetness: number,
  paceOffset: number,
): number {
  return (
    track.baseLapTime +
    paceOffset +
    fuelPenalty(track, fuelKg) +
    compoundPaceDelta(track, compound) +
    (tyreDegradation(compound, wear) + wetnessPenalty(compound, wetness)) * scale
  );
}

function wetnessAt(forecast: readonly WeatherForecastPoint[], raceTime: number, fallback: number): number {
  const first = forecast[0];
  if (!first) return fallback;
  if (raceTime <= first.raceTime) return first.trackWetness;
  // Forecast points are evenly spaced: jump close to the right one, then interpolate.
  const second = forecast[1];
  const step = second ? Math.max(1, second.raceTime - first.raceTime) : 1;
  let index = Math.min(forecast.length - 2, Math.max(0, Math.floor((raceTime - first.raceTime) / step)));
  while (index > 0 && forecast[index]!.raceTime > raceTime) index--;
  while (index < forecast.length - 2 && forecast[index + 1]!.raceTime < raceTime) index++;
  const a = forecast[index]!;
  const b = forecast[index + 1];
  if (!b || b.raceTime <= a.raceTime) return a.trackWetness;
  const t = clamp((raceTime - a.raceTime) / (b.raceTime - a.raceTime), 0, 1);
  return a.trackWetness + (b.trackWetness - a.trackWetness) * t;
}

/** Everything about the request that is the same for every run. */
interface Setup {
  request: ProjectionRequest;
  track: TrackDefinition;
  scale: number;
  cars: ProjectionCarInput[];
  n: number;
  raceLaps: number;
  focus: number;
  /** First lap each car completes in the projection (the one it is on now). */
  firstLap: Int32Array;
  burn: number;
  drsGain: number;
  /** Per-lap probability multiplier: overtaking opportunities per lap. */
  opportunities: number;
  /** Wear of the sets each car can still fit, per compound, least worn first. */
  setWear: Map<TyreCompound, number[]>[];
  /** Neutralisation already running when the projection starts. */
  ongoing: Neutralisation | null;
  rates: { safetyCar: number; vsc: number };
}

/** Mutable buffers reused by every run. */
interface Buffers {
  /** times[i * (R + 2) + L] = race clock at which car i completes lap L. */
  times: Float64Array;
  wear: Float64Array;
  fuel: Float64Array;
  readiness: Float64Array;
  pendingOut: Float64Array;
  freeLap: Float64Array;
  bias: Float64Array;
  compound: TyreCompound[];
  /** Compound each car ran during lap L, and whether it stopped at the end of it. */
  lapCompound: TyreCompound[][];
  lapPit: Uint8Array;
  nextStop: Int32Array;
  pitPhase: Uint8Array;
  reacted: Uint8Array;
  used: Map<TyreCompound, number>[];
  order: Int32Array;
  stops: PlannedStop[][];
  finishLap: Int32Array;
  finishTime: Float64Array;
  rank: Int32Array;
}

function createBuffers(setup: Setup): Buffers {
  const { n, raceLaps } = setup;
  const stride = raceLaps + 2;
  return {
    times: new Float64Array(n * stride),
    wear: new Float64Array(n),
    fuel: new Float64Array(n),
    readiness: new Float64Array(n),
    pendingOut: new Float64Array(n),
    freeLap: new Float64Array(n),
    bias: new Float64Array(n),
    compound: new Array<TyreCompound>(n).fill('MEDIUM'),
    lapCompound: Array.from({ length: n }, () => new Array<TyreCompound>(stride).fill('MEDIUM')),
    lapPit: new Uint8Array(n * stride),
    nextStop: new Int32Array(n),
    pitPhase: new Uint8Array(n),
    reacted: new Uint8Array(n),
    used: Array.from({ length: n }, () => new Map<TyreCompound, number>()),
    order: new Int32Array(n),
    stops: Array.from({ length: n }, () => []),
    finishLap: new Int32Array(n),
    finishTime: new Float64Array(n),
    rank: new Int32Array(n),
  };
}

function neutralisationAt(list: readonly Neutralisation[], time: number): Neutralisation | null {
  for (const item of list) if (time >= item.start && time < item.end) return item;
  return null;
}

/** First neutralisation that overlaps a lap starting at `start` and lasting `racingLap` at racing speed. */
function neutralisationDuring(list: readonly Neutralisation[], start: number, racingLap: number): Neutralisation | null {
  for (const item of list) if (start < item.end && start + racingLap > item.start) return item;
  return null;
}

const blend = { seconds: 0, fraction: 0 };

/**
 * Duration of a lap that is only partly neutralised. A flag that comes out or is withdrawn mid-lap must
 * not create a cliff between two cars a second apart: the part of the lap driven under the flag takes
 * `neutralLap` pro rata, the rest is driven at racing speed. Writes into `blend` (no allocation).
 */
function blendedLap(start: number, racingLap: number, neutralLap: number, window: Neutralisation): void {
  let time = start;
  let done = 0;
  if (time < window.start) {
    done = Math.min(1, (window.start - time) / racingLap);
    time = window.start;
  }
  const needed = (1 - done) * neutralLap;
  if (time + needed <= window.end) {
    blend.seconds = time - start + needed;
    blend.fraction = 1 - done;
    return;
  }
  const covered = Math.max(0, (window.end - time) / neutralLap);
  blend.seconds = window.end - start + Math.max(0, 1 - done - covered) * racingLap;
  blend.fraction = covered;
}

/** Compound a car fits when the weather forces an unplanned change. */
function weatherCompound(wetness: number, lapsLeft: number): TyreCompound {
  const wanted = bestTyreClass(wetness);
  if (wanted === 'WET') return 'WET';
  if (wanted === 'INTER') return 'INTER';
  return lapsLeft > 26 ? 'HARD' : lapsLeft > 12 ? 'MEDIUM' : 'SOFT';
}

/**
 * One race from now to the flag. `rng` null = expected run (no noise). Fills `buffers.times` and the
 * finishing order.
 */
function simulate(setup: Setup, buffers: Buffers, plans: readonly PlannedStop[][], rng: SeededRandom | null, neutralisations: readonly Neutralisation[]): void {
  const { track, scale, cars, n, raceLaps, firstLap, burn, request } = setup;
  const stride = raceLaps + 2;
  const T = track.baseLapTime;
  const { times, wear, fuel, readiness, pendingOut, freeLap, bias, compound, lapCompound, lapPit, nextStop, pitPhase, reacted, used, order } = buffers;
  const forecast = request.forecast;
  const currentWetness = request.weather.trackWetness;

  lapPit.fill(0);
  let minFirst = raceLaps + 1;
  for (let i = 0; i < n; i++) {
    const car = cars[i]!;
    const stops = buffers.stops[i]!;
    stops.length = 0;
    for (const stop of plans[i]!) stops.push({ lap: stop.lap, compound: stop.compound });
    wear[i] = car.tyreWear;
    fuel[i] = car.fuelKg;
    readiness[i] = 1;
    pendingOut[i] = 0;
    compound[i] = car.compound;
    nextStop[i] = 0;
    pitPhase[i] = 0;
    // Whether to stop under the neutralisation in force is exactly what the candidates compare: the focus
    // car follows its candidate there. (It does take a cheap stop under a later, randomly drawn one.)
    reacted[i] = i === setup.focus && setup.ongoing ? 1 : 0;
    used[i]!.clear();
    bias[i] = rng ? rng.normal() * PACE_BIAS * scale : 0;
    const lap0 = firstLap[i]!;
    if (lap0 < minFirst) minFirst = lap0;
    let t = car.nextLineCrossingTime;
    lapCompound[i]![lap0] = car.compound;
    // A stop called for the lap the car is on right now.
    while (nextStop[i]! < stops.length && stops[nextStop[i]!]!.lap < lap0) nextStop[i] = nextStop[i]! + 1;
    const due = stops[nextStop[i]!];
    if (due && due.lap === lap0 && !car.inPitLane && lap0 < raceLaps) {
      const flag: FlagStatus = setup.ongoing ? setup.ongoing.kind : 'GREEN';
      const loss = pitStopTimeLoss(track, flag, rng ? sampleStationaryTime(rng, AVERAGE_CREW_TIME).time : NOMINAL_STATIONARY_TIME);
      t += loss * PIT_LOSS_IN_LAP_SHARE;
      pendingOut[i] = loss * (1 - PIT_LOSS_IN_LAP_SHARE);
      fit(setup, buffers, i, due.compound);
      lapPit[i * stride + lap0] = 1;
      nextStop[i] = nextStop[i]! + 1;
      pitPhase[i] = 2;
    } else if (due && due.lap === lap0) {
      nextStop[i] = nextStop[i]! + 1;
    }
    times[i * stride + lap0] = t;
  }

  for (let lap = minFirst + 1; lap <= raceLaps; lap++) {
    // Cars running this lap, in the order they start it.
    let count = 0;
    for (let i = 0; i < n; i++) if (firstLap[i]! < lap) order[count++] = i;
    for (let a = 1; a < count; a++) {
      const item = order[a]!;
      const key = times[item * stride + lap - 1]!;
      let b = a - 1;
      while (b >= 0 && times[order[b]! * stride + lap - 1]! > key) {
        order[b + 1] = order[b]!;
        b--;
      }
      order[b + 1] = item;
    }

    for (let k = 0; k < count; k++) {
      const i = order[k]!;
      const car = cars[i]!;
      const start = times[i * stride + lap - 1]!;
      const window = neutralisations.length > 0 ? neutralisationDuring(neutralisations, start, T * 1.06) : null;
      // `flag` = neutralised from the very start of the lap (the moment strategy calls are made).
      const flag = window && start >= window.start ? window : null;
      const wetness = wetnessAt(forecast, start + T * 0.5, currentWetness);
      const tyre = compound[i]!;
      const lapsLeft = raceLaps - lap;
      const outLap = pitPhase[i] === 2;
      lapCompound[i]![lap] = tyre;

      // Does the car stop at the end of this lap?
      const stops = buffers.stops[i]!;
      let stopCompound: TyreCompound | null = null;
      const planned = stops[nextStop[i]!];
      const ownClass = COMPOUNDS[tyre].tyreClass;
      const wantedClass = bestTyreClass(wetness + (ownClass === 'SLICK' ? -0.02 : ownClass === 'WET' ? 0.02 : 0));
      if (lapsLeft >= 1 && ownClass !== wantedClass && !outLap) {
        // Wrong tyre family for the track: unplanned stop.
        stopCompound = weatherCompound(wetness, lapsLeft);
        if (planned && planned.lap <= lap + 6) nextStop[i] = nextStop[i]! + 1;
      } else if (planned && planned.lap <= lap && lapsLeft >= 1) {
        stopCompound = COMPOUNDS[planned.compound].tyreClass === wantedClass ? planned.compound : weatherCompound(wetness, lapsLeft);
        nextStop[i] = nextStop[i]! + 1;
      } else if (flag && !reacted[i] && lapsLeft >= 3 && !outLap) {
        // First lap of a neutralisation: take the cheap stop if one was coming anyway.
        reacted[i] = 1;
        if (planned && planned.lap - lap <= 8) {
          stopCompound = COMPOUNDS[planned.compound].tyreClass === wantedClass ? planned.compound : weatherCompound(wetness, lapsLeft);
          nextStop[i] = nextStop[i]! + 1;
        } else if (!planned && wear[i]! > 0.5 && lapsLeft >= 6) {
          stopCompound = weatherCompound(wetness, lapsLeft);
        }
      }
      if (!flag) reacted[i] = 0;

      // Lap time.
      const rate = wearPerLap({ track, compound: tyre, fuelKg: fuel[i]!, wearFactor: car.wearFactor, trackWetness: wetness, flag: flag ? flag.kind : 'GREEN' });
      const clean = projectedLapTime(track, scale, tyre, wear[i]! + rate / 2, fuel[i]!, wetness, car.paceOffset + bias[i]!);
      freeLap[i] = clean;
      // Racing lap first; a neutralisation then replaces the part of the lap it covers.
      let lapSeconds = clean;
      if (readiness[i]! < 0.995) {
        const tau = warmupTimeConstant(tyre, track.trackTempC, wetness);
        lapSeconds += meanWarmupPenaltyOverLap(tyre, readiness[i]!, tau) * scale;
        readiness[i] = readinessAfter(readiness[i]!, 1, tau, 1);
      }
      if (rng) lapSeconds += rng.normal() * PACE_NOISE * scale;
      if (!window && k > 0 && !outLap) {
        const gap = start - times[order[k - 1]! * stride + lap - 1]!;
        if (gap < 1.2) {
          lapSeconds += dirtyAirPenalty(track, gap);
          if (gap < 1 && wetness < 0.2) lapSeconds -= setup.drsGain * 0.8;
        }
      }
      let neutralFraction = 0;
      if (window) {
        const pace = window.kind === 'VSC' ? NEUTRALISED_PACE.VSC : k === 0 ? NEUTRALISED_PACE.SC : NEUTRALISED_PACE.SC_CATCH_UP;
        blendedLap(start, lapSeconds, T * pace, window);
        lapSeconds = blend.seconds;
        neutralFraction = blend.fraction;
      }
      if (outLap) {
        lapSeconds += pendingOut[i]!;
        pendingOut[i] = 0;
      }
      let stopLoss = 0;
      if (stopCompound) {
        const stationary = rng ? sampleStationaryTime(rng, AVERAGE_CREW_TIME).time : NOMINAL_STATIONARY_TIME;
        stopLoss = pitStopTimeLoss(track, flag ? flag.kind : 'GREEN', stationary);
        lapSeconds += stopLoss * PIT_LOSS_IN_LAP_SHARE;
      }
      let finish = start + lapSeconds;

      // Traffic: a car in the pit lane neither blocks nor is blocked.
      const inPitPhase = outLap || stopCompound !== null;
      if (!inPitPhase && !(window && window.kind === 'VSC')) {
        for (let a = k - 1; a >= 0; a--) {
          const j = order[a]!;
          if (pitPhase[j] !== 0) continue;
          const ahead = times[j * stride + lap]!;
          if (window) {
            // Behind the safety car (or until the line at the restart): close up to the train, no overtaking.
            const spacing = HELD_GAP + (SC_SPACING - HELD_GAP) * neutralFraction;
            if (finish < ahead + spacing) finish = ahead + spacing;
            break;
          }
          if (finish >= ahead + 0.3) break;
          const probability = overtakeProbability(track, freeLap[j]! - clean, { drs: wetness < 0.2, trackWetness: wetness });
          const perLap = 1 - Math.pow(1 - probability, setup.opportunities);
          const through = rng ? rng.chance(perLap) : perLap >= 0.5;
          if (!through) {
            finish = ahead + HELD_GAP;
            break;
          }
          finish += 0.12;
        }
      }
      times[i * stride + lap] = finish;

      // State at the end of the lap.
      wear[i] = wear[i]! + rate;
      fuel[i] = Math.max(0, fuel[i]! - burn * (1 - 0.5 * neutralFraction));
      if (window && neutralFraction > 0.5) readiness[i] = Math.min(readiness[i]!, window.kind === 'SC' ? 0.75 : 0.85);
      if (stopCompound) {
        pendingOut[i] = stopLoss * (1 - PIT_LOSS_IN_LAP_SHARE);
        fit(setup, buffers, i, stopCompound);
        lapPit[i * stride + lap] = 1;
        pitPhase[i] = 1;
      }
    }
    // Only once the whole lap is resolved: out-laps are over, in-laps become out-laps. (A car on its
    // out-lap must stay "in the pit phase" while the cars behind it are processed, or it would block them.)
    for (let k = 0; k < count; k++) {
      const i = order[k]!;
      if (pitPhase[i] === 2) pitPhase[i] = 0;
      else if (pitPhase[i] === 1) pitPhase[i] = 2;
    }
  }

  classify(setup, buffers);
}

/** Bolts a new set of `compound` on car `i`: least worn set still available, or a new one if unknown. */
function fit(setup: Setup, buffers: Buffers, i: number, compound: TyreCompound): void {
  const available = setup.setWear[i]!.get(compound);
  const taken = buffers.used[i]!.get(compound) ?? 0;
  buffers.used[i]!.set(compound, taken + 1);
  buffers.compound[i] = compound;
  buffers.wear[i] = available && available[taken] !== undefined ? available[taken]! : 0;
  buffers.readiness[i] = COMPOUNDS[compound].blanketReadiness;
}

/** The race ends when the leader takes the flag: everybody else finishes on the next crossing of the line. */
function classify(setup: Setup, buffers: Buffers): void {
  const { n, raceLaps, firstLap } = setup;
  const stride = raceLaps + 2;
  const { times, finishLap, finishTime, rank } = buffers;
  let flagTime = Infinity;
  for (let i = 0; i < n; i++) {
    const t = times[i * stride + raceLaps]!;
    if (t < flagTime) flagTime = t;
  }
  for (let i = 0; i < n; i++) {
    let lap = raceLaps;
    for (let l = firstLap[i]!; l <= raceLaps; l++) {
      if (times[i * stride + l]! >= flagTime - 1e-9) {
        lap = l;
        break;
      }
    }
    finishLap[i] = lap;
    finishTime[i] = times[i * stride + lap]!;
    rank[i] = i;
  }
  // Insertion sort: more laps first, then earlier across the line.
  for (let a = 1; a < n; a++) {
    const item = rank[a]!;
    let b = a - 1;
    while (b >= 0) {
      const other = rank[b]!;
      const worse = finishLap[other]! < finishLap[item]! || (finishLap[other]! === finishLap[item]! && finishTime[other]! > finishTime[item]!);
      if (!worse) break;
      rank[b + 1] = other;
      b--;
    }
    rank[b + 1] = item;
  }
}

function finishingPosition(buffers: Buffers, car: number, n: number): number {
  for (let p = 0; p < n; p++) if (buffers.rank[p] === car) return p + 1;
  return n;
}

/** Race trace of one car from the buffers of the last run. */
function traceOf(setup: Setup, buffers: Buffers, car: number): ProjectionPoint[] {
  const { n, raceLaps, firstLap } = setup;
  const stride = raceLaps + 2;
  const { times } = buffers;
  const points: ProjectionPoint[] = [];
  const last = Math.min(raceLaps, buffers.finishLap[car]!);
  for (let lap = firstLap[car]!; lap <= last; lap++) {
    const own = times[car * stride + lap]!;
    let leader = own;
    let position = 1;
    for (let j = 0; j < n; j++) {
      if (j === car) continue;
      if (firstLap[j]! > lap) {
        // That car completed this lap before the projection started: it is ahead, by at least a lap's worth.
        position += 1;
        const known = times[j * stride + firstLap[j]!]!;
        const estimate = known - (firstLap[j]! - lap) * setup.track.baseLapTime * 1.04;
        if (estimate < leader) leader = estimate;
        continue;
      }
      const other = times[j * stride + lap]!;
      if (other < own) position += 1;
      if (other < leader) leader = other;
    }
    points.push({
      lap,
      gapToLeader: Math.max(0, own - leader),
      raceTime: own,
      position,
      compound: buffers.lapCompound[car]![lap]!,
      pit: buffers.lapPit[car * stride + lap] === 1,
    });
  }
  return points;
}

function drawNeutralisations(setup: Setup, rng: SeededRandom): Neutralisation[] {
  const { request, track, raceLaps, n } = setup;
  const list: Neutralisation[] = [];
  if (setup.ongoing) list.push(setup.ongoing);
  const T = track.baseLapTime;
  let leaderLap = 0;
  for (const car of setup.cars) leaderLap = Math.max(leaderLap, car.lapsCompleted);
  const lapsRemaining = Math.max(0, raceLaps - leaderLap - 1);
  if (lapsRemaining < 2) return list;
  const exposure = n * lapsRemaining;
  const horizon = lapsRemaining * T * 1.03;
  const from = setup.ongoing ? setup.ongoing.end + T : request.raceTime + T * 0.5;
  if (rng.chance(1 - Math.exp(-setup.rates.safetyCar * exposure))) {
    const start = from + rng.next() * Math.max(0, horizon - T * 4);
    list.push({ kind: 'SC', start, end: start + rng.int(4, 6) * T * NEUTRALISED_PACE.SC });
  }
  if (rng.chance(1 - Math.exp(-setup.rates.vsc * exposure))) {
    const start = from + rng.next() * Math.max(0, horizon - T * 2);
    if (!neutralisationAt(list, start)) list.push({ kind: 'VSC', start, end: start + rng.int(1, 3) * T * NEUTRALISED_PACE.VSC });
  }
  return list;
}

function prepare(request: ProjectionRequest): Setup {
  const cars = request.cars.filter((c) => c.lapsCompleted < request.raceLaps);
  const focus = cars.findIndex((c) => c.id === request.focusCarId);
  if (focus < 0) throw new Error(`Projection: focus car ${request.focusCarId} is not in the field`);
  const n = cars.length;
  const firstLap = new Int32Array(n);
  const setWear: Map<TyreCompound, number[]>[] = [];
  cars.forEach((car, i) => {
    firstLap[i] = Math.min(request.raceLaps, car.lapsCompleted + 1);
    const map = new Map<TyreCompound, number[]>();
    for (const set of car.availableSets) {
      if (set.fitted) continue;
      const list = map.get(set.compound) ?? [];
      list.push(set.wear);
      map.set(set.compound, list);
    }
    for (const list of map.values()) list.sort((a, b) => a - b);
    setWear.push(map);
  });
  const T = request.track.baseLapTime;
  let ongoing: Neutralisation | null = null;
  if (request.flag === 'SC') ongoing = { kind: 'SC', start: request.raceTime - 1, end: request.raceTime + 3 * T * NEUTRALISED_PACE.SC };
  else if (request.flag === 'VSC') ongoing = { kind: 'VSC', start: request.raceTime - 1, end: request.raceTime + T * NEUTRALISED_PACE.VSC };
  const rates = incidentRates(request.track, request.raceLaps, Math.max(1, n));
  return {
    request,
    track: request.track,
    scale: lapScale(request.track),
    cars,
    n,
    raceLaps: request.raceLaps,
    focus,
    firstLap,
    burn: fuelBurnPerLap(request.track),
    drsGain: drsLapGain(request.track),
    opportunities: Math.max(1, request.track.drsZones.length + request.track.overtakingSpots.length),
    setWear,
    ongoing,
    rates: { safetyCar: rates.safetyCar, vsc: rates.vsc },
  };
}

/** Stops a rival is expected to make from its current state (nobody announces their strategy). */
function predictStops(setup: Setup, car: ProjectionCarInput): PlannedStop[] {
  const { request, track, raceLaps } = setup;
  const lap = car.lapsCompleted + 1;
  if (lap >= raceLaps - 1) return [];
  const wetness = request.weather.trackWetness;
  const dryRule = !car.compoundsUsed.some((c) => !isSlick(c)) && isSlick(car.compound);
  const best = optimiseStrategy({
    track,
    raceLaps,
    fromLap: lap + 1,
    compound: car.compound,
    tyreWear: car.tyreWear,
    fuelKg: car.fuelKg,
    paceOffset: car.paceOffset,
    wearFactor: car.wearFactor,
    availableSets: car.availableSets,
    compoundsUsed: car.compoundsUsed,
    mustUseTwoCompounds: dryRule,
    trackWetness: isSlick(car.compound) ? Math.min(wetness, WEATHER_CROSSOVER.slickToInter - 0.06) : wetness,
    pitLoss: pitLossUnderFlag(track, 'GREEN'),
    maxStops: 2,
  }, 1)[0];
  return best ? best.stops : [];
}

/** Full stop sequence of the focus car for a candidate: the candidate stop, then the best continuation. */
function candidateStops(setup: Setup, candidate: ProjectionRequest['candidates'][number]): PlannedStop[] {
  const { request, track, raceLaps } = setup;
  const car = setup.cars[setup.focus]!;
  const lap = car.lapsCompleted + 1;
  if (candidate.pitLap === null || candidate.compound === null) return [];
  const pitLap = Math.round(clamp(candidate.pitLap, lap, raceLaps - 1));
  if (car.inPitLane && pitLap === lap) return [];
  const neutral = request.flag === 'SC' || request.flag === 'VSC';
  const wetCompound = !isSlick(candidate.compound);
  const dryRule = !wetCompound && !car.compoundsUsed.some((c) => !isSlick(c)) && isSlick(car.compound);
  const best = optimiseStrategy({
    track,
    raceLaps,
    fromLap: lap + 1,
    compound: car.compound,
    tyreWear: car.tyreWear,
    fuelKg: car.fuelKg,
    paceOffset: car.paceOffset,
    wearFactor: car.wearFactor,
    availableSets: car.availableSets,
    compoundsUsed: car.compoundsUsed,
    mustUseTwoCompounds: dryRule,
    trackWetness: wetCompound ? Math.max(request.weather.trackWetness, WEATHER_CROSSOVER.slickToInter) : 0,
    pitLoss: pitLossUnderFlag(track, 'GREEN'),
    firstStopLoss: neutral && pitLap === lap ? pitLossUnderFlag(track, request.flag) : undefined,
    forcedFirstStopLap: pitLap,
    forcedFirstCompound: candidate.compound,
    maxStops: 2,
  }, 1)[0];
  const stops = best && best.stops.length > 0 ? best.stops.map((s) => ({ ...s })) : [{ lap: pitLap, compound: candidate.compound }];
  stops[0] = { lap: pitLap, compound: candidate.compound };
  return stops;
}

function jitter(stops: readonly PlannedStop[], fromLap: number, raceLaps: number, rng: SeededRandom): PlannedStop[] {
  const out: PlannedStop[] = [];
  let previous = fromLap - 1;
  for (const stop of stops) {
    const lap = Math.round(clamp(stop.lap + rng.int(-2, 2), Math.max(fromLap, previous + 2), raceLaps - 1));
    if (lap <= previous) continue;
    out.push({ lap, compound: stop.compound });
    previous = lap;
  }
  return out;
}

/** Time-sliced projection: yields progress in [0, 1] after each small unit of work, returns the result. */
export function* runProjection(request: ProjectionRequest): Generator<number, ProjectionResult, void> {
  const setup = prepare(request);
  const { n, cars, focus, raceLaps } = setup;
  const buffers = createBuffers(setup);
  const stride = raceLaps + 2;
  const runs = Math.max(0, Math.round(request.monteCarloRuns));
  const candidates = request.candidates;
  const totalSteps = n + candidates.length * (1 + runs) + 1;
  let done = 0;

  // Strategies: the user's cars follow their plans, everybody else is predicted.
  const basePlans: PlannedStop[][] = [];
  for (let i = 0; i < n; i++) {
    const car = cars[i]!;
    basePlans.push(car.plannedStops ? car.plannedStops.map((s) => ({ ...s })) : predictStops(setup, car));
    done += 1;
    if (i % 3 === 2) yield done / totalSteps;
  }
  const focusStops = candidates.map((candidate) => candidateStops(setup, candidate));

  const focusCar = cars[focus]!;
  const focusLap = focusCar.lapsCompleted + 1;
  const sorted = cars.map((_, i) => i).sort((a, b) => cars[a]!.position - cars[b]!.position);
  const focusRank = sorted.indexOf(focus);
  const aheadIndex = focusRank > 0 ? sorted[focusRank - 1]! : -1;
  const behindIndex = focusRank < sorted.length - 1 ? sorted[focusRank + 1]! : -1;
  const rivalIndices = [aheadIndex, behindIndex].filter((i) => i >= 0);

  // Expected (noise-free) run of each candidate.
  const expected: {
    trace: ProjectionPoint[];
    raceTime: number;
    rejoin: { position: number | null; ahead: number | null; behind: number | null };
    gapNow: number[];
    gapAfter: number[];
  }[] = [];
  let rivalTraces: { carId: CarId; trace: ProjectionPoint[] }[] = [];
  const baseline = setup.ongoing ? [setup.ongoing] : [];
  for (let c = 0; c < candidates.length; c++) {
    const plans = basePlans.map((plan, i) => (i === focus ? focusStops[c]! : plan));
    simulate(setup, buffers, plans, null, baseline);
    const trace = traceOf(setup, buffers, focus);
    const stops = focusStops[c]!;
    const firstStop = stops[0];

    // Traffic right after the candidate stop: order at the end of the out-lap.
    let rejoin: { position: number | null; ahead: number | null; behind: number | null } = { position: null, ahead: null, behind: null };
    if (firstStop && firstStop.lap + 1 <= raceLaps) {
      const lap = firstStop.lap + 1;
      const own = buffers.times[focus * stride + lap]!;
      let position = 1;
      let ahead = Infinity;
      let behind = Infinity;
      for (let j = 0; j < n; j++) {
        if (j === focus) continue;
        if (setup.firstLap[j]! > lap) {
          position += 1;
          continue;
        }
        const delta = own - buffers.times[j * stride + lap]!;
        if (delta > 0) {
          position += 1;
          if (delta < ahead) ahead = delta;
        } else if (-delta < behind) behind = -delta;
      }
      rejoin = { position, ahead: Number.isFinite(ahead) ? ahead : null, behind: Number.isFinite(behind) ? behind : null };
    }

    // Gap to the cars directly ahead and behind: now, and once both have made their next stop.
    const gapNow: number[] = [];
    const gapAfter: number[] = [];
    for (const r of rivalIndices) {
      const common = Math.max(setup.firstLap[focus]!, setup.firstLap[r]!);
      gapNow.push(buffers.times[focus * stride + common]! - buffers.times[r * stride + common]! - inLapShare(setup, buffers, focus, common));
      const rivalStop = basePlans[r]![0];
      const settle = Math.min(raceLaps, Math.max(firstStop ? firstStop.lap : focusLap, rivalStop ? rivalStop.lap : focusLap, common) + 2);
      gapAfter.push(buffers.times[focus * stride + settle]! - buffers.times[r * stride + settle]!);
    }
    expected.push({ trace, raceTime: buffers.finishTime[focus]!, rejoin, gapNow, gapAfter });

    if (c === 0) {
      const picks = new Set<number>();
      if (sorted[0] !== undefined) picks.add(sorted[0]);
      for (let d = 1; d <= 3; d++) {
        if (focusRank - d >= 0) picks.add(sorted[focusRank - d]!);
        if (focusRank + d < sorted.length) picks.add(sorted[focusRank + d]!);
      }
      picks.delete(focus);
      rivalTraces = [...picks].map((i) => ({ carId: cars[i]!.id, trace: traceOf(setup, buffers, i) }));
    }
    done += 1;
    yield done / totalSteps;
  }

  // Monte-Carlo runs: identical random draws for every candidate.
  const distributions = candidates.map(() => new Float64Array(n));
  const positionSums = new Float64Array(candidates.length);
  const beats = candidates.map(() => new Float64Array(rivalIndices.length));
  const finishes = candidates.map(() => new Uint8Array(Math.max(1, runs)));
  for (let run = 0; run < runs; run++) {
    const runSeed = (request.seed ^ Math.imul(run + 1, 2246822519)) >>> 0;
    // The scenario (neutralisations, rivals' timing) is drawn once per run and shared by all candidates.
    const scenario = new SeededRandom(runSeed);
    const neutralisations = drawNeutralisations(setup, scenario);
    const rivalPlans = basePlans.map((plan, i) => (i === focus || cars[i]!.plannedStops ? plan : jitter(plan, cars[i]!.lapsCompleted + 1, raceLaps, scenario)));
    for (let c = 0; c < candidates.length; c++) {
      const plans = rivalPlans.map((plan, i) => (i === focus ? focusStops[c]! : plan));
      simulate(setup, buffers, plans, new SeededRandom(runSeed + 1), neutralisations);
      const position = finishingPosition(buffers, focus, n);
      distributions[c]![position - 1] = distributions[c]![position - 1]! + 1;
      positionSums[c] = positionSums[c]! + position;
      finishes[c]![run] = position;
      rivalIndices.forEach((r, index) => {
        if (finishingPosition(buffers, r, n) > position) beats[c]![index] = beats[c]![index]! + 1;
      });
      done += 1;
      yield done / totalSteps;
    }
  }

  const percentile = (values: Uint8Array, q: number): number => {
    if (runs === 0) return 0;
    const sortedValues = Array.from(values).sort((a, b) => a - b);
    return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, Math.round(q * (sortedValues.length - 1))))]!;
  };

  const projections: CandidateProjection[] = candidates.map((candidate, c) => {
    const e = expected[c]!;
    const lastPoint = e.trace[e.trace.length - 1];
    const expectedPosition = lastPoint ? lastPoint.position : focusCar.position;
    const distribution = Array.from(distributions[c]!, (count) => (runs > 0 ? count / runs : 0));
    if (runs === 0) distribution[clamp(expectedPosition, 1, n) - 1] = 1;
    // Gaps are "focus minus rival" at the line: positive while the rival is ahead.
    const rivals: UndercutOutcome[] = rivalIndices.map((r, index) => ({
      rivalId: cars[r]!.id,
      gapNow: e.gapNow[index]!,
      gapAfter: e.gapAfter[index]!,
      successProbability: runs > 0 ? beats[c]![index]! / runs : e.gapAfter[index]! < 0 ? 1 : 0,
    }));
    return {
      candidate,
      trace: e.trace,
      stops: focusStops[c]!.map((s) => ({ ...s })),
      expectedRaceTime: e.raceTime,
      expectedFinish: runs > 0 ? positionSums[c]! / runs : expectedPosition,
      finishP10: runs > 0 ? percentile(finishes[c]!, 0.1) : expectedPosition,
      finishP50: runs > 0 ? percentile(finishes[c]!, 0.5) : expectedPosition,
      finishP90: runs > 0 ? percentile(finishes[c]!, 0.9) : expectedPosition,
      finishDistribution: distribution,
      rejoinPosition: e.rejoin.position,
      rejoinGapAhead: e.rejoin.ahead,
      rejoinGapBehind: e.rejoin.behind,
      rivals,
    };
  });

  let recommended = projections[0];
  for (const projection of projections) {
    if (!recommended) {
      recommended = projection;
      continue;
    }
    const delta = projection.expectedFinish - recommended.expectedFinish;
    if (delta < -0.05 || (Math.abs(delta) <= 0.05 && projection.expectedRaceTime < recommended.expectedRaceTime)) recommended = projection;
  }

  yield 1;
  return {
    focusCarId: request.focusCarId,
    fromLap: focusLap,
    raceTime: request.raceTime,
    candidates: projections,
    rivalTraces,
    recommendedId: recommended ? recommended.candidate.id : '',
    monteCarloRuns: runs,
  };
}

/** Part of a pit loss already included in a car's time for `lap` (so "gap now" is not polluted by a stop this lap). */
function inLapShare(setup: Setup, buffers: Buffers, car: number, lap: number): number {
  const stride = setup.raceLaps + 2;
  if (buffers.lapPit[car * stride + lap] !== 1) return 0;
  return pitLossUnderFlag(setup.track, setup.ongoing ? setup.ongoing.kind : 'GREEN') * PIT_LOSS_IN_LAP_SHARE;
}

/** Synchronous convenience wrapper that drains `runProjection`. */
export function projectRace(request: ProjectionRequest): ProjectionResult {
  const generator = runProjection(request);
  let step = generator.next();
  while (!step.done) step = generator.next();
  return step.value;
}
