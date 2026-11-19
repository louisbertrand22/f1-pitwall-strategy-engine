/**
 * Shared domain model of the Pit Wall Strategy Engine.
 *
 * This file is the contract between the simulation core (src/simulation), the race engine running in
 * the Web Worker (src/workers) and the React cockpit (src/components). It contains types only.
 *
 * Conventions
 *  - Times are in seconds, distances along the lap are fractions in [0, 1) measured from the start/finish
 *    line in the racing direction ("lap distance fraction").
 *  - `wear` is the fraction of a tyre's useful life consumed: 0 = new, 1 = the cliff point, > 1 = past it.
 *  - `trackWetness` and `rainIntensity` are in [0, 1].
 *  - A `CarId` is the driver's unique three-letter code.
 */

// ───────────────────────────────────────────────────────────── primitives ──

export type CarId = string;
export type TeamId = string;
export type TrackId = 'silverstone' | 'spa' | 'monaco' | 'monza' | 'suzuka';

export type TyreCompound = 'SOFT' | 'MEDIUM' | 'HARD' | 'INTER' | 'WET';
export type DryCompound = 'SOFT' | 'MEDIUM' | 'HARD';
/** Tyre family that suits a given track wetness. */
export type TyreClass = 'SLICK' | 'INTER' | 'WET';

/** Driver pace instruction: Push/Attack · Balanced · Lift & Coast / Save tyres. */
export type PaceMode = 'PUSH' | 'BALANCED' | 'CONSERVE';
/** Hybrid deployment instruction. */
export type ErsMode = 'OVERTAKE' | 'BALANCED' | 'HARVEST';
/** Standing instruction between the two team cars. */
export type TeamOrderMode = 'FREE' | 'HOLD';
export type PlanId = 'A' | 'B' | 'C';
export type WeatherMode = 'AUTO' | 'DRY' | 'MIXED' | 'WET';
export type TimeScale = 1 | 2 | 5 | 15 | 30;

export type FlagStatus = 'GREEN' | 'YELLOW' | 'VSC' | 'SC' | 'RED' | 'CHEQUERED';
/** GRID: cars lined up, waiting for lights out · SUSPENDED: red flag · FINISHED: all cars classified. */
export type RacePhase = 'GRID' | 'RACING' | 'SUSPENDED' | 'FINISHED';
export type CarStatus = 'GRID' | 'RACING' | 'PIT_LANE' | 'PIT_BOX' | 'RETIRED' | 'FINISHED';
/** FIA timing colours: PURPLE = overall best, GREEN = personal best, YELLOW = slower than personal best. */
export type SectorFlag = 'PURPLE' | 'GREEN' | 'YELLOW' | 'NONE';
export type Severity = 'INFO' | 'WARN' | 'CRITICAL';

// ────────────────────────────────────────────────────────────────── track ──

export interface DrsZone {
  name: string;
  /** Detection point (lap distance fraction). */
  detection: number;
  /** Activation zone start / end (lap distance fractions). `end < start` when the zone wraps the line. */
  start: number;
  end: number;
}

export interface TrackCorner {
  name: string;
  /** Lap distance fraction of the apex. */
  at: number;
}

export interface TrackDefinition {
  id: TrackId;
  /** "Silverstone Circuit" */
  name: string;
  /** "SILVERSTONE" */
  shortName: string;
  /** "British Grand Prix" */
  grandPrix: string;
  /** ISO-3166 alpha-3 country code, e.g. "GBR". */
  country: string;
  lengthKm: number;
  raceLaps: number;
  /**
   * Reference dry lap (s): fastest car/driver, new SOFT in its operating window, empty tank, clean air,
   * balanced engine/ERS modes, rubbered-in track.
   */
  baseLapTime: number;
  /** Total green-flag time lost by a pit stop (s), including a nominal 2.5 s stationary time. */
  pitLossSeconds: number;
  pitSpeedLimitKph: number;
  /** Pit entry (late in the lap, e.g. 0.95) and pit exit (early in the next lap, e.g. 0.04). */
  pitEntry: number;
  pitExit: number;
  /** Side of the track the pit lane sits on, looking in the direction of travel. */
  pitSide: 'LEFT' | 'RIGHT';
  /** Asphalt abrasiveness: multiplier on tyre wear (≈0.70 smooth street surface … 1.35 very abrasive). */
  abrasiveness: number;
  /** Tyre energy from the layout (fast, loaded corners): second multiplier on wear (≈0.85 … 1.20). */
  tyreStress: number;
  /** 0 = overtaking is trivial … 1 = virtually impossible. */
  overtakingDifficulty: number;
  /** Probability of at least one full Safety Car period during a dry race. */
  safetyCarProbability: number;
  /** Probability of at least one Virtual Safety Car period during a dry race. */
  vscProbability: number;
  /** Probability that it rains at some point during the race (weather mode AUTO). */
  rainProbability: number;
  /** Lap-time cost of one kilogram of fuel (s/kg), ≈0.03. */
  fuelEffectPerKg: number;
  /** Fuel burnt per racing lap at balanced pace (kg). */
  fuelPerLapKg: number;
  /** Multiplier on the dirty-air penalty (≈0.6 low-downforce track … 1.3 high-downforce track). */
  dirtyAirSensitivity: number;
  /** Lap-time gap between adjacent dry compounds at this track (s): [SOFT→MEDIUM, MEDIUM→HARD]. */
  compoundGap: [number, number];
  airTempC: number;
  trackTempC: number;
  /** Lap distance fractions where sector 1 and sector 2 end (sector 3 ends at the line). */
  sectors: [number, number];
  drsZones: DrsZone[];
  /** Heavy braking zones where passes are completed, besides the end of each DRS zone. */
  overtakingSpots: number[];
  corners: TrackCorner[];
  /**
   * SVG path data of the circuit centreline. Closed, starts exactly on the start/finish line and runs in
   * the racing direction. Absolute commands M, L, C, Q and Z only.
   */
  svgPath: string;
  /** The path lives in a `0 0 width height` viewBox. */
  svgViewBox: { width: number; height: number };
}

// ──────────────────────────────────────────────────────── teams & drivers ──

/** Strategic personality of a pit wall, all in [0, 1]. */
export interface StrategyProfile {
  /** Eagerness to gamble: early undercuts, opportunistic stops, alternative strategies. */
  aggression: number;
  /** Willingness to stay out on the wrong tyre when the weather turns (0 = switches early). */
  weatherRisk: number;
  /** How quickly the team reacts to a rival's stop (1 = covers on the very next lap). */
  reactivity: number;
}

export interface TeamInfo {
  id: TeamId;
  name: string;
  shortName: string;
  /** Hex colour used to identify the team everywhere in the UI. */
  color: string;
  /** Car pace deficit to the fastest car (s per 90 s reference lap). */
  carPace: number;
  /** Mechanical failure hazard multiplier (1 = average, lower = more reliable). */
  unreliability: number;
  /** Mean stationary time of the pit crew (s). */
  pitCrewTime: number;
  /** Position of the garage along the pit lane, 0 (pit entry end) … 1 (pit exit end). */
  pitBoxPosition: number;
  profile: StrategyProfile;
}

export interface DriverInfo {
  id: CarId;
  /** Three-letter timing code (same as id). */
  code: string;
  firstName: string;
  lastName: string;
  number: number;
  teamId: TeamId;
  /** Which of the team's two cars: #1 or #2. */
  carNumber: 1 | 2;
  /** Pace deficit to the best driver (s per 90 s reference lap). */
  paceDelta: number;
  /** Standard deviation of lap-to-lap noise (s). */
  consistency: number;
  /** Overtaking / defending skill in [0, 1]. */
  racecraft: number;
  /** Wet-weather skill in [0, 1]. */
  wetSkill: number;
  /** Tyre wear multiplier (< 1 is gentle on tyres). */
  tyreWearFactor: number;
  /** Driver error hazard multiplier (1 = average). */
  errorProneness: number;
}

// ────────────────────────────────────────────────────────────────── tyres ──

export interface TyreSet {
  /** Unique within a car's allocation, e.g. "M1", "S2", "I1". */
  id: string;
  compound: TyreCompound;
  /** Laps completed on the set, including laps done before the race on a used ("scrubbed") set. */
  laps: number;
  /** Fraction of useful life consumed. */
  wear: number;
  /** True if the set had never been run before the race. */
  isNew: boolean;
  /** Currently bolted on the car. */
  fitted: boolean;
}

export interface TyreState {
  setId: string;
  compound: TyreCompound;
  ageLaps: number;
  wear: number;
  /** Thermal readiness: 0 = stone cold, 1 = in the operating window. */
  readiness: number;
  /** Indicative tread surface temperature for display (°C). */
  tempC: number;
}

// ──────────────────────────────────────────────────────────────── weather ──

export interface WeatherState {
  rainIntensity: number;
  trackWetness: number;
  airTempC: number;
  trackTempC: number;
  /** Rubbered-in grip level 0..1 (resets when it rains). */
  gripLevel: number;
}

export interface WeatherSample {
  raceTime: number;
  /** Leader's lap at that time (fractional). */
  lap: number;
  rainIntensity: number;
  trackWetness: number;
}

export interface WeatherForecastPoint {
  /** Race clock this point refers to (s). */
  raceTime: number;
  /** Estimated leader lap at that time (fractional). */
  lap: number;
  /** Expected rain intensity and its uncertainty band. */
  rainIntensity: number;
  rainLow: number;
  rainHigh: number;
  /** Track wetness predicted from the expected rain. */
  trackWetness: number;
}

// ────────────────────────────────────────────────────────────── strategy ──

export interface StintPlan {
  compound: TyreCompound;
  /** Last lap of the stint (the in-lap). Equals the race distance for the final stint. */
  endLap: number;
}

export interface StrategyPlan {
  id: PlanId;
  label: string;
  /** Ordered stints; stint k is run after k pit stops. */
  stints: StintPlan[];
}

export interface CarStrategy {
  activePlan: PlanId;
  plans: Record<PlanId, StrategyPlan>;
  /** When true the race engineer calls the planned stops automatically. */
  autoBox: boolean;
}

/** "Pit at the end of lap `lap` and fit `compound`". */
export interface PlannedStop {
  lap: number;
  compound: TyreCompound;
}

export type PitReason =
  | 'PLANNED'
  | 'TYRE_WEAR'
  | 'UNDERCUT'
  | 'COVER'
  | 'SAFETY_CAR'
  | 'WEATHER'
  | 'PUNCTURE'
  | 'OPPORTUNISTIC'
  | 'MANUAL';

// ─────────────────────────────────────────────────────────────── session ──

export interface SessionConfig {
  trackId: TrackId;
  /** Seed of the deterministic race: same seed + same commands ⇒ same race. */
  seed: number;
  playerTeamId: TeamId;
  weatherMode: WeatherMode;
  /** Scales the random incident hazards: 0 = none, 1 = realistic, 2 = chaotic. */
  incidentLevel: 0 | 1 | 2;
  /** Optional race distance override (laps). */
  raceLaps?: number;
}

export interface SessionInfo {
  config: SessionConfig;
  track: TrackDefinition;
  raceLaps: number;
  teams: TeamInfo[];
  drivers: DriverInfo[];
  /** Starting grid, pole first. */
  grid: CarId[];
  playerTeamId: TeamId;
  /** The two cars the user controls: [#1, #2]. */
  playerCarIds: [CarId, CarId];
  /** Fuel load at the start (kg). */
  startFuelKg: number;
}

// ──────────────────────────────────────────────────────────── live state ──

export interface SectorCell {
  time: number | null;
  flag: SectorFlag;
}

export interface CarSnapshot {
  id: CarId;
  /** 1-based race position. */
  position: number;
  gridPosition: number;
  status: CarStatus;
  /** Laps completed; the car is on lap `lapsCompleted + 1`. */
  lapsCompleted: number;
  /** Position along the lap (distance fraction). In the pit lane: the equivalent position on track. */
  lapFraction: number;
  /** Progress along the pit lane in [0, 1] while status is PIT_LANE or PIT_BOX, otherwise null. */
  pitLaneProgress: number | null;
  speedKph: number;
  /** Seconds behind the leader. Null for the leader and for lapped cars (see `lapsDown`). */
  gapToLeader: number | null;
  /** Whole laps behind the leader. */
  lapsDown: number;
  /** Seconds to the car directly ahead in the classification. Null for the leader or when `intervalLaps > 0`. */
  interval: number | null;
  /** Whole laps to the car directly ahead in the classification. */
  intervalLaps: number;
  lastLapTime: number | null;
  bestLapTime: number | null;
  /** Latest S1/S2/S3 times with FIA colour coding. */
  sectors: [SectorCell, SectorCell, SectorCell];
  currentSector: 0 | 1 | 2;
  tyre: TyreState;
  pitStops: number;
  /** Within one second at the last detection point, so allowed to open DRS in the next zone. */
  drsEligible: boolean;
  /** DRS flap currently open. */
  drsOpen: boolean;
  inDirtyAir: boolean;
  /** Car currently being attacked or defended against. */
  battleWith: CarId | null;
  paceMode: PaceMode;
  ersMode: ErsMode;
  /** A stop has been called for the end of the current lap. */
  boxThisLap: boolean;
  /** Holds the fastest lap of the race. */
  hasFastestLap: boolean;
  retiredReason: string | null;
}

export interface RejoinEstimate {
  /** Pit loss used for the estimate under the current flag (s). */
  pitLoss: number;
  /** Where the car would be on track right now had it already made its stop (lap distance fraction). */
  ghostLapFraction: number;
  /** Predicted race position after the stop. */
  position: number;
  positionsLost: number;
  /** Cars that would be directly ahead / behind on track at pit exit, with the gaps in seconds. */
  carAhead: CarId | null;
  gapAhead: number | null;
  carBehind: CarId | null;
  gapBehind: number | null;
  /** More than 1.5 s of clear track ahead at pit exit. */
  clearAir: boolean;
}

export interface UndercutAnalysis {
  /** Rival directly ahead in the classification. */
  targetId: CarId;
  gap: number;
  /** Time gained on the target by stopping one lap before it (s). */
  gainPerLap: number;
  /** Laps of offset needed for the undercut to work; null if it never does. */
  lapsNeeded: number | null;
  feasible: boolean;
}

export interface ThreatAnalysis {
  /** Rival directly behind in the classification. */
  rivalId: CarId;
  gap: number;
  /** The rival would jump us by stopping now if we do not respond. */
  undercutRisk: boolean;
}

export interface DoubleStackEstimate {
  leadCarId: CarId;
  trailCarId: CarId;
  /** Gap between the two cars at pit entry (s). */
  gap: number;
  /** Time the second car is expected to queue behind the first (s). */
  expectedWait: number;
  /** Probability that the second car loses time queueing. */
  queueProbability: number;
  /** Rival cars expected in the pit lane at the same time. */
  pitLaneTraffic: number;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface BoxCall {
  setId: string;
  compound: TyreCompound;
  reason: PitReason;
  /** Seconds until the car reaches the pit entry. */
  etaSeconds: number;
}

export interface PlayerCarTelemetry {
  carId: CarId;
  carNumber: 1 | 2;
  fuelKg: number;
  /** Laps of fuel in hand versus the remaining distance at balanced pace (negative = must save). */
  fuelMarginLaps: number;
  /** Battery state of charge 0..1. */
  ersCharge: number;
  engineTempC: number;
  brakeTempC: number;
  /** Driver instructed to defend his position. */
  defend: boolean;
  boxCall: BoxCall | null;
  /** The weekend allocation with the live state of every set. */
  tyreSets: TyreSet[];
  /** Laps left before the current set reaches its cliff at the current wear rate. */
  tyreLifeLaps: number;
  rejoin: RejoinEstimate | null;
  undercut: UndercutAnalysis | null;
  threat: ThreatAnalysis | null;
  strategy: CarStrategy;
  /** Next stop of the active plan, if any. */
  nextPlannedStop: PlannedStop | null;
}

export interface TrackIncident {
  lapFraction: number;
  carId: CarId | null;
}

export interface RaceControlState {
  flag: FlagStatus;
  /** Sectors under local yellow. */
  yellowSectors: [boolean, boolean, boolean];
  /** Safety car position on track (lap distance fraction) or null. */
  safetyCarLapFraction: number | null;
  /** "Safety car in this lap" has been announced. */
  safetyCarInThisLap: boolean;
  drsEnabled: boolean;
  /** Countdown (s) to lights out (GRID) or to the restart (SUSPENDED); null otherwise. */
  countdown: number | null;
  incidents: TrackIncident[];
  /** Latest race-control headline. */
  message: string;
}

export interface FastestLap {
  carId: CarId;
  time: number;
  lap: number;
}

export interface RaceSnapshot {
  seq: number;
  /** Race clock in seconds since lights out (keeps running during a red-flag suspension). */
  raceTime: number;
  phase: RacePhase;
  /** Leader's current lap (1..raceLaps). */
  lap: number;
  raceLaps: number;
  timeScale: TimeScale;
  paused: boolean;
  raceControl: RaceControlState;
  weather: WeatherState;
  /** Every car, sorted by race position. */
  cars: CarSnapshot[];
  player: {
    teamOrder: TeamOrderMode;
    /** A position swap has been ordered and is pending. */
    swapPending: boolean;
    cars: [PlayerCarTelemetry, PlayerCarTelemetry];
    doubleStack: DoubleStackEstimate | null;
  };
  fastestLap: FastestLap | null;
  /** Overall best S1/S2/S3 of the race so far. */
  bestSectors: [number | null, number | null, number | null];
}

// ─────────────────────────────────────────────────────────────── history ──

export interface LapRecord {
  carId: CarId;
  /** Lap just completed (1-based). */
  lap: number;
  lapTime: number;
  sectors: [number, number, number];
  /** Race clock when the car crossed the line. */
  raceTime: number;
  position: number;
  /** Seconds behind the leader at the line (includes whole laps for lapped cars). */
  gapToLeader: number;
  compound: TyreCompound;
  tyreAge: number;
  tyreWear: number;
  fuelKg: number;
  /** The car entered the pit lane at the end of this lap. */
  pitIn: boolean;
  /** The lap started from the pit lane. */
  pitOut: boolean;
  /** Most severe flag shown during the lap. */
  flag: FlagStatus;
  trackWetness: number;
}

export interface PitStopRecord {
  carId: CarId;
  /** In-lap number. */
  lap: number;
  raceTime: number;
  fromCompound: TyreCompound;
  toCompound: TyreCompound;
  toSetId: string;
  reason: PitReason;
  stationaryTime: number;
  /** Time lost queueing behind the team-mate (double stack). */
  queueTime: number;
  /** Total time lost versus staying on track (s). */
  timeLost: number;
  flag: FlagStatus;
  positionBefore: number;
  /** Position at pit exit; null until the car has rejoined. */
  positionAfter: number | null;
}

export type RaceEventType =
  | 'START'
  | 'FLAG'
  | 'INCIDENT'
  | 'RETIREMENT'
  | 'PIT'
  | 'OVERTAKE'
  | 'FASTEST_LAP'
  | 'WEATHER'
  | 'DRS'
  | 'TEAM_ORDER'
  | 'PENALTY'
  | 'FINISH';

export interface RaceEvent {
  id: number;
  raceTime: number;
  lap: number;
  type: RaceEventType;
  severity: Severity;
  message: string;
  carIds: CarId[];
}

export interface RaceHistory {
  laps: Record<CarId, LapRecord[]>;
  pitStops: PitStopRecord[];
  events: RaceEvent[];
  weather: WeatherSample[];
}

export interface ClassificationEntry {
  position: number;
  carId: CarId;
  status: 'FINISHED' | 'DNF';
  lapsCompleted: number;
  /** Total race time (s) for cars on the lead lap, otherwise null. */
  totalTime: number | null;
  /** Seconds behind the winner, null when lapped or retired. */
  gap: number | null;
  lapsDown: number;
  bestLapTime: number | null;
  pitStops: number;
  gridPosition: number;
  points: number;
  /** Time penalty applied (s), e.g. for not using two dry compounds. */
  penaltySeconds: number;
  retiredReason: string | null;
}

// ───────────────────────────────────────────────────────────────── radio ──

export type RadioCategory =
  | 'TYRES'
  | 'STRATEGY'
  | 'UNDERCUT'
  | 'WEATHER'
  | 'TEMPS'
  | 'FUEL'
  | 'ERS'
  | 'TRAFFIC'
  | 'INCIDENT'
  | 'PIT'
  | 'TEAM_ORDER'
  | 'INFO';

export interface RadioQuickReply {
  id: string;
  label: string;
  tone: 'CONFIRM' | 'DENY' | 'NEUTRAL';
}

export interface RadioMessage {
  id: number;
  raceTime: number;
  lap: number;
  /** Player car concerned, or null for a team-wide message. */
  carId: CarId | null;
  /** DRIVER → pit wall · ENGINEER / STRATEGY → the user · PIT_WALL = the user's own replies. */
  from: 'DRIVER' | 'ENGINEER' | 'STRATEGY' | 'PIT_WALL';
  category: RadioCategory;
  severity: Severity;
  text: string;
  /** Instructions the user can answer with; empty when no answer is expected. */
  quickReplies: RadioQuickReply[];
  /** Id of the chosen reply once answered. */
  repliedWith: string | null;
  /** Race clock after which the quick replies are no longer actionable. */
  expiresAt: number | null;
}

// ────────────────────────────────────────────── AI strategist (contract) ──

/** Seeded random source. The simulation never calls Math.random(). */
export interface RandomSource {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Standard normal deviate. */
  normal(): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Pick one element. */
  pick<T>(items: readonly T[]): T;
  /** Independent child stream derived from this one and a label. */
  fork(label: string): RandomSource;
}

/** What a pit wall can see of any car on track. */
export interface StrategicCarView {
  id: CarId;
  teamId: TeamId;
  position: number;
  status: CarStatus;
  lapsCompleted: number;
  /** Fraction of the current lap completed (time domain) in [0, 1). */
  lapProgress: number;
  /** Seconds behind the leader, whole laps included. */
  gapToLeader: number;
  /** Seconds to the car ahead / behind in the classification (null at either end of the field). */
  gapAhead: number | null;
  gapBehind: number | null;
  carAheadId: CarId | null;
  carBehindId: CarId | null;
  compound: TyreCompound;
  tyreAgeLaps: number;
  tyreWear: number;
  fuelKg: number;
  pitStops: number;
  /** In-lap of the most recent stop, or null. */
  lastPitLap: number | null;
  compoundsUsed: TyreCompound[];
  lastLapTime: number | null;
  /** Car + driver pace deficit to the reference at this track (s/lap). */
  paceOffset: number;
  /** Driver tyre wear multiplier. */
  wearFactor: number;
  inPitLane: boolean;
}

export interface StrategyContext {
  track: TrackDefinition;
  raceLaps: number;
  /** Lap the car is currently on (1-based). A stop decided now happens at the end of this lap. */
  lap: number;
  car: StrategicCarView;
  teammate: StrategicCarView | null;
  /** Every car still running, sorted by position (includes `car`). */
  field: StrategicCarView[];
  /** Sets of this car that are not currently fitted. */
  availableSets: TyreSet[];
  /** Remaining planned stops for this car, earliest first. */
  plan: PlannedStop[];
  /** Own-car telemetry: battery state of charge 0..1 and laps of fuel in hand (negative = must save). */
  ersCharge: number;
  fuelMarginLaps: number;
  flag: FlagStatus;
  /** Time a stop would cost right now given the flag state (s). */
  pitLossNow: number;
  /** True if the team-mate has a stop called for this lap and will reach the box first. */
  teammateBoxingAhead: boolean;
  /** Queueing time expected if this car also stops this lap (s). */
  doubleStackWait: number;
  weather: WeatherState;
  forecast: WeatherForecastPoint[];
  /** The two-dry-compound rule still applies (false once wet-weather tyres have been used). */
  mustUseTwoCompounds: boolean;
  profile: StrategyProfile;
  rng: RandomSource;
}

export interface StrategyDecision {
  /** Stop at the end of the current lap with this set, or null to stay out. */
  box: { setId: string; reason: PitReason } | null;
  paceMode: PaceMode;
  ersMode: ErsMode;
  /** Updated remaining plan (excluding a stop decided in `box`). */
  plan: PlannedStop[];
  /** One-line rationale in pit-wall English, e.g. "Undercut window open on BEL (+1.4 s)". */
  rationale: string;
}

export interface RacePlanInput {
  track: TrackDefinition;
  raceLaps: number;
  carId: CarId;
  gridPosition: number;
  paceOffset: number;
  wearFactor: number;
  startFuelKg: number;
  sets: TyreSet[];
  weather: WeatherState;
  forecast: WeatherForecastPoint[];
  profile: StrategyProfile;
  rng: RandomSource;
}

export interface RacePlan {
  startSetId: string;
  stops: PlannedStop[];
  /** Expected race time in clean air (s). */
  expectedRaceTime: number;
}

// ────────────────────────────────────────── predictive engine (contract) ──

export interface ProjectionCarInput {
  id: CarId;
  teamId: TeamId;
  position: number;
  lapsCompleted: number;
  /** Race clock at which the car is expected to complete the lap it is on. */
  nextLineCrossingTime: number;
  compound: TyreCompound;
  tyreWear: number;
  tyreAgeLaps: number;
  fuelKg: number;
  paceOffset: number;
  wearFactor: number;
  pitStops: number;
  compoundsUsed: TyreCompound[];
  availableSets: TyreSet[];
  /** Known plan (the user's cars) or null when it must be predicted (rivals). */
  plannedStops: PlannedStop[] | null;
  /** The car is in the pit lane right now; `nextLineCrossingTime` already includes the stop. */
  inPitLane: boolean;
}

export interface StrategyCandidate {
  /** Stable id, e.g. "T+1", "T+3", "T+5", "PLAN". */
  id: string;
  label: string;
  /** In-lap of the stop under evaluation, or null for "no further stop". */
  pitLap: number | null;
  /** Compound fitted at that stop. */
  compound: TyreCompound | null;
}

export interface ProjectionRequest {
  track: TrackDefinition;
  raceLaps: number;
  focusCarId: CarId;
  /** Every running car. */
  cars: ProjectionCarInput[];
  candidates: StrategyCandidate[];
  flag: FlagStatus;
  /** Race clock now (s). */
  raceTime: number;
  weather: WeatherState;
  forecast: WeatherForecastPoint[];
  /** Number of Monte-Carlo runs per candidate. */
  monteCarloRuns: number;
  /** Seed of the projection's own random stream (never the race's). */
  seed: number;
}

export interface ProjectionPoint {
  lap: number;
  /** Seconds behind the projected leader at the end of that lap. */
  gapToLeader: number;
  /** Cumulative race time at the end of that lap (s). */
  raceTime: number;
  position: number;
  compound: TyreCompound;
  /** The car stops at the end of this lap. */
  pit: boolean;
}

export interface UndercutOutcome {
  rivalId: CarId;
  /** Gap to the rival now: positive when the rival is ahead. */
  gapNow: number;
  /** Projected gap once both cars have stopped: positive when the rival is still ahead. */
  gapAfter: number;
  /** Monte-Carlo probability of being ahead of the rival at the flag. */
  successProbability: number;
}

export interface CandidateProjection {
  candidate: StrategyCandidate;
  /** Expected (noise-free) trace from the current lap to the flag. */
  trace: ProjectionPoint[];
  /** Full stop sequence assumed after the candidate stop. */
  stops: PlannedStop[];
  expectedRaceTime: number;
  /** Monte-Carlo statistics of the finishing position. */
  expectedFinish: number;
  finishP10: number;
  finishP50: number;
  finishP90: number;
  /** distribution[i] = probability of finishing in position i + 1. */
  finishDistribution: number[];
  /** Position and traffic right after the candidate stop (expected run). */
  rejoinPosition: number | null;
  rejoinGapAhead: number | null;
  rejoinGapBehind: number | null;
  /** Outcome against the cars directly ahead and behind. */
  rivals: UndercutOutcome[];
}

export interface ProjectionResult {
  focusCarId: CarId;
  /** Lap the focus car was on when the projection was computed. */
  fromLap: number;
  raceTime: number;
  candidates: CandidateProjection[];
  /** Expected traces of the surrounding cars (leader, cars ahead and behind) on their predicted strategies. */
  rivalTraces: { carId: CarId; trace: ProjectionPoint[] }[];
  /** Id of the candidate with the best expected finish (ties broken by race time). */
  recommendedId: string;
  monteCarloRuns: number;
}
