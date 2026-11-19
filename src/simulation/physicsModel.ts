/**
 * Lap-time physics of the Pit Wall Strategy Engine.
 *
 * Every model here is a pure function. The race engine (Web Worker) integrates them continuously, the AI
 * strategist and the Monte-Carlo projection evaluate them lap by lap, and the UI uses them to draw the
 * strategy planner – so all three always agree on what a tyre, a kilo of fuel or a pit stop is worth.
 *
 *   lapTime = base + car + fuel + compound + degradation + warm-up + wetness + dirtyAir
 *             + paceMode + ers + trackEvolution − drs
 *
 * All "per reference lap" quantities are defined for a 90 s lap and scaled by `lapScale(track)`.
 */
import type {
  DrsZone,
  ErsMode,
  FlagStatus,
  PaceMode,
  RandomSource,
  StintPlan,
  TrackDefinition,
  TyreClass,
  TyreCompound,
} from './types';

// ─────────────────────────────────────────────────────────────── constants ──

/** Lap length (s) for which all per-lap effects are specified. */
export const REFERENCE_LAP = 90;
/** Stationary time already included in `TrackDefinition.pitLossSeconds`. */
export const NOMINAL_STATIONARY_TIME = 2.5;
/** Share of the pit loss that lands on the in-lap in lap-by-lap simulations (the rest hits the out-lap). */
export const PIT_LOSS_IN_LAP_SHARE = 0.4;
/** Following closer than this (s) costs downforce. */
export const DIRTY_AIR_RANGE = 1.2;
/** Gap (s) under which the full dirty-air penalty applies. */
export const DIRTY_AIR_FULL = 0.3;
/** Peak dirty-air loss (s per reference lap) at sensitivity 1. */
export const DIRTY_AIR_MAX_PENALTY = 0.55;
/** DRS: maximum gap at the detection point (s). */
export const DRS_DETECTION_GAP = 1.0;
/** DRS: relative speed gain with the flap open. */
export const DRS_SPEED_GAIN = 0.042;
/** DRS is disabled by race control above this track wetness. */
export const DRS_MAX_WETNESS = 0.2;
/** DRS is enabled this many laps after the start or a restart. */
export const DRS_ENABLE_LAPS = 2;
/** Typical full-throttle speed on a DRS straight (m/s), used to convert a zone length into time. */
const DRS_STRAIGHT_SPEED = 85;
/** Reference fuel mass used to normalise the fuel-load effect on tyre wear (kg). */
const REFERENCE_FUEL = 110;

/** Lap-time multipliers while the race is neutralised. */
export const NEUTRALISED_PACE = {
  /** Train behind the safety car. */
  SC: 1.5,
  /** Cars catching the safety-car train at the prescribed delta. */
  SC_CATCH_UP: 1.22,
  VSC: 1.4,
  /** Lift through a sector under local yellow. */
  YELLOW_SECTOR: 1.035,
} as const;

/** Fraction of the green-flag pit loss that a stop costs under each flag. */
export const PIT_LOSS_FACTOR: Record<FlagStatus, number> = {
  GREEN: 1,
  YELLOW: 1,
  VSC: 0.65,
  SC: 0.55,
  RED: 0,
  CHEQUERED: 1,
};

export const PACE_MODES: Record<PaceMode, { lapDelta: number; wear: number; fuel: number; label: string }> = {
  PUSH: { lapDelta: -0.38, wear: 1.22, fuel: 1.035, label: 'Push' },
  BALANCED: { lapDelta: 0, wear: 1, fuel: 1, label: 'Balanced' },
  CONSERVE: { lapDelta: 0.48, wear: 0.78, fuel: 0.93, label: 'Lift & Coast' },
};

/** `chargePerLap` is the change of battery state of charge (0..1) over one racing lap. */
export const ERS_MODES: Record<ErsMode, { lapDelta: number; chargePerLap: number; label: string }> = {
  OVERTAKE: { lapDelta: -0.32, chargePerLap: -0.26, label: 'Overtake' },
  BALANCED: { lapDelta: 0, chargePerLap: 0.03, label: 'Balanced' },
  HARVEST: { lapDelta: 0.28, chargePerLap: 0.24, label: 'Harvest' },
};

export interface CompoundSpec {
  compound: TyreCompound;
  tyreClass: TyreClass;
  label: string;
  letter: string;
  /** Laps to the cliff (wear = 1) on a reference track at balanced pace and mid fuel load. */
  lifeLaps: number;
  /** Degradation at wear = 1 (s per reference lap): linear and quadratic parts. */
  degLinear: number;
  degQuadratic: number;
  /** Loss with stone-cold tyres, readiness = 0 (s per reference lap). */
  warmupPenalty: number;
  /** Laps at racing speed for the "coldness" (1 − readiness) to decay by a factor e. */
  warmupLaps: number;
  /** Readiness when the set comes out of the blankets. */
  blanketReadiness: number;
  /** Operating temperature window (°C), for display. */
  windowC: [number, number];
}

export const COMPOUNDS: Record<TyreCompound, CompoundSpec> = {
  SOFT: {
    compound: 'SOFT', tyreClass: 'SLICK', label: 'Soft', letter: 'S',
    lifeLaps: 16, degLinear: 1.3, degQuadratic: 0.9,
    warmupPenalty: 2.4, warmupLaps: 0.25, blanketReadiness: 0.5, windowC: [90, 110],
  },
  MEDIUM: {
    compound: 'MEDIUM', tyreClass: 'SLICK', label: 'Medium', letter: 'M',
    lifeLaps: 28, degLinear: 1.25, degQuadratic: 0.75,
    warmupPenalty: 3.4, warmupLaps: 0.4, blanketReadiness: 0.5, windowC: [95, 115],
  },
  HARD: {
    compound: 'HARD', tyreClass: 'SLICK', label: 'Hard', letter: 'H',
    lifeLaps: 42, degLinear: 1.15, degQuadratic: 0.65,
    warmupPenalty: 4.4, warmupLaps: 0.5, blanketReadiness: 0.5, windowC: [105, 125],
  },
  INTER: {
    compound: 'INTER', tyreClass: 'INTER', label: 'Intermediate', letter: 'I',
    lifeLaps: 30, degLinear: 1.2, degQuadratic: 0.7,
    warmupPenalty: 4.0, warmupLaps: 0.4, blanketReadiness: 0.45, windowC: [65, 85],
  },
  WET: {
    compound: 'WET', tyreClass: 'WET', label: 'Full Wet', letter: 'W',
    lifeLaps: 36, degLinear: 1.1, degQuadratic: 0.6,
    warmupPenalty: 4.5, warmupLaps: 0.5, blanketReadiness: 0.4, windowC: [50, 70],
  },
};

export const DRY_COMPOUNDS: readonly TyreCompound[] = ['SOFT', 'MEDIUM', 'HARD'];
export const ALL_COMPOUNDS: readonly TyreCompound[] = ['SOFT', 'MEDIUM', 'HARD', 'INTER', 'WET'];

/** Wear beyond which the cliff term kicks in. */
export const CLIFF_WEAR = 1;
const CLIFF_SCALE = 0.55;
const CLIFF_RATE = 6.5;
const CLIFF_MAX = 14;

// ───────────────────────────────────────────────────────────────── helpers ──

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Scale factor between this track's lap and the 90 s reference lap. */
export function lapScale(track: TrackDefinition): number {
  return track.baseLapTime / REFERENCE_LAP;
}

export function isSlick(compound: TyreCompound): boolean {
  return COMPOUNDS[compound].tyreClass === 'SLICK';
}

// ─────────────────────────────────────────────────────────────────── tyres ──

/** Intrinsic pace offset of a dry compound versus the SOFT at this track (s). Zero for INTER/WET. */
export function compoundPaceDelta(track: TrackDefinition, compound: TyreCompound): number {
  switch (compound) {
    case 'SOFT':
      return 0;
    case 'MEDIUM':
      return track.compoundGap[0];
    case 'HARD':
      return track.compoundGap[0] + track.compoundGap[1];
    default:
      return 0;
  }
}

/**
 * Non-linear degradation curve (s per reference lap) as a function of wear.
 *   deg(w) = k1·w + k2·w²                              optimal window, w ≤ 1
 *          + 0.55·(exp(6.5·(w − 1)) − 1)               the "cliff", w > 1
 */
export function tyreDegradation(compound: TyreCompound, wear: number): number {
  const spec = COMPOUNDS[compound];
  const w = Math.max(0, wear);
  let loss = spec.degLinear * w + spec.degQuadratic * w * w;
  if (w > CLIFF_WEAR) {
    loss += Math.min(CLIFF_MAX, CLIFF_SCALE * (Math.exp(CLIFF_RATE * (w - CLIFF_WEAR)) - 1));
  }
  return loss;
}

/** Warm-up phase: loss (s per reference lap) while the tyre is below its window. */
export function warmupPenalty(compound: TyreCompound, readiness: number): number {
  return COMPOUNDS[compound].warmupPenalty * (1 - clamp(readiness, 0, 1));
}

/** Warm-up time constant in laps: slicks struggle to come in on a cold or damp track. */
export function warmupTimeConstant(compound: TyreCompound, trackTempC = 35, trackWetness = 0): number {
  const spec = COMPOUNDS[compound];
  const cold = 1 + clamp((32 - trackTempC) * 0.02, -0.2, 0.5);
  const damp = spec.tyreClass === 'SLICK' ? 1 + 1.4 * clamp(trackWetness, 0, 1) : 1;
  return spec.warmupLaps * cold * damp;
}

/**
 * Thermal readiness after running `laps` laps towards `target` (1 at racing speed, lower behind a
 * safety car). Exponential relaxation, so the closed form is exact for any step size.
 */
export function readinessAfter(readiness: number, laps: number, timeConstantLaps: number, target = 1): number {
  if (laps <= 0) return readiness;
  return target + (readiness - target) * Math.exp(-laps / Math.max(1e-6, timeConstantLaps));
}

/** Mean warm-up loss (s per reference lap) over the next lap, starting from `readiness`. */
export function meanWarmupPenaltyOverLap(compound: TyreCompound, readiness: number, timeConstantLaps: number): number {
  const tau = Math.max(1e-6, timeConstantLaps);
  const coldness = 1 - clamp(readiness, 0, 1);
  return COMPOUNDS[compound].warmupPenalty * coldness * tau * (1 - Math.exp(-1 / tau));
}

/** Indicative tread temperature (°C) for the telemetry display. */
export function tyreTemperatureC(
  compound: TyreCompound,
  readiness: number,
  opts: { paceMode?: PaceMode; dirtyAir?: number; trackWetness?: number; trackTempC?: number } = {},
): number {
  const [lo, hi] = COMPOUNDS[compound].windowC;
  const centre = (lo + hi) / 2;
  const cold = Math.min(lo - 30, 20 + (opts.trackTempC ?? 35) * 0.9);
  const wetness = opts.trackWetness ?? 0;
  let temp = cold + clamp(readiness, 0, 1) * (centre - cold);
  if (opts.paceMode === 'PUSH') temp += 5;
  if (opts.paceMode === 'CONSERVE') temp -= 5;
  temp += 7 * clamp(opts.dirtyAir ?? 0, 0, 1);
  if (isSlick(compound)) temp -= 28 * clamp(wetness, 0, 1);
  if (compound === 'INTER') temp += 30 * clamp((0.2 - wetness) / 0.2, 0, 1);
  if (compound === 'WET') temp += 40 * clamp((0.45 - wetness) / 0.45, 0, 1);
  return temp;
}

export interface WearInput {
  track: TrackDefinition;
  compound: TyreCompound;
  fuelKg: number;
  paceMode?: PaceMode;
  /** Driver tyre management multiplier (default 1). */
  wearFactor?: number;
  /** 0..1 intensity of dirty air (1 when right behind another car). */
  dirtyAir?: number;
  trackWetness?: number;
  trackTempC?: number;
  flag?: FlagStatus;
}

/** Wet-weather tyres overheat and tear on a dry track; slicks barely wear when they have no grip. */
export function wetnessWearFactor(compound: TyreCompound, trackWetness: number): number {
  const w = clamp(trackWetness, 0, 1);
  switch (COMPOUNDS[compound].tyreClass) {
    case 'INTER':
      return 1 + 3.5 * Math.pow(clamp((0.25 - w) / 0.25, 0, 1), 1.5);
    case 'WET':
      return 1 + 5 * Math.pow(clamp((0.5 - w) / 0.5, 0, 1), 1.5);
    default:
      return 1 - 0.45 * w;
  }
}

/** Wear added per racing lap (fraction of useful life). */
export function wearPerLap(input: WearInput): number {
  const spec = COMPOUNDS[input.compound];
  const pace = PACE_MODES[input.paceMode ?? 'BALANCED'].wear;
  const fuel = (1 + 0.2 * (Math.max(0, input.fuelKg) / REFERENCE_FUEL)) / 1.1;
  const temp = 1 + clamp(((input.trackTempC ?? input.track.trackTempC) - 35) * 0.012, -0.15, 0.25);
  const air = 1 + 0.15 * clamp(input.dirtyAir ?? 0, 0, 1);
  const flag = input.flag === 'SC' ? 0.35 : input.flag === 'VSC' ? 0.45 : 1;
  return (
    (1 / spec.lifeLaps) *
    input.track.abrasiveness *
    input.track.tyreStress *
    pace *
    fuel *
    temp *
    air *
    flag *
    (input.wearFactor ?? 1) *
    wetnessWearFactor(input.compound, input.trackWetness ?? 0)
  );
}

/** Laps left before the cliff at the given wear rate. */
export function lapsToCliff(wear: number, wearRatePerLap: number): number {
  if (wearRatePerLap <= 0) return Infinity;
  return Math.max(0, (CLIFF_WEAR - wear) / wearRatePerLap);
}

/** Puncture / delamination hazard per lap once a tyre is run far beyond its cliff. */
export function punctureHazardPerLap(wear: number): number {
  if (wear <= 1.15) return 0;
  const x = (wear - 1.15) / 0.1;
  return Math.min(0.6, 0.02 * x * x);
}

// ───────────────────────────────────────────────────────────────── weather ──

/**
 * Lap-time loss (s per reference lap) of a compound on a track of given wetness, relative to a slick
 * on a dry track. The three families cross at `WEATHER_CROSSOVER`.
 */
export function wetnessPenalty(compound: TyreCompound, trackWetness: number): number {
  const w = clamp(trackWetness, 0, 1);
  switch (compound) {
    case 'INTER':
      return 4.5 + 9 * w + 3.5 * w * w + 60 * Math.pow(Math.max(0, w - 0.5), 2);
    case 'WET':
      return 9 + 6.5 * w + 2 * w * w;
    default: {
      const hardness = compound === 'HARD' ? 1.14 : compound === 'MEDIUM' ? 1.06 : 1;
      return 75 * Math.pow(Math.max(0, w - 0.03), 1.75) * hardness;
    }
  }
}

function solveCrossover(a: TyreCompound, b: TyreCompound, lo: number, hi: number): number {
  // wetnessPenalty(a) − wetnessPenalty(b) is negative below the crossover and positive above it.
  let low = lo;
  let high = hi;
  for (let i = 0; i < 48; i++) {
    const mid = (low + high) / 2;
    if (wetnessPenalty(a, mid) - wetnessPenalty(b, mid) < 0) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Track wetness at which the optimal tyre family changes (derived from the penalty curves). */
export const WEATHER_CROSSOVER = {
  /** Above this wetness an intermediate is faster than a soft slick. */
  slickToInter: solveCrossover('SOFT', 'INTER', 0.03, 0.6),
  /** Above this wetness a full wet is faster than an intermediate. */
  interToWet: solveCrossover('INTER', 'WET', 0.4, 1),
} as const;

export function bestTyreClass(trackWetness: number): TyreClass {
  if (trackWetness >= WEATHER_CROSSOVER.interToWet) return 'WET';
  if (trackWetness >= WEATHER_CROSSOVER.slickToInter) return 'INTER';
  return 'SLICK';
}

/** Equilibrium track wetness under constant rain of the given intensity. */
export function equilibriumWetness(rainIntensity: number): number {
  const r = clamp(rainIntensity, 0, 1);
  return r <= 0 ? 0 : Math.min(1, 1.15 * Math.pow(r, 0.75));
}

/**
 * Track wetness after `dt` seconds: first-order relaxation towards the rain equilibrium. The track
 * soaks faster in heavy rain than it dries, and dries faster when hot and under traffic.
 */
export function stepTrackWetness(
  wetness: number,
  rainIntensity: number,
  dt: number,
  opts: { trackTempC?: number; carsOnTrack?: number } = {},
): number {
  const target = equilibriumWetness(rainIntensity);
  let tau: number;
  if (target > wetness) {
    tau = 150 / (0.3 + clamp(rainIntensity, 0, 1));
  } else {
    const heat = 1 + clamp(((opts.trackTempC ?? 30) - 30) * 0.02, -0.3, 0.4);
    const traffic = 0.7 + 0.3 * clamp((opts.carsOnTrack ?? 20) / 20, 0, 1);
    tau = 520 / (heat * traffic);
  }
  return clamp(target + (wetness - target) * Math.exp(-dt / tau), 0, 1);
}

// ─────────────────────────────────────────────────── fuel, aero, modes, ERS ──

/** Lap-time cost of the fuel on board (s): ≈0.03 s per kg. */
export function fuelPenalty(track: TrackDefinition, fuelKg: number): number {
  return Math.max(0, fuelKg) * track.fuelEffectPerKg;
}

/** Fuel burnt over one lap (kg). */
export function fuelBurnPerLap(track: TrackDefinition, paceMode: PaceMode = 'BALANCED', flag: FlagStatus = 'GREEN'): number {
  const flagFactor = flag === 'SC' ? 0.45 : flag === 'VSC' ? 0.55 : 1;
  return track.fuelPerLapKg * PACE_MODES[paceMode].fuel * flagFactor;
}

/** Fuel on the grid: teams under-fuel slightly and rely on lift-and-coast or neutralisations. */
export function startingFuelKg(track: TrackDefinition, raceLaps: number): number {
  return track.fuelPerLapKg * raceLaps * 0.994;
}

/** Share of a lap's fuel that lift-and-coast saves compared with balanced running. */
export const LIFT_AND_COAST_SAVING = 1 - PACE_MODES.CONSERVE.fuel;

/** 0..1 intensity of the wake of the car ahead for a given gap (s). */
export function dirtyAirIntensity(gapSeconds: number | null | undefined): number {
  if (gapSeconds === null || gapSeconds === undefined || gapSeconds >= DIRTY_AIR_RANGE) return 0;
  if (gapSeconds <= DIRTY_AIR_FULL) return 1;
  const x = (DIRTY_AIR_RANGE - gapSeconds) / (DIRTY_AIR_RANGE - DIRTY_AIR_FULL);
  return x * x;
}

/** Dirty-air lap-time loss (s) when following within 1.2 s. */
export function dirtyAirPenalty(track: TrackDefinition, gapSeconds: number | null | undefined): number {
  return DIRTY_AIR_MAX_PENALTY * track.dirtyAirSensitivity * dirtyAirIntensity(gapSeconds) * lapScale(track);
}

/** Length of a DRS zone as a lap distance fraction (handles zones wrapping the line). */
export function drsZoneLength(zone: DrsZone): number {
  const len = zone.end - zone.start;
  return len >= 0 ? len : len + 1;
}

/** Time gained through one DRS zone with the flap open (s). */
export function drsZoneGain(track: TrackDefinition, zone: DrsZone): number {
  const metres = drsZoneLength(zone) * track.lengthKm * 1000;
  return (metres / DRS_STRAIGHT_SPEED) * (DRS_SPEED_GAIN / (1 + DRS_SPEED_GAIN));
}

/** Time gained over a lap with DRS open in every zone (s). */
export function drsLapGain(track: TrackDefinition): number {
  let gain = 0;
  for (const zone of track.drsZones) gain += drsZoneGain(track, zone);
  return gain;
}

/** Lap-time effect of the hybrid mode (s per reference lap); Overtake does nothing on an empty battery. */
export function ersLapDelta(mode: ErsMode, charge: number): number {
  if (mode === 'OVERTAKE') return charge > 0.02 ? ERS_MODES.OVERTAKE.lapDelta : 0.06;
  return ERS_MODES[mode].lapDelta;
}

/** Battery state of charge after `laps` laps in the given mode. */
export function ersChargeAfter(charge: number, mode: ErsMode, laps: number, flag: FlagStatus = 'GREEN'): number {
  const neutralised = flag === 'SC' || flag === 'VSC';
  const rate = neutralised ? 0.15 : ERS_MODES[mode].chargePerLap;
  return clamp(charge + rate * laps, 0, 1);
}

/** Lap-time loss on a green (un-rubbered) track (s per reference lap). */
export function trackEvolutionPenalty(gripLevel: number): number {
  return 0.7 * (1 - clamp(gripLevel, 0, 1));
}

/** Steady-state power-unit temperature (°C) for the given operating point. */
export function engineTempTarget(opts: {
  paceMode: PaceMode;
  ersMode: ErsMode;
  dirtyAir: number;
  airTempC: number;
  flag: FlagStatus;
}): number {
  let t = 104 + (opts.airTempC - 22) * 0.55 + 9 * clamp(opts.dirtyAir, 0, 1);
  if (opts.paceMode === 'PUSH') t += 8;
  if (opts.paceMode === 'CONSERVE') t -= 7;
  if (opts.ersMode === 'OVERTAKE') t += 2;
  if (opts.flag === 'SC' || opts.flag === 'VSC') t -= 5;
  return t;
}

/** Steady-state brake disc temperature (°C) for the given operating point. */
export function brakeTempTarget(opts: { paceMode: PaceMode; dirtyAir: number; airTempC: number; flag: FlagStatus }): number {
  let t = 640 + (opts.airTempC - 22) * 3 + 150 * clamp(opts.dirtyAir, 0, 1);
  if (opts.paceMode === 'PUSH') t += 90;
  if (opts.paceMode === 'CONSERVE') t -= 80;
  if (opts.flag === 'SC' || opts.flag === 'VSC') t -= 220;
  return t;
}

export const TEMP_LIMITS = {
  engineWarn: 121,
  engineCritical: 127,
  brakeWarn: 860,
  brakeCritical: 940,
} as const;

/** Multiplier on the mechanical failure hazard from running the power unit hot. */
export function overheatHazardFactor(engineTempC: number, brakeTempC: number): number {
  const e = Math.max(0, (engineTempC - 117) / 5);
  const b = Math.max(0, (brakeTempC - 880) / 60);
  return 1 + e * e * 1.6 + b * b * 0.8;
}

// ──────────────────────────────────────────────────────────────── lap time ──

export interface LapTimeInput {
  track: TrackDefinition;
  compound: TyreCompound;
  /** Wear at the point of evaluation (use the mid-lap value in lap-by-lap simulations). */
  wear: number;
  /** Thermal readiness 0..1; defaults to 1 (tyre in its window). */
  readiness?: number;
  fuelKg: number;
  trackWetness?: number;
  /** Car + driver deficit to the reference at this track (s/lap). */
  paceOffset?: number;
  paceMode?: PaceMode;
  ersMode?: ErsMode;
  ersCharge?: number;
  /** Gap to the car ahead on track (s); null/undefined in clean air. */
  gapAhead?: number | null;
  /** Share of the lap's DRS zones run with the flap open (0..1). */
  drsFraction?: number;
  /** Rubbered-in grip level 0..1; defaults to 1. */
  gripLevel?: number;
  /** Driver wet-weather skill 0..1; defaults to 1. */
  wetSkill?: number;
}

export interface LapTimeBreakdown {
  total: number;
  base: number;
  car: number;
  fuel: number;
  compound: number;
  degradation: number;
  warmup: number;
  wetness: number;
  dirtyAir: number;
  paceMode: number;
  ers: number;
  evolution: number;
  /** Positive number of seconds gained with DRS. */
  drs: number;
}

/** Full lap-time model with its additive breakdown. */
export function computeLapTime(input: LapTimeInput): LapTimeBreakdown {
  const { track, compound } = input;
  const scale = lapScale(track);
  const wetnessLevel = input.trackWetness ?? 0;

  const base = track.baseLapTime;
  const car = input.paceOffset ?? 0;
  const fuel = fuelPenalty(track, input.fuelKg);
  const compoundDelta = compoundPaceDelta(track, compound);
  const degradation = tyreDegradation(compound, input.wear) * scale;
  const warmup = warmupPenalty(compound, input.readiness ?? 1) * scale;
  const wetRaw = wetnessPenalty(compound, wetnessLevel) * scale;
  const wetness = wetRaw * (1 + 0.25 * (1 - clamp(input.wetSkill ?? 1, 0, 1)) * (wetnessLevel > 0.05 ? 1 : 0));
  const dirtyAir = dirtyAirPenalty(track, input.gapAhead);
  const paceMode = PACE_MODES[input.paceMode ?? 'BALANCED'].lapDelta * scale;
  const ers = ersLapDelta(input.ersMode ?? 'BALANCED', input.ersCharge ?? 0.5) * scale;
  const evolution = trackEvolutionPenalty(input.gripLevel ?? 1) * scale;
  const drs = clamp(input.drsFraction ?? 0, 0, 1) * drsLapGain(track);

  const total =
    base + car + fuel + compoundDelta + degradation + warmup + wetness + dirtyAir + paceMode + ers + evolution - drs;

  return {
    total,
    base,
    car,
    fuel,
    compound: compoundDelta,
    degradation,
    warmup,
    wetness,
    dirtyAir,
    paceMode,
    ers,
    evolution,
    drs,
  };
}

/** Convenience wrapper returning only the lap time (s). */
export function lapTime(input: LapTimeInput): number {
  return computeLapTime(input).total;
}

// ─────────────────────────────────────────────────────────────── pit stops ──

/** Time a stop costs versus staying on track under the given flag (s), nominal stationary time included. */
export function pitLossUnderFlag(track: TrackDefinition, flag: FlagStatus = 'GREEN'): number {
  return track.pitLossSeconds * PIT_LOSS_FACTOR[flag];
}

/** Part of the pit loss spent driving the pit lane at the speed limiter (s), i.e. without the stop itself. */
export function pitLaneTransitLoss(track: TrackDefinition, flag: FlagStatus = 'GREEN'): number {
  return Math.max(0, pitLossUnderFlag(track, flag) - NOMINAL_STATIONARY_TIME);
}

/** Total time lost by a stop with an actual stationary time and an optional queue (s). */
export function pitStopTimeLoss(
  track: TrackDefinition,
  flag: FlagStatus,
  stationaryTime: number = NOMINAL_STATIONARY_TIME,
  queueTime = 0,
): number {
  return pitLaneTransitLoss(track, flag) + stationaryTime + queueTime;
}

export const PIT_STOP = {
  /** Standard deviation of a clean stop (s). */
  sigma: 0.22,
  /** Probability of a problem (slow gun, sticking wheel). */
  slowProbability: 0.06,
  slowMin: 1.5,
  slowMax: 6.5,
  /** Time the crew needs to reset between two cars of a double stack (s). */
  crewResetTime: 1.2,
  /** Extra stationary time for the second car of a double stack (s). */
  doubleStackPenalty: 0.25,
} as const;

/** Draws a stationary time for a crew whose clean-stop average is `crewMean` seconds. */
export function sampleStationaryTime(rng: RandomSource, crewMean: number): { time: number; slow: boolean } {
  const clean = Math.max(1.75, crewMean + Math.abs(rng.normal()) * PIT_STOP.sigma - 0.1);
  if (rng.chance(PIT_STOP.slowProbability)) {
    return { time: clean + rng.range(PIT_STOP.slowMin, PIT_STOP.slowMax), slow: true };
  }
  return { time: clean, slow: false };
}

/** Time the second car of a double stack waits, given the gap at pit entry and the first car's stop. */
export function doubleStackWait(gapSeconds: number, firstStationaryTime: number): number {
  return Math.max(0, firstStationaryTime + PIT_STOP.crewResetTime - Math.max(0, gapSeconds));
}

function normalCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * Double-stack risk: expected queueing time and probability of queueing for the second car, integrating
 * over the distribution of the first car's stationary time (clean stops + slow-stop tail).
 */
export function doubleStackRisk(gapSeconds: number, crewMean: number): { expectedWait: number; queueProbability: number } {
  const gap = Math.max(0, gapSeconds);
  const mean = crewMean + 0.08;
  const sigma = PIT_STOP.sigma;
  // Clean stop: wait = max(0, S + reset − gap), S ~ N(mean, sigma)
  const threshold = gap - PIT_STOP.crewResetTime;
  const z = (threshold - mean) / sigma;
  const pClean = 1 - normalCdf(z);
  const pdf = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const waitClean = (mean - threshold) * pClean + sigma * pdf;
  // Slow stop: uniform extra delay on top of the mean
  let waitSlow = 0;
  let pSlow = 0;
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    const extra = PIT_STOP.slowMin + ((i + 0.5) / steps) * (PIT_STOP.slowMax - PIT_STOP.slowMin);
    const w = mean + extra - threshold;
    if (w > 0) {
      waitSlow += w / steps;
      pSlow += 1 / steps;
    }
  }
  const ps = PIT_STOP.slowProbability;
  return {
    expectedWait: Math.max(0, (1 - ps) * waitClean + ps * waitSlow),
    queueProbability: clamp((1 - ps) * pClean + ps * pSlow, 0, 1),
  };
}

// ───────────────────────────────────────────────────────────── overtaking ──

/** Lap-time advantage (s/lap) that gives an attacker an even chance at each overtaking opportunity. */
export function overtakeDeltaRequired(track: TrackDefinition): number {
  const d = clamp(track.overtakingDifficulty, 0, 1);
  // Quadratic for normal circuits, plus a wall for street circuits where passing is all but impossible.
  return (0.3 + 1.9 * d * d + 2.6 * Math.pow(d, 12)) * lapScale(track);
}

export interface OvertakeModifiers {
  /** Attacker has DRS open at this opportunity. */
  drs?: boolean;
  attackerErs?: ErsMode;
  defenderErs?: ErsMode;
  /** Defender has been told to defend. */
  defending?: boolean;
  /** Attacker racecraft minus defender racecraft, in [-1, 1]. */
  racecraftDelta?: number;
  trackWetness?: number;
}

/** Probability that a pass succeeds at one overtaking opportunity. */
export function overtakeProbability(track: TrackDefinition, paceAdvantage: number, mods: OvertakeModifiers = {}): number {
  const scale = lapScale(track);
  const required = overtakeDeltaRequired(track);
  let advantage = paceAdvantage;
  if (mods.drs) advantage += 0.15 * scale;
  if (mods.attackerErs === 'OVERTAKE') advantage += 0.22 * scale;
  if (mods.attackerErs === 'HARVEST') advantage -= 0.18 * scale;
  if (mods.defenderErs === 'OVERTAKE') advantage -= 0.18 * scale;
  if (mods.defenderErs === 'HARVEST') advantage += 0.15 * scale;
  if (mods.defending) advantage -= 0.3 * scale;
  advantage += 0.3 * scale * clamp(mods.racecraftDelta ?? 0, -1, 1);
  // A wet track opens up lines and mistakes: passing gets easier.
  advantage += 0.25 * scale * clamp(mods.trackWetness ?? 0, 0, 1);
  const x = (advantage - required) / (0.25 * required + 0.06);
  return clamp(1 / (1 + Math.exp(-2.4 * x)), 0.005, 0.97);
}

// ─────────────────────────────────────────────────────────────── incidents ──

/**
 * Expected number of incidents per car and per lap, calibrated so that the probability of at least one
 * Safety Car (or VSC) over a full dry race matches the circuit's historical figure:
 *   P(≥1) = 1 − exp(−rate · cars · laps)  ⇒  rate = −ln(1 − P) / (cars · laps)
 */
export function incidentRates(track: TrackDefinition, raceLaps: number, cars = 20): { safetyCar: number; vsc: number; yellow: number } {
  const exposure = Math.max(1, cars * raceLaps);
  const safetyCar = -Math.log(1 - clamp(track.safetyCarProbability, 0, 0.98)) / exposure;
  const vsc = -Math.log(1 - clamp(track.vscProbability, 0, 0.98)) / exposure;
  return { safetyCar, vsc, yellow: 1.5 * (safetyCar + vsc) + 0.6 / exposure };
}

/** Context multiplier on the driver-error hazard (wrong tyres in the rain, worn tyres, wheel-to-wheel…). */
export function driverErrorFactor(opts: {
  compound: TyreCompound;
  wear: number;
  trackWetness: number;
  paceMode: PaceMode;
  inBattle: boolean;
  firstLap: boolean;
  errorProneness: number;
  wetSkill: number;
}): number {
  let f = opts.errorProneness;
  const w = clamp(opts.trackWetness, 0, 1);
  // Any wet running is riskier; the wrong tyre family is far worse.
  f *= 1 + 2.2 * w * (1.4 - opts.wetSkill);
  const best = bestTyreClass(w);
  const own = COMPOUNDS[opts.compound].tyreClass;
  if (own === 'SLICK' && best !== 'SLICK') f *= 1 + 60 * Math.pow(w - WEATHER_CROSSOVER.slickToInter + 0.05, 2) + 3;
  if (own === 'INTER' && best === 'WET') f *= 2.5;
  if (opts.wear > 1) f *= 1 + 4 * (opts.wear - 1);
  if (opts.paceMode === 'PUSH') f *= 1.35;
  if (opts.paceMode === 'CONSERVE') f *= 0.75;
  if (opts.inBattle) f *= 1.8;
  if (opts.firstLap) f *= 6;
  return f;
}

// ───────────────────────────────────────────── stints & strategy evaluation ──

export interface StintSimulation {
  lapTimes: number[];
  total: number;
  endWear: number;
  endFuelKg: number;
  endReadiness: number;
}

export interface StintOptions {
  track: TrackDefinition;
  compound: TyreCompound;
  /** Number of laps in the stint. */
  laps: number;
  /** Wear and laps already on the set (used tyres). */
  initialWear?: number;
  /** Fuel on board at the start of the stint (kg). */
  startFuelKg: number;
  /** Readiness at the start: defaults to the compound's blanket readiness (fresh from the pits). */
  initialReadiness?: number;
  paceOffset?: number;
  wearFactor?: number;
  paceMode?: PaceMode;
  /** Constant wetness, or a function of the lap index within the stint (0-based). */
  trackWetness?: number | ((lapIndex: number) => number);
  gripLevel?: number;
}

/** Clean-air, lap-by-lap simulation of one stint. */
export function simulateStint(opts: StintOptions): StintSimulation {
  const { track, compound } = opts;
  const lapTimes: number[] = [];
  let wear = opts.initialWear ?? 0;
  let fuel = opts.startFuelKg;
  let readiness = opts.initialReadiness ?? COMPOUNDS[compound].blanketReadiness;
  let total = 0;
  const scale = lapScale(track);
  for (let i = 0; i < opts.laps; i++) {
    const wetness = typeof opts.trackWetness === 'function' ? opts.trackWetness(i) : (opts.trackWetness ?? 0);
    const rate = wearPerLap({
      track,
      compound,
      fuelKg: fuel,
      paceMode: opts.paceMode,
      wearFactor: opts.wearFactor,
      trackWetness: wetness,
    });
    const tau = warmupTimeConstant(compound, track.trackTempC, wetness);
    const warm = meanWarmupPenaltyOverLap(compound, readiness, tau) * scale;
    const time =
      lapTime({
        track,
        compound,
        wear: wear + rate / 2,
        readiness: 1,
        fuelKg: fuel,
        trackWetness: wetness,
        paceOffset: opts.paceOffset,
        paceMode: opts.paceMode,
        gripLevel: opts.gripLevel,
      }) + warm;
    lapTimes.push(time);
    total += time;
    wear += rate;
    readiness = readinessAfter(readiness, 1, tau, 1);
    fuel = Math.max(0, fuel - fuelBurnPerLap(track, opts.paceMode ?? 'BALANCED'));
  }
  return { lapTimes, total, endWear: wear, endFuelKg: fuel, endReadiness: readiness };
}

export interface StintSummary {
  compound: TyreCompound;
  startLap: number;
  endLap: number;
  laps: number;
  time: number;
  averageLap: number;
  endWear: number;
  /** Laps run past the cliff (0 when the stint ends inside the tyre's life). */
  lapsPastCliff: number;
}

export interface StrategyEvaluation {
  /** Total race time in clean air, pit stops included (s). */
  totalTime: number;
  lapTimes: number[];
  stints: StintSummary[];
  pitStops: number;
  /** Time spent in the pit lane overall (s). */
  pitTime: number;
  /** False when the plan breaks a rule or is not runnable. */
  valid: boolean;
  issues: string[];
}

/** Track wetness a compound is designed for: used to evaluate a stint when no forecast is supplied. */
export function nominalWetness(compound: TyreCompound): number {
  switch (COMPOUNDS[compound].tyreClass) {
    case 'INTER':
      return 0.45;
    case 'WET':
      return 0.8;
    default:
      return 0;
  }
}

export interface StrategyEvaluationOptions {
  paceOffset?: number;
  wearFactor?: number;
  startFuelKg?: number;
  /**
   * Track wetness assumed for every stint. When omitted, each stint is evaluated in the conditions its
   * tyre is made for (dry for slicks, damp for intermediates, wet for full wets).
   */
  trackWetness?: number;
  /** Wear already on the set used for each stint (same order as the stints). */
  initialWear?: number[];
  /** Stationary time assumed at each stop (s). */
  stationaryTime?: number;
  /** Enforce the two-dry-compound rule (default true in dry conditions). */
  requireTwoCompounds?: boolean;
}

/**
 * Deterministic clean-air evaluation of a complete strategy. Used by the pre-race planner and as the
 * objective function of the AI strategy optimiser.
 */
export function evaluateStrategy(
  track: TrackDefinition,
  raceLaps: number,
  stints: readonly StintPlan[],
  opts: StrategyEvaluationOptions = {},
): StrategyEvaluation {
  const issues: string[] = [];
  const lapTimes: number[] = [];
  const summaries: StintSummary[] = [];
  const wetnessOf = (compound: TyreCompound): number => opts.trackWetness ?? nominalWetness(compound);
  const stopLoss = pitStopTimeLoss(track, 'GREEN', opts.stationaryTime ?? NOMINAL_STATIONARY_TIME);
  let fuel = opts.startFuelKg ?? startingFuelKg(track, raceLaps);
  let startLap = 1;
  let total = 0;

  if (stints.length === 0) issues.push('No stint defined');

  stints.forEach((stint, index) => {
    const isLast = index === stints.length - 1;
    const endLap = isLast ? raceLaps : clamp(Math.round(stint.endLap), 0, raceLaps);
    const laps = endLap - startLap + 1;
    if (laps <= 0) {
      issues.push(`Stint ${index + 1} has no laps`);
      return;
    }
    const initialWear = opts.initialWear?.[index] ?? 0;
    const sim = simulateStint({
      track,
      compound: stint.compound,
      laps,
      startFuelKg: fuel,
      initialWear,
      // The race start is made on tyres brought up to temperature on the formation lap.
      initialReadiness: index === 0 ? 0.85 : undefined,
      paceOffset: opts.paceOffset,
      wearFactor: opts.wearFactor,
      trackWetness: wetnessOf(stint.compound),
    });
    lapTimes.push(...sim.lapTimes);
    total += sim.total;
    fuel = sim.endFuelKg;
    const perLapWear = (sim.endWear - initialWear) / laps;
    const lapsPastCliff = sim.endWear > CLIFF_WEAR && perLapWear > 0 ? (sim.endWear - CLIFF_WEAR) / perLapWear : 0;
    if (lapsPastCliff > 0.5) {
      issues.push(
        `Stint ${index + 1} (${COMPOUNDS[stint.compound].label}) runs ${Math.round(lapsPastCliff)} laps past the cliff`,
      );
    }
    summaries.push({
      compound: stint.compound,
      startLap,
      endLap,
      laps,
      time: sim.total,
      averageLap: sim.total / laps,
      endWear: sim.endWear,
      lapsPastCliff,
    });
    startLap = endLap + 1;
  });

  // Each stop costs `stopLoss`: part of it on the in-lap, the rest on the following out-lap.
  const pitStops = Math.max(0, summaries.length - 1);
  let cursor = 0;
  for (let i = 0; i < pitStops; i++) {
    cursor += summaries[i]!.laps;
    const inLap = cursor - 1;
    const outLap = cursor;
    if (inLap >= 0 && inLap < lapTimes.length) lapTimes[inLap] = lapTimes[inLap]! + stopLoss * PIT_LOSS_IN_LAP_SHARE;
    if (outLap < lapTimes.length) lapTimes[outLap] = lapTimes[outLap]! + stopLoss * (1 - PIT_LOSS_IN_LAP_SHARE);
  }
  const pitTime = pitStops * stopLoss;
  total += pitTime;

  const lapsCovered = summaries.reduce((sum, s) => sum + s.laps, 0);
  if (lapsCovered !== raceLaps) issues.push(`Plan covers ${lapsCovered} of ${raceLaps} laps`);

  const allDry = stints.every((s) => isSlick(s.compound));
  const requireTwo = opts.requireTwoCompounds ?? (allDry && (opts.trackWetness ?? 0) < WEATHER_CROSSOVER.slickToInter);
  if (requireTwo && new Set(stints.map((s) => s.compound)).size < 2) {
    issues.push('Two different dry compounds must be used');
  }

  return {
    totalTime: total,
    lapTimes,
    stints: summaries,
    pitStops,
    pitTime,
    valid: issues.length === 0,
    issues,
  };
}
