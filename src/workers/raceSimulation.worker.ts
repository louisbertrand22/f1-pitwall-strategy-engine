/**
 * Race simulation worker.
 *
 * Hosts the deterministic race engine (20 cars, tyre physics, weather, incidents, rival-team AI) and the
 * Monte-Carlo strategy projection, away from the UI thread. A 60 Hz timer converts wall-clock time into
 * fixed simulation steps according to the time scale (x1 … x30), posts a snapshot at ~30 Hz and
 * time-slices projection jobs so the simulation never stalls.
 *
 * Protocol: see ./protocol.ts (WorkerCommand in, WorkerEvent out).
 */
import { buildDefaultPlans, decideStrategy, planRace } from '../simulation/aiStrategist';
import { runProjection } from '../simulation/projection';
import { ENGINE_DT, RaceEngine } from '../simulation/raceEngine';
import { getTrack } from '../simulation/trackData';
import type { CarId, ProjectionResult, TimeScale, TyreCompound } from '../simulation/types';
import type { WorkerCommand, WorkerEvent } from './protocol';

/** Minimal typing of the dedicated worker scope (avoids mixing the DOM and WebWorker libs). */
interface WorkerScope {
  postMessage(message: WorkerEvent): void;
  onmessage: ((event: MessageEvent<WorkerCommand>) => void) | null;
}
const scope = self as unknown as WorkerScope;

const TICK_MS = 1000 / 60;
/** One snapshot every N ticks while racing (30 Hz) and every M ticks while idle. */
const SNAPSHOT_TICKS_RUNNING = 2;
const SNAPSHOT_TICKS_IDLE = 15;
/** Hard cap on simulation steps per tick: protects the loop if the thread was suspended. */
const MAX_STEPS_PER_TICK = 60;
/** Wall-clock budget per tick for the Monte-Carlo projection (ms). */
const PROJECTION_BUDGET_MS = 4;
const MONTE_CARLO_RUNS = 120;
const DEFAULT_OFFSETS: readonly number[] = [1, 3, 5];

interface ProjectionPrefs {
  compound: TyreCompound | null;
  offsets: number[];
}

let engine: RaceEngine | null = null;
let timeScale: TimeScale = 1;
let paused = false;
let autoSlow = true;
let accumulator = 0;
let lastTick = performance.now();
let tickCount = 0;
let timer: ReturnType<typeof setInterval> | null = null;

const projectionPrefs = new Map<CarId, ProjectionPrefs>();
const projectionQueue: CarId[] = [];
let projectionJob: { carId: CarId; generator: Generator<number, ProjectionResult, void> } | null = null;

function post(event: WorkerEvent): void {
  scope.postMessage(event);
}

function postSnapshot(): void {
  if (engine) post({ type: 'SNAPSHOT', snapshot: engine.snapshot(timeScale, paused) });
}

function queueProjection(carId: CarId): void {
  if (!projectionQueue.includes(carId)) projectionQueue.push(carId);
  // A running job for the same car is now stale.
  if (projectionJob && projectionJob.carId === carId) projectionJob = null;
}

function flushOutbox(): void {
  if (!engine) return;
  const out = engine.drain();
  if (out.laps.length > 0) post({ type: 'LAPS', records: out.laps });
  for (const record of out.pitStops) post({ type: 'PIT_STOP', record });
  for (const event of out.events) post({ type: 'RACE_EVENT', event });
  for (const message of out.radio) post({ type: 'RADIO', message });
  if (out.weather) post({ type: 'WEATHER', sample: out.weather.sample, forecast: out.weather.forecast });
  for (const carId of out.projectionDue) queueProjection(carId);
  if (out.attention && autoSlow && timeScale > 2) timeScale = 2;
  if (out.classification) post({ type: 'FINISHED', classification: out.classification });
}

function runProjectionSlice(): void {
  if (!engine) return;
  if (!projectionJob) {
    const carId = projectionQueue.shift();
    if (carId === undefined) return;
    const prefs = projectionPrefs.get(carId) ?? { compound: null, offsets: [...DEFAULT_OFFSETS] };
    const request = engine.buildProjectionRequest(carId, prefs.compound, prefs.offsets, MONTE_CARLO_RUNS);
    if (!request) return;
    projectionJob = { carId, generator: runProjection(request) };
  }
  const job = projectionJob;
  const deadline = performance.now() + PROJECTION_BUDGET_MS;
  do {
    const step = job.generator.next();
    if (step.done) {
      post({ type: 'PROJECTION', result: step.value });
      if (projectionJob === job) projectionJob = null;
      return;
    }
  } while (performance.now() < deadline && projectionJob === job);
}

function tick(): void {
  const now = performance.now();
  const elapsed = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  if (!engine) return;
  try {
    const running = !paused && !engine.isFinished;
    if (running) {
      accumulator += elapsed * timeScale;
      let steps = Math.min(MAX_STEPS_PER_TICK, Math.floor(accumulator / ENGINE_DT));
      accumulator -= steps * ENGINE_DT;
      if (accumulator > ENGINE_DT * MAX_STEPS_PER_TICK) accumulator = 0;
      while (steps-- > 0) engine.step();
    }
    flushOutbox();
    tickCount += 1;
    if (tickCount % (running ? SNAPSHOT_TICKS_RUNNING : SNAPSHOT_TICKS_IDLE) === 0) postSnapshot();
    runProjectionSlice();
  } catch (error) {
    paused = true;
    post({ type: 'ERROR', message: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
  }
}

function initialise(command: Extract<WorkerCommand, { type: 'INIT' }>): void {
  const track = getTrack(command.config.trackId);
  engine = new RaceEngine(command.config, { track, planRace, buildDefaultPlans, decideStrategy });
  timeScale = 1;
  paused = false;
  accumulator = 0;
  tickCount = 0;
  lastTick = performance.now();
  projectionPrefs.clear();
  projectionQueue.length = 0;
  projectionJob = null;
  post({ type: 'READY', session: engine.session, snapshot: engine.snapshot(timeScale, paused), forecast: engine.forecastNow() });
  if (timer === null) timer = setInterval(tick, TICK_MS);
}

scope.onmessage = (message: MessageEvent<WorkerCommand>): void => {
  const command = message.data;
  try {
    switch (command.type) {
      case 'INIT':
        initialise(command);
        return;
      case 'PAUSE':
        paused = true;
        break;
      case 'RESUME':
        paused = false;
        lastTick = performance.now();
        break;
      case 'SET_TIME_SCALE':
        timeScale = command.scale;
        break;
      case 'SET_AUTO_SLOW':
        autoSlow = command.enabled;
        break;
      case 'REQUEST_PROJECTION':
        projectionPrefs.set(command.carId, { compound: command.compound, offsets: command.offsets.slice(0, 5) });
        queueProjection(command.carId);
        break;
      default:
        engine?.command(command);
        break;
    }
    // Reflect the effect of the command immediately, even while paused.
    flushOutbox();
    postSnapshot();
  } catch (error) {
    post({ type: 'ERROR', message: error instanceof Error ? error.message : String(error) });
  }
};
