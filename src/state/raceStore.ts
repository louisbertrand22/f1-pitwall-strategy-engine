/**
 * UI-side connection to the simulation worker.
 *
 * Owns the Worker, folds its event stream into an immutable `RaceUiState` for React (flushed at ~10 Hz)
 * and exposes the freshest snapshot to animation loops through a pull-based `LiveFrameSource`, so the
 * 60 FPS canvas never waits for – or triggers – a React render.
 */
import { useSyncExternalStore } from 'react';
import type { LiveFrame, LiveFrameSource, PitWallActions } from '../components/contracts';
import type {
  CarId,
  ClassificationEntry,
  ProjectionResult,
  RaceHistory,
  RaceSnapshot,
  RadioMessage,
  SessionConfig,
  SessionInfo,
  TimeScale,
  WeatherForecastPoint,
} from '../simulation/types';
import type { WorkerCommand, WorkerEvent } from '../workers/protocol';

export interface RaceUiState {
  stage: 'SETUP' | 'LOADING' | 'SESSION';
  session: SessionInfo | null;
  snapshot: RaceSnapshot | null;
  history: RaceHistory;
  forecast: WeatherForecastPoint[];
  radio: RadioMessage[];
  projections: Partial<Record<CarId, ProjectionResult>>;
  classification: ClassificationEntry[] | null;
  autoSlow: boolean;
  error: string | null;
}

const FLUSH_INTERVAL_MS = 100;
const MAX_RADIO = 400;
const MAX_EVENTS = 600;

function emptyHistory(): RaceHistory {
  return { laps: {}, pitStops: [], events: [], weather: [] };
}

function initialState(): RaceUiState {
  return {
    stage: 'SETUP',
    session: null,
    snapshot: null,
    history: emptyHistory(),
    forecast: [],
    radio: [],
    projections: {},
    classification: null,
    autoSlow: true,
    error: null,
  };
}

class RaceStore {
  private worker: Worker | null = null;
  private state: RaceUiState = initialState();
  private pending: Partial<RaceUiState> = {};
  private dirty = false;
  private frame: LiveFrame | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<() => void>();

  /** Pull-based access to the latest snapshot for requestAnimationFrame loops. */
  readonly frames: LiveFrameSource = { getFrame: () => this.frame };

  readonly actions: PitWallActions = {
    setPaceMode: (carId, mode) => this.send({ type: 'SET_PACE_MODE', carId, mode }),
    setErsMode: (carId, mode) => this.send({ type: 'SET_ERS_MODE', carId, mode }),
    setTeamOrder: (order) => this.send({ type: 'SET_TEAM_ORDER', order }),
    swapPositions: () => this.send({ type: 'SWAP_POSITIONS' }),
    setDefend: (carId, defend) => this.send({ type: 'SET_DEFEND', carId, defend }),
    box: (carId, setId) => this.send({ type: 'BOX', carId, setId }),
    cancelBox: (carId) => this.send({ type: 'CANCEL_BOX', carId }),
    doubleStack: (setIds) => this.send({ type: 'DOUBLE_STACK', setIds }),
    setStrategy: (carId, strategy) => this.send({ type: 'SET_STRATEGY', carId, strategy }),
    setActivePlan: (carId, planId) => this.send({ type: 'SET_ACTIVE_PLAN', carId, planId }),
    setAutoBox: (carId, enabled) => this.send({ type: 'SET_AUTO_BOX', carId, enabled }),
    replyRadio: (messageId, replyId) => this.send({ type: 'RADIO_REPLY', messageId, replyId }),
    requestProjection: (carId, compound, offsets) => this.send({ type: 'REQUEST_PROJECTION', carId, compound, offsets }),
    raceControl: (action) => this.send({ type: 'RACE_CONTROL', action }),
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): RaceUiState => this.state;

  // ─────────────────────────────────────────────────────────── session ──

  /** Builds a new race in a fresh worker. */
  init(config: SessionConfig): void {
    this.dispose();
    this.state = { ...initialState(), stage: 'LOADING', autoSlow: this.state.autoSlow };
    this.emit();
    const worker = new Worker(new URL('../workers/raceSimulation.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerEvent>) => this.receive(event.data);
    worker.onerror = (event) => this.patch({ error: event.message || 'Simulation worker crashed' }, true);
    this.worker = worker;
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.send({ type: 'INIT', config });
    this.send({ type: 'SET_AUTO_SLOW', enabled: this.state.autoSlow });
  }

  /** Back to the setup screen. */
  reset(): void {
    this.dispose();
    this.state = { ...initialState(), autoSlow: this.state.autoSlow };
    this.emit();
  }

  startRace(): void {
    this.send({ type: 'START' });
  }

  setPaused(paused: boolean): void {
    this.send({ type: paused ? 'PAUSE' : 'RESUME' });
  }

  setTimeScale(scale: TimeScale): void {
    this.send({ type: 'SET_TIME_SCALE', scale });
  }

  setAutoSlow(enabled: boolean): void {
    this.patch({ autoSlow: enabled }, true);
    this.send({ type: 'SET_AUTO_SLOW', enabled });
  }

  private dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.flushTimer !== null) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.frame = null;
    this.pending = {};
    this.dirty = false;
  }

  private send(command: WorkerCommand): void {
    this.worker?.postMessage(command);
  }

  // ───────────────────────────────────────────────────────────── events ──

  /** Current value of a field, including changes not yet flushed to React. */
  private current<K extends keyof RaceUiState>(key: K): RaceUiState[K] {
    return (key in this.pending ? this.pending[key] : this.state[key]) as RaceUiState[K];
  }

  private patch(partial: Partial<RaceUiState>, immediate = false): void {
    Object.assign(this.pending, partial);
    this.dirty = true;
    if (immediate) this.flush();
  }

  private flush(): void {
    if (!this.dirty) return;
    this.state = { ...this.state, ...this.pending };
    this.pending = {};
    this.dirty = false;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private receive(event: WorkerEvent): void {
    switch (event.type) {
      case 'READY':
        this.frame = { snapshot: event.snapshot, receivedAt: performance.now() };
        this.patch({ stage: 'SESSION', session: event.session, snapshot: event.snapshot, forecast: event.forecast }, true);
        break;
      case 'SNAPSHOT':
        this.frame = { snapshot: event.snapshot, receivedAt: performance.now() };
        this.patch({ snapshot: event.snapshot });
        break;
      case 'LAPS': {
        const history = this.current('history');
        const laps = { ...history.laps };
        for (const record of event.records) laps[record.carId] = [...(laps[record.carId] ?? []), record];
        this.patch({ history: { ...history, laps } });
        break;
      }
      case 'PIT_STOP': {
        const history = this.current('history');
        const others = history.pitStops.filter((p) => !(p.carId === event.record.carId && p.lap === event.record.lap));
        this.patch({ history: { ...history, pitStops: [...others, event.record] } });
        break;
      }
      case 'RACE_EVENT': {
        const history = this.current('history');
        this.patch({ history: { ...history, events: [...history.events, event.event].slice(-MAX_EVENTS) } });
        break;
      }
      case 'RADIO': {
        const radio = this.current('radio');
        const index = radio.findIndex((m) => m.id === event.message.id);
        const next = index >= 0 ? radio.map((m, i) => (i === index ? event.message : m)) : [...radio, event.message].slice(-MAX_RADIO);
        this.patch({ radio: next });
        break;
      }
      case 'WEATHER': {
        const history = this.current('history');
        this.patch({ history: { ...history, weather: [...history.weather, event.sample] }, forecast: event.forecast });
        break;
      }
      case 'PROJECTION':
        this.patch({ projections: { ...this.current('projections'), [event.result.focusCarId]: event.result } });
        break;
      case 'FINISHED':
        this.patch({ classification: event.classification }, true);
        break;
      case 'ERROR':
        this.patch({ error: event.message }, true);
        break;
    }
  }
}

export const raceStore = new RaceStore();

export function useRaceState(): RaceUiState {
  return useSyncExternalStore(raceStore.subscribe, raceStore.getState, raceStore.getState);
}
