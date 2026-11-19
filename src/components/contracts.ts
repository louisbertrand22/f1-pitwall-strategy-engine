/**
 * Props contracts of the cockpit components. `App` owns the worker connection and passes plain data
 * down; components never talk to the worker directly – they call `PitWallActions`.
 */
import type { RaceControlAction } from '../workers/protocol';
import type {
  CarId,
  CarStrategy,
  ClassificationEntry,
  ErsMode,
  PaceMode,
  PlanId,
  ProjectionResult,
  RaceEvent,
  RaceHistory,
  RaceSnapshot,
  RadioMessage,
  SessionInfo,
  TeamOrderMode,
  TyreCompound,
  WeatherForecastPoint,
} from '../simulation/types';

/** Every order the pit wall can give. Each call is forwarded to the simulation worker. */
export interface PitWallActions {
  setPaceMode(carId: CarId, mode: PaceMode): void;
  setErsMode(carId: CarId, mode: ErsMode): void;
  setTeamOrder(order: TeamOrderMode): void;
  swapPositions(): void;
  setDefend(carId: CarId, defend: boolean): void;
  /** Box at the end of the current lap and fit `setId`. */
  box(carId: CarId, setId: string): void;
  cancelBox(carId: CarId): void;
  /** Box both cars this lap; set ids per car number [#1, #2]. */
  doubleStack(setIds: [string, string]): void;
  setStrategy(carId: CarId, strategy: CarStrategy): void;
  setActivePlan(carId: CarId, planId: PlanId): void;
  setAutoBox(carId: CarId, enabled: boolean): void;
  replyRadio(messageId: number, replyId: string): void;
  /** Ask the predictive engine for candidates stopping at lap T + offset on `compound` (null = engine's choice). */
  requestProjection(carId: CarId, compound: TyreCompound | null, offsets: number[]): void;
  raceControl(action: RaceControlAction): void;
}

/** A snapshot with the wall-clock time (performance.now()) at which it reached the UI thread. */
export interface LiveFrame {
  snapshot: RaceSnapshot;
  receivedAt: number;
}

/**
 * Pull-based access to the freshest snapshot (~30 Hz), for requestAnimationFrame loops that must not
 * re-render React. Extrapolate car positions between frames with
 *   lapFraction += speedKph / 3.6 · Δt · timeScale / trackLengthMetres   (Δt capped, zero when paused).
 */
export interface LiveFrameSource {
  getFrame(): LiveFrame | null;
}

interface BaseProps {
  session: SessionInfo;
  /** Latest snapshot, refreshed at React rate (~10 Hz). */
  snapshot: RaceSnapshot;
  className?: string;
}

export interface TimingTowerProps extends BaseProps {
  selectedCarId: CarId | null;
  onSelectCar: (carId: CarId | null) => void;
}

export interface TrackRadarCanvasProps extends BaseProps {
  /** High-rate frames for the 60 FPS canvas loop. */
  frames: LiveFrameSource;
  selectedCarId: CarId | null;
  onSelectCar: (carId: CarId | null) => void;
}

export interface StrategyGraphProps extends BaseProps {
  history: RaceHistory;
  /** Latest projection per player car, if one has been computed. */
  projections: Partial<Record<CarId, ProjectionResult>>;
  /** Car whose strategy is being studied (one of the two player cars). */
  focusCarId: CarId;
  onFocusCar: (carId: CarId) => void;
  actions: PitWallActions;
}

export interface WeatherRadarProps extends BaseProps {
  history: RaceHistory;
  forecast: WeatherForecastPoint[];
}

export interface PitWallControlsProps extends BaseProps {
  actions: PitWallActions;
  selectedCarId: CarId | null;
  onSelectCar: (carId: CarId | null) => void;
}

export interface RadioConsoleProps extends BaseProps {
  /** Radio traffic, oldest first. */
  messages: RadioMessage[];
  /** Race-control log, oldest first. */
  events: RaceEvent[];
  actions: PitWallActions;
}

export interface StrategyPlannerProps extends BaseProps {
  /** PRE_RACE: full editor on the grid · LIVE: compact editor during the race (past stints are locked). */
  mode: 'PRE_RACE' | 'LIVE';
  actions: PitWallActions;
}

export interface RaceAnalysisProps extends BaseProps {
  history: RaceHistory;
  /** Final classification once the race is over, otherwise null. */
  classification: ClassificationEntry[] | null;
}
