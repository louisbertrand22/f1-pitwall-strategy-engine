/**
 * Deterministic race engine.
 *
 * The race is simulated in the *time domain*: each car's coordinate `tau` is the number of seconds of the
 * reference lap it has covered, so a difference of `tau` between two cars IS their time gap (at reference
 * pace) and every rule expressed in seconds – dirty air under 1.2 s, DRS under 1 s, pit loss, the rejoin
 * ghost – is exact by construction. The circuit geometry only maps `tau` back to a point on the map.
 *
 * The engine advances with a fixed step (`ENGINE_DT`) and draws every random number from seeded streams:
 * the same seed and the same commands at the same race times replay the same race.
 *
 * It runs inside the Web Worker (src/workers/raceSimulation.worker.ts) but has no worker dependency, so
 * it can be driven headlessly in tests.
 */
import type { RaceControlAction, WorkerCommand } from '../workers/protocol';
import { DRIVERS, POINTS_TABLE, TEAMS } from './gridData';
import {
  COMPOUNDS,
  DRS_DETECTION_GAP,
  DRS_ENABLE_LAPS,
  DRS_MAX_WETNESS,
  DRS_SPEED_GAIN,
  ERS_MODES,
  LIFT_AND_COAST_SAVING,
  NEUTRALISED_PACE,
  PACE_MODES,
  PIT_STOP,
  TEMP_LIMITS,
  WEATHER_CROSSOVER,
  bestTyreClass,
  brakeTempTarget,
  clamp,
  computeLapTime,
  dirtyAirIntensity,
  doubleStackRisk,
  driverErrorFactor,
  engineTempTarget,
  fuelBurnPerLap,
  incidentRates,
  isSlick,
  lapScale,
  lapTime,
  lapsToCliff,
  meanWarmupPenaltyOverLap,
  overheatHazardFactor,
  overtakeProbability,
  pitLaneTransitLoss,
  pitLossUnderFlag,
  punctureHazardPerLap,
  readinessAfter,
  sampleStationaryTime,
  startingFuelKg,
  tyreTemperatureC,
  warmupTimeConstant,
  wearPerLap,
} from './physicsModel';
import { RadioDirector } from './radioDirector';
import type { RadioDraft } from './radioDirector';
import { SeededRandom } from './rng';
import { distanceToTime, getTrackGeometry, speedAt, timeToDistance } from './trackGeometry';
import type { TrackGeometry } from './trackGeometry';
import { buildTyreAllocation } from './tyreAllocation';
import type {
  BoxCall,
  CarId,
  CarSnapshot,
  CarStatus,
  CarStrategy,
  ClassificationEntry,
  DoubleStackEstimate,
  DriverInfo,
  ErsMode,
  FlagStatus,
  LapRecord,
  PaceMode,
  PitReason,
  PitStopRecord,
  PlanId,
  PlannedStop,
  PlayerCarTelemetry,
  ProjectionCarInput,
  ProjectionRequest,
  RaceEvent,
  RaceEventType,
  RacePhase,
  RacePlan,
  RacePlanInput,
  RaceSnapshot,
  RadioMessage,
  RejoinEstimate,
  SectorCell,
  SessionConfig,
  SessionInfo,
  Severity,
  StrategicCarView,
  StrategyCandidate,
  StrategyContext,
  StrategyDecision,
  StrategyPlan,
  TeamInfo,
  TeamOrderMode,
  ThreatAnalysis,
  TimeScale,
  TrackDefinition,
  TrackIncident,
  TyreClass,
  TyreCompound,
  TyreSet,
  UndercutAnalysis,
  WeatherForecastPoint,
  WeatherSample,
  WeatherState,
} from './types';
import { WeatherSystem } from './weatherModel';

// ─────────────────────────────────────────────────────────────── constants ──

/** Fixed integration step (s). */
export const ENGINE_DT = 0.05;
/** Closest two cars can follow nose to tail (τ-seconds). */
const MIN_GAP = 0.16;
/** An attack is attempted at an overtaking spot when the attacker is within this gap (τ-seconds). */
const BATTLE_GAP = 0.45;
/** Spacing of the safety-car train (τ-seconds). */
const SC_QUEUE_GAP = 0.65;
/** After lights out cars may run side by side for this long (s). */
const START_FREE_TIME = 16;
/** Spacing of two grid slots (τ-seconds, ≈ 8 m). */
const GRID_SLOT = 0.1;
/** AI strategy decisions are taken this long before pit entry (τ-seconds). */
const DECISION_LEAD = 9;
/** Upper bound of the progress rate of a car on its own (reference laps per lap time). */
const MAX_RATE = 1.08;
/** Lights sequence (s). */
const LIGHTS_COUNTDOWN = 5;
/** Length of a red-flag suspension (s of simulated time). */
const RED_FLAG_DURATION = 90;
const FLAG_SEVERITY: Record<FlagStatus, number> = { GREEN: 0, CHEQUERED: 0, YELLOW: 1, VSC: 2, SC: 3, RED: 4 };
const FAILURES = ['power unit', 'gearbox', 'hydraulics', 'brake-by-wire', 'ERS', 'water pressure', 'suspension'] as const;
const WHEEL_CORNERS = ['front-left', 'front-right', 'rear-left', 'rear-right'] as const;
const PLAN_IDS: readonly PlanId[] = ['A', 'B', 'C'];

// ─────────────────────────────────────────────────────────────────── types ──

export interface EngineDeps {
  track: TrackDefinition;
  planRace: (input: RacePlanInput) => RacePlan;
  buildDefaultPlans: (input: RacePlanInput) => CarStrategy;
  decideStrategy: (ctx: StrategyContext) => StrategyDecision;
}

export interface EngineOutbox {
  laps: LapRecord[];
  pitStops: PitStopRecord[];
  events: RaceEvent[];
  radio: RadioMessage[];
  weather: { sample: WeatherSample; forecast: WeatherForecastPoint[] } | null;
  classification: ClassificationEntry[] | null;
  /** Player cars whose strategy projection should be refreshed. */
  projectionDue: CarId[];
  /** An actionable call was just radioed to the pit wall (used by auto-slow). */
  attention: boolean;
}

interface PitVisit {
  phase: 'IN' | 'QUEUE' | 'STOP' | 'OUT';
  /** 0 at pit entry … 1 at pit exit, proportional to driving time. */
  progress: number;
  driveTime: number;
  boxPosition: number;
  stopRemaining: number;
  stationary: number;
  queue: number;
  slow: boolean;
  setId: string;
  reason: PitReason;
  entryTime: number;
  /** Time a car staying on track would have needed over the same stretch (s). */
  onTrackTime: number;
  positionBefore: number;
  fromCompound: TyreCompound;
  flag: FlagStatus;
  lap: number;
  lineCrossed: boolean;
}

interface Car {
  idx: number;
  id: CarId;
  driver: DriverInfo;
  team: TeamInfo;
  teamIdx: number;
  isPlayer: boolean;
  gridPosition: number;
  paceOffset: number;
  status: CarStatus;
  position: number;

  tau: number;
  lapsCompleted: number;
  rate: number;
  /** Real seconds per τ-second, smoothed: converts τ gaps into seconds on the timing screen. */
  paceEma: number;
  lapTimeNow: number;
  freeLapTime: number;

  sets: TyreSet[];
  set: TyreSet;
  readiness: number;
  compoundsUsed: TyreCompound[];
  fuel: number;
  ersCharge: number;
  engineTemp: number;
  brakeTemp: number;
  paceMode: PaceMode;
  ersMode: ErsMode;
  defend: boolean;

  ahead: Car | null;
  aheadIsSafetyCar: boolean;
  gapTau: number;
  behindGapTau: number;
  dirtyAir: number;
  drsZone: number;
  drsOpen: boolean;
  passing: Car | null;
  passTimer: number;
  battleWith: Car | null;
  timeLoss: number;
  /** Race clock before which the car does not attack (it has just been passed). */
  attackAfter: number;
  noOvertake: boolean;
  puncture: boolean;
  launchDelay: number;
  launchQuality: number;
  lapNoise: number;

  lapStartTime: number;
  sectorStartTime: number;
  currentSector: 0 | 1 | 2;
  lapSectors: [number, number, number];
  sectorCells: [SectorCell, SectorCell, SectorCell];
  bestSectors: [number | null, number | null, number | null];
  lastLap: number | null;
  bestLap: number | null;
  lapFlag: FlagStatus;
  lapCompound: TyreCompound;
  lapStartedInPit: boolean;

  box: { setId: string; reason: PitReason } | null;
  pit: PitVisit | null;
  pitStops: number;
  lastPitLap: number | null;
  pendingPitRecord: PitStopRecord | null;

  plan: PlannedStop[];
  strategy: CarStrategy | null;
  decidedLap: number;
  advisedLap: number;
  /** Consecutive pit-entry checks spent on the wrong tyre family. */
  wrongTyreLaps: number;

  retiredReason: string | null;
  finishTime: number | null;
  finishProgress: number;
  penaltySeconds: number;
}

interface LocalYellow {
  sector: 0 | 1 | 2;
  until: number;
  incident: TrackIncident | null;
}

interface SafetyCarState {
  deployedAt: number;
  /** Position on track (τ in [0, T)); null until the car has left the pit lane. */
  tau: number | null;
  spawnAt: number;
  clearAt: number;
  inThisLap: boolean;
}

type ReplyHandler = () => void;

function mod(x: number, m: number): number {
  const r = x % m;
  return r < 0 ? r + m : r;
}

function emptyCells(): [SectorCell, SectorCell, SectorCell] {
  return [
    { time: null, flag: 'NONE' },
    { time: null, flag: 'NONE' },
    { time: null, flag: 'NONE' },
  ];
}

// ────────────────────────────────────────────────────────────────── engine ──

export class RaceEngine {
  readonly session: SessionInfo;

  private readonly deps: EngineDeps;
  private readonly track: TrackDefinition;
  private readonly geometry: TrackGeometry;
  /** Reference lap time (s): the length of a lap in τ. */
  private readonly T: number;
  private readonly scale: number;
  private readonly raceLaps: number;
  private readonly cars: Car[] = [];
  private readonly byId = new Map<CarId, Car>();
  private readonly players: [Car, Car];
  private order: Car[] = [];
  private onTrack: Car[] = [];

  // seeded random streams
  private readonly rngNoise: SeededRandom;
  private readonly rngIncident: SeededRandom;
  private readonly rngPit: SeededRandom;
  private readonly rngFight: SeededRandom;
  private readonly rngAi: SeededRandom;
  private readonly rngControl: SeededRandom;

  // track landmarks in τ
  private readonly sectorTau: [number, number];
  private readonly pitEntryTau: number;
  private readonly pitExitTau: number;
  private readonly pitSpan: number;
  private readonly pitLineProgress: number;
  private readonly decisionTau: number;
  private readonly adviceTau: number;
  private readonly drsZones: { detection: number; start: number; end: number; sector: 0 | 1 | 2 }[];
  private readonly overtakeSpots: { tau: number; drsZone: number }[];

  private readonly weather: WeatherSystem;
  private wx: WeatherState;
  private readonly radio: RadioDirector;
  private readonly replyHandlers = new Map<number, Map<string, ReplyHandler>>();
  private readonly radioLog = new Map<number, RadioMessage>();
  private readonly rates: { safetyCar: number; vsc: number; yellow: number };

  // clock & race control
  private phase: RacePhase = 'GRID';
  private raceTime = 0;
  private countdown: number | null = null;
  private started = false;
  private flag: FlagStatus = 'GREEN';
  private yellows: LocalYellow[] = [];
  private incidents: TrackIncident[] = [];
  private escalation: { at: number; kind: 'VSC' | 'SC' | 'RED'; reason: string } | null = null;
  private vscUntil: number | null = null;
  private safetyCar: SafetyCarState | null = null;
  private drsEnabled = false;
  private drsFromLap = 1 + DRS_ENABLE_LAPS;
  private freeStartUntil = 0;
  private launchTime = 0;
  private chequered = false;
  private finished = false;
  private headline = 'Formation lap complete — cars on the grid';
  private teamOrder: TeamOrderMode = 'FREE';
  private swap: { yielder: Car; beneficiary: Car; until: number } | null = null;
  private readonly boxBusyUntil: number[];
  private restarts = 0;
  private redFlagTime = 0;

  // timing
  private bestSectors: [number | null, number | null, number | null] = [null, null, null];
  private fastestLap: { carId: CarId; time: number; lap: number } | null = null;
  private readonly lapLeaderTime: number[] = [];
  private finishCount = 0;

  // scheduling
  private nextSlowTick = 0;
  private nextWeatherSample = 0;
  private eventId = 1;
  private seq = 0;
  private viewsStamp = -1;
  private views: StrategicCarView[] = [];
  private viewById = new Map<CarId, StrategicCarView>();
  private forecastCache: WeatherForecastPoint[] = [];
  private forecastStamp = -1;
  private lastWetnessClass = bestTyreClass(0);

  private outbox: EngineOutbox = RaceEngine.emptyOutbox();

  private static emptyOutbox(): EngineOutbox {
    return { laps: [], pitStops: [], events: [], radio: [], weather: null, classification: null, projectionDue: [], attention: false };
  }

  constructor(config: SessionConfig, deps: EngineDeps) {
    this.deps = deps;
    this.track = deps.track;
    this.geometry = getTrackGeometry(this.track);
    this.T = this.track.baseLapTime;
    this.scale = lapScale(this.track);
    this.raceLaps = Math.max(3, Math.round(config.raceLaps ?? this.track.raceLaps));

    const root = new SeededRandom(config.seed);
    this.rngNoise = root.fork('noise');
    this.rngIncident = root.fork('incident');
    this.rngPit = root.fork('pit');
    this.rngFight = root.fork('fight');
    this.rngAi = root.fork('ai');
    this.rngControl = root.fork('control');
    this.radio = new RadioDirector(root.fork('radio'));

    const tauOf = (fraction: number): number => distanceToTime(this.geometry, fraction) * this.T;
    this.sectorTau = [tauOf(this.track.sectors[0]), tauOf(this.track.sectors[1])];
    this.pitEntryTau = tauOf(this.track.pitEntry);
    this.pitExitTau = tauOf(this.track.pitExit);
    this.pitSpan = this.T - this.pitEntryTau + this.pitExitTau;
    this.pitLineProgress = (this.T - this.pitEntryTau) / this.pitSpan;
    this.decisionTau = Math.max(1, this.pitEntryTau - DECISION_LEAD);
    this.adviceTau = Math.min(this.decisionTau - 1, Math.max(this.pitExitTau + 2, this.T * 0.12));

    const sectorOfTau = (tau: number): 0 | 1 | 2 => (tau < this.sectorTau[0] ? 0 : tau < this.sectorTau[1] ? 1 : 2);
    this.drsZones = this.track.drsZones.map((zone) => ({
      detection: tauOf(zone.detection),
      start: tauOf(zone.start),
      end: tauOf(zone.end),
      sector: sectorOfTau(tauOf(zone.start)),
    }));
    const zoneEnds = this.drsZones.map((zone, index) => ({ tau: mod(zone.end - 0.4, this.T), drsZone: index }));
    const extraSpots = this.track.overtakingSpots
      .map((fraction) => ({ tau: tauOf(fraction), drsZone: -1 }))
      // A braking zone right after a DRS zone is the same overtaking opportunity, not a second one.
      .filter((spot) => !zoneEnds.some((end) => mod(spot.tau - end.tau, this.T) < this.T * 0.05));
    this.overtakeSpots = [...zoneEnds, ...extraSpots];

    this.rates = incidentRates(this.track, this.raceLaps);
    this.boxBusyUntil = TEAMS.map(() => -1);

    const raceDuration = this.raceLaps * (this.T + 4);
    this.weather = new WeatherSystem(this.track, config.weatherMode, root.fork('weather'), raceDuration);
    this.wx = this.weather.state;
    this.lastWetnessClass = bestTyreClass(this.wx.trackWetness);

    // Qualifying: car + driver pace with a little session noise decides the grid.
    const qualifying = root.fork('qualifying');
    const entries = DRIVERS.map((driver) => {
      const team = TEAMS.find((t) => t.id === driver.teamId);
      if (!team) throw new Error(`Driver ${driver.id} has no team`);
      const paceOffset = (team.carPace + driver.paceDelta) * this.scale;
      return { driver, team, paceOffset, lap: paceOffset + qualifying.normal() * 0.16 * this.scale };
    }).sort((a, b) => a.lap - b.lap);

    const startFuel = startingFuelKg(this.track, this.raceLaps);
    const allocationRng = root.fork('allocation');
    entries.forEach((entry, index) => {
      const sets = buildTyreAllocation(this.track, index + 1, allocationRng);
      const firstSet = sets[0];
      if (!firstSet) throw new Error('Empty tyre allocation');
      const car: Car = {
        idx: index,
        id: entry.driver.id,
        driver: entry.driver,
        team: entry.team,
        teamIdx: TEAMS.findIndex((t) => t.id === entry.team.id),
        isPlayer: entry.team.id === config.playerTeamId,
        gridPosition: index + 1,
        paceOffset: entry.paceOffset,
        status: 'GRID',
        position: index + 1,
        tau: -(0.06 + index * GRID_SLOT),
        lapsCompleted: 0,
        rate: 0,
        paceEma: 1.05,
        lapTimeNow: this.T + entry.paceOffset + 3,
        freeLapTime: this.T + entry.paceOffset + 3,
        sets,
        set: firstSet,
        readiness: 0.85,
        compoundsUsed: [],
        fuel: startFuel,
        ersCharge: 0.9,
        engineTemp: 100,
        brakeTemp: 420,
        paceMode: 'BALANCED',
        ersMode: 'BALANCED',
        defend: false,
        ahead: null,
        aheadIsSafetyCar: false,
        gapTau: Infinity,
        behindGapTau: Infinity,
        dirtyAir: 0,
        drsZone: -1,
        drsOpen: false,
        passing: null,
        passTimer: 0,
        battleWith: null,
        timeLoss: 0,
        attackAfter: 0,
        noOvertake: false,
        puncture: false,
        launchDelay: 0,
        launchQuality: 1,
        lapNoise: 0,
        lapStartTime: 0,
        sectorStartTime: 0,
        currentSector: 2,
        lapSectors: [0, 0, 0],
        sectorCells: emptyCells(),
        bestSectors: [null, null, null],
        lastLap: null,
        bestLap: null,
        lapFlag: 'GREEN',
        lapCompound: firstSet.compound,
        lapStartedInPit: false,
        box: null,
        pit: null,
        pitStops: 0,
        lastPitLap: null,
        pendingPitRecord: null,
        plan: [],
        strategy: null,
        decidedLap: 0,
        advisedLap: 0,
        wrongTyreLaps: 0,
        retiredReason: null,
        finishTime: null,
        finishProgress: 0,
        penaltySeconds: 0,
      };
      this.cars.push(car);
      this.byId.set(car.id, car);
    });

    const playerCars = this.cars.filter((c) => c.isPlayer).sort((a, b) => a.driver.carNumber - b.driver.carNumber);
    const [first, second] = playerCars;
    if (!first || !second) throw new Error(`Team ${config.playerTeamId} does not field two cars`);
    this.players = [first, second];

    // Pre-race strategy: the AI teams commit to a plan, the user gets plans A/B/C to edit.
    const forecast = this.forecastNow();
    for (const car of this.cars) {
      const input: RacePlanInput = {
        track: this.track,
        raceLaps: this.raceLaps,
        carId: car.id,
        gridPosition: car.gridPosition,
        paceOffset: car.paceOffset,
        wearFactor: car.driver.tyreWearFactor,
        startFuelKg: startFuel,
        sets: car.sets.map((s) => ({ ...s })),
        weather: this.wx,
        forecast,
        profile: car.team.profile,
        rng: this.rngAi.fork(`plan-${car.id}`),
      };
      if (car.isPlayer) {
        car.strategy = this.sanitiseStrategy(deps.buildDefaultPlans(input));
        this.fitStartingSet(car);
      } else {
        const plan = deps.planRace(input);
        car.plan = plan.stops.map((s) => ({ ...s }));
        const set = car.sets.find((s) => s.id === plan.startSetId) ?? firstUsable(car.sets, this.wx.trackWetness);
        this.fitSet(car, set, 0.85);
      }
    }

    this.staggerTeamPlans();

    this.order = this.cars.slice();
    this.session = {
      config,
      track: this.track,
      raceLaps: this.raceLaps,
      teams: TEAMS.map((t) => ({ ...t })),
      drivers: DRIVERS.map((d) => ({ ...d })),
      grid: this.cars.map((c) => c.id),
      playerTeamId: config.playerTeamId,
      playerCarIds: [first.id, second.id],
      startFuelKg: startFuel,
    };
  }

  /** Default plans are computed car by car: offset the car starting behind by a lap wherever both would stop together. */
  private staggerTeamPlans(): void {
    const [a, b] = this.players;
    const lead = a.gridPosition <= b.gridPosition ? a : b;
    const trail = lead === a ? b : a;
    if (!lead.strategy || !trail.strategy) return;
    for (const id of PLAN_IDS) {
      const leadStints = lead.strategy.plans[id].stints;
      const trailStints = trail.strategy.plans[id].stints;
      for (let i = 0; i < trailStints.length - 1 && i < leadStints.length - 1; i++) {
        const stint = trailStints[i]!;
        if (stint.endLap === leadStints[i]!.endLap && stint.endLap + 1 < trailStints[i + 1]!.endLap) stint.endLap += 1;
      }
    }
    trail.strategy = this.sanitiseStrategy(trail.strategy);
  }

  // ───────────────────────────────────────────────────────── public surface ──

  get isFinished(): boolean {
    return this.finished;
  }

  get currentPhase(): RacePhase {
    return this.phase;
  }

  get clock(): number {
    return this.raceTime;
  }

  /** Starts the lights sequence. */
  start(): void {
    if (this.phase !== 'GRID' || this.countdown !== null || this.started) return;
    this.countdown = LIGHTS_COUNTDOWN;
    this.headline = 'Five red lights…';
  }

  /** Advances the simulation by one fixed step. */
  step(): void {
    if (this.finished) return;
    const dt = ENGINE_DT;
    if (this.phase === 'GRID') {
      if (this.countdown === null) return;
      if (this.started) this.advanceClock(dt);
      this.countdown -= dt;
      if (this.countdown <= 0) this.lightsOut();
      return;
    }
    if (this.phase === 'SUSPENDED') {
      this.advanceClock(dt);
      if (this.countdown !== null) {
        this.countdown -= dt;
        if (this.countdown <= 0) {
          // Do not restart into a monsoon: wait for the worst of it to pass.
          if (this.wx.trackWetness > 0.88 && this.wx.rainIntensity > 0.6) this.countdown = 30;
          else this.formRestartGrid();
        }
      }
      return;
    }
    if (this.phase !== 'RACING') return;

    this.advanceClock(dt);
    this.updateRaceControl();
    this.buildTrackOrder();
    for (const car of this.cars) this.updateCar(car, dt);
    this.rankCars();
    this.flushPitRecords();
    if (this.raceTime >= this.nextSlowTick) {
      this.nextSlowTick = this.raceTime + 0.5;
      this.slowTick();
    }
    this.checkRaceEnd();
  }

  drain(): EngineOutbox {
    const out = this.outbox;
    this.outbox = RaceEngine.emptyOutbox();
    return out;
  }

  /** Weather forecast as the pit wall sees it right now. */
  forecastNow(): WeatherForecastPoint[] {
    const stamp = Math.floor(this.raceTime / 5);
    if (stamp === this.forecastStamp && this.forecastCache.length > 0) return this.forecastCache;
    const leader = this.order[0] ?? this.cars[0];
    const lapSeconds = leader ? clamp(leader.lapTimeNow, this.T, this.T * 1.6) : this.T + 4;
    const leaderLap = leader ? leader.lapsCompleted + Math.max(0, leader.tau) / this.T + 1 : 1;
    const remaining = Math.max(0, this.raceLaps + 1 - leaderLap) * lapSeconds;
    const horizon = clamp(remaining + 120, 600, 7200);
    const step = horizon > 3600 ? 40 : 20;
    const now = this.raceTime;
    this.forecastCache = this.weather.forecast(now, horizon, step, (t) => leaderLap + (t - now) / lapSeconds);
    this.forecastStamp = stamp;
    return this.forecastCache;
  }

  // ───────────────────────────────────────────────────────────────── clock ──

  private advanceClock(dt: number): void {
    this.raceTime += dt;
    this.weather.step(dt, this.raceTime, this.onTrack.length);
    this.wx = this.weather.state;
    if (this.raceTime >= this.nextWeatherSample) {
      this.nextWeatherSample = this.raceTime + 10;
      const leader = this.order[0];
      const lap = leader ? leader.lapsCompleted + clamp(leader.tau / this.T, 0, 1) + 1 : 1;
      this.outbox.weather = {
        sample: { raceTime: this.raceTime, lap, rainIntensity: this.wx.rainIntensity, trackWetness: this.wx.trackWetness },
        forecast: this.forecastNow(),
      };
    }
  }

  private lightsOut(): void {
    const firstStart = !this.started;
    this.started = true;
    this.phase = 'RACING';
    this.countdown = null;
    this.flag = 'GREEN';
    this.launchTime = this.raceTime;
    this.freeStartUntil = this.raceTime + START_FREE_TIME;
    const leaderLaps = Math.max(...this.cars.filter((c) => c.status === 'GRID').map((c) => c.lapsCompleted), 0);
    this.drsFromLap = leaderLaps + 1 + DRS_ENABLE_LAPS;
    this.drsEnabled = false;
    const slippery = 1 + 2 * this.wx.trackWetness;
    for (const car of this.cars) {
      if (car.status !== 'GRID') continue;
      car.status = 'RACING';
      car.launchDelay = 0.16 + Math.abs(this.rngNoise.normal()) * 0.07;
      const tyreBonus = car.set.compound === 'SOFT' ? 0.012 : car.set.compound === 'HARD' ? -0.012 : 0;
      car.launchQuality = clamp(1 + tyreBonus + this.rngNoise.normal() * 0.03 * slippery, 0.86, 1.08);
      car.lapStartTime = this.raceTime;
      car.sectorStartTime = this.raceTime;
      car.currentSector = 0;
      car.lapFlag = 'GREEN';
      car.lapCompound = car.set.compound;
      car.lapStartedInPit = false;
      car.lapNoise = this.rngNoise.normal() * car.driver.consistency * this.scale;
      car.rate = 0;
    }
    this.headline = firstStart ? 'Lights out and away we go' : 'Race restarted';
    this.event('START', 'INFO', firstStart ? 'LIGHTS OUT — race started' : 'STANDING RESTART — race resumed', []);
    for (const player of this.players) {
      if (player.status === 'RACING') {
        this.say({ carId: player.id, from: 'ENGINEER', category: 'INFO', severity: 'INFO', phrase: 'start', vars: { pos: player.position } });
      }
    }
  }

  // ────────────────────────────────────────────────────────── race control ──

  private updateRaceControl(): void {
    const now = this.raceTime;

    if (this.yellows.length > 0) {
      const before = this.yellows.length;
      this.yellows = this.yellows.filter((y) => y.until > now);
      if (this.yellows.length !== before) {
        this.incidents = this.incidents.filter((i) => this.yellows.some((y) => y.incident === i) || this.safetyCar !== null || this.vscUntil !== null);
      }
    }

    if (this.escalation && now >= this.escalation.at) {
      const { kind, reason } = this.escalation;
      this.escalation = null;
      if (kind === 'VSC') this.deployVsc(reason);
      else if (kind === 'SC') this.deploySafetyCar(reason);
      else this.redFlag(reason);
      if (this.phase !== 'RACING') return;
    }

    if (this.vscUntil !== null && now >= this.vscUntil) {
      this.vscUntil = null;
      this.incidents = [];
      this.yellows = [];
      this.event('FLAG', 'INFO', 'VSC ENDING — green flag', []);
      this.headline = 'VSC ending';
      this.onRestart();
    }

    const sc = this.safetyCar;
    if (sc) {
      if (sc.tau === null) {
        if (now >= sc.spawnAt) {
          const head = this.order.find((c) => c.status === 'RACING');
          sc.tau = mod((head ? head.tau : 0) + 5, this.T);
        }
      } else {
        const before = sc.tau;
        const advanced = before + ENGINE_DT / NEUTRALISED_PACE.SC;
        if (sc.inThisLap && before < this.pitEntryTau && advanced >= this.pitEntryTau) {
          this.safetyCar = null;
          this.incidents = [];
          this.yellows = [];
          for (const car of this.cars) if (car.status === 'RACING') car.noOvertake = true;
          this.event('FLAG', 'INFO', 'SAFETY CAR IN — green flag at the line', []);
          this.headline = 'Safety car in — green flag';
          this.onRestart();
        } else {
          if (!sc.inThisLap && advanced >= this.T && now >= sc.clearAt) {
            sc.inThisLap = true;
            this.event('FLAG', 'WARN', 'SAFETY CAR IN THIS LAP', []);
            this.headline = 'Safety car in this lap';
            for (const player of this.players) {
              if (player.status === 'RACING') {
                this.say({ carId: player.id, from: 'ENGINEER', category: 'INCIDENT', severity: 'INFO', phrase: 'scEnding' });
              }
            }
          }
          sc.tau = mod(advanced, this.T);
        }
      }
    }

    // Resolve the flag shown.
    const previous = this.flag;
    if (this.chequered) this.flag = 'CHEQUERED';
    else if (this.safetyCar) this.flag = 'SC';
    else if (this.vscUntil !== null) this.flag = 'VSC';
    else if (this.yellows.length > 0) this.flag = 'YELLOW';
    else this.flag = 'GREEN';
    if (previous !== this.flag && this.flag === 'GREEN' && previous === 'YELLOW') {
      this.event('FLAG', 'INFO', 'TRACK CLEAR — green flag', []);
      this.headline = 'Track clear';
    }

    // DRS availability.
    const leader = this.order[0];
    const leaderLap = leader ? leader.lapsCompleted + 1 : 1;
    const allowed =
      (this.flag === 'GREEN' || this.flag === 'YELLOW') && leaderLap >= this.drsFromLap && this.wx.trackWetness < DRS_MAX_WETNESS;
    if (allowed !== this.drsEnabled) {
      this.drsEnabled = allowed;
      if (this.flag === 'GREEN' || this.flag === 'YELLOW') {
        this.event('DRS', 'INFO', allowed ? 'DRS ENABLED' : 'DRS DISABLED', []);
      }
    }
  }

  /** Back to green after a neutralisation: DRS stays off for two laps. */
  private onRestart(): void {
    const leader = this.order[0];
    this.drsFromLap = (leader ? leader.lapsCompleted + 1 : 1) + DRS_ENABLE_LAPS;
    for (const player of this.players) {
      if (player.status === 'RACING') {
        this.say({ carId: player.id, from: 'ENGINEER', category: 'INCIDENT', severity: 'INFO', phrase: 'greenFlag' });
      }
    }
    this.outbox.projectionDue.push(...this.players.filter((p) => p.status === 'RACING').map((p) => p.id));
  }

  private sectorOfTau(tau: number): 0 | 1 | 2 {
    const t = mod(tau, this.T);
    return t < this.sectorTau[0] ? 0 : t < this.sectorTau[1] ? 1 : 2;
  }

  private isYellowAt(tau: number): boolean {
    if (this.yellows.length === 0) return false;
    const sector = this.sectorOfTau(tau);
    return this.yellows.some((y) => y.sector === sector);
  }

  private addYellow(car: Car, duration: number, withIncident: boolean): void {
    const sector = this.sectorOfTau(car.tau);
    const incident: TrackIncident | null = withIncident ? { lapFraction: this.fractionOf(car.tau), carId: car.id } : null;
    if (incident) this.incidents.push(incident);
    this.yellows.push({ sector, until: this.raceTime + duration, incident });
    if (this.flag === 'GREEN') {
      this.event('FLAG', 'WARN', `YELLOW FLAG — sector ${sector + 1}`, [car.id]);
      this.headline = `Yellow flag in sector ${sector + 1}`;
    }
  }

  private cancelBattles(): void {
    for (const car of this.cars) {
      car.passing = null;
      car.passTimer = 0;
      car.drsZone = -1;
      car.drsOpen = false;
    }
    this.swap = null;
  }

  private deployVsc(reason: string): void {
    if (this.safetyCar || this.phase !== 'RACING' || this.chequered) return;
    const wasActive = this.vscUntil !== null;
    this.vscUntil = this.raceTime + this.rngControl.range(55, 130);
    if (wasActive) return;
    this.cancelBattles();
    this.flag = 'VSC';
    this.event('FLAG', 'WARN', `VIRTUAL SAFETY CAR DEPLOYED — ${reason}`, []);
    this.headline = 'Virtual safety car deployed';
    this.onNeutralisation('VSC');
  }

  private deploySafetyCar(reason: string): void {
    if (this.phase !== 'RACING' || this.chequered) return;
    if (this.safetyCar) {
      this.safetyCar.clearAt = Math.max(this.safetyCar.clearAt, this.raceTime + 120);
      this.safetyCar.inThisLap = false;
      return;
    }
    this.vscUntil = null;
    this.cancelBattles();
    this.safetyCar = {
      deployedAt: this.raceTime,
      tau: null,
      spawnAt: this.raceTime + 10,
      clearAt: this.raceTime + this.rngControl.range(190, 400),
      inThisLap: false,
    };
    this.flag = 'SC';
    this.event('FLAG', 'CRITICAL', `SAFETY CAR DEPLOYED — ${reason}`, []);
    this.headline = 'Safety car deployed';
    this.onNeutralisation('SC');
  }

  /** Every pit wall reconsiders its strategy the moment the race is neutralised. */
  private onNeutralisation(kind: 'SC' | 'VSC'): void {
    this.rankCars();
    for (const car of this.cars) {
      if (car.status !== 'RACING') continue;
      if (car.isPlayer) {
        const green = pitLossUnderFlag(this.track, 'GREEN');
        const loss = pitLossUnderFlag(this.track, kind);
        // One message: the facts, plus what our strategist would do.
        const ctx = car.box ? null : this.buildContext(car, this.remainingStops(car));
        const decision = ctx ? this.deps.decideStrategy(ctx) : null;
        const suggested = decision?.box ? car.sets.find((s) => s.id === decision.box!.setId) : undefined;
        const call = car.box
          ? 'Stop already called.'
          : decision?.box
            ? `Strategy call: BOX. ${decision.rationale}.`
            : `Strategy call: STAY OUT.${decision ? ` ${decision.rationale}.` : ''}`;
        const replies = this.boxReplies(car, 'SAFETY_CAR', true, suggested?.compound);
        this.say({
          carId: car.id,
          from: 'ENGINEER',
          category: 'INCIDENT',
          severity: 'WARN',
          phrase: kind === 'SC' ? 'safetyCar' : 'vsc',
          vars: { loss: loss.toFixed(1), green: green.toFixed(1), call },
          quickReplies: car.box ? [] : replies.replies,
          ttl: 150,
        }, replies.handlers);
        this.radio.ready(`advice-${car.id}-SAFETY_CAR`, this.raceTime, 240);
        this.outbox.attention = true;
      } else if (mod(car.tau, this.T) < this.pitEntryTau) {
        // Not yet past the pit entry: the call can still be made for this lap.
        car.decidedLap = 0;
        this.decideAi(car);
      }
    }
    this.outbox.projectionDue.push(...this.players.filter((p) => p.status === 'RACING').map((p) => p.id));
  }

  private redFlag(reason: string): void {
    if (this.phase !== 'RACING' || this.chequered) return;
    this.rankCars();
    this.phase = 'SUSPENDED';
    this.flag = 'RED';
    this.redFlagTime = this.raceTime;
    this.countdown = RED_FLAG_DURATION;
    this.safetyCar = null;
    this.vscUntil = null;
    this.yellows = [];
    this.incidents = [];
    this.escalation = null;
    this.cancelBattles();
    this.event('FLAG', 'CRITICAL', `RED FLAG — ${reason}. Race suspended`, []);
    this.headline = 'Red flag — race suspended';

    // Freeze the order, bring everyone into the pit lane and give the AI teams their free tyre change.
    const running = this.order.filter((c) => c.status !== 'RETIRED' && c.status !== 'FINISHED');
    for (const car of running) {
      car.finishProgress = this.progressOf(car);
      car.status = 'PIT_BOX';
      car.pit = null;
      car.box = null;
      car.rate = 0;
      car.timeLoss = 0;
      car.puncture = false;
      car.ahead = null;
      car.gapTau = Infinity;
      if (!car.isPlayer) this.redFlagTyreChange(car);
    }
    this.onTrack = [];
    this.say({ carId: null, from: 'ENGINEER', category: 'INCIDENT', severity: 'CRITICAL', phrase: 'redFlag' });
    this.outbox.attention = true;
  }

  private redFlagTyreChange(car: Car): void {
    const wetness = this.wx.trackWetness;
    const wanted = bestTyreClass(wetness);
    const lapsLeft = this.raceLaps - car.lapsCompleted;
    let compound: TyreCompound | null = null;
    if (wanted !== 'SLICK') {
      // Fresh wet-weather tyres only if the ones on the car are the wrong kind or already used up.
      if (COMPOUNDS[car.set.compound].tyreClass !== wanted || car.set.wear > 0.25) compound = wanted === 'WET' ? 'WET' : 'INTER';
    } else if (!isSlick(car.set.compound) || car.set.wear > 0.3) {
      const next = car.plan[0]?.compound;
      const perLap = wearPerLap({ track: this.track, compound: 'MEDIUM', fuelKg: car.fuel });
      compound = next && isSlick(next) ? next : lapsLeft * perLap > 0.95 ? 'HARD' : lapsLeft < 14 ? 'SOFT' : 'MEDIUM';
    }
    if (!compound) return;
    const set = bestSet(car.sets, compound);
    if (!set || set === car.set) return;
    const from = car.set.compound;
    this.fitSet(car, set, COMPOUNDS[set.compound].blanketReadiness + 0.2);
    car.pitStops += 1;
    car.lastPitLap = car.lapsCompleted + 1;
    // A stop for the same kind of tyre that was due soon has just been made for free.
    const lap = car.lapsCompleted + 1;
    const fittedClass = COMPOUNDS[set.compound].tyreClass;
    car.plan = car.plan.filter((stop) => !(stop.lap <= lap + 8 && COMPOUNDS[stop.compound].tyreClass === fittedClass));
    this.outbox.pitStops.push({
      carId: car.id,
      lap: car.lapsCompleted + 1,
      raceTime: this.raceTime,
      fromCompound: from,
      toCompound: set.compound,
      toSetId: set.id,
      reason: 'OPPORTUNISTIC',
      stationaryTime: 0,
      queueTime: 0,
      timeLost: 0,
      flag: 'RED',
      positionBefore: car.position,
      positionAfter: car.position,
    });
  }

  /** After the suspension the field lines up on the grid in race order for a standing restart. */
  private formRestartGrid(): void {
    const running = this.order.filter((c) => c.status === 'PIT_BOX');
    const leader = running[0];
    if (!leader) {
      this.finishRace();
      return;
    }
    const leaderProgress = leader.finishProgress;
    const burn = fuelBurnPerLap(this.track);
    running.forEach((car, slot) => {
      const frozen = car.finishProgress;
      const lapsDown = Math.max(0, Math.floor((leaderProgress - frozen) / this.T));
      const laps = Math.max(car.lapsCompleted, Math.floor(leaderProgress / this.T) - lapsDown);
      // The interrupted lap is run again from the grid: hand back the fuel already spent on it.
      const repeated = frozen - laps * this.T;
      if (repeated > 0) car.fuel += (burn * repeated) / this.T;
      // A car that had not reached the line yet is credited with the lap: keep its lap history gap-free.
      for (let lap = car.lapsCompleted + 1; lap <= laps; lap++) {
        const gap = Math.max(0, leaderProgress - frozen) * car.paceEma;
        const lapSeconds = Math.max(1, this.redFlagTime - car.lapStartTime);
        const leaderTime = this.lapLeaderTime[lap] ?? this.redFlagTime;
        car.set.laps += 1;
        car.lastLap = lapSeconds;
        this.outbox.laps.push({
          carId: car.id,
          lap,
          lapTime: lapSeconds,
          sectors: [lapSeconds, 0, 0],
          raceTime: leaderTime + gap,
          position: car.position,
          gapToLeader: gap,
          compound: car.lapCompound,
          tyreAge: car.set.laps,
          tyreWear: car.set.wear,
          fuelKg: car.fuel,
          pitIn: false,
          pitOut: car.lapStartedInPit,
          flag: 'RED',
          trackWetness: this.wx.trackWetness,
        });
        if (this.lapLeaderTime[lap] === undefined) this.lapLeaderTime[lap] = leaderTime;
      }
      car.lapsCompleted = laps;
      car.tau = -(0.06 + slot * GRID_SLOT);
      car.status = 'GRID';
      car.readiness = Math.max(car.readiness, 0.8);
      car.finishProgress = 0;
      car.drsZone = -1;
      car.drsOpen = false;
      car.passing = null;
      car.noOvertake = false;
      car.box = null;
    });
    this.restarts += 1;
    this.phase = 'GRID';
    this.flag = 'GREEN';
    this.countdown = LIGHTS_COUNTDOWN + 1;
    this.headline = 'Cars on the grid for the restart';
    this.event('FLAG', 'INFO', 'RACE WILL RESUME — standing restart', []);
    this.rankCars();
  }

  // ─────────────────────────────────────────────────────────── track order ──

  private buildTrackOrder(): void {
    const T = this.T;
    const list = this.onTrack;
    list.length = 0;
    for (const car of this.cars) {
      car.battleWith = null;
      if (car.status === 'RACING') list.push(car);
    }
    list.sort((a, b) => mod(a.tau, T) - mod(b.tau, T));
    const n = list.length;
    const scTau = this.safetyCar?.tau ?? null;
    for (let i = 0; i < n; i++) {
      const car = list[i]!;
      const ahead = n > 1 ? list[(i + 1) % n]! : null;
      const pos = mod(car.tau, T);
      let gap = ahead ? mod(mod(ahead.tau, T) - pos, T) : Infinity;
      // Two cars exactly level: treat the other one as ahead only once.
      if (ahead && gap === 0 && ahead.idx < car.idx) gap = T;
      car.ahead = ahead;
      car.aheadIsSafetyCar = false;
      if (scTau !== null) {
        const toSc = mod(scTau - pos, T);
        if (toSc < gap) {
          gap = toSc;
          car.aheadIsSafetyCar = true;
        }
      }
      car.gapTau = gap;
      if (ahead) ahead.behindGapTau = car.aheadIsSafetyCar ? Infinity : gap;
    }
    if (n === 1) list[0]!.behindGapTau = Infinity;
  }

  private rankCars(): void {
    this.order = this.cars.slice().sort((a, b) => {
      const ra = a.status === 'RETIRED' ? 1 : 0;
      const rb = b.status === 'RETIRED' ? 1 : 0;
      if (ra !== rb) return ra - rb;
      const pa = this.progressOf(a);
      const pb = this.progressOf(b);
      if (pa !== pb) return pb - pa;
      if (a.finishTime !== null && b.finishTime !== null) return a.finishTime - b.finishTime;
      return a.gridPosition - b.gridPosition;
    });
    for (let i = 0; i < this.order.length; i++) this.order[i]!.position = i + 1;
  }

  private progressOf(car: Car): number {
    if (car.status === 'FINISHED' || car.status === 'PIT_BOX' && this.phase === 'SUSPENDED') return car.finishProgress;
    return car.lapsCompleted * this.T + car.tau;
  }

  private fractionOf(tau: number): number {
    return timeToDistance(this.geometry, mod(tau, this.T) / this.T);
  }

  // ──────────────────────────────────────────────────────────── car update ──

  private updateCar(car: Car, dt: number): void {
    switch (car.status) {
      case 'RACING':
        this.updateRacing(car, dt);
        break;
      case 'PIT_LANE':
      case 'PIT_BOX':
        this.updatePit(car, dt);
        break;
      case 'FINISHED':
        // Cool-down lap: keep the car rolling on the map without affecting the classification.
        car.rate = 0.55;
        car.tau = mod(car.tau + car.rate * dt, this.T);
        break;
      default:
        break;
    }
  }

  private updateRacing(car: Car, dt: number): void {
    const T = this.T;
    const flag = this.flag;
    const freeStart = this.raceTime < this.freeStartUntil;
    const wetness = this.wx.trackWetness;

    // Traffic seen by this car.
    const gapSeconds = car.ahead && !freeStart && car.gapTau < 40 ? car.gapTau * car.paceEma : null;
    car.dirtyAir = car.aheadIsSafetyCar ? 0 : dirtyAirIntensity(gapSeconds);
    const threatened = car.behindGapTau < 0.75;
    const defending = car.isPlayer ? car.defend : threatened && car.driver.racecraft >= 0.8 && car.position <= 12;

    // Model lap time for the current state.
    const breakdown = computeLapTime({
      track: this.track,
      compound: car.set.compound,
      wear: car.set.wear,
      readiness: car.readiness,
      fuelKg: car.fuel,
      trackWetness: wetness,
      paceOffset: car.paceOffset,
      paceMode: car.paceMode,
      ersMode: car.ersMode,
      ersCharge: car.ersCharge,
      gapAhead: car.aheadIsSafetyCar ? null : gapSeconds,
      gripLevel: this.wx.gripLevel,
      wetSkill: car.driver.wetSkill,
    });
    let lap = breakdown.total + car.lapNoise;
    if (defending && threatened) lap += 0.12 * this.scale;
    car.lapTimeNow = lap;
    car.freeLapTime = lap - breakdown.dirtyAir;

    let rate = T / lap;
    const pos = mod(car.tau, T);

    // DRS flap.
    if (car.drsZone >= 0) {
      const zone = this.drsZones[car.drsZone]!;
      const inside = zone.start <= zone.end ? pos >= zone.start && pos < zone.end : pos >= zone.start || pos < zone.end;
      car.drsOpen = inside && this.drsEnabled && !this.isYellowAt(pos);
      if (car.drsOpen) rate *= 1 + DRS_SPEED_GAIN;
    } else {
      car.drsOpen = false;
    }

    // Neutralisations.
    let minGap = MIN_GAP;
    if (flag === 'VSC') {
      rate = 1 / NEUTRALISED_PACE.VSC;
    } else if (flag === 'SC') {
      rate = Math.min(rate, 1 / NEUTRALISED_PACE.SC_CATCH_UP);
      minGap = SC_QUEUE_GAP;
    } else if (this.isYellowAt(pos)) {
      rate /= NEUTRALISED_PACE.YELLOW_SECTOR;
    }

    // Standing start: reaction time then traction-limited launch.
    const sinceLaunch = this.raceTime - this.launchTime;
    if (sinceLaunch < 14) {
      const t = sinceLaunch - car.launchDelay;
      rate *= t <= 0 ? 0 : (1 - Math.exp(-t / 2.3)) * car.launchQuality;
    }

    // Time lost to mistakes, failed moves, blue flags.
    if (car.timeLoss > 0) {
      const share = car.timeLoss > 3 ? 0.85 : 0.3;
      rate *= 1 - share;
      car.timeLoss = Math.max(0, car.timeLoss - share * dt);
    }
    if (car.puncture) rate = Math.min(rate, 0.5);

    // Team order: the car that must yield lifts until its team-mate is through.
    const swap = this.swap;
    if (swap && swap.yielder === car) {
      const behind = mod(pos - mod(swap.beneficiary.tau, T), T);
      if (behind < 2.5) rate *= 0.9;
    }

    // Being lapped: blue flags, let the leader through without a fight.
    const ahead = car.ahead;
    if (ahead && !car.aheadIsSafetyCar && !freeStart && car.passing === null && flag !== 'SC' && flag !== 'VSC') {
      const lead = this.progressOf(car) - this.progressOf(ahead);
      const catching = car.freeLapTime < ahead.lapTimeNow && ahead.passing !== car;
      if (car.gapTau < 0.5 && lead > T * 0.5 && catching && !this.isYellowAt(pos)) {
        this.grantPass(car, ahead);
        ahead.timeLoss += 0.45;
        car.timeLoss += 0.1;
      } else if (swap && swap.beneficiary === car && swap.yielder === ahead && car.gapTau < 0.8 && ahead.passing !== car) {
        this.grantPass(car, ahead);
      }
    }

    // A pass in progress.
    if (car.passing) {
      car.passTimer -= dt;
      const target = car.passing;
      const stillBehind = car.ahead === target && !car.aheadIsSafetyCar;
      if (car.passTimer <= 0 || target.status !== 'RACING' || flag === 'SC' || flag === 'VSC') {
        car.passing = null;
      } else if (stillBehind) {
        rate = Math.max(rate, Math.min(target.rate, MAX_RATE) * 1.035 + 0.004);
      } else {
        const done = mod(pos - mod(target.tau, T), T);
        if (done < 30 && done > 0.12) this.completePass(car, target);
        else rate = Math.max(rate, Math.min(target.rate, MAX_RATE) * 1.02);
      }
    }
    // Nothing on four wheels laps much faster than the reference lap.
    if (rate > MAX_RATE * 1.06) rate = MAX_RATE * 1.06;

    // Advance, respecting the car ahead.
    let advance = rate * dt;
    const blocked = (car.ahead !== null || car.aheadIsSafetyCar) && !freeStart && !(car.passing && car.passing === car.ahead && !car.aheadIsSafetyCar);
    if (blocked) {
      const room = car.gapTau - minGap;
      if (advance > room) advance = Math.max(0, room);
    }
    const before = car.tau;
    car.tau = before + advance;
    car.rate = advance / dt;
    car.paceEma += (1 / Math.max(car.rate, 0.35) - car.paceEma) * (dt / 1.5);

    if (car.ahead && !car.aheadIsSafetyCar && car.gapTau < 0.4 && !freeStart) {
      const lead = Math.abs(this.progressOf(car) - this.progressOf(car.ahead));
      if (lead < T * 0.5) {
        car.battleWith = car.ahead;
        if (car.ahead.battleWith === null) car.ahead.battleWith = car;
      }
    }

    // Consumables and temperatures.
    const lapShare = advance / T;
    const neutral = flag === 'SC' || flag === 'VSC';
    car.set.wear +=
      lapShare *
      wearPerLap({
        track: this.track,
        compound: car.set.compound,
        fuelKg: car.fuel,
        paceMode: car.paceMode,
        wearFactor: car.driver.tyreWearFactor * (defending && threatened ? 1.06 : 1),
        dirtyAir: car.dirtyAir,
        trackWetness: wetness,
        trackTempC: this.wx.trackTempC,
        flag,
      });
    car.fuel = Math.max(0, car.fuel - lapShare * fuelBurnPerLap(this.track, car.paceMode, flag));
    car.ersCharge = clamp(car.ersCharge + lapShare * (neutral ? 0.15 : ERS_MODES[car.ersMode].chargePerLap), 0, 1);
    const target = flag === 'SC' ? 0.72 : flag === 'VSC' ? 0.8 : 1;
    car.readiness = readinessAfter(car.readiness, lapShare, warmupTimeConstant(car.set.compound, this.wx.trackTempC, wetness), target);
    const engineTarget = engineTempTarget({ paceMode: car.paceMode, ersMode: car.ersMode, dirtyAir: car.dirtyAir, airTempC: this.wx.airTempC, flag });
    const brakeTarget = brakeTempTarget({ paceMode: car.paceMode, dirtyAir: car.dirtyAir, airTempC: this.wx.airTempC, flag });
    car.engineTemp += (engineTarget - car.engineTemp) * (1 - Math.exp(-dt / 25));
    car.brakeTemp += (brakeTarget - car.brakeTemp) * (1 - Math.exp(-dt / 12));

    if (car.fuel <= 0) {
      this.retire(car, 'Out of fuel', false);
      this.addYellow(car, 30, true);
      return;
    }

    // Timing lines and decision points crossed during this step.
    const crossed = (point: number): boolean => before < point && car.tau >= point;
    const timeAt = (point: number): number => this.raceTime - dt + (advance > 0 ? (dt * (point - before)) / advance : dt);

    if (crossed(this.sectorTau[0])) this.recordSector(car, 0, timeAt(this.sectorTau[0]));
    if (crossed(this.sectorTau[1])) this.recordSector(car, 1, timeAt(this.sectorTau[1]));

    for (let z = 0; z < this.drsZones.length; z++) {
      const zone = this.drsZones[z]!;
      if (crossed(zone.detection)) {
        const eligible =
          this.drsEnabled &&
          !car.aheadIsSafetyCar &&
          gapSeconds !== null &&
          gapSeconds <= DRS_DETECTION_GAP &&
          !this.yellows.some((y) => y.sector === zone.sector);
        car.drsZone = eligible ? z : -1;
      }
      if (car.drsZone === z && crossed(zone.end)) {
        car.drsZone = -1;
        car.drsOpen = false;
      }
    }

    for (const spot of this.overtakeSpots) {
      if (crossed(spot.tau)) this.attemptOvertake(car, spot.drsZone);
    }

    if (crossed(this.adviceTau) && car.isPlayer) this.advise(car, false);
    if (crossed(this.decisionTau)) {
      if (car.isPlayer) this.playerPitEntryCheck(car);
      else this.decideAi(car);
    }

    if (car.box && crossed(this.pitEntryTau)) {
      this.enterPit(car);
      return;
    }

    if (car.tau >= T) {
      const lineTime = timeAt(T);
      car.tau -= T;
      this.completeLap(car, lineTime);
    }
  }

  // ───────────────────────────────────────────────────────────── overtaking ──

  private grantPass(attacker: Car, target: Car): void {
    if (target.passing === attacker) target.passing = null;
    attacker.passing = target;
    attacker.passTimer = 9;
  }

  private completePass(attacker: Car, target: Car): void {
    attacker.passing = null;
    const lead = this.progressOf(attacker) - this.progressOf(target);
    if (Math.abs(lead) < this.T * 0.5) {
      // A genuine pass for position: the car passed is off line and cannot counter-attack at once.
      target.timeLoss += 0.35;
      target.attackAfter = this.raceTime + 1.2 * target.lapTimeNow;
      if (this.swap && this.swap.beneficiary === attacker && this.swap.yielder === target) {
        this.swap = null;
        this.event('TEAM_ORDER', 'INFO', `${attacker.id} and ${target.id} swap positions under team orders`, [attacker.id, target.id]);
        this.say({ carId: null, from: 'ENGINEER', category: 'TEAM_ORDER', severity: 'INFO', phrase: 'swapDone' });
        return;
      }
      const position = Math.min(attacker.position, target.position);
      if (position <= 10 || attacker.isPlayer || target.isPlayer) {
        this.event('OVERTAKE', 'INFO', `${attacker.id} passes ${target.id} for P${position}`, [attacker.id, target.id]);
      }
      const worthSaying = attacker.team.id !== target.team.id && this.raceTime - this.launchTime > 150;
      if (worthSaying && attacker.isPlayer && this.radio.ready(`position-${attacker.id}`, this.raceTime, 75)) {
        this.say({ carId: attacker.id, from: 'ENGINEER', category: 'TRAFFIC', severity: 'INFO', phrase: 'positionGain', vars: { pos: position } });
      }
      if (worthSaying && target.isPlayer && this.radio.ready(`position-${target.id}`, this.raceTime, 75)) {
        this.say({ carId: target.id, from: 'ENGINEER', category: 'TRAFFIC', severity: 'INFO', phrase: 'positionLost', vars: { rival: attacker.id, pos: position + 1 } });
      }
    }
  }

  private attemptOvertake(car: Car, drsZone: number): void {
    const target = car.ahead;
    if (!target || car.aheadIsSafetyCar || car.passing || car.noOvertake) return;
    if (this.raceTime < this.freeStartUntil || this.raceTime < car.attackAfter) return;
    if (this.flag !== 'GREEN' && this.flag !== 'YELLOW') return;
    if (car.gapTau > BATTLE_GAP) return;
    if (this.isYellowAt(car.tau)) return;

    if (target.passing === car) return; // that car is in the middle of passing us
    const lead = this.progressOf(car) - this.progressOf(target);
    if (lead > this.T * 0.5) return; // lapping is handled by blue flags
    const advantage = target.lapTimeNow - car.freeLapTime;
    if (lead < -this.T * 0.5 && advantage < 1.2 * this.scale) return; // a lapped car does not fight the leaders

    if (car.team.id === target.team.id && car.isPlayer) {
      if (this.swap && this.swap.beneficiary === car) {
        this.grantPass(car, target);
        return;
      }
      if (this.teamOrder === 'HOLD') return;
    }

    const targetDefends = target.isPlayer ? target.defend : target.driver.racecraft >= 0.8 && target.position <= 12;
    const probability = overtakeProbability(this.track, advantage, {
      drs: drsZone >= 0 && car.drsOpen && !target.drsOpen,
      attackerErs: car.ersCharge > 0.02 ? car.ersMode : 'BALANCED',
      defenderErs: target.ersCharge > 0.02 ? target.ersMode : 'BALANCED',
      defending: targetDefends,
      racecraftDelta: car.driver.racecraft - target.driver.racecraft,
      trackWetness: this.wx.trackWetness,
    });
    if (this.rngFight.chance(probability)) {
      this.grantPass(car, target);
    } else {
      // A failed lunge costs the attacker a little momentum and both a little rubber.
      car.timeLoss += 0.12;
      car.set.wear += 0.0015;
      target.set.wear += 0.0008;
    }
  }

  // ───────────────────────────────────────────────────────────────── timing ──

  private recordSector(car: Car, sector: 0 | 1 | 2, time: number): void {
    const elapsed = time - car.sectorStartTime;
    car.sectorStartTime = time;
    car.lapSectors[sector] = elapsed;
    const personal = car.bestSectors[sector];
    const overall = this.bestSectors[sector];
    let flag: SectorCell['flag'] = 'YELLOW';
    if (overall === null || elapsed < overall) {
      flag = 'PURPLE';
      this.bestSectors[sector] = elapsed;
    } else if (personal === null || elapsed < personal) {
      flag = 'GREEN';
    }
    if (personal === null || elapsed < personal) car.bestSectors[sector] = elapsed;
    car.sectorCells[sector] = { time: elapsed, flag };
    car.currentSector = sector === 2 ? 0 : sector === 0 ? 1 : 2;
  }

  private completeLap(car: Car, lineTime: number): void {
    this.recordSector(car, 2, lineTime);
    const lapSeconds = lineTime - car.lapStartTime;
    car.lapsCompleted += 1;
    car.set.laps += 1;
    car.lastLap = lapSeconds;
    const inPit = car.pit !== null;
    const clean = !inPit && !car.lapStartedInPit && FLAG_SEVERITY[car.lapFlag] < FLAG_SEVERITY.VSC;
    if (clean && (car.bestLap === null || lapSeconds < car.bestLap)) car.bestLap = lapSeconds;
    if (clean && car.lapsCompleted >= 2 && (this.fastestLap === null || lapSeconds < this.fastestLap.time)) {
      this.fastestLap = { carId: car.id, time: lapSeconds, lap: car.lapsCompleted };
      if (car.lapsCompleted >= 4) {
        this.event('FASTEST_LAP', 'INFO', `FASTEST LAP — ${car.id} ${formatLap(lapSeconds)}`, [car.id]);
        if (car.isPlayer && this.radio.ready(`fl-${car.id}`, this.raceTime, 240)) {
          this.say({ carId: car.id, from: 'ENGINEER', category: 'INFO', severity: 'INFO', phrase: 'fastestLap', vars: { time: formatLap(lapSeconds) } });
        }
      }
    }

    const lap = car.lapsCompleted;
    if (this.lapLeaderTime[lap] === undefined) this.lapLeaderTime[lap] = lineTime;
    const leaderTime = this.lapLeaderTime[lap] ?? lineTime;

    // The flag falls for the first car to complete the distance; everybody else finishes on this crossing
    // once it is out. Classify the car before recording the lap so the record carries its final position.
    const wins = !this.chequered && car.lapsCompleted >= this.raceLaps;
    const finishing = this.chequered || wins;
    const lapFlag = car.lapFlag;
    const startedInPit = car.lapStartedInPit;
    if (wins) {
      this.chequered = true;
      this.flag = 'CHEQUERED';
      this.yellows = [];
      this.incidents = [];
      this.safetyCar = null;
      this.vscUntil = null;
      this.escalation = null;
    }
    if (finishing) this.finishCar(car, lineTime);

    this.outbox.laps.push({
      carId: car.id,
      lap,
      lapTime: lapSeconds,
      sectors: [car.lapSectors[0], car.lapSectors[1], car.lapSectors[2]],
      raceTime: lineTime,
      position: this.livePosition(car),
      gapToLeader: Math.max(0, lineTime - leaderTime),
      compound: car.lapCompound,
      tyreAge: car.set.laps,
      tyreWear: car.set.wear,
      fuelKg: car.fuel,
      pitIn: inPit,
      pitOut: startedInPit,
      flag: lapFlag,
      trackWetness: this.wx.trackWetness,
    });

    car.lapStartTime = lineTime;
    car.lapFlag = this.flag === 'CHEQUERED' ? 'GREEN' : this.flag;
    car.lapCompound = car.set.compound;
    car.lapStartedInPit = inPit;
    car.lapNoise = this.rngNoise.normal() * car.driver.consistency * this.scale;
    car.noOvertake = false;

    if (wins) {
      this.event('FINISH', 'INFO', `CHEQUERED FLAG — ${car.id} wins the ${this.track.grandPrix}`, [car.id]);
      this.headline = `${car.id} wins`;
    } else if (!finishing && car.isPlayer) {
      this.outbox.projectionDue.push(car.id);
      if (car.lapsCompleted === this.raceLaps - 1) {
        this.say({ carId: car.id, from: 'ENGINEER', category: 'INFO', severity: 'INFO', phrase: 'lastLap' });
      }
    }
  }

  /** Position of a car counted live (the cached order may be one step old when a lap is recorded). */
  private livePosition(car: Car): number {
    if (car.status === 'RETIRED') return car.position;
    const own = this.progressOf(car);
    let position = 1;
    for (const other of this.cars) {
      if (other === car || other.status === 'RETIRED') continue;
      const p = this.progressOf(other);
      if (p > own || (p === own && other.finishTime !== null && car.finishTime !== null && other.finishTime < car.finishTime)) position += 1;
    }
    return position;
  }

  private finishCar(car: Car, time: number): void {
    car.finishTime = time;
    car.finishProgress = car.lapsCompleted * this.T - this.finishCount * 1e-6;
    this.finishCount += 1;
    car.status = 'FINISHED';
    car.pit = null;
    car.box = null;
    car.passing = null;
    car.drsZone = -1;
    car.drsOpen = false;
  }

  private checkRaceEnd(): void {
    if (!this.chequered || this.finished) return;
    if (this.cars.some((c) => c.status === 'RACING' || c.status === 'PIT_LANE' || c.status === 'PIT_BOX')) return;
    this.finishRace();
  }

  private finishRace(): void {
    if (this.finished) return;
    this.finished = true;
    this.phase = 'FINISHED';
    this.flag = 'CHEQUERED';

    // Rule check: two different dry compounds unless wet-weather tyres were used.
    for (const car of this.cars) {
      if (car.status !== 'FINISHED') continue;
      const usedWet = car.compoundsUsed.some((c) => !isSlick(c));
      const dry = new Set(car.compoundsUsed.filter((c) => isSlick(c)));
      if (!usedWet && dry.size < 2) {
        car.penaltySeconds = 30;
        this.event('PENALTY', 'WARN', `${car.id} — 30 s penalty: two dry compounds not used`, [car.id]);
        if (car.isPlayer) {
          this.say({ carId: car.id, from: 'ENGINEER', category: 'STRATEGY', severity: 'WARN', phrase: 'penalty', vars: { seconds: 30 } });
        }
      }
    }

    const finishers = this.cars
      .filter((c) => c.status === 'FINISHED')
      .sort((a, b) => {
        if (a.lapsCompleted !== b.lapsCompleted) return b.lapsCompleted - a.lapsCompleted;
        return (a.finishTime ?? 0) + a.penaltySeconds - ((b.finishTime ?? 0) + b.penaltySeconds);
      });
    const retired = this.cars.filter((c) => c.status !== 'FINISHED').sort((a, b) => this.progressOf(b) - this.progressOf(a));
    const winner = finishers[0];
    const classification: ClassificationEntry[] = [];
    [...finishers, ...retired].forEach((car, index) => {
      const done = car.status === 'FINISHED';
      const lapsDown = winner && done ? winner.lapsCompleted - car.lapsCompleted : 0;
      const total = done && car.finishTime !== null ? car.finishTime + car.penaltySeconds : null;
      const winnerTotal = winner && winner.finishTime !== null ? winner.finishTime + winner.penaltySeconds : null;
      classification.push({
        position: index + 1,
        carId: car.id,
        status: done ? 'FINISHED' : 'DNF',
        lapsCompleted: car.lapsCompleted,
        totalTime: done && lapsDown === 0 ? total : null,
        gap: done && lapsDown === 0 && total !== null && winnerTotal !== null ? total - winnerTotal : null,
        lapsDown,
        bestLapTime: car.bestLap,
        pitStops: car.pitStops,
        gridPosition: car.gridPosition,
        points: done ? (POINTS_TABLE[index] ?? 0) : 0,
        penaltySeconds: car.penaltySeconds,
        retiredReason: car.retiredReason,
      });
    });
    this.outbox.classification = classification;
    for (const player of this.players) {
      const entry = classification.find((c) => c.carId === player.id);
      if (entry && entry.status === 'FINISHED') {
        const delta = player.gridPosition - entry.position;
        const comment = delta > 0 ? `Up ${delta} from the grid, great drive.` : delta < 0 ? 'Tough one today, we will regroup.' : 'Solid race.';
        this.say({ carId: player.id, from: 'ENGINEER', category: 'INFO', severity: 'INFO', phrase: 'finish', vars: { pos: entry.position, comment } });
      }
    }
    this.headline = 'Race finished';
  }

  // ──────────────────────────────────────────────────────────────── pit lane ──

  private enterPit(car: Car): void {
    const box = car.box;
    if (!box) return;
    const flag = this.flag;
    let fieldRate: number;
    if (flag === 'SC') fieldRate = clamp(car.rate, 1 / NEUTRALISED_PACE.SC, 1 / NEUTRALISED_PACE.SC_CATCH_UP);
    else if (flag === 'VSC') fieldRate = 1 / NEUTRALISED_PACE.VSC;
    else fieldRate = this.T / car.freeLapTime;
    const onTrackTime = this.pitSpan / fieldRate;
    car.pit = {
      phase: 'IN',
      progress: 0,
      driveTime: onTrackTime + pitLaneTransitLoss(this.track, flag),
      boxPosition: car.team.pitBoxPosition,
      stopRemaining: 0,
      stationary: 0,
      queue: 0,
      slow: false,
      setId: box.setId,
      reason: box.reason,
      entryTime: this.raceTime,
      onTrackTime,
      positionBefore: car.position,
      fromCompound: car.set.compound,
      flag,
      lap: car.lapsCompleted + 1,
      lineCrossed: false,
    };
    car.status = 'PIT_LANE';
    car.tau = this.pitEntryTau;
    car.passing = null;
    car.drsZone = -1;
    car.drsOpen = false;
    car.dirtyAir = 0;
    car.ahead = null;
    car.gapTau = Infinity;
    car.timeLoss = 0;
    car.rate = fieldRate;
    this.event('PIT', 'INFO', `${car.id} pits from P${car.position}`, [car.id]);
    if (!car.isPlayer && flag === 'GREEN') this.notifyRivalStop(car);
  }

  /** A rival running directly ahead of or behind one of the user's cars has just dived into the pits. */
  private notifyRivalStop(rival: Car): void {
    this.buildViews();
    for (const player of this.players) {
      if (player.status !== 'RACING' || player.box) continue;
      const view = this.viewById.get(player.id);
      if (!view || this.raceLaps - player.lapsCompleted < 4) continue;
      const lapSeconds = player.lapTimeNow;
      if (view.carBehindId === rival.id && view.gapBehind !== null && view.gapBehind < 4) {
        const { replies, handlers } = this.boxReplies(player, 'COVER', false);
        this.say({
          carId: player.id, from: 'STRATEGY', category: 'UNDERCUT', severity: 'WARN', phrase: 'rivalPitted',
          vars: { rival: rival.id, gap: view.gapBehind.toFixed(1) }, quickReplies: replies, ttl: 1.2 * lapSeconds,
        }, handlers);
        this.outbox.attention = true;
      } else if (view.carAheadId === rival.id && view.gapAhead !== null && view.gapAhead < 4) {
        this.say({
          carId: player.id, from: 'STRATEGY', category: 'UNDERCUT', severity: 'INFO', phrase: 'aheadPitted', vars: { rival: rival.id },
          quickReplies: [{ id: 'push', label: 'PUSH NOW', tone: 'CONFIRM' }, { id: 'keep', label: 'KEEP PACE', tone: 'NEUTRAL' }], ttl: lapSeconds,
        }, new Map<string, ReplyHandler>([['push', () => { player.paceMode = 'PUSH'; }], ['keep', () => undefined]]));
      }
    }
  }

  private updatePit(car: Car, dt: number): void {
    const pit = car.pit;
    if (!pit) return;
    const before = pit.progress;
    switch (pit.phase) {
      case 'IN': {
        pit.progress = Math.min(pit.boxPosition, before + dt / pit.driveTime);
        if (pit.progress >= pit.boxPosition) {
          if (this.raceTime < this.boxBusyUntil[car.teamIdx]!) pit.phase = 'QUEUE';
          else this.startService(car, pit);
        }
        break;
      }
      case 'QUEUE': {
        pit.queue += dt;
        if (this.raceTime >= this.boxBusyUntil[car.teamIdx]!) this.startService(car, pit);
        break;
      }
      case 'STOP': {
        pit.stopRemaining -= dt;
        // A puncture stop or a slow stop still ends here; unsafe releases are not modelled.
        if (pit.stopRemaining <= 0) {
          const set = car.sets.find((s) => s.id === pit.setId) ?? bestSet(car.sets, car.set.compound) ?? car.set;
          this.fitSet(car, set, COMPOUNDS[set.compound].blanketReadiness);
          car.pitStops += 1;
          car.lastPitLap = pit.lap;
          car.puncture = false;
          car.status = 'PIT_LANE';
          pit.phase = 'OUT';
        }
        break;
      }
      case 'OUT': {
        pit.progress = before + dt / pit.driveTime;
        break;
      }
    }

    // The timing line runs through the pit lane.
    if (!pit.lineCrossed && before < this.pitLineProgress && pit.progress >= this.pitLineProgress) {
      pit.lineCrossed = true;
      const span = pit.progress - before;
      const lineTime = this.raceTime - dt + (span > 0 ? (dt * (this.pitLineProgress - before)) / span : dt);
      car.tau = 0;
      this.completeLap(car, lineTime);
      if (car.status === 'FINISHED') return;
    }

    car.tau = this.pitEntryTau + Math.min(1, pit.progress) * this.pitSpan - (pit.lineCrossed ? this.T : 0);
    car.rate = pit.phase === 'IN' || pit.phase === 'OUT' ? this.pitSpan / pit.driveTime : 0;

    if (pit.phase === 'OUT' && pit.progress >= 1) this.leavePit(car, pit);
  }

  private startService(car: Car, pit: PitVisit): void {
    const sample = sampleStationaryTime(this.rngPit, car.team.pitCrewTime);
    const stacked = pit.queue > 0 || this.raceTime - this.boxBusyUntil[car.teamIdx]! < 4;
    pit.stationary = sample.time + (stacked ? PIT_STOP.doubleStackPenalty : 0) + (car.puncture ? 0.8 : 0);
    pit.slow = sample.slow;
    pit.stopRemaining = pit.stationary;
    pit.phase = 'STOP';
    car.status = 'PIT_BOX';
    this.boxBusyUntil[car.teamIdx] = this.raceTime + pit.stationary + PIT_STOP.crewResetTime;
  }

  private leavePit(car: Car, pit: PitVisit): void {
    const T = this.T;
    car.status = 'RACING';
    car.pit = null;
    car.box = null;
    let tau = this.pitExitTau;
    // Cars on the racing line have priority at the pit exit: slot in behind anyone alongside.
    for (const other of this.cars) {
      if (other === car || other.status !== 'RACING') continue;
      const delta = mod(mod(other.tau, T) - tau + T / 2, T) - T / 2;
      if (delta > -0.14 && delta < 0.14) tau = Math.min(tau, mod(other.tau, T) - 0.2);
    }
    car.tau = Math.max(0.01, tau);
    car.sectorStartTime = car.lapStartTime;
    car.currentSector = 0;
    car.paceEma = Math.max(car.paceEma, 1);
    const timeLost = this.raceTime - pit.entryTime - pit.onTrackTime;
    car.pendingPitRecord = {
      carId: car.id,
      lap: pit.lap,
      raceTime: pit.entryTime,
      fromCompound: pit.fromCompound,
      toCompound: car.set.compound,
      toSetId: car.set.id,
      reason: pit.reason,
      stationaryTime: pit.stationary,
      queueTime: pit.queue,
      timeLost,
      flag: pit.flag,
      positionBefore: pit.positionBefore,
      positionAfter: null,
    };
    if (car.isPlayer) {
      this.pendingPitRadio.push({ car, stationary: pit.stationary, slow: pit.slow, queue: pit.queue });
      this.outbox.projectionDue.push(car.id);
    }
  }

  private readonly pendingPitRadio: { car: Car; stationary: number; slow: boolean; queue: number }[] = [];

  /** Pit stop records are emitted once the order has been recomputed, so they carry the rejoin position. */
  private flushPitRecords(): void {
    for (const car of this.cars) {
      const record = car.pendingPitRecord;
      if (!record) continue;
      record.positionAfter = car.position;
      this.outbox.pitStops.push(record);
      car.pendingPitRecord = null;
    }
    while (this.pendingPitRadio.length > 0) {
      const item = this.pendingPitRadio.pop()!;
      const { car } = item;
      const vars = { time: item.stationary.toFixed(1), pos: car.position, corner: this.rngPit.pick(WHEEL_CORNERS) };
      this.say({ carId: car.id, from: 'ENGINEER', category: 'PIT', severity: item.slow ? 'WARN' : 'INFO', phrase: item.slow ? 'pitSlow' : 'pitGood', vars });
      if (item.queue > 0.3) {
        this.say({ carId: car.id, from: 'ENGINEER', category: 'PIT', severity: 'WARN', phrase: 'pitQueue', vars: { time: item.queue.toFixed(1) } });
      }
      if (car.set.compound === 'HARD' || car.set.compound === 'MEDIUM') {
        this.say({ carId: car.id, from: 'ENGINEER', category: 'TYRES', severity: 'INFO', phrase: 'coldTyres', vars: { compound: COMPOUNDS[car.set.compound].label.toLowerCase() } });
      }
    }
  }

  private fitSet(car: Car, set: TyreSet, readiness: number): void {
    car.set.fitted = false;
    car.set = set;
    set.fitted = true;
    car.readiness = clamp(readiness, 0, 1);
    if (!car.compoundsUsed.includes(set.compound)) car.compoundsUsed.push(set.compound);
  }

  /** On the grid the fitted set follows the first stint of the active plan. */
  private fitStartingSet(car: Car): void {
    const strategy = car.strategy;
    const compound = strategy?.plans[strategy.activePlan].stints[0]?.compound;
    const set = (compound ? bestSet(car.sets, compound, car.set) : null) ?? firstUsable(car.sets, this.wx.trackWetness);
    car.compoundsUsed = [];
    this.fitSet(car, set, 0.85);
    car.lapCompound = set.compound;
  }

  // ─────────────────────────────────────────────────────────────── incidents ──

  private retire(car: Car, reason: string, critical: boolean): void {
    if (car.status === 'RETIRED' || car.status === 'FINISHED') return;
    car.status = 'RETIRED';
    car.retiredReason = reason;
    car.rate = 0;
    car.pit = null;
    car.box = null;
    car.passing = null;
    car.drsZone = -1;
    car.drsOpen = false;
    for (const other of this.cars) if (other.passing === car) other.passing = null;
    if (this.swap && (this.swap.yielder === car || this.swap.beneficiary === car)) this.swap = null;
    this.event('RETIREMENT', critical ? 'CRITICAL' : 'WARN', `${car.id} is OUT — ${reason}`, [car.id]);
  }

  private nearestCorner(tau: number): string {
    const fraction = this.fractionOf(tau);
    let best = 'the main straight';
    let bestDistance = Infinity;
    for (const corner of this.track.corners) {
      const d = Math.abs(mod(corner.at - fraction + 0.5, 1) - 0.5);
      if (d < bestDistance) {
        bestDistance = d;
        best = corner.name;
      }
    }
    return best;
  }

  private hazardTick(car: Car, seconds: number): void {
    const level = this.session.config.incidentLevel;
    if (level === 0 || this.chequered || car.status !== 'RACING') return;
    const neutral = this.flag === 'SC' || this.flag === 'VSC';
    const exposure = (car.rate / this.T) * seconds * (level === 2 ? 2.6 : 1);
    if (exposure <= 0) return;

    const error =
      (driverErrorFactor({
        compound: car.set.compound,
        wear: car.set.wear,
        trackWetness: this.wx.trackWetness,
        paceMode: car.paceMode,
        inBattle: car.battleWith !== null,
        firstLap: car.lapsCompleted === 0 && this.restarts === 0 && this.raceTime - this.launchTime < 45,
        errorProneness: car.driver.errorProneness,
        wetSkill: car.driver.wetSkill,
      }) /
        1.15) *
      (neutral ? 0.1 : 1);
    const mechanical = car.team.unreliability * overheatHazardFactor(car.engineTemp, car.brakeTemp) * (neutral ? 0.5 : 1);

    const pSafetyCar = this.rates.safetyCar * exposure * (0.6 * error + 0.4 * mechanical);
    const pVsc = this.rates.vsc * exposure * (0.5 * error + 0.5 * mechanical);
    const pYellow = this.rates.yellow * exposure * error;
    const pQuiet = 0.001 * exposure * mechanical;
    const pPuncture = car.puncture ? 0 : punctureHazardPerLap(car.set.wear) * (car.rate / this.T) * seconds;

    const roll = this.rngIncident.next();
    let threshold = pSafetyCar;
    if (roll < threshold) {
      const crash = this.rngIncident.chance(0.6 * error / Math.max(1e-6, 0.6 * error + 0.4 * mechanical));
      const where = this.nearestCorner(car.tau);
      const reason = crash ? `Crash at ${where}` : `Stopped at ${where} (${this.rngIncident.pick(FAILURES)})`;
      if (car.isPlayer) {
        this.say({ carId: car.id, from: crash ? 'DRIVER' : 'ENGINEER', category: 'INCIDENT', severity: 'CRITICAL', phrase: crash ? 'crash' : 'retire', vars: { failure: 'terminal' } });
      }
      this.retire(car, reason, true);
      this.addYellow(car, 600, true);
      const red = crash && this.rngIncident.chance(0.07);
      this.scheduleEscalation(red ? 'RED' : 'SC', `${car.id} ${crash ? 'in the barriers' : 'stopped on track'} at ${where}`, this.rngIncident.range(4, 9));
      return;
    }
    threshold += pVsc;
    if (roll < threshold) {
      const where = this.nearestCorner(car.tau);
      const failure = this.rngIncident.pick(FAILURES);
      if (car.isPlayer) {
        this.say({ carId: car.id, from: 'ENGINEER', category: 'INCIDENT', severity: 'CRITICAL', phrase: 'retire', vars: { failure } });
      }
      this.retire(car, `Stopped at ${where} (${failure})`, true);
      this.addYellow(car, 400, true);
      this.scheduleEscalation('VSC', `${car.id} stopped at ${where}`, this.rngIncident.range(4, 8));
      return;
    }
    threshold += pYellow;
    if (roll < threshold) {
      const where = this.nearestCorner(car.tau);
      if (this.rngIncident.chance(0.6)) {
        car.timeLoss += this.rngIncident.range(4, 11);
        car.set.wear += 0.03;
        this.event('INCIDENT', 'WARN', `${car.id} spins at ${where} and continues`, [car.id]);
        this.addYellow(car, this.rngIncident.range(14, 24), false);
      } else {
        car.timeLoss += this.rngIncident.range(1.5, 4);
        this.event('INCIDENT', 'INFO', `${car.id} runs wide at ${where}`, [car.id]);
      }
      if (car.isPlayer) this.say({ carId: car.id, from: 'DRIVER', category: 'INCIDENT', severity: 'WARN', phrase: 'spin' });
      return;
    }
    threshold += pQuiet;
    if (roll < threshold) {
      const failure = this.rngIncident.pick(FAILURES);
      if (car.isPlayer) {
        this.say({ carId: car.id, from: 'ENGINEER', category: 'INCIDENT', severity: 'CRITICAL', phrase: 'retire', vars: { failure } });
      }
      this.retire(car, `Mechanical (${failure})`, false);
      this.addYellow(car, this.rngIncident.range(25, 45), true);
      return;
    }
    threshold += pPuncture;
    if (roll < threshold) {
      car.puncture = true;
      this.event('INCIDENT', 'WARN', `${car.id} has a puncture`, [car.id]);
      const wanted = this.emergencyCompound(car);
      const set = bestSet(car.sets, wanted) ?? firstUsable(car.sets, this.wx.trackWetness);
      car.box = { setId: set.id, reason: 'PUNCTURE' };
      if (car.isPlayer) {
        this.say({ carId: car.id, from: 'DRIVER', category: 'TYRES', severity: 'CRITICAL', phrase: 'puncture' });
        this.outbox.attention = true;
      }
    }
  }

  private scheduleEscalation(kind: 'VSC' | 'SC' | 'RED', reason: string, delay: number): void {
    const current = this.escalation;
    const rank = { VSC: 1, SC: 2, RED: 3 } as const;
    if (current && rank[current.kind] >= rank[kind]) return;
    this.escalation = { at: this.raceTime + delay, kind, reason };
  }

  /** Compound to bolt on in an emergency: right family for the conditions, hardest that reaches the flag. */
  private emergencyCompound(car: Car): TyreCompound {
    const wanted = bestTyreClass(this.wx.trackWetness);
    if (wanted === 'WET') return 'WET';
    if (wanted === 'INTER') return 'INTER';
    const lapsLeft = this.raceLaps - car.lapsCompleted;
    const candidates: TyreCompound[] = lapsLeft > 26 ? ['HARD', 'MEDIUM', 'SOFT'] : lapsLeft > 13 ? ['MEDIUM', 'HARD', 'SOFT'] : ['SOFT', 'MEDIUM', 'HARD'];
    return candidates.find((c) => bestSet(car.sets, c) !== null) ?? 'MEDIUM';
  }

  // ─────────────────────────────────────────────────────── strategy / AI ──

  private buildViews(): void {
    const stamp = Math.round(this.raceTime * 20);
    if (stamp === this.viewsStamp) return;
    this.viewsStamp = stamp;
    const order = this.order;
    const leader = order[0];
    const leaderProgress = leader ? this.progressOf(leader) : 0;
    this.views = [];
    this.viewById.clear();
    const running = order.filter((c) => c.status !== 'RETIRED' && c.status !== 'FINISHED');
    running.forEach((car, index) => {
      const progress = this.progressOf(car);
      const ahead = index > 0 ? running[index - 1]! : null;
      const behind = index < running.length - 1 ? running[index + 1]! : null;
      const view: StrategicCarView = {
        id: car.id,
        teamId: car.team.id,
        position: car.position,
        status: car.status,
        lapsCompleted: car.lapsCompleted,
        lapProgress: clamp(car.tau / this.T, 0, 0.999),
        gapToLeader: Math.max(0, leaderProgress - progress) * car.paceEma,
        gapAhead: ahead ? Math.max(0, this.progressOf(ahead) - progress) * car.paceEma : null,
        gapBehind: behind ? Math.max(0, progress - this.progressOf(behind)) * behind.paceEma : null,
        carAheadId: ahead ? ahead.id : null,
        carBehindId: behind ? behind.id : null,
        compound: car.set.compound,
        tyreAgeLaps: car.set.laps,
        tyreWear: car.set.wear,
        fuelKg: car.fuel,
        pitStops: car.pitStops,
        lastPitLap: car.lastPitLap,
        compoundsUsed: car.compoundsUsed.slice(),
        lastLapTime: car.lastLap,
        paceOffset: car.paceOffset,
        wearFactor: car.driver.tyreWearFactor,
        inPitLane: car.status === 'PIT_LANE' || car.status === 'PIT_BOX',
      };
      this.views.push(view);
      this.viewById.set(car.id, view);
    });
  }

  private teammateOf(car: Car): Car | null {
    return this.cars.find((c) => c !== car && c.team.id === car.team.id) ?? null;
  }

  private fuelMarginLaps(car: Car): number {
    const lapsLeft = this.raceLaps - car.lapsCompleted - clamp(car.tau / this.T, 0, 1);
    return car.fuel / fuelBurnPerLap(this.track, 'BALANCED') - lapsLeft;
  }

  /** True once lift-and-coast for the rest of the race is only just enough to reach the flag. */
  private mustSaveFuelNow(car: Car): boolean {
    const shortfall = -this.fuelMarginLaps(car);
    if (shortfall <= 0) return false;
    const lapsLeft = this.raceLaps - car.lapsCompleted - clamp(car.tau / this.T, 0, 1);
    // Each remaining lap of lift-and-coast claws back a fixed share of a lap's fuel. Strategy calls are
    // made once a lap, so saving has to begin while one more lap of pushing could still be made up.
    return shortfall + 0.04 >= 0.9 * LIFT_AND_COAST_SAVING * Math.max(0, lapsLeft - 1);
  }

  /** Pace mode the fuel on board can afford: no pushing on fumes, lift-and-coast once it cannot wait. */
  private fuelSafePace(car: Car, requested: PaceMode): PaceMode {
    if (this.mustSaveFuelNow(car)) return 'CONSERVE';
    if (requested === 'PUSH') {
      const lapsLeft = this.raceLaps - car.lapsCompleted - clamp(car.tau / this.T, 0, 1);
      const pushCost = (PACE_MODES.PUSH.fuel - 1) * Math.min(lapsLeft, 2);
      if (this.fuelMarginLaps(car) < pushCost + 0.03) return 'BALANCED';
    }
    return requested;
  }

  private etaToPitEntry(car: Car): number {
    const distance = mod(this.pitEntryTau - mod(car.tau, this.T), this.T);
    return distance * car.paceEma;
  }

  private mustUseTwoCompounds(car: Car): boolean {
    return !car.compoundsUsed.some((c) => !isSlick(c));
  }

  private buildContext(car: Car, plan: PlannedStop[]): StrategyContext | null {
    this.buildViews();
    const view = this.viewById.get(car.id);
    if (!view) return null;
    const mate = this.teammateOf(car);
    const mateView = mate ? (this.viewById.get(mate.id) ?? null) : null;
    let teammateBoxingAhead = false;
    let doubleStackWait = 0;
    if (mate && (mate.box || mate.pit) && mate.status !== 'RETIRED') {
      const ownEta = this.etaToPitEntry(car);
      const mateEta = mate.pit ? -(this.raceTime - mate.pit.entryTime) : this.etaToPitEntry(mate);
      if (mateEta < ownEta) {
        teammateBoxingAhead = true;
        doubleStackWait = doubleStackRisk(ownEta - mateEta, car.team.pitCrewTime).expectedWait;
      }
    }
    return {
      track: this.track,
      raceLaps: this.raceLaps,
      lap: Math.min(this.raceLaps, car.lapsCompleted + 1),
      car: view,
      teammate: mateView,
      field: this.views,
      availableSets: car.sets.filter((s) => !s.fitted).map((s) => ({ ...s })),
      plan: plan.map((s) => ({ ...s })),
      ersCharge: car.ersCharge,
      fuelMarginLaps: this.fuelMarginLaps(car),
      flag: this.flag,
      pitLossNow: pitLossUnderFlag(this.track, this.flag),
      teammateBoxingAhead,
      doubleStackWait,
      weather: this.wx,
      forecast: this.forecastNow(),
      mustUseTwoCompounds: this.mustUseTwoCompounds(car),
      profile: car.team.profile,
      rng: this.rngAi,
    };
  }

  private decideAi(car: Car): void {
    const lap = car.lapsCompleted + 1;
    if (car.decidedLap === lap || car.status !== 'RACING' || this.chequered) return;
    car.decidedLap = lap;
    if (car.puncture) return;
    const ctx = this.buildContext(car, car.plan);
    if (!ctx) return;
    const decision = this.deps.decideStrategy(ctx);
    car.plan = decision.plan.map((s) => ({ ...s }));
    car.paceMode = decision.paceMode;
    car.ersMode = decision.ersMode;
    if (decision.box) {
      const set = car.sets.find((s) => s.id === decision.box!.setId && !s.fitted);
      car.box = set ? { setId: set.id, reason: decision.box.reason } : null;
    } else {
      car.box = null;
    }
    // Never run dry: protect the finish if the strategist asked for more than the tank allows.
    car.paceMode = this.fuelSafePace(car, car.paceMode);
  }

  /** Remaining stops of the user's active plan, given the stops already made. */
  private remainingStops(car: Car): PlannedStop[] {
    const strategy = car.strategy;
    if (!strategy) return car.plan;
    const stints = strategy.plans[strategy.activePlan].stints;
    const lap = Math.min(this.raceLaps, car.lapsCompleted + 1);
    const stops: PlannedStop[] = [];
    for (let i = car.pitStops; i < stints.length - 1; i++) {
      const stint = stints[i]!;
      const next = stints[i + 1]!;
      stops.push({ lap: Math.max(lap, Math.min(this.raceLaps - 1, stint.endLap)), compound: next.compound });
    }
    return stops;
  }

  /** Shortly before pit entry: execute the planned stop if auto-box is on. */
  private playerPitEntryCheck(car: Car): void {
    const strategy = car.strategy;
    if (!strategy || car.status !== 'RACING' || this.chequered) return;
    const lap = car.lapsCompleted + 1;
    if (car.decidedLap === lap) return;
    car.decidedLap = lap;
    if (car.box || !strategy.autoBox || lap >= this.raceLaps) return;

    // The engineer does not wait for ever: wrong tyre family for a whole lap, or tyres far beyond the cliff.
    const wantedClass = this.lastWetnessClass;
    const mismatch = COMPOUNDS[car.set.compound].tyreClass !== wantedClass;
    if (!mismatch) car.wrongTyreLaps = 0;
    else car.wrongTyreLaps += 1;
    const lapsLeft = this.raceLaps - lap;
    if ((mismatch && car.wrongTyreLaps >= 2 && lapsLeft >= 2) || (car.set.wear >= 1.12 && lapsLeft >= 3)) {
      const compound: TyreCompound = mismatch && wantedClass !== 'SLICK' ? (wantedClass === 'WET' ? 'WET' : 'INTER') : this.nextCompoundFor(car);
      const emergency = bestSet(car.sets, compound) ?? bestSet(car.sets, this.emergencyCompound(car));
      if (emergency) {
        car.box = { setId: emergency.id, reason: mismatch ? 'WEATHER' : 'TYRE_WEAR' };
        car.wrongTyreLaps = 0;
        this.say({
          carId: car.id, from: 'ENGINEER', category: mismatch ? 'WEATHER' : 'TYRES', severity: 'WARN', phrase: 'boxEmergency',
          vars: { compound: COMPOUNDS[emergency.compound].label.toLowerCase(), why: mismatch ? 'we are on the wrong tyre for this track' : 'this set is finished' },
          quickReplies: [{ id: 'cancel', label: 'CANCEL STOP', tone: 'DENY' }], ttl: this.etaToPitEntry(car),
        }, new Map([['cancel', () => this.cancelBox(car, true)]]));
        return;
      }
    }

    const next = this.remainingStops(car)[0];
    if (!next || next.lap > lap) return;
    // Under green, do not queue behind the team-mate for a routine stop: come in one lap later.
    const mate = this.teammateOf(car);
    if (mate && mate.box && !mate.pit && this.flag !== 'SC' && this.flag !== 'VSC' && lap < this.raceLaps - 1 && car.set.wear < 1.05) {
      const gap = this.etaToPitEntry(car) - this.etaToPitEntry(mate);
      if (gap > 0 && doubleStackRisk(gap, car.team.pitCrewTime).expectedWait > 1) {
        if (this.radio.ready(`stack-${car.id}`, this.raceTime, 2 * car.lapTimeNow)) {
          this.say({ carId: car.id, from: 'ENGINEER', category: 'PIT', severity: 'INFO', phrase: 'stackAvoided', vars: { mate: mate.id } });
        }
        return;
      }
    }
    let compound = next.compound;
    if (COMPOUNDS[compound].tyreClass !== wantedClass) {
      compound = wantedClass === 'WET' ? 'WET' : wantedClass === 'INTER' ? 'INTER' : this.emergencyCompound(car);
    } else if (isSlick(compound) && this.rainImminent(2.5) && car.set.wear < 1.05) {
      if (this.radio.ready(`hold-rain-${car.id}`, this.raceTime, 3 * car.lapTimeNow)) {
        this.say({ carId: car.id, from: 'ENGINEER', category: 'WEATHER', severity: 'INFO', phrase: 'holdForRain' });
      }
      return;
    }
    const set = bestSet(car.sets, compound);
    if (!set) {
      if (this.radio.ready(`noset-${car.id}`, this.raceTime, 200)) {
        this.say({ carId: car.id, from: 'ENGINEER', category: 'STRATEGY', severity: 'WARN', phrase: 'noSet', vars: { compound: COMPOUNDS[compound].label.toLowerCase() } });
        this.outbox.attention = true;
      }
      return;
    }
    car.box = { setId: set.id, reason: 'PLANNED' };
    this.say({
      carId: car.id,
      from: 'ENGINEER',
      category: 'PIT',
      severity: 'INFO',
      phrase: 'boxPlanned',
      vars: { plan: strategy.activePlan, compound: COMPOUNDS[set.compound].label.toLowerCase() },
      quickReplies: [{ id: 'cancel', label: 'CANCEL STOP', tone: 'DENY' }],
      ttl: this.etaToPitEntry(car),
    }, new Map([['cancel', () => this.cancelBox(car, true)]]));
  }

  /** Quick replies that box the car on the compound the situation calls for. */
  private boxReplies(car: Car, reason: PitReason, offerDoubleStack: boolean, compound?: TyreCompound): { replies: RadioMessage['quickReplies']; handlers: Map<string, ReplyHandler> } {
    const wanted = compound ?? this.remainingStops(car)[0]?.compound ?? this.emergencyCompound(car);
    const set = bestSet(car.sets, wanted) ?? bestSet(car.sets, this.emergencyCompound(car));
    const replies: RadioMessage['quickReplies'] = [];
    const handlers = new Map<string, ReplyHandler>();
    if (set) {
      replies.push({ id: 'box', label: `BOX THIS LAP · ${COMPOUNDS[set.compound].letter}`, tone: 'CONFIRM' });
      handlers.set('box', () => this.callBox(car, set.id, reason));
      const mate = this.teammateOf(car);
      if (offerDoubleStack && mate && mate.status === 'RACING') {
        const mateWanted = this.remainingStops(mate)[0]?.compound ?? this.emergencyCompound(mate);
        const mateSet = bestSet(mate.sets, mateWanted) ?? bestSet(mate.sets, this.emergencyCompound(mate));
        if (mateSet) {
          replies.push({ id: 'stack', label: 'DOUBLE STACK', tone: 'NEUTRAL' });
          handlers.set('stack', () => {
            this.callBox(car, set.id, reason);
            this.callBox(mate, mateSet.id, reason);
          });
        }
      }
    }
    replies.push({ id: 'stay', label: 'STAY OUT', tone: 'DENY' });
    handlers.set('stay', () => undefined);
    return { replies, handlers };
  }

  /** The race engineer's strategic advice for a user car: the same brain as the rival pit walls. */
  private advise(car: Car, force: boolean): void {
    if (car.status !== 'RACING' || this.chequered || car.box || car.puncture) return;
    const lap = car.lapsCompleted + 1;
    if (!force && car.advisedLap === lap) return;
    car.advisedLap = lap;
    if (lap >= this.raceLaps) return;
    const ctx = this.buildContext(car, this.remainingStops(car));
    if (!ctx) return;
    const decision = this.deps.decideStrategy(ctx);
    if (!decision.box || decision.box.reason === 'PLANNED') return;
    const reason = decision.box.reason;
    const cooldown = reason === 'SAFETY_CAR' ? 240 : 2.2 * car.lapTimeNow;
    // Weather calls share one channel with the crossover watch, so the same call is never made twice.
    const key = reason === 'WEATHER' ? `weather-call-${car.id}` : `advice-${car.id}-${reason}`;
    if (!this.radio.ready(key, this.raceTime, cooldown)) return;
    const set = car.sets.find((s) => s.id === decision.box!.setId);
    const { replies, handlers } = this.boxReplies(car, reason, this.flag === 'SC' || this.flag === 'VSC', set?.compound);
    const urgent = reason === 'TYRE_WEAR' || reason === 'WEATHER' || reason === 'SAFETY_CAR';
    this.say({
      carId: car.id,
      from: 'STRATEGY',
      category: reason === 'WEATHER' ? 'WEATHER' : reason === 'UNDERCUT' || reason === 'COVER' ? 'UNDERCUT' : 'STRATEGY',
      severity: urgent ? 'WARN' : 'INFO',
      phrase: 'strategyCall',
      vars: { rationale: decision.rationale },
      quickReplies: replies,
      ttl: 1.6 * car.lapTimeNow,
    }, handlers);
    if (urgent) this.outbox.attention = true;
  }

  private callBox(car: Car, setId: string, reason: PitReason): boolean {
    if (car.status === 'RETIRED' || car.status === 'FINISHED') return false;
    const set = car.sets.find((s) => s.id === setId && !s.fitted);
    if (!set) return false;
    if (this.phase === 'SUSPENDED' || (this.phase === 'GRID' && this.started)) {
      // Red flag: free tyre change in the pit lane.
      if (car.status !== 'PIT_BOX' && car.status !== 'GRID') return false;
      const from = car.set.compound;
      this.fitSet(car, set, COMPOUNDS[set.compound].blanketReadiness + 0.2);
      car.pitStops += 1;
      car.lastPitLap = car.lapsCompleted + 1;
      this.outbox.pitStops.push({
        carId: car.id, lap: car.lapsCompleted + 1, raceTime: this.raceTime, fromCompound: from, toCompound: set.compound, toSetId: set.id,
        reason: 'MANUAL', stationaryTime: 0, queueTime: 0, timeLost: 0, flag: 'RED', positionBefore: car.position, positionAfter: car.position,
      });
      return true;
    }
    if (this.phase === 'GRID') {
      // Before the start: simply choose the starting set.
      this.fitSet(car, set, 0.85);
      car.compoundsUsed = [set.compound];
      car.lapCompound = set.compound;
      return true;
    }
    if (car.status !== 'RACING' || this.chequered) return false;
    if (car.box?.reason === 'PUNCTURE') reason = 'PUNCTURE';
    car.box = { setId: set.id, reason };
    const pastEntry = mod(car.tau, this.T) > this.pitEntryTau;
    this.say({ carId: car.id, from: 'DRIVER', category: 'PIT', severity: 'INFO', phrase: pastEntry ? 'boxNextLap' : 'boxAck' });
    return true;
  }

  private cancelBox(car: Car, announce: boolean): void {
    if (!car.box || car.pit || car.box.reason === 'PUNCTURE') return;
    car.box = null;
    if (announce) this.say({ carId: car.id, from: 'ENGINEER', category: 'PIT', severity: 'INFO', phrase: 'boxCancelled' });
  }

  // ──────────────────────────────────────────────────────────────── commands ──

  command(cmd: WorkerCommand): void {
    switch (cmd.type) {
      case 'START':
        this.start();
        break;
      case 'SET_PACE_MODE': {
        const car = this.playerCar(cmd.carId);
        if (car) car.paceMode = cmd.mode;
        break;
      }
      case 'SET_ERS_MODE': {
        const car = this.playerCar(cmd.carId);
        if (car) car.ersMode = cmd.mode;
        break;
      }
      case 'SET_DEFEND': {
        const car = this.playerCar(cmd.carId);
        if (car && car.defend !== cmd.defend) {
          car.defend = cmd.defend;
          if (cmd.defend && car.status === 'RACING') {
            this.say({ carId: car.id, from: 'DRIVER', category: 'TEAM_ORDER', severity: 'INFO', phrase: 'defendAck' });
          }
        }
        break;
      }
      case 'SET_TEAM_ORDER':
        if (this.teamOrder !== cmd.order) {
          this.teamOrder = cmd.order;
          this.event('TEAM_ORDER', 'INFO', cmd.order === 'HOLD' ? 'Team order: hold position' : 'Team order: free to race', this.players.map((p) => p.id));
          this.say({ carId: null, from: 'ENGINEER', category: 'TEAM_ORDER', severity: 'INFO', phrase: cmd.order === 'HOLD' ? 'holdAck' : 'freeAck' });
        }
        break;
      case 'SWAP_POSITIONS':
        this.requestSwap();
        break;
      case 'BOX': {
        const car = this.playerCar(cmd.carId);
        if (car) this.callBox(car, cmd.setId, 'MANUAL');
        break;
      }
      case 'CANCEL_BOX': {
        const car = this.playerCar(cmd.carId);
        if (car) this.cancelBox(car, true);
        break;
      }
      case 'DOUBLE_STACK':
        this.callBox(this.players[0], cmd.setIds[0], 'MANUAL');
        this.callBox(this.players[1], cmd.setIds[1], 'MANUAL');
        break;
      case 'SET_STRATEGY': {
        const car = this.playerCar(cmd.carId);
        if (car) {
          car.strategy = this.sanitiseStrategy(cmd.strategy);
          if (!this.started) this.fitStartingSet(car);
          if (this.phase === 'RACING') this.outbox.projectionDue.push(car.id);
        }
        break;
      }
      case 'SET_ACTIVE_PLAN': {
        const car = this.playerCar(cmd.carId);
        if (car?.strategy && car.strategy.activePlan !== cmd.planId) {
          car.strategy = { ...car.strategy, activePlan: cmd.planId };
          if (!this.started) this.fitStartingSet(car);
          else {
            const plan = car.strategy.plans[cmd.planId];
            this.say({ carId: car.id, from: 'ENGINEER', category: 'STRATEGY', severity: 'INFO', phrase: 'planSwitch', vars: { plan: cmd.planId, summary: plan.label } });
            this.outbox.projectionDue.push(car.id);
          }
        }
        break;
      }
      case 'SET_AUTO_BOX': {
        const car = this.playerCar(cmd.carId);
        if (car?.strategy) car.strategy = { ...car.strategy, autoBox: cmd.enabled };
        break;
      }
      case 'RADIO_REPLY':
        this.replyRadio(cmd.messageId, cmd.replyId);
        break;
      case 'RACE_CONTROL':
        this.raceControlAction(cmd.action);
        break;
      default:
        break;
    }
  }

  private playerCar(carId: CarId): Car | null {
    const car = this.byId.get(carId);
    return car && car.isPlayer ? car : null;
  }

  private requestSwap(): void {
    const [a, b] = this.players;
    if (this.phase !== 'RACING' || a.status !== 'RACING' || b.status !== 'RACING') return;
    const ahead = this.progressOf(a) >= this.progressOf(b) ? a : b;
    const behind = ahead === a ? b : a;
    const gap = (this.progressOf(ahead) - this.progressOf(behind)) * behind.paceEma;
    if (gap > 6 || this.flag === 'SC' || this.flag === 'VSC') {
      this.say({ carId: null, from: 'ENGINEER', category: 'TEAM_ORDER', severity: 'WARN', phrase: 'swapNo', vars: { gap: gap.toFixed(1) } });
      return;
    }
    this.swap = { yielder: ahead, beneficiary: behind, until: this.raceTime + 150 };
    this.say({ carId: ahead.id, from: 'DRIVER', category: 'TEAM_ORDER', severity: 'INFO', phrase: 'swapYield' });
  }

  private raceControlAction(action: RaceControlAction): void {
    switch (action) {
      case 'SAFETY_CAR':
        this.deploySafetyCar('debris on track');
        break;
      case 'VIRTUAL_SAFETY_CAR':
        this.deployVsc('debris on track');
        break;
      case 'RED_FLAG':
        this.redFlag('track blocked');
        break;
      case 'RAIN_SHOWER':
        this.weather.injectShower(this.raceTime, 0.65);
        this.forecastStamp = -1;
        this.event('WEATHER', 'WARN', 'Rain cell approaching the circuit', []);
        break;
      case 'DRY_UP':
        this.weather.dryUp(this.raceTime);
        this.forecastStamp = -1;
        this.event('WEATHER', 'INFO', 'Rain easing off', []);
        break;
    }
  }

  /** Makes any plan received from the UI runnable: ordered stops, final stint to the flag, sane lengths. */
  private sanitiseStrategy(strategy: CarStrategy): CarStrategy {
    const plans = {} as Record<PlanId, StrategyPlan>;
    for (const id of PLAN_IDS) {
      const source = strategy.plans[id];
      const stints = (source?.stints ?? []).slice(0, 5).map((s) => ({ compound: s.compound, endLap: Math.round(s.endLap) }));
      if (stints.length === 0) stints.push({ compound: 'MEDIUM', endLap: this.raceLaps });
      let previous = 0;
      stints.forEach((stint, index) => {
        const remainingStints = stints.length - 1 - index;
        stint.endLap = clamp(stint.endLap, previous + 1, this.raceLaps - remainingStints);
        previous = stint.endLap;
      });
      stints[stints.length - 1]!.endLap = this.raceLaps;
      plans[id] = { id, label: source?.label ?? describeStints(stints), stints };
    }
    const activePlan = PLAN_IDS.includes(strategy.activePlan) ? strategy.activePlan : 'A';
    return { activePlan, plans, autoBox: strategy.autoBox };
  }

  private replyRadio(messageId: number, replyId: string): void {
    const message = this.radioLog.get(messageId);
    const handlers = this.replyHandlers.get(messageId);
    if (!message || message.repliedWith !== null) return;
    if (message.expiresAt !== null && this.raceTime > message.expiresAt + 0.5) return;
    if (!message.quickReplies.some((r) => r.id === replyId)) return;
    const updated: RadioMessage = { ...message, repliedWith: replyId };
    this.radioLog.set(messageId, updated);
    this.outbox.radio.push(updated);
    this.replyHandlers.delete(messageId);
    handlers?.get(replyId)?.();
  }

  // ───────────────────────────────────────────────────────── slow tick / radio ──

  private slowTick(): void {
    for (const car of this.cars) {
      this.hazardTick(car, 0.5);
      // The rival drivers manage their own fuel between two calls from their pit wall.
      if (!car.isPlayer && car.status === 'RACING') car.paceMode = this.fuelSafePace(car, car.paceMode);
    }
    if (this.swap && this.raceTime > this.swap.until) this.swap = null;
    for (const player of this.players) this.playerWatch(player);
    this.weatherWatch();
  }

  private say(draft: RadioDraft, handlers?: Map<string, ReplyHandler>): void {
    const car = draft.carId ? this.byId.get(draft.carId) : null;
    const lap = car ? Math.min(this.raceLaps, car.lapsCompleted + 1) : Math.min(this.raceLaps, (this.order[0]?.lapsCompleted ?? 0) + 1);
    const message = this.radio.compose(draft, this.raceTime, lap);
    this.radioLog.set(message.id, message);
    if (handlers && message.quickReplies.length > 0) this.replyHandlers.set(message.id, handlers);
    this.outbox.radio.push(message);
  }

  private event(type: RaceEventType, severity: Severity, message: string, carIds: CarId[]): void {
    const leader = this.order[0];
    if (type !== 'OVERTAKE' && type !== 'PIT' && type !== 'FASTEST_LAP' && type !== 'TEAM_ORDER') this.headline = message;
    this.outbox.events.push({
      id: this.eventId++,
      raceTime: this.raceTime,
      lap: Math.min(this.raceLaps, (leader?.lapsCompleted ?? 0) + 1),
      type,
      severity,
      message,
      carIds,
    });
  }

  /** Conditions on a user car that are worth a radio call. */
  private playerWatch(car: Car): void {
    if (car.status !== 'RACING' || this.chequered) return;
    const now = this.raceTime;
    const id = car.id;
    const lapSeconds = car.lapTimeNow;
    const wear = car.set.wear;

    // Tyres.
    const rate = this.currentWearRate(car);
    if (wear >= 1.08 && this.radio.ready(`tyre-crit-${id}-${car.set.id}`, now, 3 * lapSeconds)) {
      const { replies, handlers } = this.boxReplies(car, 'TYRE_WEAR', false);
      this.say({ carId: id, from: 'DRIVER', category: 'TYRES', severity: 'CRITICAL', phrase: 'tyresCritical', quickReplies: replies, ttl: 2 * lapSeconds }, handlers);
      this.outbox.attention = true;
    } else if (wear >= 0.93 && this.radio.ready(`tyre-gone-${id}-${car.set.id}`, now, 1e9)) {
      const { replies, handlers } = this.boxReplies(car, 'TYRE_WEAR', false);
      replies.splice(replies.length - 1, 0, { id: 'manage', label: 'MANAGE PACE', tone: 'NEUTRAL' });
      handlers.set('manage', () => {
        car.paceMode = 'CONSERVE';
      });
      this.say({ carId: id, from: 'DRIVER', category: 'TYRES', severity: 'WARN', phrase: 'tyresGone', quickReplies: replies, ttl: 2 * lapSeconds }, handlers);
      this.outbox.attention = true;
    } else if (wear >= 0.72 && wear < 0.93 && this.radio.ready(`tyre-fade-${id}-${car.set.id}`, now, 1e9)) {
      this.say({ carId: id, from: 'ENGINEER', category: 'TYRES', severity: 'INFO', phrase: 'tyresFading', vars: { laps: Math.max(1, Math.round(lapsToCliff(wear, rate))) } });
    }

    // Wrong tyres for the conditions: the driver takes matters into his own hands.
    const wetness = this.wx.trackWetness;
    if (isSlick(car.set.compound) && wetness > WEATHER_CROSSOVER.slickToInter + 0.18 && !car.box) {
      if (this.radio.ready(`undriveable-${id}`, now, 1.5 * lapSeconds)) {
        const set = bestSet(car.sets, wetness > WEATHER_CROSSOVER.interToWet ? 'WET' : 'INTER') ?? bestSet(car.sets, 'INTER') ?? bestSet(car.sets, 'WET');
        if (set) {
          car.box = { setId: set.id, reason: 'WEATHER' };
          this.say({ carId: id, from: 'DRIVER', category: 'WEATHER', severity: 'CRITICAL', phrase: 'undriveable' });
          this.outbox.attention = true;
        }
      }
    }

    // Temperatures.
    if (car.engineTemp >= TEMP_LIMITS.engineCritical && this.radio.ready(`eng-crit-${id}`, now, 90)) {
      this.say({
        carId: id, from: 'ENGINEER', category: 'TEMPS', severity: 'CRITICAL', phrase: 'engineCritical', vars: { temp: Math.round(car.engineTemp) },
        quickReplies: [{ id: 'lift', label: 'LIFT & COAST', tone: 'CONFIRM' }, { id: 'ignore', label: 'KEEP PUSHING', tone: 'DENY' }], ttl: 60,
      }, new Map<string, ReplyHandler>([['lift', () => { car.paceMode = 'CONSERVE'; }], ['ignore', () => undefined]]));
      this.outbox.attention = true;
    } else if (car.engineTemp >= TEMP_LIMITS.engineWarn && this.radio.ready(`eng-warn-${id}`, now, 240)) {
      this.say({
        carId: id, from: 'ENGINEER', category: 'TEMPS', severity: 'WARN', phrase: 'engineHot', vars: { temp: Math.round(car.engineTemp) },
        quickReplies: [{ id: 'lift', label: 'LIFT & COAST', tone: 'CONFIRM' }, { id: 'balanced', label: 'BALANCED', tone: 'NEUTRAL' }, { id: 'ignore', label: 'IGNORE', tone: 'DENY' }], ttl: 90,
      }, new Map<string, ReplyHandler>([['lift', () => { car.paceMode = 'CONSERVE'; }], ['balanced', () => { car.paceMode = 'BALANCED'; }], ['ignore', () => undefined]]));
    }
    if (car.brakeTemp >= TEMP_LIMITS.brakeCritical && this.radio.ready(`brk-crit-${id}`, now, 90)) {
      this.say({ carId: id, from: 'ENGINEER', category: 'TEMPS', severity: 'CRITICAL', phrase: 'brakesCritical', vars: { temp: Math.round(car.brakeTemp) } });
    } else if (car.brakeTemp >= TEMP_LIMITS.brakeWarn && this.radio.ready(`brk-warn-${id}`, now, 300)) {
      this.say({ carId: id, from: 'ENGINEER', category: 'TEMPS', severity: 'WARN', phrase: 'brakesHot', vars: { temp: Math.round(car.brakeTemp) } });
    }

    // Fuel.
    const margin = this.fuelMarginLaps(car);
    const lapsLeft = this.raceLaps - car.lapsCompleted;
    if (this.mustSaveFuelNow(car) && car.paceMode !== 'CONSERVE') {
      // The driver will not park the car: once saving cannot wait any longer he lifts and coasts on his own.
      car.paceMode = 'CONSERVE';
      if (this.radio.ready(`fuel-forced-${id}`, now, 6 * lapSeconds)) {
        this.say({ carId: id, from: 'DRIVER', category: 'FUEL', severity: 'CRITICAL', phrase: 'fuelForced' });
      }
    } else if (margin < -0.2 && lapsLeft <= 9 && car.paceMode !== 'CONSERVE' && this.radio.ready(`fuel-crit-${id}`, now, 4 * lapSeconds)) {
      this.say({
        carId: id, from: 'ENGINEER', category: 'FUEL', severity: 'CRITICAL', phrase: 'fuelCritical',
        quickReplies: [{ id: 'lift', label: 'LIFT & COAST', tone: 'CONFIRM' }, { id: 'ignore', label: 'IGNORE', tone: 'DENY' }], ttl: 3 * lapSeconds,
      }, new Map<string, ReplyHandler>([['lift', () => { car.paceMode = 'CONSERVE'; }], ['ignore', () => undefined]]));
      this.outbox.attention = true;
    } else if (margin < -0.35 && car.lapsCompleted >= 4 && lapsLeft > 9 && this.radio.ready(`fuel-short-${id}`, now, 14 * lapSeconds)) {
      this.say({ carId: id, from: 'ENGINEER', category: 'FUEL', severity: 'INFO', phrase: 'fuelShort', vars: { laps: (-margin).toFixed(1) } });
    }

    // Hybrid.
    if (car.ersMode === 'OVERTAKE' && car.ersCharge < 0.03 && this.radio.ready(`ers-empty-${id}`, now, 9 * lapSeconds)) {
      this.say({
        carId: id, from: 'ENGINEER', category: 'ERS', severity: 'WARN', phrase: 'batteryEmpty',
        quickReplies: [{ id: 'harvest', label: 'HARVEST', tone: 'CONFIRM' }, { id: 'balanced', label: 'BALANCED', tone: 'NEUTRAL' }], ttl: 2 * lapSeconds,
      }, new Map<string, ReplyHandler>([['harvest', () => { car.ersMode = 'HARVEST'; }], ['balanced', () => { car.ersMode = 'BALANCED'; }]]));
    } else if (car.ersMode === 'HARVEST' && car.ersCharge > 0.97 && this.radio.ready(`ers-full-${id}`, now, 9 * lapSeconds)) {
      this.say({
        carId: id, from: 'ENGINEER', category: 'ERS', severity: 'INFO', phrase: 'batteryFull',
        quickReplies: [{ id: 'balanced', label: 'BALANCED', tone: 'CONFIRM' }, { id: 'overtake', label: 'OVERTAKE', tone: 'NEUTRAL' }], ttl: 2 * lapSeconds,
      }, new Map<string, ReplyHandler>([['balanced', () => { car.ersMode = 'BALANCED'; }], ['overtake', () => { car.ersMode = 'OVERTAKE'; }]]));
    }

    // DRS train.
    if (car.ahead && car.ahead.ahead && car.gapTau < 0.9 && car.ahead.gapTau < 0.9 && car.drsOpen && car.ahead.drsOpen) {
      if (this.radio.ready(`train-${id}`, now, 12 * lapSeconds)) {
        this.say({ carId: id, from: 'ENGINEER', category: 'TRAFFIC', severity: 'INFO', phrase: 'drsTrain' });
      }
    }
  }

  /** Weather calls shared by both cars: incoming rain and tyre crossovers. */
  private weatherWatch(): void {
    if (this.chequered) return;
    const now = this.raceTime;
    const wetness = this.wx.trackWetness;
    const leader = this.order[0];
    const lapSeconds = leader ? clamp(leader.lapTimeNow, this.T, this.T * 1.7) : this.T;
    const forecast = this.forecastNow();

    // Rain on the radar while the track is still dry.
    if (wetness < 0.05 && this.wx.rainIntensity < 0.03) {
      const arrival = forecast.find((p) => p.rainIntensity > 0.12 && p.raceTime > now);
      if (arrival && arrival.raceTime - now < 8 * lapSeconds && this.radio.ready('rain-soon', now, 10 * lapSeconds)) {
        const peak = Math.max(...forecast.filter((p) => p.raceTime < arrival.raceTime + 600).map((p) => p.rainIntensity));
        const intensity = peak > 0.6 ? 'heavy' : peak > 0.3 ? 'moderate' : 'light';
        this.say({
          carId: null, from: 'STRATEGY', category: 'WEATHER', severity: 'WARN', phrase: 'rainSoon',
          vars: { intensity, laps: Math.max(1, Math.round((arrival.raceTime - now) / lapSeconds)) },
        });
        this.event('WEATHER', 'WARN', `Rain expected in ${Math.max(1, Math.round((arrival.raceTime - now) / 60))} min`, []);
      }
    } else if (this.wx.rainIntensity > 0.08 && wetness < 0.12 && this.radio.ready('rain-now', now, 15 * lapSeconds)) {
      const player = this.players.find((p) => p.status === 'RACING');
      if (player) this.say({ carId: player.id, from: 'DRIVER', category: 'WEATHER', severity: 'WARN', phrase: 'rainNow' });
      this.event('WEATHER', 'WARN', 'Rain starts to fall', []);
    }

    // Crossover between tyre families (with hysteresis, so a track sitting on the threshold does not flicker).
    const wanted = this.tyreClassNow();
    if (wanted !== this.lastWetnessClass) {
      const previous = this.lastWetnessClass;
      this.lastWetnessClass = wanted;
      const label = wanted === 'SLICK' ? 'slicks' : wanted === 'INTER' ? 'intermediates' : 'full wets';
      this.event('WEATHER', 'WARN', `Track at ${(wetness * 100).toFixed(0)}% wetness — crossover to ${label}`, []);
      for (const car of this.players) {
        if (car.status !== 'RACING' || COMPOUNDS[car.set.compound].tyreClass === wanted) continue;
        if (car.box || !this.radio.ready(`weather-call-${car.id}`, now, 2.2 * lapSeconds)) continue;
        const compound: TyreCompound = wanted === 'WET' ? 'WET' : wanted === 'INTER' ? 'INTER' : this.emergencyCompound(car);
        const { replies, handlers } = this.boxReplies(car, 'WEATHER', true, compound);
        const drying = wanted === 'SLICK' || (wanted === 'INTER' && previous === 'WET');
        this.say({
          carId: car.id, from: 'STRATEGY', category: 'WEATHER', severity: 'WARN',
          phrase: wanted === 'SLICK' ? 'crossSlick' : wanted === 'INTER' ? (drying ? 'crossInterDrying' : 'crossInter') : 'crossWet',
          vars: { wet: (wetness * 100).toFixed(0), compound: COMPOUNDS[compound].label.toLowerCase() },
          quickReplies: replies, ttl: 2 * lapSeconds,
        }, handlers);
        this.outbox.attention = true;
      }
      this.outbox.projectionDue.push(...this.players.filter((p) => p.status === 'RACING').map((p) => p.id));
    }
  }

  /** The forecast takes the track past the slick → inter crossover within the next `laps` laps. */
  private rainImminent(laps: number): boolean {
    if (this.lastWetnessClass !== 'SLICK') return false;
    const leader = this.order[0];
    const lapSeconds = leader ? clamp(leader.lapTimeNow, this.T, this.T * 1.7) : this.T;
    const horizon = this.raceTime + laps * lapSeconds;
    for (const point of this.forecastNow()) {
      if (point.raceTime > horizon) break;
      if (point.trackWetness >= WEATHER_CROSSOVER.slickToInter - 0.02) return true;
    }
    return false;
  }

  /** Tyre family the conditions call for; the thresholds lean against a change of the current class. */
  private tyreClassNow(): TyreClass {
    const wetness = this.wx.trackWetness;
    const previous = this.lastWetnessClass;
    const margin = 0.025;
    const toInter = WEATHER_CROSSOVER.slickToInter + (previous === 'SLICK' ? margin : -margin);
    const toWet = WEATHER_CROSSOVER.interToWet + (previous === 'WET' ? -margin : margin);
    return wetness >= toWet ? 'WET' : wetness >= toInter ? 'INTER' : 'SLICK';
  }

  private currentWearRate(car: Car): number {
    return wearPerLap({
      track: this.track,
      compound: car.set.compound,
      fuelKg: car.fuel,
      paceMode: car.paceMode,
      wearFactor: car.driver.tyreWearFactor,
      dirtyAir: car.dirtyAir,
      trackWetness: this.wx.trackWetness,
      trackTempC: this.wx.trackTempC,
      flag: this.flag,
    });
  }

  // ─────────────────────────────────────────────────────── player analytics ──

  /** Lap time a car would do next lap on a brand new set of `compound`, out-lap warm-up included. */
  private outLapTime(car: Car, compound: TyreCompound): number {
    const wetness = this.wx.trackWetness;
    const tau = warmupTimeConstant(compound, this.wx.trackTempC, wetness);
    return (
      lapTime({ track: this.track, compound, wear: 0.02, fuelKg: car.fuel, trackWetness: wetness, paceOffset: car.paceOffset, gripLevel: this.wx.gripLevel, wetSkill: car.driver.wetSkill }) +
      meanWarmupPenaltyOverLap(compound, COMPOUNDS[compound].blanketReadiness, tau) * this.scale
    );
  }

  /** Second lap on that new set: nearly up to temperature. */
  private secondLapTime(car: Car, compound: TyreCompound): number {
    const wetness = this.wx.trackWetness;
    const tau = warmupTimeConstant(compound, this.wx.trackTempC, wetness);
    const readiness = readinessAfter(COMPOUNDS[compound].blanketReadiness, 1, tau, 1);
    return (
      lapTime({ track: this.track, compound, wear: 0.05, fuelKg: car.fuel, trackWetness: wetness, paceOffset: car.paceOffset, gripLevel: this.wx.gripLevel, wetSkill: car.driver.wetSkill }) +
      meanWarmupPenaltyOverLap(compound, readiness, tau) * this.scale
    );
  }

  /** Lap time of a car on its current tyres in clean air at balanced pace. */
  private cleanLapTime(car: Car): number {
    return lapTime({
      track: this.track,
      compound: car.set.compound,
      wear: car.set.wear,
      fuelKg: car.fuel,
      trackWetness: this.wx.trackWetness,
      paceOffset: car.paceOffset,
      gripLevel: this.wx.gripLevel,
      wetSkill: car.driver.wetSkill,
    });
  }

  /** Compound a stop made now would fit: the planned one if it suits the track, otherwise what the weather asks for. */
  private nextCompoundFor(car: Car): TyreCompound {
    const planned = this.remainingStops(car)[0]?.compound;
    if (planned && COMPOUNDS[planned].tyreClass === this.lastWetnessClass && bestSet(car.sets, planned)) return planned;
    return this.emergencyCompound(car);
  }

  private rejoinEstimate(car: Car): RejoinEstimate | null {
    if (car.status !== 'RACING' || this.phase !== 'RACING' || this.chequered) return null;
    const T = this.T;
    const loss = pitLossUnderFlag(this.track, this.flag);
    const rate = this.flag === 'SC' || this.flag === 'VSC' ? car.rate || 1 / NEUTRALISED_PACE.SC : T / car.freeLapTime;
    const ghostProgress = this.progressOf(car) - loss * rate;
    const ghostPos = mod(ghostProgress, T);
    let position = 1;
    let aheadCar: Car | null = null;
    let behindCar: Car | null = null;
    let aheadGap = Infinity;
    let behindGap = Infinity;
    for (const other of this.cars) {
      if (other === car || other.status === 'RETIRED') continue;
      if (this.progressOf(other) > ghostProgress) position += 1;
      if (other.status !== 'RACING') continue;
      const forward = mod(mod(other.tau, T) - ghostPos, T);
      const backward = T - forward;
      if (forward < aheadGap) {
        aheadGap = forward;
        aheadCar = other;
      }
      if (backward < behindGap) {
        behindGap = backward;
        behindCar = other;
      }
    }
    const pace = car.paceEma;
    const gapAhead = aheadCar && aheadGap < T / 2 ? aheadGap * pace : null;
    const gapBehind = behindCar && behindGap < T / 2 ? behindGap * pace : null;
    return {
      pitLoss: loss,
      ghostLapFraction: this.fractionOf(ghostProgress),
      position,
      positionsLost: position - car.position,
      carAhead: gapAhead !== null && aheadCar ? aheadCar.id : null,
      gapAhead,
      carBehind: gapBehind !== null && behindCar ? behindCar.id : null,
      gapBehind,
      clearAir: gapAhead === null || gapAhead > 1.5,
    };
  }

  private undercutAnalysis(car: Car, view: StrategicCarView | undefined): UndercutAnalysis | null {
    if (!view || view.carAheadId === null || view.gapAhead === null || car.status !== 'RACING') return null;
    const target = this.byId.get(view.carAheadId);
    if (!target || target.status !== 'RACING' || view.gapAhead > 6 || target.team.id === car.team.id) return null;
    if (this.raceLaps - car.lapsCompleted < 4) return null;
    // Swing if the target answers one lap later: our out-lap against its worn tyres, then our second lap
    // against its own out-lap on cold tyres. Every extra lap it stays out adds the old-versus-new delta.
    const compound = this.nextCompoundFor(car);
    const ownOut = this.outLapTime(car, compound);
    const ownSecond = this.secondLapTime(car, compound);
    const targetOld = this.cleanLapTime(target);
    const targetOut = this.outLapTime(target, compound);
    const gain = targetOld - ownOut + (targetOut - ownSecond);
    const perExtraLap = targetOld - ownSecond;
    const needed = view.gapAhead + 0.3;
    let lapsNeeded: number | null = null;
    if (gain >= needed) lapsNeeded = 1;
    else if (perExtraLap > 0.05) {
      const laps = 1 + Math.ceil((needed - gain) / perExtraLap);
      lapsNeeded = laps <= 6 ? laps : null;
    }
    const justStopped = target.lastPitLap !== null && target.lapsCompleted + 1 - target.lastPitLap < 6;
    return { targetId: target.id, gap: view.gapAhead, gainPerLap: gain, lapsNeeded, feasible: lapsNeeded !== null && lapsNeeded <= 2 && !justStopped };
  }

  private threatAnalysis(car: Car, view: StrategicCarView | undefined): ThreatAnalysis | null {
    if (!view || view.carBehindId === null || view.gapBehind === null || car.status !== 'RACING') return null;
    const rival = this.byId.get(view.carBehindId);
    if (!rival || rival.status !== 'RACING' || view.gapBehind > 8 || rival.team.id === car.team.id) return null;
    const compound: TyreCompound = isSlick(rival.set.compound) ? (rival.set.compound === 'HARD' ? 'MEDIUM' : 'HARD') : rival.set.compound;
    // Same swing as our own undercut, seen from the other side: the rival stops now, we answer a lap later.
    const gain = this.cleanLapTime(car) - this.outLapTime(rival, compound) + (this.outLapTime(car, compound) - this.secondLapTime(rival, compound));
    const fresh = rival.lastPitLap !== null && rival.lapsCompleted + 1 - rival.lastPitLap < 6;
    return { rivalId: rival.id, gap: view.gapBehind, undercutRisk: !fresh && gain > view.gapBehind + 0.2 && this.raceLaps - car.lapsCompleted > 4 };
  }

  private doubleStackEstimate(): DoubleStackEstimate | null {
    const [a, b] = this.players;
    if (this.phase !== 'RACING' || a.status !== 'RACING' || b.status !== 'RACING' || this.chequered) return null;
    const etaA = this.etaToPitEntry(a);
    const etaB = this.etaToPitEntry(b);
    const lead = etaA <= etaB ? a : b;
    const trail = lead === a ? b : a;
    const gap = Math.abs(etaA - etaB);
    const risk = doubleStackRisk(gap, a.team.pitCrewTime);
    let traffic = 0;
    for (const other of this.cars) {
      if (other.isPlayer) continue;
      if (other.status === 'PIT_LANE' || other.status === 'PIT_BOX') traffic += 1;
      else if ((this.flag === 'SC' || this.flag === 'VSC') && other.status === 'RACING' && other.set.wear > 0.4) traffic += 0.5;
    }
    const pitLaneTraffic = Math.round(traffic);
    const level: DoubleStackEstimate['risk'] =
      risk.queueProbability > 0.6 || risk.expectedWait > 1.5 ? 'HIGH' : risk.queueProbability > 0.15 || pitLaneTraffic >= 4 ? 'MEDIUM' : 'LOW';
    return { leadCarId: lead.id, trailCarId: trail.id, gap, expectedWait: risk.expectedWait, queueProbability: risk.queueProbability, pitLaneTraffic, risk: level };
  }

  private telemetry(car: Car): PlayerCarTelemetry {
    this.buildViews();
    const view = this.viewById.get(car.id);
    const strategy = car.strategy ?? this.sanitiseStrategy({ activePlan: 'A', autoBox: true, plans: {} as Record<PlanId, StrategyPlan> });
    let boxCall: BoxCall | null = null;
    if (car.box) {
      const set = car.sets.find((s) => s.id === car.box!.setId);
      if (set) boxCall = { setId: set.id, compound: set.compound, reason: car.box.reason, etaSeconds: car.pit ? 0 : this.etaToPitEntry(car) };
    }
    const racing = car.status === 'RACING' && this.phase === 'RACING';
    return {
      carId: car.id,
      carNumber: car.driver.carNumber,
      fuelKg: car.fuel,
      fuelMarginLaps: this.fuelMarginLaps(car),
      ersCharge: car.ersCharge,
      engineTempC: car.engineTemp,
      brakeTempC: car.brakeTemp,
      defend: car.defend,
      boxCall,
      tyreSets: car.sets.map((s) => ({ ...s })),
      tyreLifeLaps: lapsToCliff(car.set.wear, this.currentWearRate(car)),
      rejoin: this.rejoinEstimate(car),
      undercut: racing && this.flag === 'GREEN' && car.lapsCompleted >= 1 ? this.undercutAnalysis(car, view) : null,
      threat: racing && this.flag === 'GREEN' && car.lapsCompleted >= 1 ? this.threatAnalysis(car, view) : null,
      strategy,
      nextPlannedStop: car.status === 'RETIRED' || car.status === 'FINISHED' ? null : (this.remainingStops(car)[0] ?? null),
    };
  }

  // ─────────────────────────────────────────────────────────────── snapshot ──

  private gapBetween(leader: Car, car: Car): { seconds: number | null; laps: number } {
    if (leader === car || car.status === 'RETIRED' || this.phase === 'GRID' && !this.started) return { seconds: null, laps: 0 };
    const T = this.T;
    if (leader.status === 'FINISHED') {
      if (car.status === 'FINISHED') {
        const laps = leader.lapsCompleted - car.lapsCompleted;
        return { seconds: laps === 0 && car.finishTime !== null && leader.finishTime !== null ? car.finishTime - leader.finishTime : null, laps: Math.max(0, laps) };
      }
      const laps = Math.max(0, leader.lapsCompleted - (car.lapsCompleted + 1));
      const toLine = (T - clamp(car.tau, 0, T)) * car.paceEma;
      return { seconds: laps === 0 && leader.finishTime !== null ? this.raceTime - leader.finishTime + toLine : null, laps };
    }
    const delta = Math.max(0, this.progressOf(leader) - this.progressOf(car));
    const laps = Math.floor(delta / T);
    return { seconds: laps === 0 ? delta * car.paceEma : null, laps };
  }

  snapshot(timeScale: TimeScale, paused: boolean): RaceSnapshot {
    const order = this.order.length === this.cars.length ? this.order : this.cars;
    const leader = order[0]!;
    const cars: CarSnapshot[] = order.map((car, index) => {
      const toLeader = this.gapBetween(leader, car);
      const previous = index > 0 ? order[index - 1]! : null;
      const toAhead = previous ? this.gapBetween(previous, car) : { seconds: null, laps: 0 };
      const inPit = car.status === 'PIT_LANE' || car.status === 'PIT_BOX';
      const fraction = this.fractionOf(car.tau);
      let pitLaneProgress: number | null = null;
      if (inPit) pitLaneProgress = car.pit ? clamp(car.pit.progress, 0, 1) : car.team.pitBoxPosition;
      let speed = 0;
      if (car.status === 'RACING' || car.status === 'FINISHED') speed = speedAt(this.geometry, fraction) * car.rate * 3.6;
      else if (car.status === 'PIT_LANE') speed = this.track.pitSpeedLimitKph;
      return {
        id: car.id,
        position: car.position,
        gridPosition: car.gridPosition,
        status: car.status,
        lapsCompleted: car.lapsCompleted,
        lapFraction: fraction,
        pitLaneProgress,
        speedKph: speed,
        gapToLeader: toLeader.seconds,
        lapsDown: toLeader.laps,
        interval: toAhead.laps > 0 ? null : toAhead.seconds,
        intervalLaps: toAhead.laps,
        lastLapTime: car.lastLap,
        bestLapTime: car.bestLap,
        sectors: [{ ...car.sectorCells[0] }, { ...car.sectorCells[1] }, { ...car.sectorCells[2] }],
        currentSector: car.currentSector,
        tyre: {
          setId: car.set.id,
          compound: car.set.compound,
          ageLaps: car.set.laps,
          wear: car.set.wear,
          readiness: car.readiness,
          tempC: tyreTemperatureC(car.set.compound, car.readiness, {
            paceMode: car.paceMode,
            dirtyAir: car.dirtyAir,
            trackWetness: this.wx.trackWetness,
            trackTempC: this.wx.trackTempC,
          }),
        },
        pitStops: car.pitStops,
        drsEligible: car.drsZone >= 0,
        drsOpen: car.drsOpen,
        inDirtyAir: car.dirtyAir > 0.05,
        battleWith: car.battleWith ? car.battleWith.id : null,
        paceMode: car.paceMode,
        ersMode: car.ersMode,
        // Rival pit walls do not announce their calls: only the user's own box calls are visible.
        boxThisLap: car.isPlayer ? car.box !== null : car.pit !== null,
        hasFastestLap: this.fastestLap !== null && this.fastestLap.carId === car.id,
        retiredReason: car.retiredReason,
      };
    });

    const yellowSectors: [boolean, boolean, boolean] = [false, false, false];
    for (const y of this.yellows) yellowSectors[y.sector] = true;

    return {
      seq: this.seq++,
      raceTime: this.raceTime,
      phase: this.phase,
      lap: clamp(leader.lapsCompleted + 1, 1, this.raceLaps),
      raceLaps: this.raceLaps,
      timeScale,
      paused,
      raceControl: {
        flag: this.flag,
        yellowSectors,
        safetyCarLapFraction: this.safetyCar && this.safetyCar.tau !== null ? this.fractionOf(this.safetyCar.tau) : null,
        safetyCarInThisLap: this.safetyCar?.inThisLap ?? false,
        drsEnabled: this.drsEnabled,
        countdown: this.countdown,
        incidents: this.incidents.map((i) => ({ ...i })),
        message: this.headline,
      },
      weather: { ...this.wx },
      cars,
      player: {
        teamOrder: this.teamOrder,
        swapPending: this.swap !== null,
        cars: [this.telemetry(this.players[0]), this.telemetry(this.players[1])],
        doubleStack: this.doubleStackEstimate(),
      },
      fastestLap: this.fastestLap ? { ...this.fastestLap } : null,
      bestSectors: [this.bestSectors[0], this.bestSectors[1], this.bestSectors[2]],
    };
  }

  // ───────────────────────────────────────────────────────────── projection ──

  /** Builds the input of the predictive engine for one of the user's cars. */
  buildProjectionRequest(carId: CarId, compound: TyreCompound | null, offsets: readonly number[], monteCarloRuns: number): ProjectionRequest | null {
    const focus = this.playerCar(carId);
    if (!focus || this.phase !== 'RACING' || this.chequered) return null;
    if (focus.status !== 'RACING' && focus.status !== 'PIT_LANE' && focus.status !== 'PIT_BOX') return null;
    const T = this.T;
    const cars: ProjectionCarInput[] = [];
    for (const car of this.order) {
      if (car.status === 'RETIRED' || car.status === 'FINISHED') continue;
      let toLine: number;
      const pit = car.pit;
      if (pit) {
        const remainingDrive = (1 - pit.progress) * pit.driveTime;
        const remainingStop = pit.phase === 'STOP' ? pit.stopRemaining : pit.phase === 'OUT' ? 0 : car.team.pitCrewTime;
        if (!pit.lineCrossed) toLine = Math.max(0, (this.pitLineProgress - pit.progress) * pit.driveTime) + (pit.boxPosition < this.pitLineProgress ? remainingStop : 0);
        else toLine = remainingDrive + remainingStop + ((T - this.pitExitTau) / T) * car.freeLapTime;
      } else {
        toLine = (T - clamp(car.tau, 0, T)) * car.paceEma;
      }
      cars.push({
        id: car.id,
        teamId: car.team.id,
        position: car.position,
        lapsCompleted: car.lapsCompleted,
        nextLineCrossingTime: this.raceTime + toLine,
        compound: car.set.compound,
        tyreWear: car.set.wear,
        tyreAgeLaps: car.set.laps,
        fuelKg: car.fuel,
        paceOffset: car.paceOffset,
        wearFactor: car.driver.tyreWearFactor,
        pitStops: car.pitStops,
        compoundsUsed: car.compoundsUsed.slice(),
        availableSets: car.sets.filter((s) => !s.fitted).map((s) => ({ ...s })),
        // The user's own plans are known; rivals' intentions have to be predicted.
        plannedStops: car.isPlayer ? this.remainingStops(car) : null,
        inPitLane: pit !== null,
      });
    }

    const lap = focus.lapsCompleted + 1;
    const planned = this.remainingStops(focus)[0] ?? null;
    const chosen = compound ?? this.nextCompoundFor(focus);
    const candidates: StrategyCandidate[] = [];
    const used = new Set<number>();
    for (const offset of offsets) {
      const pitLap = lap + Math.max(0, Math.round(offset));
      if (pitLap >= this.raceLaps || used.has(pitLap)) continue;
      used.add(pitLap);
      candidates.push({ id: `T+${offset}`, label: `T+${offset} · L${pitLap}`, pitLap, compound: chosen });
    }
    if (planned && !used.has(planned.lap) && planned.lap < this.raceLaps) {
      candidates.push({ id: 'PLAN', label: `PLAN ${focus.strategy?.activePlan ?? ''} · L${planned.lap}`, pitLap: planned.lap, compound: planned.compound });
    } else if (!planned) {
      candidates.push({ id: 'PLAN', label: 'NO STOP', pitLap: null, compound: null });
    }
    if (candidates.length === 0) return null;

    return {
      track: this.track,
      raceLaps: this.raceLaps,
      focusCarId: focus.id,
      cars,
      candidates,
      flag: this.flag,
      raceTime: this.raceTime,
      weather: { ...this.wx },
      forecast: this.forecastNow(),
      monteCarloRuns,
      seed: (this.session.config.seed ^ Math.imul(lap + 1, 2654435761) ^ Math.imul(focus.idx + 7, 40503)) >>> 0,
    };
  }
}

// ───────────────────────────────────────────────────────────── free helpers ──

/** Least-worn unfitted set of a compound (the currently fitted one counts when passed as `fitted`). */
function bestSet(sets: readonly TyreSet[], compound: TyreCompound, fitted?: TyreSet): TyreSet | null {
  let best: TyreSet | null = null;
  for (const set of sets) {
    if (set.compound !== compound) continue;
    if (set.fitted && set !== fitted) continue;
    if (!best || set.wear < best.wear) best = set;
  }
  return best;
}

/** A sensible set when nothing specific was asked for: right family for the conditions, medium first. */
function firstUsable(sets: readonly TyreSet[], trackWetness: number): TyreSet {
  const wanted = bestTyreClass(trackWetness);
  const preference: TyreCompound[] = wanted === 'WET' ? ['WET', 'INTER'] : wanted === 'INTER' ? ['INTER', 'WET'] : ['MEDIUM', 'HARD', 'SOFT'];
  for (const compound of preference) {
    const set = bestSet(sets, compound);
    if (set) return set;
  }
  const fallback = sets.find((s) => !s.fitted) ?? sets[0];
  if (!fallback) throw new Error('No tyre set available');
  return fallback;
}

function describeStints(stints: readonly { compound: TyreCompound }[]): string {
  const stops = stints.length - 1;
  return `${stops}-STOP ${stints.map((s) => COMPOUNDS[s.compound].letter).join('→')}`;
}

function formatLap(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(3)}`;
}
