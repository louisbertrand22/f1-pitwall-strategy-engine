import { useEffect, useId, useMemo, useState } from 'react';
import { ArrowRight, ChartLine, Check, RefreshCw, TriangleAlert } from 'lucide-react';
import type { StrategyGraphProps } from './contracts';
import { Panel, Segmented, TyreBadge } from './ui';
import { formatDelta, formatLapTime, formatPercent } from '../lib/format';
import { indexSession } from '../lib/session';
import type { SessionIndex } from '../lib/session';
import { TYRE_LABELS, TYRE_ORDER } from '../lib/tyres';
import { pitLossUnderFlag } from '../simulation/physicsModel';
import type { CandidateProjection, CarId, StintPlan, TyreCompound, UndercutOutcome } from '../simulation/types';
import {
  ChartHeader,
  ChartTooltip,
  Crosshair,
  CursorOverlay,
  EmptyState,
  FlagBands,
  HGrid,
  INK,
  LapAxis,
  LegendItem,
  LineKey,
  Marker,
  SERIES,
  SLOT_SHAPES,
  SeriesTable,
  TEXT_HALO,
  TooltipGrid,
  TooltipRow,
  TooltipTitle,
  VRule,
  ValueAxis,
  ViewToggle,
  useElementSize,
} from './charts/chartKit';
import type { CursorInfo, MarkerShapeName, PlotRect } from './charts/chartKit';
import { spreadLabels } from './charts/layout';
import { linePath } from './charts/path';
import { countLapRecords, flagSpans, isNeutralFlag, lastRecord, raceLapFlags } from './charts/raceData';
import { extent, lapTicks, linearScale, niceTicks } from './charts/scale';
import {
  CANDIDATE_OFFSETS,
  buildAdoptedStrategy,
  candidateSlots,
  candidateStopSequence,
  isCandidateAdopted,
} from './charts/strategyData';

type TraceMode = 'GAP' | 'TRACE';
type Zoom = 'FULL' | 'NOW';
type CompoundChoice = 'AUTO' | TyreCompound;
type LineKind = 'FOCUS' | 'RIVAL' | 'CANDIDATE' | 'RIVAL_PROJECTION';

interface Pt {
  lap: number;
  v: number;
  position: number;
  pit: boolean;
}

interface Line {
  id: string;
  kind: LineKind;
  label: string;
  color: string;
  carId: CarId | null;
  shape: MarkerShapeName | null;
  points: Pt[];
  byLap: Map<number, Pt>;
  /** First projected lap (0 for an actual trace); points before it only anchor the line on the actual trace. */
  fromLap: number;
}

const MARGIN = { left: 40, right: 48, top: 4, bottom: 18 };
/** Laps of history kept in view by the "NOW −8" window. */
const ZOOM_BACK = 8;
/** A projection older than this many laps is dimmed. */
const STALE_AFTER = 2;

function makeLine(partial: Omit<Line, 'byLap'>): Line {
  const byLap = new Map<number, Pt>();
  for (const p of partial.points) byLap.set(p.lap, p);
  return { ...partial, byLap };
}

function signed(value: number): string {
  if (Math.abs(value) < 0.05) return '0';
  return `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(Math.abs(value) < 10 && value % 1 !== 0 ? 1 : 0)}`;
}

export function StrategyGraph(props: StrategyGraphProps) {
  const { session, snapshot, history, projections, focusCarId, onFocusCar, actions, className = '' } = props;
  const index = indexSession(session);
  const clipId = useId();
  const raceLaps = session.raceLaps;

  const [mode, setMode] = useState<TraceMode>('GAP');
  const [zoom, setZoom] = useState<Zoom>('FULL');
  const [table, setTable] = useState(false);
  const [choiceByCar, setChoiceByCar] = useState<Record<CarId, CompoundChoice>>({});
  const [emphasis, setEmphasis] = useState<string | null>(null);
  const [cursor, setCursor] = useState<CursorInfo | null>(null);
  const [pending, setPending] = useState<{ carId: CarId; previous: unknown } | null>(null);
  const [plotRef, size] = useElementSize<HTMLDivElement>();

  const focusCar = snapshot.cars.find((c) => c.id === focusCarId);
  const telemetry = snapshot.player.cars.find((t) => t.carId === focusCarId);
  const projection = projections[focusCarId];
  const choice: CompoundChoice = choiceByCar[focusCarId] ?? 'AUTO';
  const lapsCompleted = focusCar ? focusCar.lapsCompleted : Math.max(0, snapshot.lap - 1);
  const currentLap = Math.min(raceLaps, lapsCompleted + 1);
  const nowX = Math.min(raceLaps, lapsCompleted + (focusCar ? focusCar.lapFraction : 0));
  const running = focusCar !== undefined && focusCar.status !== 'RETIRED' && focusCar.status !== 'FINISHED' && snapshot.phase !== 'FINISHED';
  const isPending = pending !== null && pending.carId === focusCarId && pending.previous === projection;

  useEffect(() => {
    if (!pending) return undefined;
    const timer = window.setTimeout(() => setPending(null), 4000);
    return () => window.clearTimeout(timer);
  }, [pending]);

  const request = (next: CompoundChoice): void => {
    setPending({ carId: focusCarId, previous: projection });
    actions.requestProjection(focusCarId, next === 'AUTO' ? null : next, [...CANDIDATE_OFFSETS]);
  };

  // Rivals shown as context: the leader and the cars directly ahead / behind, plus whatever the
  // projection traced.
  const runningCars = snapshot.cars.filter((c) => c.status !== 'RETIRED');
  const focusAt = runningCars.findIndex((c) => c.id === focusCarId);
  const rivalIds: CarId[] = [];
  const addRival = (id: CarId | undefined): void => {
    if (id !== undefined && id !== focusCarId && !rivalIds.includes(id) && rivalIds.length < 5) rivalIds.push(id);
  };
  if (focusAt >= 0) {
    addRival(runningCars[focusAt - 1]?.id);
    addRival(runningCars[focusAt + 1]?.id);
  }
  addRival(runningCars[0]?.id);
  for (const trace of projection?.rivalTraces ?? []) addRival(trace.carId);
  const rivalKey = rivalIds.join(',');

  const lapCount = countLapRecords(history.laps);
  const flags = useMemo(() => raceLapFlags(history.laps), [history.laps, lapCount]);
  const spans = useMemo(() => flagSpans(flags), [flags]);

  const model = useMemo(() => {
    const records = history.laps[focusCarId] ?? [];
    const last = lastRecord(records);
    // Race trace: cumulative time against a constant reference pace (the focus car's average lap).
    const referenceLap = last ? last.raceTime / last.lap : session.track.baseLapTime;
    const value = (lap: number, gap: number, raceTime: number): number => (mode === 'GAP' ? gap : referenceLap * lap - raceTime);
    const actual = (carId: CarId): Pt[] =>
      (history.laps[carId] ?? []).map((r) => ({ lap: r.lap, v: value(r.lap, r.gapToLeader, r.raceTime), position: r.position, pit: r.pitIn }));

    const lines: Line[] = [];
    const focusLine = makeLine({ id: 'focus', kind: 'FOCUS', label: index.driver(focusCarId).code, color: INK.primary, carId: focusCarId, shape: null, points: actual(focusCarId), fromLap: 0 });
    const ids = rivalKey === '' ? [] : rivalKey.split(',');
    for (const id of ids) {
      lines.push(makeLine({ id: `rival-${id}`, kind: 'RIVAL', label: index.driver(id).code, color: INK.muted, carId: id, shape: null, points: actual(id), fromLap: 0 }));
    }
    for (const trace of projection?.rivalTraces ?? []) {
      if (!ids.includes(trace.carId) || trace.trace.length === 0) continue;
      const first = trace.trace[0]!.lap;
      const anchor = lines.find((l) => l.kind === 'RIVAL' && l.carId === trace.carId)?.byLap.get(first - 1);
      const points = trace.trace.map((p) => ({ lap: p.lap, v: value(p.lap, p.gapToLeader, p.raceTime), position: p.position, pit: p.pit }));
      lines.push(makeLine({ id: `rproj-${trace.carId}`, kind: 'RIVAL_PROJECTION', label: index.driver(trace.carId).code, color: INK.muted, carId: trace.carId, shape: null, points: anchor ? [anchor, ...points] : points, fromLap: first }));
    }
    lines.push(focusLine);
    const candidates = projection?.candidates ?? [];
    const slots = candidateSlots(candidates.map((c) => c.candidate.id));
    for (const c of candidates) {
      if (c.trace.length === 0) continue;
      const slot = slots.get(c.candidate.id) ?? 0;
      const first = c.trace[0]!.lap;
      const anchor = focusLine.byLap.get(first - 1);
      const points = c.trace.map((p) => ({ lap: p.lap, v: value(p.lap, p.gapToLeader, p.raceTime), position: p.position, pit: p.pit }));
      lines.push(makeLine({ id: c.candidate.id, kind: 'CANDIDATE', label: c.candidate.label, color: SERIES[slot] ?? INK.secondary, carId: focusCarId, shape: SLOT_SHAPES[slot] ?? 'circle', points: anchor ? [anchor, ...points] : points, fromLap: first }));
    }
    return { lines, slots, referenceLap };
    // History arrays are append-only: their record count is the change signal.
  }, [history.laps, lapCount, focusCarId, rivalKey, projection, mode, session, index]);

  const candidates = projection?.candidates ?? [];
  const activeEmphasis = emphasis !== null && candidates.some((c) => c.candidate.id === emphasis) ? emphasis : null;
  const projectionAge = projection ? Math.max(0, currentLap - projection.fromLap) : 0;
  const stale = projection !== undefined && projectionAge > STALE_AFTER;

  // ── scales ──
  const xMin = zoom === 'FULL' ? 0 : Math.max(0, Math.min(raceLaps - 4, Math.floor(nowX) - ZOOM_BACK));
  const xMax = raceLaps;
  const plot: PlotRect = {
    left: MARGIN.left,
    top: MARGIN.top,
    width: Math.max(10, size.width - MARGIN.left - MARGIN.right),
    height: Math.max(10, size.height - MARGIN.top - MARGIN.bottom),
  };
  const ready = size.width > 120 && size.height > 60;

  const geometry = useMemo(() => {
    const x = linearScale([xMin, xMax], [plot.left, plot.left + plot.width]);
    const visible: number[] = [];
    let maxDataLap = 0;
    for (const line of model.lines) {
      for (const p of line.points) {
        if (p.lap > maxDataLap) maxDataLap = p.lap;
        if (p.lap >= xMin && p.lap <= xMax) visible.push(p.v);
      }
    }
    let [lo, hi] = extent(visible) ?? [0, 30];
    const pad = Math.max(1, (hi - lo) * 0.07);
    lo -= pad;
    hi += pad;
    // The leader's line (gap 0) is only worth the room when the focus car is close to it; it then gets
    // a little headroom so that it does not run under the flag strip along the top edge.
    if (mode === 'GAP') lo = lo < (hi - lo) * 0.3 ? -(hi - lo) * 0.05 : Math.max(0, lo);
    const y = mode === 'GAP' ? linearScale([lo, hi], [plot.top, plot.top + plot.height]) : linearScale([lo, hi], [plot.top + plot.height, plot.top]);
    const paths = model.lines.map((line) => ({ line, d: linePath(line.points.map((p) => [x(p.lap), y(p.v)] as const)) }));
    const snapLaps: number[] = [];
    for (let lap = Math.max(1, Math.ceil(xMin)); lap <= Math.min(xMax, maxDataLap); lap++) snapLaps.push(lap);
    return {
      x,
      y,
      paths,
      snapLaps,
      yTicks: niceTicks(lo, hi, Math.max(2, Math.floor(plot.height / 36))),
      xTicks: lapTicks(xMin, xMax, plot.width),
    };
  }, [model, mode, xMin, xMax, plot.left, plot.top, plot.width, plot.height]);
  const { x, y } = geometry;

  // ── direct end labels (de-collided, with leader lines when displaced) ──
  const hasProjectionOf = (carId: CarId | null): boolean => model.lines.some((l) => l.kind === 'RIVAL_PROJECTION' && l.carId === carId);
  const labelled = model.lines.filter((line) => {
    if (line.points.length === 0) return false;
    if (line.kind === 'FOCUS') return candidates.length === 0;
    if (line.kind === 'RIVAL') return !hasProjectionOf(line.carId);
    return true;
  });
  const endOf = (line: Line): Pt => line.points[line.points.length - 1]!;
  const groups = new Map<number, Line[]>();
  for (const line of labelled) {
    const key = Math.round(x(endOf(line).lap) / 12);
    const group = groups.get(key);
    if (group) group.push(line);
    else groups.set(key, [line]);
  }
  const endLabels: { line: Line; ax: number; ay: number; ly: number }[] = [];
  for (const group of groups.values()) {
    const anchors = group.map((line) => y(endOf(line).v));
    const ys = spreadLabels(anchors, 11, plot.top + 5, plot.top + plot.height - 4);
    group.forEach((line, i) => endLabels.push({ line, ax: x(endOf(line).lap), ay: anchors[i]!, ly: ys[i]! }));
  }

  // ── cursor readout ──
  const cursorLap = cursor && geometry.snapLaps.includes(cursor.value) ? cursor.value : null;
  const readout = (lap: number): { line: Line; point: Pt }[] => {
    const rows: { line: Line; point: Pt }[] = [];
    const order: LineKind[] = ['FOCUS', 'CANDIDATE', 'RIVAL', 'RIVAL_PROJECTION'];
    for (const kind of order) {
      for (const line of model.lines) {
        if (line.kind !== kind) continue;
        const point = line.byLap.get(lap);
        if (!point || lap < line.fromLap) {
          continue;
        }
        // An actual lap supersedes the (now stale) projection of the same car and lap.
        if (kind === 'RIVAL_PROJECTION' && model.lines.some((l) => l.kind === 'RIVAL' && l.carId === line.carId && l.byLap.has(lap))) continue;
        rows.push({ line, point });
      }
    }
    return rows;
  };
  const unit = mode === 'GAP' ? 'gap' : 'trace';
  const fmt = (v: number): string => (mode === 'GAP' && Math.abs(v) < 0.0005 ? 'LEADER' : `${formatDelta(v, 1)} s`);
  const cursorRows = cursorLap === null ? [] : readout(cursorLap);
  const cursorFlag = cursorLap !== null ? flags[cursorLap] : undefined;
  const valueText =
    cursorLap === null
      ? 'No lap selected'
      : `Lap ${cursorLap}: ${cursorRows.map((r) => `${r.line.label}${r.line.kind === 'FOCUS' ? ' actual' : ''} ${unit} ${fmt(r.point.v)} P${r.point.position}`).join('; ')}`;

  // ── decision table ──
  // Narrow slots drop the least decisive columns before anything gets clipped.
  const showRejoin = size.width === 0 || size.width >= 880;
  const showDelta = size.width === 0 || size.width >= 790;
  const bestTime = candidates.length > 0 ? Math.min(...candidates.map((c) => c.expectedRaceTime)) : 0;
  const rangeLo = Math.max(1, Math.min(...candidates.map((c) => Math.min(c.finishP10, c.expectedFinish)), 20) - 1);
  const rangeHi = Math.max(rangeLo + 2, Math.max(...candidates.map((c) => Math.max(c.finishP90, c.expectedFinish)), 1) + 1);

  const adopt = (candidate: CandidateProjection): void => {
    if (!telemetry || !focusCar) return;
    const own = history.pitStops.filter((s) => s.carId === focusCarId).sort((a, b) => a.lap - b.lap);
    // Red-flag tyre changes are logged as stops; only trust the history when it matches the stop count.
    const usable = own.length === focusCar.pitStops ? own : own.filter((s) => s.flag !== 'RED');
    const completedStints: StintPlan[] = usable.length === focusCar.pitStops ? usable.map((s) => ({ compound: s.fromCompound, endLap: s.lap })) : [];
    actions.setStrategy(
      focusCarId,
      buildAdoptedStrategy({
        strategy: telemetry.strategy,
        stintIndex: focusCar.pitStops,
        currentCompound: focusCar.tyre.compound,
        completedStints,
        candidate,
        raceLaps,
      }),
    );
  };

  const spare = new Set<TyreCompound>((telemetry?.tyreSets ?? []).filter((s) => !s.fitted).map((s) => s.compound));
  const flagNow = snapshot.raceControl.flag;
  const focusCode = index.driver(focusCarId).code;
  const dim = (line: Line): number => {
    if (line.kind === 'CANDIDATE') return (stale ? 0.4 : 1) * (activeEmphasis !== null && line.id !== activeEmphasis ? 0.25 : 1);
    if (line.kind === 'RIVAL_PROJECTION') return stale ? 0.4 : 0.9;
    return 1;
  };

  const subtitle = focusCar ? `${focusCode} · P${focusCar.position} · LAP ${currentLap}/${raceLaps}` : focusCode;
  const projectionNote = projection
    ? `PROJECTION FROM L${projection.fromLap} · ${projection.monteCarloRuns} MC RUNS${projectionAge > 0 ? ` · ${projectionAge} LAP${projectionAge > 1 ? 'S' : ''} OLD` : ''}`
    : 'NO PROJECTION';

  // Table twin: the focus car first, then the candidates, then the rivals (actual, else projected).
  const tableLines = useMemo(() => {
    const rank: Record<LineKind, number> = { FOCUS: 0, CANDIDATE: 1, RIVAL: 2, RIVAL_PROJECTION: 3 };
    return model.lines.filter((l) => l.kind !== 'RIVAL_PROJECTION').sort((a, b) => rank[a.kind] - rank[b.kind]);
  }, [model]);
  const tableRows = useMemo(() => {
    if (!table) return [];
    const rows = [];
    for (let lap = Math.max(1, Math.ceil(xMin)); lap <= xMax; lap++) {
      const cells = tableLines
        .map((line) => {
          const own = line.byLap.get(lap);
          const projected = line.kind === 'RIVAL' ? model.lines.find((l) => l.kind === 'RIVAL_PROJECTION' && l.carId === line.carId)?.byLap.get(lap) : undefined;
          const point = own && (line.kind !== 'CANDIDATE' || lap >= line.fromLap) ? own : projected;
          return point ? `${formatDelta(point.v, 1)} · P${point.position}${point.pit ? ' · PIT' : ''}` : '—';
        });
      if (cells.every((c) => c === '—')) continue;
      rows.push({ key: String(lap), cells: [`L${lap}`, ...cells], marked: lap === currentLap, dimmed: lap > lapsCompleted });
    }
    return rows;
  }, [table, model, tableLines, xMin, xMax, currentLap, lapsCompleted]);

  return (
    <Panel
      title="Undercut / Overcut"
      icon={<ChartLine size={14} strokeWidth={1.75} />}
      subtitle={subtitle}
      actions={<ViewToggle table={table} onToggle={setTable} />}
      className={`h-full ${className}`}
      bodyClassName="flex flex-col"
    >
      {/* One control row above everything it scopes. */}
      <div className="flex h-7 shrink-0 items-center gap-2 overflow-hidden border-b border-carbon-700 px-2 [&_button]:px-1.5 [&_button]:py-1">
        <Segmented
          ariaLabel="Focus car"
          fill={false}
          value={focusCarId}
          onChange={onFocusCar}
          options={session.playerCarIds.map((id) => ({ value: id, label: index.driver(id).code, title: `Study ${index.driver(id).lastName}'s strategy` }))}
        />
        <div role="radiogroup" aria-label="Compound of the candidate stop" className="flex">
          {(['AUTO', ...TYRE_ORDER] as const).map((option, i) => {
            const unavailable = option !== 'AUTO' && telemetry !== undefined && !spare.has(option);
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={choice === option}
                data-active={choice === option}
                disabled={!running || unavailable}
                title={option === 'AUTO' ? "Engine's choice of compound" : unavailable ? `${TYRE_LABELS[option]}: no set left` : `Stop for ${TYRE_LABELS[option]}`}
                className={`pw-btn rounded-none first:rounded-l-[2px] last:rounded-r-[2px] ${i > 0 ? '-ml-px' : ''}`}
                onClick={() => {
                  setChoiceByCar((previous) => ({ ...previous, [focusCarId]: option }));
                  request(option);
                }}
              >
                {option === 'AUTO' ? 'Auto' : <TyreBadge compound={option} size={13} />}
              </button>
            );
          })}
        </div>
        <button type="button" className="pw-btn" disabled={!running || isPending} onClick={() => request(choice)} title="Run the Monte-Carlo projection for T+1 / T+3 / T+5">
          <RefreshCw size={11} strokeWidth={1.75} />
          {isPending ? 'Computing' : 'Recompute'}
        </button>
        {stale ? (
          <span className="flex items-center gap-1 whitespace-nowrap font-display text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-300">
            <TriangleAlert size={11} strokeWidth={1.75} className="text-warn" />
            Stale
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Segmented
            ariaLabel="Vertical axis"
            fill={false}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'GAP', label: 'Gap', title: 'Gap to the leader' },
              { value: 'TRACE', label: 'Trace', title: 'Race trace: time against a constant reference pace (slopes show pace)' },
            ]}
          />
          <Segmented
            ariaLabel="Lap window"
            fill={false}
            value={zoom}
            onChange={setZoom}
            options={[
              { value: 'FULL', label: 'Full race' },
              { value: 'NOW', label: `Now −${ZOOM_BACK}`, title: `From ${ZOOM_BACK} laps ago to the flag` },
            ]}
          />
        </div>
      </div>

      <ChartHeader
        title={mode === 'GAP' ? 'Gap to leader · s · up is better' : `Race trace vs ${formatLapTime(model.referenceLap)} avg lap · s`}
        note={`${projectionNote} · PIT LOSS NOW ${pitLossUnderFlag(session.track, flagNow).toFixed(1)} s${isNeutralFlag(flagNow) ? ` (${flagNow})` : ''}`}
      >
        <LegendItem swatch={<LineKey color={INK.primary} />} label={`${focusCode} actual`} />
        <LegendItem swatch={<LineKey color={INK.muted} weight={1.25} />} label="Rivals" />
        <LegendItem swatch={<LineKey color={INK.secondary} dashed />} label="Projected" />
      </ChartHeader>

      <div ref={plotRef} className="relative min-h-0 flex-1">
        {table ? (
          <SeriesTable
            caption={`${mode === 'GAP' ? 'Gap to leader' : 'Race trace'} and position per lap`}
            columns={[
              { key: 'lap', label: 'Lap', align: 'left' },
              ...tableLines
                .map((l) => ({ key: l.id, label: l.kind === 'FOCUS' ? `${l.label} actual` : l.label, swatch: <LineKey color={l.color} dashed={l.kind === 'CANDIDATE'} marker={l.shape ?? undefined} /> })),
            ]}
            rows={tableRows}
          />
        ) : !ready ? null : model.lines.every((l) => l.points.length === 0) ? (
          <EmptyState icon={<ChartLine size={18} strokeWidth={1.5} />} title="Waiting for the first lap" hint="The race trace starts when the cars complete lap 1; the projection follows." />
        ) : (
          <>
            <svg width={size.width} height={size.height} className="absolute inset-0 block" role="img" aria-label={`${mode === 'GAP' ? 'Gap to the leader' : 'Race trace'} of ${focusCode} by lap, with the projected pit-stop candidates`}>
              <defs>
                <clipPath id={clipId}>
                  <rect x={plot.left} y={plot.top - 2} width={plot.width} height={plot.height + 4} />
                </clipPath>
              </defs>
              <HGrid plot={plot} ys={geometry.yTicks.map((t) => y(t))} />
              <FlagBands plot={plot} spans={spans} x={x} />
              <LapAxis plot={plot} ticks={geometry.xTicks} x={x} />
              <ValueAxis plot={plot} ticks={geometry.yTicks} y={y} format={signed} />
              <g clipPath={`url(#${clipId})`} fill="none" strokeLinejoin="round" strokeLinecap="round">
                {geometry.paths.map(({ line, d }) => (
                  <path
                    key={line.id}
                    d={d}
                    stroke={line.color}
                    strokeWidth={line.kind === 'FOCUS' || line.kind === 'CANDIDATE' ? 2 : 1.25}
                    strokeDasharray={line.kind === 'CANDIDATE' ? '6 4' : line.kind === 'RIVAL_PROJECTION' ? '3 3' : undefined}
                    opacity={dim(line)}
                  />
                ))}
                {model.lines
                  .filter((l) => l.kind === 'FOCUS')
                  .flatMap((l) => l.points.filter((p) => p.pit))
                  .map((p) => (
                    <Marker key={`pit-${p.lap}`} shape="circle" x={x(p.lap)} y={y(p.v)} r={3.5} color={INK.primary} />
                  ))}
                {model.lines
                  .filter((l) => l.kind === 'CANDIDATE')
                  .map((l) => {
                    const pit = l.points.find((p) => p.pit && p.lap >= l.fromLap);
                    return pit ? (
                      <g key={`cpit-${l.id}`} opacity={dim(l)}>
                        <Marker shape={l.shape ?? 'circle'} x={x(pit.lap)} y={y(pit.v)} color={l.color} />
                      </g>
                    ) : null;
                  })}
              </g>
              <VRule plot={plot} x={x(nowX)} label="NOW" labelAtBottom />
              {candidates.length === 0 && running && x(raceLaps) - x(nowX) > 230 ? (
                <text x={(x(nowX) + x(raceLaps)) / 2} y={plot.top + plot.height / 2} textAnchor="middle" className="fill-ink-500 font-display text-[11px] font-semibold uppercase tracking-[0.14em]">
                  <tspan x={(x(nowX) + x(raceLaps)) / 2}>No projection yet</tspan>
                  <tspan x={(x(nowX) + x(raceLaps)) / 2} dy="1.4em" className="fill-ink-600">
                    Recompute to simulate T+1 · T+3 · T+5
                  </tspan>
                </text>
              ) : null}
              {endLabels.map(({ line, ax, ay, ly }) => (
                <g key={`end-${line.id}`} opacity={line.kind === 'CANDIDATE' ? Math.max(0.45, dim(line)) : 1}>
                  {Math.abs(ly - ay) > 3 ? <path d={`M${ax + 1} ${ay}L${ax + 6} ${ly}`} stroke={INK.faint} fill="none" /> : null}
                  {line.kind === 'CANDIDATE' ? (
                    <Marker shape={line.shape ?? 'circle'} x={ax + 11} y={ly} r={3.2} color={line.color} ring={false} />
                  ) : (
                    <rect x={ax + 8} y={ly - 4} width={3} height={8} rx={1} fill={line.kind === 'FOCUS' ? INK.primary : index.color(line.carId ?? focusCarId)} />
                  )}
                  <text x={ax + (line.kind === 'CANDIDATE' ? 18 : 14)} y={ly} dy="0.34em" className={`font-display text-[10px] font-semibold tracking-[0.06em] ${line.kind === 'RIVAL' || line.kind === 'RIVAL_PROJECTION' ? 'fill-ink-300' : 'fill-ink-100'} ${TEXT_HALO}`}>
                    {line.label}
                  </text>
                </g>
              ))}
              {cursorLap !== null ? (
                <g pointerEvents="none">
                  <Crosshair plot={plot} x={x(cursorLap)} />
                  {cursorRows.map(({ line, point }) => (
                    <circle key={line.id} cx={x(cursorLap)} cy={y(point.v)} r={3} fill={line.color} stroke="var(--color-carbon-900)" strokeWidth={1.5} />
                  ))}
                </g>
              ) : null}
            </svg>
            <CursorOverlay
              plot={plot}
              values={geometry.snapLaps}
              x={x}
              cursor={cursorLap}
              onCursor={setCursor}
              home={Math.max(1, lapsCompleted)}
              ariaLabel={`Lap cursor: ${mode === 'GAP' ? 'gap to leader' : 'race trace'} of every series`}
              valueText={valueText}
            />
          </>
        )}
      </div>

      <ChartTooltip anchor={cursorLap !== null && !table ? cursor : null}>
        {cursorLap !== null ? (
          <>
            <TooltipTitle note={cursorLap > lapsCompleted ? 'Projected' : cursorFlag && isNeutralFlag(cursorFlag) ? cursorFlag : undefined}>Lap {cursorLap}</TooltipTitle>
            <TooltipGrid>
              {cursorRows.map(({ line, point }) => (
                <TooltipRow
                  key={line.id}
                  swatch={<LineKey color={line.color} dashed={line.kind === 'CANDIDATE' || line.kind === 'RIVAL_PROJECTION'} weight={line.kind === 'RIVAL' || line.kind === 'RIVAL_PROJECTION' ? 1.25 : 2} marker={line.shape ?? undefined} />}
                  value={fmt(point.v)}
                  name={line.kind === 'FOCUS' ? `${line.label} actual` : line.label}
                  detail={
                    <>
                      P{point.position}
                      {point.pit ? <span className="rounded-[1px] border border-carbon-500 px-0.5 font-display text-[9px] tracking-wider text-ink-100">PIT</span> : null}
                    </>
                  }
                />
              ))}
            </TooltipGrid>
          </>
        ) : null}
      </ChartTooltip>

      {/* Candidate legend = decision table. */}
      <div className={`shrink-0 overflow-x-auto border-t border-carbon-700 ${stale ? 'opacity-60' : ''}`}>
        {candidates.length === 0 ? (
          <div className="flex h-[52px] items-center justify-center gap-3 px-3">
            <span className="text-xs text-ink-500">
              {running ? `No projection for ${focusCode} yet — pick the stop compound and run the simulation (candidates T+1 · T+3 · T+5).` : `No projection: ${focusCode} is not racing.`}
            </span>
            {running ? (
              <button type="button" className="pw-btn px-2 py-1" disabled={isPending} onClick={() => request(choice)}>
                <RefreshCw size={11} strokeWidth={1.75} />
                {isPending ? 'Computing' : 'Compute projection'}
              </button>
            ) : null}
          </div>
        ) : (
          <table className="w-full border-collapse text-2xs">
            <caption className="sr-only">Pit-stop candidates for {focusCode}</caption>
            <thead>
              <tr className="h-4 bg-carbon-850 text-left">
                {[
                  ['Candidate', ''],
                  ['Stops', 'Remaining stops if adopted'],
                  ['Finish', 'Expected finishing position (Monte-Carlo mean)'],
                  ['P10–P90', 'Range of finishing positions between the 10th and 90th percentile; tick = median'],
                  ...(showDelta ? [['Δ time', 'Expected race time versus the best candidate']] : []),
                  ...(showRejoin ? [['Rejoin', 'Position at pit exit · gap to the car ahead / to the car behind (s)']] : []),
                  ['vs ahead', 'Gap to the rival now → once both have stopped (+ = rival ahead) · probability of finishing ahead'],
                  ['vs behind', 'Gap to the rival now → once both have stopped (+ = rival ahead) · probability of finishing ahead'],
                  ['Plan', ''],
                ].map(([label, title]) => (
                  <th key={label} scope="col" title={title || undefined} className="whitespace-nowrap px-1.5 font-normal first:pl-2 last:pr-2 last:text-right">
                    <span className="pw-label text-[9px]">{label}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono tabular">
              {candidates.map((c) => {
                const id = c.candidate.id;
                const slot = model.slots.get(id) ?? 0;
                const color = SERIES[slot] ?? INK.secondary;
                const stops = candidateStopSequence(c);
                const recommended = projection?.recommendedId === id;
                const adopted = telemetry !== undefined && isCandidateAdopted(telemetry.nextPlannedStop, c);
                const passed = c.candidate.pitLap !== null && c.candidate.pitLap < currentLap;
                // Rival ahead / behind by the sign of the current gap; an odd one out takes the free column.
                let ahead = c.rivals.find((r) => r.gapNow >= 0);
                let behind = c.rivals.find((r) => r.gapNow < 0);
                const spareRival = c.rivals.find((r) => r !== ahead && r !== behind);
                if (!ahead) ahead = spareRival;
                else if (!behind) behind = spareRival;
                const delta = c.expectedRaceTime - bestTime;
                const faded = activeEmphasis !== null && activeEmphasis !== id;
                const toX = (p: number): number => 2 + ((Math.min(rangeHi, Math.max(rangeLo, p)) - rangeLo) / (rangeHi - rangeLo)) * 52;
                return (
                  <tr
                    key={id}
                    className={`h-[21px] cursor-pointer border-t border-carbon-700/70 hover:bg-carbon-850 ${activeEmphasis === id ? 'bg-carbon-800' : ''} ${faded ? 'opacity-50' : ''}`}
                    onClick={() => setEmphasis(activeEmphasis === id ? null : id)}
                  >
                    <td className="whitespace-nowrap py-0 pl-2 pr-1.5">
                      <button
                        type="button"
                        aria-pressed={activeEmphasis === id}
                        title="Emphasise this candidate on the chart"
                        className="flex items-center gap-1.5"
                        onClick={(event) => {
                          event.stopPropagation();
                          setEmphasis(activeEmphasis === id ? null : id);
                        }}
                      >
                        <LineKey color={color} dashed marker={SLOT_SHAPES[slot]} width={22} />
                        <span className="font-display text-xs font-semibold tracking-wider text-ink-50">{c.candidate.label}</span>
                        <span className="text-ink-300">{c.candidate.pitLap !== null ? `· L${c.candidate.pitLap}` : /no stop/i.test(c.candidate.label) ? '' : '· NO STOP'}</span>
                        {recommended ? (
                          <span className="flex items-center gap-0.5 rounded-[1px] border border-ink-300 px-1 font-display text-[9px] font-bold leading-[13px] tracking-[0.12em] text-ink-50" title="Best expected finish">
                            <Check size={9} strokeWidth={2.5} />
                            REC
                          </span>
                        ) : null}
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-1.5 py-0">
                      {stops.length === 0 ? (
                        <span className="text-ink-600">—</span>
                      ) : (
                        <span className="flex items-center gap-1">
                          {stops.map((stop, i) => (
                            <span key={stop.lap} className="flex items-center gap-0.5 text-ink-300">
                              {i > 0 ? <span className="text-ink-600">›</span> : null}
                              L{stop.lap}
                              <TyreBadge compound={stop.compound} size={13} />
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-1.5 py-0 font-bold text-ink-50">P{c.expectedFinish.toFixed(1)}</td>
                    <td className="whitespace-nowrap px-1.5 py-0">
                      <span className="flex items-center gap-1.5 text-ink-300">
                        <svg width={56} height={9} aria-hidden="true">
                          <line x1={2} x2={54} y1={4.5} y2={4.5} className="stroke-chart-axis" />
                          <line x1={toX(c.finishP10)} x2={toX(c.finishP90)} y1={4.5} y2={4.5} stroke={INK.secondary} strokeWidth={4} strokeLinecap="round" />
                          <line x1={toX(c.finishP50)} x2={toX(c.finishP50)} y1={0.5} y2={8.5} stroke={INK.strong} strokeWidth={2} />
                        </svg>
                        {c.finishP10}–{c.finishP90}
                      </span>
                    </td>
                    {showDelta ? (
                      <td className="whitespace-nowrap px-1.5 py-0 text-ink-100">{delta < 0.05 ? <span className="font-display tracking-wider text-ink-300">BEST</span> : `+${delta.toFixed(1)} s`}</td>
                    ) : null}
                    {showRejoin ? (
                      <td className="whitespace-nowrap px-1.5 py-0 text-ink-300">
                        {c.rejoinPosition === null ? (
                          <span className="text-ink-600">—</span>
                        ) : (
                          <>
                            <span className="text-ink-100">P{c.rejoinPosition}</span> · {c.rejoinGapAhead === null ? '—' : `+${c.rejoinGapAhead.toFixed(1)}`} / {c.rejoinGapBehind === null ? '—' : `−${c.rejoinGapBehind.toFixed(1)}`}
                          </>
                        )}
                      </td>
                    ) : null}
                    <td className="whitespace-nowrap px-1.5 py-0">
                      <Outcome outcome={ahead} index={index} />
                    </td>
                    <td className="whitespace-nowrap px-1.5 py-0">
                      <Outcome outcome={behind} index={index} />
                    </td>
                    <td className="whitespace-nowrap py-0 pl-1.5 pr-2 text-right">
                      {adopted ? (
                        <span className="inline-flex items-center gap-0.5 font-display text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-300" title="This is the next stop of the active plan">
                          <Check size={10} strokeWidth={2} />
                          Active
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="pw-btn px-1.5 py-[3px] text-[10px]"
                          disabled={!running || passed || telemetry === undefined}
                          title={passed ? 'This pit lap has passed' : `Make ${c.candidate.label} the next stop of the active plan`}
                          onClick={(event) => {
                            event.stopPropagation();
                            adopt(c);
                          }}
                        >
                          Adopt
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}

/** Undercut/overcut outcome against one rival: gap now → gap after both stops, verdict and probability. */
function Outcome({ outcome, index }: { outcome: UndercutOutcome | undefined; index: SessionIndex }) {
  if (!outcome) return <span className="text-ink-600">—</span>;
  const ahead = outcome.gapAfter < 0;
  return (
    <span className="flex items-center gap-1">
      <span className="h-2.5 w-[3px] shrink-0 rounded-[1px]" style={{ backgroundColor: index.color(outcome.rivalId) }} />
      <span className="font-display tracking-wider text-ink-300">{index.driver(outcome.rivalId).code}</span>
      <span className="text-ink-500">{formatDelta(outcome.gapNow, 1)}</span>
      <ArrowRight size={9} strokeWidth={2} className="text-ink-600" />
      <span className="text-ink-100">{formatDelta(outcome.gapAfter, 1)}</span>
      <span className={ahead ? 'text-ok' : 'text-crit'} title={ahead ? 'Ahead once both have stopped' : 'Behind once both have stopped'}>
        {ahead ? '▲' : '▼'}
        <span className="sr-only">{ahead ? 'ahead after the stops' : 'behind after the stops'}</span>
      </span>
      <span className="font-bold text-ink-50">{formatPercent(outcome.successProbability)}</span>
    </span>
  );
}
