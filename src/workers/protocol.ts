/**
 * Message protocol between the UI thread and the race simulation worker.
 *
 *   UI ──WorkerCommand──▶ raceSimulation.worker ──WorkerEvent──▶ UI
 *
 * The worker owns the whole race state. The UI never mutates it: it sends commands and renders the
 * snapshots and append-only history it receives.
 */
import type {
  CarId,
  CarStrategy,
  ClassificationEntry,
  ErsMode,
  LapRecord,
  PaceMode,
  PitStopRecord,
  PlanId,
  ProjectionResult,
  RaceEvent,
  RaceSnapshot,
  RadioMessage,
  SessionConfig,
  SessionInfo,
  TeamOrderMode,
  TimeScale,
  TyreCompound,
  WeatherForecastPoint,
  WeatherSample,
} from '../simulation/types';

/** Sandbox actions of the race director panel (inject events to rehearse a strategy). */
export type RaceControlAction = 'SAFETY_CAR' | 'VIRTUAL_SAFETY_CAR' | 'RED_FLAG' | 'RAIN_SHOWER' | 'DRY_UP';

export type WorkerCommand =
  /** Build a new race (grid, tyre allocations, weather, default plans). Answered by READY. */
  | { type: 'INIT'; config: SessionConfig }
  /** Start the lights sequence. */
  | { type: 'START' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'SET_TIME_SCALE'; scale: TimeScale }
  /** When enabled, the worker drops to x2 whenever the pit wall is asked for a decision. */
  | { type: 'SET_AUTO_SLOW'; enabled: boolean }
  | { type: 'SET_PACE_MODE'; carId: CarId; mode: PaceMode }
  | { type: 'SET_ERS_MODE'; carId: CarId; mode: ErsMode }
  | { type: 'SET_TEAM_ORDER'; order: TeamOrderMode }
  /** Ask the two team cars to swap positions on track. */
  | { type: 'SWAP_POSITIONS' }
  | { type: 'SET_DEFEND'; carId: CarId; defend: boolean }
  /** "Box, box": pit at the end of the current lap and fit the given set. */
  | { type: 'BOX'; carId: CarId; setId: string }
  | { type: 'CANCEL_BOX'; carId: CarId }
  /** Pit both cars this lap. Set ids are given per car number: [#1, #2]. */
  | { type: 'DOUBLE_STACK'; setIds: [string, string] }
  /** Replace the three plans of a car (pre-race planner or live edit). */
  | { type: 'SET_STRATEGY'; carId: CarId; strategy: CarStrategy }
  /** Switch between Plan A / B / C in one click. */
  | { type: 'SET_ACTIVE_PLAN'; carId: CarId; planId: PlanId }
  | { type: 'SET_AUTO_BOX'; carId: CarId; enabled: boolean }
  | { type: 'RADIO_REPLY'; messageId: number; replyId: string }
  /** Run the undercut/overcut projection for a car: candidates stop at lap T + offset on `compound`. */
  | { type: 'REQUEST_PROJECTION'; carId: CarId; compound: TyreCompound | null; offsets: number[] }
  | { type: 'RACE_CONTROL'; action: RaceControlAction };

export type WorkerEvent =
  /** The race is built and waiting on the grid. */
  | { type: 'READY'; session: SessionInfo; snapshot: RaceSnapshot; forecast: WeatherForecastPoint[] }
  /** Live state, posted at ~30 Hz while the race runs. */
  | { type: 'SNAPSHOT'; snapshot: RaceSnapshot }
  /** Laps completed since the previous message (append-only). */
  | { type: 'LAPS'; records: LapRecord[] }
  /** A pit stop record; sent again (same carId + lap) once `positionAfter` is known. */
  | { type: 'PIT_STOP'; record: PitStopRecord }
  | { type: 'RACE_EVENT'; event: RaceEvent }
  /** New radio message, or an update of an existing one (same id) once answered. */
  | { type: 'RADIO'; message: RadioMessage }
  | { type: 'WEATHER'; sample: WeatherSample; forecast: WeatherForecastPoint[] }
  | { type: 'PROJECTION'; result: ProjectionResult }
  | { type: 'FINISHED'; classification: ClassificationEntry[] }
  | { type: 'ERROR'; message: string };

export const TIME_SCALES: readonly TimeScale[] = [1, 2, 5, 15, 30];
