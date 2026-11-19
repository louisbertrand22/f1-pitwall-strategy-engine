/** Builders shared by the strategist and projection tests: a plausible allocation, field and forecast. */
import { DRIVERS, TEAMS } from '../gridData';
import { lapScale, startingFuelKg } from '../physicsModel';
import { SeededRandom } from '../rng';
import type {
  ProjectionCarInput,
  ProjectionRequest,
  RacePlanInput,
  StrategicCarView,
  StrategyContext,
  TrackDefinition,
  TyreCompound,
  TyreSet,
  WeatherForecastPoint,
  WeatherState,
} from '../types';
import { TEST_TRACK } from './testTrack';

export function makeSet(id: string, compound: TyreCompound, wear = 0, laps = 0): TyreSet {
  return { id, compound, wear, laps, isNew: wear === 0, fitted: false };
}

/** Race-day allocation: 2 used softs, 2 mediums, 2 hards, 3 inters, 2 wets. */
export function makeSets(): TyreSet[] {
  return [
    makeSet('S1', 'SOFT', 0.2, 3),
    makeSet('S2', 'SOFT', 0.3, 4),
    makeSet('M1', 'MEDIUM'),
    makeSet('M2', 'MEDIUM', 0.12, 3),
    makeSet('H1', 'HARD'),
    makeSet('H2', 'HARD'),
    makeSet('I1', 'INTER'),
    makeSet('I2', 'INTER'),
    makeSet('I3', 'INTER'),
    makeSet('W1', 'WET'),
    makeSet('W2', 'WET'),
  ];
}

export function makeWeather(trackWetness = 0, rainIntensity = 0): WeatherState {
  return { rainIntensity, trackWetness, airTempC: 22, trackTempC: 34, gripLevel: 1 };
}

/** Forecast whose wetness goes linearly from `from` to `to` over `laps` laps, then stays there. */
export function makeForecast(from: number, to = from, laps = 6, raceTime = 0, lap = 1, lapSeconds = 92): WeatherForecastPoint[] {
  const points: WeatherForecastPoint[] = [];
  for (let i = 0; i <= 120; i++) {
    const ahead = (i * 20) / lapSeconds;
    const wetness = from + (to - from) * Math.min(1, ahead / Math.max(0.01, laps));
    points.push({ raceTime: raceTime + i * 20, lap: lap + ahead, rainIntensity: wetness * 0.7, rainLow: wetness * 0.5, rainHigh: wetness * 0.9, trackWetness: wetness });
  }
  return points;
}

export function planInput(overrides: Partial<RacePlanInput> = {}): RacePlanInput {
  const track = overrides.track ?? TEST_TRACK;
  const raceLaps = overrides.raceLaps ?? track.raceLaps;
  return {
    track,
    raceLaps,
    carId: 'NAK',
    gridPosition: 4,
    paceOffset: 0.2,
    wearFactor: 1,
    startFuelKg: startingFuelKg(track, raceLaps),
    sets: makeSets(),
    weather: makeWeather(),
    forecast: makeForecast(0),
    profile: { aggression: 0.5, weatherRisk: 0.5, reactivity: 0.8 },
    rng: new SeededRandom(11),
    ...overrides,
  };
}

export interface FieldOptions {
  track?: TrackDefinition;
  lap?: number;
  /** Seconds between consecutive cars. */
  spacing?: number;
  compound?: TyreCompound;
  tyreWear?: number;
  tyreAge?: number;
}

/** Twenty cars in grid-pace order, evenly spaced, all on the same tyres. */
export function makeField(options: FieldOptions = {}): StrategicCarView[] {
  const track = options.track ?? TEST_TRACK;
  const lap = options.lap ?? 20;
  const spacing = options.spacing ?? 2.5;
  const scale = lapScale(track);
  const entries = DRIVERS.map((driver) => {
    const team = TEAMS.find((t) => t.id === driver.teamId)!;
    return { driver, team, pace: (team.carPace + driver.paceDelta) * scale };
  }).sort((a, b) => a.pace - b.pace);
  const fuel = Math.max(0, startingFuelKg(track, track.raceLaps) - (lap - 1) * track.fuelPerLapKg);
  return entries.map((entry, index) => ({
    id: entry.driver.id,
    teamId: entry.team.id,
    position: index + 1,
    status: 'RACING',
    lapsCompleted: lap - 1,
    lapProgress: 0.9,
    gapToLeader: index * spacing,
    gapAhead: index === 0 ? null : spacing,
    gapBehind: index === entries.length - 1 ? null : spacing,
    carAheadId: index === 0 ? null : entries[index - 1]!.driver.id,
    carBehindId: index === entries.length - 1 ? null : entries[index + 1]!.driver.id,
    compound: options.compound ?? 'MEDIUM',
    tyreAgeLaps: options.tyreAge ?? lap - 1,
    tyreWear: options.tyreWear ?? 0.6,
    fuelKg: fuel,
    pitStops: 0,
    lastPitLap: null,
    compoundsUsed: [options.compound ?? 'MEDIUM'],
    lastLapTime: track.baseLapTime + 3,
    paceOffset: entry.pace,
    wearFactor: entry.driver.tyreWearFactor,
    inPitLane: false,
  }));
}

export interface ContextOptions extends FieldOptions {
  /** Index in the field of the car deciding (0 = leader). */
  index?: number;
  context?: Partial<StrategyContext>;
  car?: Partial<StrategicCarView>;
  field?: StrategicCarView[];
}

export function makeContext(options: ContextOptions = {}): StrategyContext {
  const track = options.track ?? TEST_TRACK;
  const lap = options.lap ?? 20;
  const field = options.field ?? makeField(options);
  const index = options.index ?? 4;
  const car = { ...field[index]!, ...options.car };
  field[index] = car;
  const fitted = car.compound;
  const sets = makeSets();
  // The set on the car is not available.
  const fittedSet = sets.find((s) => s.compound === fitted && s.isNew) ?? sets.find((s) => s.compound === fitted);
  return {
    track,
    raceLaps: track.raceLaps,
    lap,
    car,
    teammate: field.find((c) => c.teamId === car.teamId && c.id !== car.id) ?? null,
    field,
    availableSets: sets.filter((s) => s !== fittedSet),
    plan: [{ lap: 24, compound: 'HARD' }],
    ersCharge: 0.6,
    fuelMarginLaps: 0.2,
    flag: 'GREEN',
    pitLossNow: track.pitLossSeconds,
    teammateBoxingAhead: false,
    doubleStackWait: 0,
    weather: makeWeather(),
    forecast: makeForecast(0, 0, 6, 1800, lap),
    mustUseTwoCompounds: true,
    profile: { aggression: 0.6, weatherRisk: 0.5, reactivity: 1 },
    rng: new SeededRandom(5),
    ...options.context,
  };
}

export interface RequestOptions {
  track?: TrackDefinition;
  lap?: number;
  spacing?: number;
  tyreWear?: number;
  runs?: number;
  seed?: number;
  focusIndex?: number;
  request?: Partial<ProjectionRequest>;
}

/** A projection request for a 20-car field in the middle of a dry race. */
export function makeRequest(options: RequestOptions = {}): ProjectionRequest {
  const track = options.track ?? TEST_TRACK;
  const lap = options.lap ?? 18;
  const raceTime = (lap - 1) * (track.baseLapTime + 4) + 40;
  const field = makeField({ track, lap, spacing: options.spacing ?? 2.2, tyreWear: options.tyreWear ?? 0.55 });
  const focusIndex = options.focusIndex ?? 4;
  const cars: ProjectionCarInput[] = field.map((view, index) => {
    const sets = makeSets().filter((s) => s.id !== 'M1');
    return {
      id: view.id,
      teamId: view.teamId,
      position: view.position,
      lapsCompleted: view.lapsCompleted,
      nextLineCrossingTime: raceTime + 30 + view.gapToLeader,
      compound: view.compound,
      tyreWear: view.tyreWear,
      tyreAgeLaps: view.tyreAgeLaps,
      fuelKg: view.fuelKg,
      paceOffset: view.paceOffset,
      wearFactor: view.wearFactor,
      pitStops: 0,
      compoundsUsed: ['MEDIUM'],
      availableSets: sets,
      plannedStops: index === focusIndex ? [{ lap: lap + 4, compound: 'HARD' }] : null,
      inPitLane: false,
    };
  });
  return {
    track,
    raceLaps: track.raceLaps,
    focusCarId: cars[focusIndex]!.id,
    cars,
    candidates: [
      { id: 'T+1', label: 'T+1', pitLap: lap + 1, compound: 'HARD' },
      { id: 'T+3', label: 'T+3', pitLap: lap + 3, compound: 'HARD' },
      { id: 'T+5', label: 'T+5', pitLap: lap + 5, compound: 'HARD' },
    ],
    flag: 'GREEN',
    raceTime,
    weather: makeWeather(),
    forecast: makeForecast(0, 0, 6, raceTime, lap),
    monteCarloRuns: options.runs ?? 40,
    seed: options.seed ?? 77,
    ...options.request,
  };
}
