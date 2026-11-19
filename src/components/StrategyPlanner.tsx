import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Lock, Plus, Route, TriangleAlert } from 'lucide-react';
import type { PitWallActions, StrategyPlannerProps } from './contracts';
import type { CarSnapshot, PlanId, PlayerCarTelemetry, RacePhase, SessionInfo, StintPlan, StrategyPlan, TrackDefinition, TyreSet } from '../simulation/types';
import { CLIFF_WEAR, evaluateStrategy, pitLossUnderFlag, startingFuelKg } from '../simulation/physicsModel';
import type { StrategyEvaluation } from '../simulation/physicsModel';
import { formatDelta, formatPercent, formatPosition, formatSeconds } from '../lib/format';
import { indexSession } from '../lib/session';
import { TYRE_LABELS, TYRE_ORDER } from '../lib/tyres';
import { DriverTag, Panel, Segmented, TyreBadge } from './ui';
import type { SegmentedOption } from './ui';
import { PaceChart } from './controls/PaceChart';
import type { PaceSeries } from './controls/PaceChart';
import { StintBar } from './controls/StintBar';
import { NO_LOCK, allocationIssues, canSplit, nextStop, sameStints, splitLongestStint, stintEndLap, stintStartLap, stintsKey, stopsRemaining } from './controls/planModel';
import type { PlanLock } from './controls/planModel';
import { StatusTag, ToggleButton, ToneIcon, formatRaceTime, useElementSize } from './controls/shared';
import { useEchoed } from './controls/useEchoed';

const PLAN_IDS: readonly PlanId[] = ['A', 'B', 'C'];
/** Chart series follow the plan, never its rank: A, B, C always wear the first three categorical hues. */
const SERIES_COLOR: Record<PlanId, string> = {
  A: 'var(--color-series-1)',
  B: 'var(--color-series-2)',
  C: 'var(--color-series-3)',
};
/** An order sent this recently is trusted over a snapshot that may not have echoed it yet (ms). */
const ORDER_FRESH_MS = 1500;

type Mode = StrategyPlannerProps['mode'];

const COLUMNS: Record<Mode, string> = {
  PRE_RACE: 'grid grid-cols-[66px_minmax(0,1fr)_22px_138px] gap-x-2 px-2',
  LIVE: 'grid grid-cols-[58px_minmax(0,1fr)_22px_152px] gap-x-2 px-2',
};
const BAR_HEIGHT: Record<Mode, number> = { PRE_RACE: 24, LIVE: 20 };

interface Stamped<T> {
  value: T;
  at: number;
}

function freshValue<T>(order: Stamped<T> | undefined): T | undefined {
  return order && performance.now() - order.at < ORDER_FRESH_MS ? order.value : undefined;
}

// ───────────────────────────────────────────────────────── circuit profile ──

function band(value: number, limits: readonly number[], words: readonly string[]): string {
  const index = limits.findIndex((limit) => value < limit);
  return words[index < 0 ? words.length - 1 : index] ?? '';
}

function ProfileItem({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <span className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="pw-label">{label}</span>
      <span className="pw-value text-2xs">{value}</span>
      {note ? <span className="font-display text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-300">{note}</span> : null}
    </span>
  );
}

/** One-line strategic profile of the circuit, to choose between the plans on the grid. */
function CircuitProfile({ track, raceLaps }: { track: TrackDefinition; raceLaps: number }) {
  return (
    <div className="flex shrink-0 items-center gap-x-5 overflow-hidden border-b border-carbon-700 bg-carbon-850 px-2 py-1.5">
      <span className="font-display text-2xs font-semibold uppercase tracking-[0.14em] text-ink-100">{track.shortName}</span>
      <ProfileItem label="Laps" value={`${raceLaps}`} />
      <ProfileItem
        label="Pit loss"
        value={formatSeconds(track.pitLossSeconds)}
        note={`SC ${pitLossUnderFlag(track, 'SC').toFixed(1)} · VSC ${pitLossUnderFlag(track, 'VSC').toFixed(1)}`}
      />
      <ProfileItem label="Abrasiveness" value={track.abrasiveness.toFixed(2)} note={band(track.abrasiveness, [0.9, 1.1], ['Low', 'Medium', 'High'])} />
      <ProfileItem
        label="Overtaking"
        value={track.overtakingDifficulty.toFixed(2)}
        note={band(track.overtakingDifficulty, [0.3, 0.6, 0.8], ['Easy', 'Moderate', 'Hard', 'Very hard'])}
      />
      <ProfileItem label="Safety car" value={formatPercent(track.safetyCarProbability)} />
      <ProfileItem label="VSC" value={formatPercent(track.vscProbability)} />
      <ProfileItem label="Rain" value={formatPercent(track.rainProbability)} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────── allocation ──

function AllocationStrip({ sets }: { sets: readonly TyreSet[] }) {
  const sorted = [...sets].sort(
    (a, b) => TYRE_ORDER.indexOf(a.compound) - TYRE_ORDER.indexOf(b.compound) || a.wear - b.wear || a.id.localeCompare(b.id),
  );
  return (
    <div className="flex items-center gap-2 px-2">
      <span className="pw-label shrink-0">Sets</span>
      <ul className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5">
        {sorted.map((set) => {
          const fresh = set.isNew && set.laps === 0;
          return (
            <li
              key={set.id}
              title={`${TYRE_LABELS[set.compound]} ${set.id} · ${fresh ? 'new' : `${set.laps} laps · wear ${formatPercent(set.wear)}`}${set.fitted ? ' · on the car' : ''}`}
              className={`flex items-center gap-1 rounded-[2px] ${set.fitted ? 'bg-carbon-750 px-1 outline outline-1 outline-carbon-500' : ''}`}
            >
              <TyreBadge compound={set.compound} size={15} used={!set.isNew} dimmed={set.wear > 0.9} />
              <span className="font-mono text-[10px] leading-4 tabular text-ink-300">{fresh ? 'NEW' : `${set.laps}L`}</span>
              {set.fitted ? <span className="pw-label text-ink-100">on car</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────── plan row ──

/** Stop laps and end-of-stint wear printed under the bar, wherever they fit without colliding. */
function StintNotes({
  stints,
  raceLaps,
  width,
  evaluation,
  lock,
}: {
  stints: readonly StintPlan[];
  raceLaps: number;
  width: number;
  evaluation: StrategyEvaluation;
  lock: PlanLock;
}) {
  const notes: ReactNode[] = [];
  let lastStopX = -Infinity;
  stints.forEach((_, index) => {
    const start = stintStartLap(stints, index);
    const end = stintEndLap(stints, index, raceLaps);
    const x0 = ((start - 1) / raceLaps) * width;
    const x1 = (end / raceLaps) * width;
    const done = lock.live && index < lock.currentStint;
    if (index < stints.length - 1 && x1 - lastStopX >= 26 && x1 >= 12 && x1 <= width - 12) {
      lastStopX = x1;
      notes.push(
        <span key={`stop-${index}`} className={`absolute top-0 -translate-x-1/2 font-mono text-3xs leading-[14px] tabular ${done ? 'text-ink-600' : 'text-ink-300'}`} style={{ left: x1 }}>
          L{end}
        </span>,
      );
    }
    const summary = evaluation.stints[index];
    if (!summary) return;
    const past = summary.endWear > CLIFF_WEAR;
    const room = x1 - x0 - 30;
    if (room < (past ? 40 : 26)) return;
    notes.push(
      <span
        key={`wear-${index}`}
        title={`Stint ${index + 1} ends at ${formatPercent(summary.endWear)} wear${past ? ' — past the cliff' : ''}`}
        className={`absolute top-0 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap leading-[14px] ${done ? 'opacity-45' : ''}`}
        style={{ left: (x0 + x1) / 2 }}
      >
        {past ? <ToneIcon tone="warn" size={9} /> : null}
        {room >= 78 ? <span className="pw-label leading-[14px]">End wear</span> : null}
        <span className={`font-mono text-3xs tabular ${past ? 'font-bold text-warn' : 'text-ink-300'}`}>{formatPercent(summary.endWear)}</span>
      </span>,
    );
  });
  return <div className="relative z-10 h-3.5">{width > 0 ? notes : null}</div>;
}

interface PlanRowProps {
  carId: string;
  driverCode: string;
  plan: StrategyPlan;
  stints: readonly StintPlan[];
  evaluation: StrategyEvaluation;
  issues: readonly string[];
  valid: boolean;
  /** Seconds to the reference (fastest valid) plan. */
  delta: number;
  active: boolean;
  lock: PlanLock;
  sets: readonly TyreSet[];
  raceLaps: number;
  barWidth: number;
  mode: Mode;
  frozen: boolean;
  popoverAbove: boolean;
  onActivate: () => void;
  onDraft: (stints: StintPlan[] | null) => void;
  onCommit: (stints: StintPlan[]) => void;
}

function PlanRow({
  carId,
  driverCode,
  plan,
  stints,
  evaluation,
  issues,
  valid,
  delta,
  active,
  lock,
  sets,
  raceLaps,
  barWidth,
  mode,
  frozen,
  popoverAbove,
  onActivate,
  onDraft,
  onCommit,
}: PlanRowProps) {
  const live = mode === 'LIVE';
  const height = BAR_HEIGHT[mode];
  const splittable = !frozen && canSplit(stints, raceLaps, lock);
  const left = stopsRemaining(stints, lock);
  const upcoming = nextStop(stints, lock);
  const stops = Math.max(0, stints.length - 1);

  return (
    <div className={`${COLUMNS[mode]} border-t border-carbon-700 py-1.5 ${active ? 'bg-carbon-850 shadow-[inset_2px_0_0_var(--color-team)]' : ''}`}>
      <div className="row-span-3 flex flex-col gap-1">
        <label className="flex cursor-pointer items-center gap-1.5" title={active ? `Plan ${plan.id} is the active plan` : `Switch ${driverCode} to plan ${plan.id}`} style={{ height }}>
          <input type="radio" name={`active-plan-${carId}`} checked={active} disabled={frozen} onChange={onActivate} aria-label={`Run plan ${plan.id}`} className="peer sr-only" />
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-carbon-500 bg-carbon-800 peer-checked:border-ink-100 peer-focus-visible:outline peer-focus-visible:outline-1 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-ink-100 peer-checked:[&>span]:opacity-100">
            <span className="h-1.5 w-1.5 rounded-full bg-ink-100 opacity-0" />
          </span>
          <span className={`font-display text-base font-bold leading-none ${active ? 'text-ink-50' : 'text-ink-300'}`}>{plan.id}</span>
          <span aria-hidden className="h-[2px] w-3 rounded-full" style={{ backgroundColor: SERIES_COLOR[plan.id] }} />
        </label>
        <span className={`truncate font-display text-[10px] font-semibold uppercase leading-3 tracking-[0.1em] ${active ? 'text-ink-100' : 'text-ink-500'}`} title={plan.label}>
          {active ? 'Active' : plan.label}
        </span>
      </div>

      <StintBar
        planId={plan.id}
        stints={stints}
        raceLaps={raceLaps}
        lock={lock}
        sets={sets}
        width={barWidth}
        height={height}
        popoverAbove={popoverAbove}
        frozen={frozen}
        onDraft={onDraft}
        onCommit={onCommit}
      />

      <button
        type="button"
        disabled={!splittable}
        aria-label={`Add a stop to plan ${plan.id}`}
        title={splittable ? 'Add a stop: split the longest stint in two' : 'No stop can be added (four stints at most, two laps per stint)'}
        onClick={() => {
          const next = splitLongestStint(stints, raceLaps, lock, sets);
          if (next) onCommit(next);
        }}
        className="pw-btn relative z-10 p-0"
        style={{ height }}
      >
        <Plus size={12} strokeWidth={2} aria-hidden />
      </button>

      <div className="row-span-2 flex flex-col justify-between gap-1">
        <div className="flex items-center justify-between gap-1" style={{ height }}>
          <span className="pw-value text-xs text-ink-50" title={live ? 'Nominal clean-air time of the whole plan' : 'Predicted race time in clean air'}>
            {formatRaceTime(evaluation.totalTime)}
          </span>
          {Math.abs(delta) < 0.05 ? (
            <span className="font-display text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-100">Fastest</span>
          ) : (
            <span className="font-mono text-2xs tabular text-ink-300">{formatDelta(delta, 1)} s</span>
          )}
        </div>
        <div className="flex items-center justify-between gap-1">
          {live ? (
            <span className="flex items-center gap-1 whitespace-nowrap" title="Stops still to make on this plan">
              <span className="pw-label text-ink-300">{left} left</span>
              {upcoming ? (
                <>
                  <span className="font-mono text-[10px] tabular text-ink-100">L{upcoming.lap}</span>
                  <TyreBadge compound={upcoming.compound} size={13} />
                </>
              ) : null}
            </span>
          ) : (
            <span className="pw-label text-ink-300">
              {stops} stop{stops === 1 ? '' : 's'}
            </span>
          )}
          <StatusTag tone={valid ? 'ok' : 'crit'}>{valid ? 'Valid' : 'Invalid'}</StatusTag>
        </div>
      </div>

      <div className="col-start-2">
        <StintNotes stints={stints} raceLaps={raceLaps} width={barWidth} evaluation={evaluation} lock={lock} />
      </div>

      <ul className="relative z-10 col-span-3 col-start-2 flex min-h-3.5 flex-wrap items-center gap-x-3">
        {issues.map((issue) => (
          <li key={issue} className="flex items-center gap-1 whitespace-nowrap text-2xs leading-[14px] text-ink-100">
            <TriangleAlert size={10} strokeWidth={1.75} aria-hidden className="shrink-0 text-warn" />
            {issue}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ────────────────────────────────────────────────────────────── car planner ──

interface CarPlannerProps {
  session: SessionInfo;
  telemetry: PlayerCarTelemetry;
  car: CarSnapshot | undefined;
  seq: number;
  phase: RacePhase;
  mode: Mode;
  actions: PitWallActions;
  className?: string;
}

function CarPlanner({ session, telemetry, car, seq, phase, mode, actions, className = '' }: CarPlannerProps) {
  const live = mode === 'LIVE';
  const { track, raceLaps } = session;
  const startFuelKg = session.startFuelKg > 0 ? session.startFuelKg : startingFuelKg(track, raceLaps);
  const carId = telemetry.carId;
  const driver = indexSession(session).driver(carId);
  const color = indexSession(session).color(carId);

  // Snapshots are fresh objects every 100 ms: key the plans by content so nothing downstream recomputes.
  const plansKey = JSON.stringify(telemetry.strategy.plans);
  const truth = useMemo(() => JSON.parse(plansKey) as Record<PlanId, StrategyPlan>, [plansKey]);

  const [stintsA, commitA] = useEchoed<readonly StintPlan[]>(truth.A.stints, seq, sameStints);
  const [stintsB, commitB] = useEchoed<readonly StintPlan[]>(truth.B.stints, seq, sameStints);
  const [stintsC, commitC] = useEchoed<readonly StintPlan[]>(truth.C.stints, seq, sameStints);
  const [drag, setDrag] = useState<{ planId: PlanId; stints: StintPlan[] } | null>(null);
  const lastOrder = useRef<{ activePlan?: Stamped<PlanId>; autoBox?: Stamped<boolean> }>({});
  const [barRef, barSize] = useElementSize<HTMLDivElement>();

  const committed: Record<PlanId, readonly StintPlan[]> = { A: stintsA, B: stintsB, C: stintsC };
  const shown: Record<PlanId, readonly StintPlan[]> = {
    A: drag?.planId === 'A' ? drag.stints : stintsA,
    B: drag?.planId === 'B' ? drag.stints : stintsB,
    C: drag?.planId === 'C' ? drag.stints : stintsC,
  };
  const keyA = stintsKey(shown.A);
  const keyB = stintsKey(shown.B);
  const keyC = stintsKey(shown.C);
  // The keys stand for the stints: each plan is re-evaluated only when its own content changes.
  const evalA = useMemo(() => evaluateStrategy(track, raceLaps, shown.A, { startFuelKg }), [track, raceLaps, startFuelKg, keyA]);
  const evalB = useMemo(() => evaluateStrategy(track, raceLaps, shown.B, { startFuelKg }), [track, raceLaps, startFuelKg, keyB]);
  const evalC = useMemo(() => evaluateStrategy(track, raceLaps, shown.C, { startFuelKg }), [track, raceLaps, startFuelKg, keyC]);
  const evaluations: Record<PlanId, StrategyEvaluation> = { A: evalA, B: evalB, C: evalC };
  const series = useMemo<PaceSeries[]>(
    () => [
      { id: 'A', color: SERIES_COLOR.A, evaluation: evalA },
      { id: 'B', color: SERIES_COLOR.B, evaluation: evalB },
      { id: 'C', color: SERIES_COLOR.C, evaluation: evalC },
    ],
    [evalA, evalB, evalC],
  );

  // Before lights out nothing has been run yet, even when the compact (live) editor is on screen.
  const racing = live && phase !== 'GRID' && car !== undefined;
  const nowLap = car ? Math.min(raceLaps, Math.max(1, car.lapsCompleted + 1)) : 1;
  const lock: PlanLock = racing ? { live: true, currentStint: car.pitStops, nowLap } : NO_LOCK;
  const frozen = live && (car === undefined || car.status === 'RETIRED' || car.status === 'FINISHED' || phase === 'FINISHED');
  const lapsDone = racing ? nowLap - 1 : 0;

  const rows = PLAN_IDS.map((id) => {
    const evaluation = evaluations[id];
    const allocation = allocationIssues(telemetry.tyreSets, shown[id], lock);
    return { id, evaluation, issues: [...evaluation.issues, ...allocation], valid: evaluation.valid && allocation.length === 0 };
  });
  const validTimes = rows.filter((row) => row.valid).map((row) => row.evaluation.totalTime);
  const reference = Math.min(...(validTimes.length > 0 ? validTimes : rows.map((row) => row.evaluation.totalTime)));

  const commitPlan = (planId: PlanId, stints: StintPlan[]) => {
    setDrag(null);
    ({ A: commitA, B: commitB, C: commitC })[planId](stints);
    const plans = { ...truth };
    for (const id of PLAN_IDS) {
      plans[id] = { ...truth[id], stints: (id === planId ? stints : committed[id]).map((stint) => ({ ...stint })) };
    }
    actions.setStrategy(carId, {
      activePlan: freshValue(lastOrder.current.activePlan) ?? telemetry.strategy.activePlan,
      autoBox: freshValue(lastOrder.current.autoBox) ?? telemetry.strategy.autoBox,
      plans,
    });
  };
  const activate = (planId: PlanId) => {
    lastOrder.current.activePlan = { value: planId, at: performance.now() };
    actions.setActivePlan(carId, planId);
  };
  const setAutoBox = (enabled: boolean) => {
    lastOrder.current.autoBox = { value: enabled, at: performance.now() };
    actions.setAutoBox(carId, enabled);
  };

  const lapStep = raceLaps > 70 ? 20 : 10;
  const guides: number[] = [];
  for (let lap = lapStep; lap < raceLaps; lap += lapStep) guides.push(lap);
  const labelled = guides.filter((lap) => raceLaps - lap >= lapStep * 0.4);

  return (
    <section
      aria-label={`Strategy of car ${telemetry.carNumber} ${driver.code}`}
      className={`min-h-0 min-w-0 ${live ? 'grid h-full grid-cols-[minmax(0,1fr)_320px]' : 'flex flex-col overflow-y-auto'} ${className}`}
    >
      <div className={`flex min-w-0 flex-col ${live ? 'min-h-0 overflow-y-auto' : 'shrink-0'}`}>
        <div className="flex items-center gap-2 px-2 pb-1 pt-1.5">
          <DriverTag code={driver.code} color={color} carNumber={telemetry.carNumber} strong />
          {live && car ? (
            <span className="flex items-center gap-2 whitespace-nowrap font-mono text-2xs tabular text-ink-300">
              <span className="font-bold text-ink-50">{formatPosition(car.position)}</span>
              <span>
                lap {nowLap}/{raceLaps}
              </span>
              <span className="flex items-center gap-1">
                stint {car.pitStops + 1}
                <TyreBadge compound={car.tyre.compound} size={14} />
                {car.tyre.ageLaps} L
              </span>
            </span>
          ) : (
            <span className="truncate text-2xs text-ink-300">
              {driver.firstName} {driver.lastName}
              {car ? <span className="ml-2 font-mono tabular text-ink-500">grid {formatPosition(car.gridPosition)}</span> : null}
            </span>
          )}
          <ToggleButton
            pressed={telemetry.strategy.autoBox}
            onToggle={setAutoBox}
            label="Auto-box"
            disabled={frozen}
            title="When on, the race engineer calls the planned stops himself"
            className="ml-auto shrink-0 px-1.5 py-1"
          />
        </div>
        <div className="pb-1.5">
          <AllocationStrip sets={telemetry.tyreSets} />
        </div>

        <div className="relative isolate border-t border-carbon-700">
          {/* lap guides, the completed part of the race and the NOW marker, aligned on the bar column */}
          <div aria-hidden className={`pointer-events-none absolute inset-0 ${COLUMNS[mode]}`}>
            <div ref={barRef} className="relative col-start-2">
              {guides.map((lap) => (
                <span key={lap} className="absolute bottom-0 top-[18px] z-0 w-px bg-chart-grid" style={{ left: `${(lap / raceLaps) * 100}%` }} />
              ))}
              {racing ? (
                <span className="absolute bottom-0 top-0.5 z-0 w-px bg-ink-500" style={{ left: `${(lapsDone / raceLaps) * 100}%` }}>
                  <span
                    className={`absolute top-0 whitespace-nowrap bg-ink-50 px-1 font-display text-3xs font-bold uppercase leading-[13px] tracking-[0.1em] text-carbon-950 ${
                      lapsDone / raceLaps > 0.8 ? 'right-0' : 'left-0'
                    }`}
                  >
                    Now L{nowLap}
                  </span>
                </span>
              ) : null}
            </div>
          </div>

          <div className={`${COLUMNS[mode]} h-[18px] items-end`}>
            <span className="pw-label">Plan</span>
            <div className="relative h-3">
              <span className="absolute left-0 top-0 font-mono text-3xs leading-3 tabular text-ink-500">L1</span>
              {labelled.map((lap) => (
                <span key={lap} className="absolute top-0 -translate-x-1/2 font-mono text-3xs leading-3 tabular text-ink-500" style={{ left: `${(lap / raceLaps) * 100}%` }}>
                  {lap}
                </span>
              ))}
              <span className="absolute right-0 top-0 font-mono text-3xs leading-3 tabular text-ink-500">{raceLaps}</span>
            </div>
            <span />
            <span className="pw-label text-right">{live ? 'Nominal time · Δ' : 'Race time · Δ'}</span>
          </div>

          {rows.map((row, i) => (
            <PlanRow
              key={row.id}
              carId={carId}
              driverCode={driver.code}
              plan={truth[row.id]}
              stints={shown[row.id]}
              evaluation={row.evaluation}
              issues={row.issues}
              valid={row.valid}
              delta={row.evaluation.totalTime - reference}
              active={telemetry.strategy.activePlan === row.id}
              lock={lock}
              sets={telemetry.tyreSets}
              raceLaps={raceLaps}
              barWidth={barSize.width}
              mode={mode}
              frozen={frozen}
              popoverAbove={i === rows.length - 1}
              onActivate={() => activate(row.id)}
              onDraft={(stints) => setDrag(stints ? { planId: row.id, stints } : null)}
              onCommit={(stints) => commitPlan(row.id, stints)}
            />
          ))}
        </div>

        <p className="flex items-center gap-1.5 border-t border-carbon-700 px-2 py-1 text-[10px] leading-3 text-ink-500">
          {live ? (
            <>
              <Lock size={10} strokeWidth={1.75} aria-hidden className="shrink-0" />
              Nominal plan time: clean air, from lights out — not a live prediction. Completed stints are locked.
            </>
          ) : (
            'Clean-air prediction · Δ to the fastest valid plan · drag a stop or use ←/→ on it · click a stint for its compound'
          )}
        </p>
      </div>

      <PaceChart
        series={series}
        raceLaps={raceLaps}
        baseLapTime={track.baseLapTime}
        nowLap={racing ? nowLap : null}
        className={live ? 'border-l border-carbon-700' : 'min-h-[128px] flex-1 border-t border-carbon-700'}
      />
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────── root ──

/**
 * Plan A / B / C stint editor for both cars. PRE_RACE is the briefing editor on the grid (two cars side
 * by side); LIVE is the compact in-race tab where what has been run is locked. Every edit is sent as a
 * whole `CarStrategy`; the snapshot's echo is the truth.
 */
export function StrategyPlanner({ session, snapshot, mode, actions, className = '' }: StrategyPlannerProps) {
  const [focus, setFocus] = useState<'0' | '1'>('0');
  const cars = snapshot.player.cars;
  const index = indexSession(session);
  const carOf = (telemetry: PlayerCarTelemetry) => snapshot.cars.find((car) => car.id === telemetry.carId);

  if (mode === 'PRE_RACE') {
    return (
      <Panel
        title="Strategy planner"
        icon={<Route size={14} strokeWidth={1.75} aria-hidden />}
        subtitle={`pre-race briefing · ${session.track.grandPrix} · ${session.raceLaps} laps`}
        className={`h-full ${className}`}
        bodyClassName="flex flex-col"
      >
        <CircuitProfile track={session.track} raceLaps={session.raceLaps} />
        <div className="grid min-h-0 flex-1 grid-cols-2">
          {cars.map((telemetry, i) => (
            <CarPlanner
              key={telemetry.carId}
              session={session}
              telemetry={telemetry}
              car={carOf(telemetry)}
              seq={snapshot.seq}
              phase={snapshot.phase}
              mode={mode}
              actions={actions}
              className={i > 0 ? 'border-l border-carbon-700' : ''}
            />
          ))}
        </div>
      </Panel>
    );
  }

  const options: SegmentedOption<'0' | '1'>[] = [
    { value: '0', label: `#1 ${index.driver(cars[0].carId).code}`, title: 'Plan car #1' },
    { value: '1', label: `#2 ${index.driver(cars[1].carId).code}`, title: 'Plan car #2' },
  ];
  const telemetry = focus === '0' ? cars[0] : cars[1];

  return (
    <Panel
      title="Strategy planner"
      icon={<Route size={14} strokeWidth={1.75} aria-hidden />}
      subtitle={`live · lap ${snapshot.lap}/${snapshot.raceLaps}`}
      actions={<Segmented options={options} value={focus} onChange={setFocus} ariaLabel="Car to plan" fill={false} className="[&>button]:px-2 [&>button]:py-1" />}
      className={`h-full ${className}`}
    >
      <CarPlanner
        key={telemetry.carId}
        session={session}
        telemetry={telemetry}
        car={carOf(telemetry)}
        seq={snapshot.seq}
        phase={snapshot.phase}
        mode={mode}
        actions={actions}
      />
    </Panel>
  );
}
