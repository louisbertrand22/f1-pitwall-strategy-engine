import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Flag, History, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import type { RaceAnalysisProps } from './contracts';
import { Panel, Segmented, TyreBadge } from './ui';
import { formatDelta, formatGap, formatLapTime } from '../lib/format';
import { indexSession } from '../lib/session';
import type { SessionIndex } from '../lib/session';
import { TYRE_COLORS, TYRE_LABELS, TYRE_LETTERS, TYRE_ORDER, tyreInkOn } from '../lib/tyres';
import { pitLossUnderFlag } from '../simulation/physicsModel';
import type { CarId, ClassificationEntry, FlagStatus, SessionInfo } from '../simulation/types';
import {
  ChartHeader,
  ChartTooltip,
  Crosshair,
  CursorOverlay,
  EmptyState,
  FLAG_COLOR,
  FLAG_LABEL,
  FlagBands,
  HGrid,
  INK,
  LapAxis,
  LegendItem,
  LineKey,
  TEXT_HALO,
  TooltipGrid,
  TooltipRow,
  TooltipTitle,
  VRule,
  ValueAxis,
  useElementSize,
} from './charts/chartKit';
import type { CursorInfo, PlotRect } from './charts/chartKit';
import { spreadLabels } from './charts/layout';
import { linePath } from './charts/path';
import {
  analysePitStops,
  carStints,
  classificationAtLap,
  countLapRecords,
  flagSpans,
  isNeutralFlag,
  latestLap,
  pitStopsSignature,
  raceLapFlags,
  recordAt,
} from './charts/raceData';
import type { ClassificationRow, FlagSpan, LapsByCar, PitStopImpact, RivalVerdict, Stint } from './charts/raceData';
import { extent, lapTicks, linearScale, niceTicks } from './charts/scale';

type View = 'LAPS' | 'GAPS' | 'STINTS' | 'PITS';
type Metric = 'POSITION' | 'GAP';

const TOWER_WIDTH = 204;
/** Rivals that can be pinned at once – the lap chart must never turn into twenty loud lines. */
const MAX_PINNED = 4;
const REPLAY_STEP_MS = 450;

function gapText(seconds: number): string {
  return seconds >= 100 ? formatGap(seconds) : `+${seconds.toFixed(1)}`;
}

function FlagChip({ flag }: { flag: FlagStatus }) {
  if (!isNeutralFlag(flag)) return <span className="text-ink-500">GRN</span>;
  return (
    <span className="inline-flex items-center gap-1 text-ink-100">
      <span className="h-2 w-2 rounded-[1px]" style={{ backgroundColor: FLAG_COLOR[flag] }} />
      {FLAG_LABEL[flag]}
    </span>
  );
}

function DriverKey({ carId, index, strong = false }: { carId: CarId; index: SessionIndex; strong?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-2.5 w-[3px] shrink-0 rounded-[1px]" style={{ backgroundColor: index.color(carId) }} />
      <span className={`font-display tracking-wider ${strong ? 'font-bold text-ink-50' : 'font-semibold text-ink-100'}`}>{index.driver(carId).code}</span>
    </span>
  );
}

export function RaceAnalysis(props: RaceAnalysisProps) {
  const { session, snapshot, history, classification, className = '' } = props;
  const index = indexSession(session);
  const [p1, p2] = session.playerCarIds;

  const [view, setView] = useState<View>('LAPS');
  const [replay, setReplay] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pinned, setPinned] = useState<CarId[]>([]);
  const [hoverId, setHoverId] = useState<CarId | null>(null);
  const [gapRef, setGapRef] = useState<string>('LEADER');
  const [allCars, setAllCars] = useState(false);
  const [contentRef, contentSize] = useElementSize<HTMLDivElement>();

  const laps = history.laps;
  const lapCount = countLapRecords(laps);
  const latest = useMemo(() => latestLap(laps), [laps, lapCount]);
  const spans = useMemo(() => flagSpans(raceLapFlags(laps)), [laps, lapCount]);

  const retiredKey = [
    ...snapshot.cars.filter((c) => c.status === 'RETIRED').map((c) => c.id),
    ...(classification ?? []).filter((c) => c.status === 'DNF').map((c) => c.carId),
  ]
    .sort()
    .join(',');
  const retired = useMemo(() => new Set<CarId>(retiredKey === '' ? [] : retiredKey.split(',')), [retiredKey]);
  const raceOver = classification !== null || snapshot.phase === 'FINISHED';

  // Replay lap: follows the latest lap until the user scrubs back.
  const replayLap = replay === null ? latest : Math.min(replay, latest);
  const live = replay === null || replay >= latest;
  const latestRef = useRef(latest);
  const replayRef = useRef(replayLap);
  latestRef.current = latest;
  replayRef.current = replayLap;
  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setInterval(() => {
      const next = replayRef.current + 1;
      if (next >= latestRef.current) {
        setReplay(null);
        setPlaying(false);
      } else setReplay(next);
    }, REPLAY_STEP_MS);
    return () => window.clearInterval(timer);
  }, [playing]);
  // Stable callbacks: the memoised views below must not re-render at snapshot rate.
  const goTo = useCallback((lap: number): void => {
    setPlaying(false);
    setReplay(lap >= latestRef.current ? null : Math.max(0, lap));
  }, []);

  const finalRows = useMemo(() => classificationAtLap(session.grid, laps, latest, retired), [session.grid, laps, lapCount, latest, retired]);
  const replayRows = useMemo(() => classificationAtLap(session.grid, laps, replayLap, retired), [session.grid, laps, lapCount, replayLap, retired]);
  const pitSignature = pitStopsSignature(history.pitStops);
  const impacts = useMemo(
    () => analysePitStops(history.pitStops, laps, session.grid, { raceOver, retired }),
    [history.pitStops, pitSignature, laps, lapCount, session.grid, raceOver, retired],
  );

  const togglePin = useCallback(
    (carId: CarId): void => {
      if (carId === p1 || carId === p2) return;
      setPinned((current) => (current.includes(carId) ? current.filter((id) => id !== carId) : [...current, carId].slice(-MAX_PINNED)));
    },
    [p1, p2],
  );

  const showTower = view !== 'PITS' || contentSize.width >= 1180;
  const refLabel = gapRef === 'LEADER' ? 'leader' : index.driver(gapRef).code;
  const chartProps = { session, index, laps, lapCount, latest, spans, finalRows, retired, pinned, hoverId, onHover: setHoverId, onTogglePin: togglePin, replayLap, live, onReplay: goTo };

  return (
    <Panel
      title="Race Analysis"
      icon={<History size={14} strokeWidth={1.75} />}
      subtitle={latest === 0 ? 'NO LAP COMPLETED' : `${raceOver ? 'FINAL' : `LAP ${latest}/${session.raceLaps}`} · ${live ? 'LIVE' : `REPLAY L${replayLap}`}`}
      className={`h-full ${className}`}
      bodyClassName="flex flex-col"
    >
      <div className="flex h-7 shrink-0 items-center gap-2 overflow-hidden border-b border-carbon-700 px-2 [&_button]:px-1.5 [&_button]:py-1">
        <Segmented
          ariaLabel="Analysis view"
          fill={false}
          value={view}
          onChange={setView}
          options={[
            { value: 'LAPS', label: 'Lap chart' },
            { value: 'GAPS', label: 'Gaps' },
            { value: 'STINTS', label: 'Stints' },
            { value: 'PITS', label: 'Pit stops' },
          ]}
        />
        {view === 'GAPS' ? (
          <Segmented
            ariaLabel="Gap reference"
            fill={false}
            value={gapRef}
            onChange={setGapRef}
            options={[
              { value: 'LEADER', label: 'To leader' },
              { value: p1, label: `To ${index.driver(p1).code}` },
              { value: p2, label: `To ${index.driver(p2).code}` },
            ]}
          />
        ) : null}
        {view === 'PITS' ? (
          <Segmented
            ariaLabel="Cars listed"
            fill={false}
            value={allCars ? 'ALL' : 'TEAM'}
            onChange={(value) => setAllCars(value === 'ALL')}
            options={[
              { value: 'TEAM', label: 'Team' },
              { value: 'ALL', label: 'All cars' },
            ]}
          />
        ) : null}
        <div className="ml-auto flex min-w-0 items-center gap-1" role="group" aria-label="Tactical replay">
          <span className="pw-label mr-1 whitespace-nowrap">Replay</span>
          <button type="button" className="pw-btn" aria-label="Back to the grid" title="Back to the grid" disabled={latest === 0} onClick={() => goTo(0)}>
            <SkipBack size={11} strokeWidth={1.75} />
          </button>
          <button type="button" className="pw-btn" aria-label="Previous lap" title="Previous lap" disabled={replayLap <= 0} onClick={() => goTo(replayLap - 1)}>
            <ChevronLeft size={11} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="pw-btn"
            aria-label={playing ? 'Pause the replay' : 'Play the replay'}
            title={playing ? 'Pause' : 'Play the race lap by lap'}
            disabled={latest === 0}
            data-active={playing}
            onClick={() => {
              if (playing) setPlaying(false);
              else {
                if (live) setReplay(0);
                setPlaying(true);
              }
            }}
          >
            {playing ? <Pause size={11} strokeWidth={1.75} /> : <Play size={11} strokeWidth={1.75} />}
          </button>
          <button type="button" className="pw-btn" aria-label="Next lap" title="Next lap" disabled={live} onClick={() => goTo(replayLap + 1)}>
            <ChevronRight size={11} strokeWidth={2} />
          </button>
          <button type="button" className="pw-btn" aria-label="Follow the latest lap" title="Follow the latest lap" data-active={live && latest > 0} disabled={latest === 0} onClick={() => goTo(latest)}>
            <SkipForward size={11} strokeWidth={1.75} />
            Live
          </button>
          <input
            type="range"
            aria-label="Replay lap"
            className="mx-1 h-1 w-28 min-w-12 shrink accent-ink-100"
            min={0}
            max={Math.max(1, latest)}
            step={1}
            value={replayLap}
            disabled={latest === 0}
            onChange={(event) => goTo(Number(event.target.value))}
          />
          <span className="w-[54px] whitespace-nowrap text-right font-mono text-2xs tabular text-ink-100">
            L{replayLap}
            <span className="text-ink-500">/{latest}</span>
          </span>
        </div>
      </div>

      {classification ? <ResultStrip classification={classification} index={index} playerIds={session.playerCarIds} /> : null}

      <div ref={contentRef} className="flex min-h-0 flex-1">
        {latest === 0 ? (
          <div className="flex-1">
            <EmptyState icon={<History size={18} strokeWidth={1.5} />} title="No lap completed yet" hint="The lap chart, gaps, stints and pit-stop analysis fill in as soon as the leader completes lap 1." />
          </div>
        ) : (
          <>
            {showTower ? (
              <Tower rows={replayRows} index={index} replayLap={replayLap} live={live} playerIds={session.playerCarIds} pinned={pinned} hoverId={hoverId} onHover={setHoverId} onTogglePin={togglePin} />
            ) : null}
            <div className="flex min-w-0 flex-1 flex-col">
              {view === 'LAPS' || view === 'GAPS' ? (
                <>
                  <ChartHeader title={view === 'LAPS' ? 'Position by lap' : `Gap to ${refLabel} · s`} note="hover or click a driver to reveal · click the chart to replay a lap">
                    <LegendItem swatch={<LineKey color={index.color(p1)} weight={2.5} />} label={index.driver(p1).code} />
                    <LegendItem swatch={<LineKey color={index.color(p2)} weight={2.5} dashed />} label={index.driver(p2).code} />
                    <LegendItem swatch={<LineKey color={INK.faint} weight={1.25} />} label="Others" />
                  </ChartHeader>
                  <LinesChart {...chartProps} metric={view === 'LAPS' ? 'POSITION' : 'GAP'} gapRef={gapRef} />
                </>
              ) : view === 'STINTS' ? (
                <>
                  <ChartHeader title="Stints by compound" note="laps on each set · gaps are pit stops">
                    {TYRE_ORDER.map((compound) => (
                      <LegendItem key={compound} swatch={<TyreBadge compound={compound} size={12} />} label={TYRE_LABELS[compound]} />
                    ))}
                  </ChartHeader>
                  <StintChart {...chartProps} />
                </>
              ) : (
                <PitStopTable impacts={impacts} session={session} index={index} allCars={allCars} replayLap={replayLap} onReplay={goTo} />
              )}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────── result strip ──

function ResultStrip({ classification, index, playerIds }: { classification: ClassificationEntry[]; index: SessionIndex; playerIds: readonly CarId[] }) {
  const shown = classification.filter((entry) => entry.position <= 3 || playerIds.includes(entry.carId)).sort((a, b) => a.position - b.position);
  return (
    <div className="flex h-7 shrink-0 items-center gap-4 overflow-hidden border-b border-carbon-700 bg-carbon-850 px-2">
      <span className="pw-label flex items-center gap-1 whitespace-nowrap">
        <Flag size={11} strokeWidth={1.75} />
        Final result
      </span>
      {shown.map((entry) => {
        const gained = entry.gridPosition - entry.position;
        const own = playerIds.includes(entry.carId);
        return (
          <span key={entry.carId} className={`flex items-center gap-1.5 whitespace-nowrap text-2xs ${own ? 'rounded-[2px] border border-carbon-500 px-1.5 py-0.5' : ''}`}>
            <span className="font-mono font-bold text-ink-50">{entry.status === 'DNF' ? 'DNF' : `P${entry.position}`}</span>
            <DriverKey carId={entry.carId} index={index} strong={own} />
            <span className="font-mono text-ink-100">{entry.points} pts</span>
            <span className="font-mono text-ink-300" title={`Started P${entry.gridPosition}`}>
              {gained === 0 ? '=' : gained > 0 ? '▲' : '▼'}
              {gained === 0 ? '' : Math.abs(gained)} <span className="text-ink-500">grid P{entry.gridPosition}</span>
            </span>
          </span>
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────────── classification tower ──

interface TowerProps {
  rows: ClassificationRow[];
  index: SessionIndex;
  replayLap: number;
  live: boolean;
  playerIds: readonly CarId[];
  pinned: readonly CarId[];
  hoverId: CarId | null;
  onHover: (carId: CarId | null) => void;
  onTogglePin: (carId: CarId) => void;
}

/** Classification at the replay lap. Doubles as the legend of the lap chart: hover reveals, click pins. */
const Tower = memo(function Tower({ rows, index, replayLap, live, playerIds, pinned, hoverId, onHover, onTogglePin }: TowerProps) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const rowHeight = Math.max(13, Math.min(24, Math.floor((size.height - 18) / Math.max(1, rows.length))));
  return (
    <div ref={ref} className="flex shrink-0 flex-col border-r border-carbon-700" style={{ width: TOWER_WIDTH }}>
      <div className="flex h-[18px] shrink-0 items-center justify-between px-2">
        <span className="pw-label">{replayLap === 0 ? 'Starting grid' : `Classification · L${replayLap}`}</span>
        <span className="font-display text-[9px] font-semibold tracking-[0.12em] text-ink-500">{live ? 'LIVE' : 'REPLAY'}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" onPointerLeave={() => onHover(null)}>
        {rows.map((row) => {
          const own = playerIds.includes(row.carId);
          const isPinned = pinned.includes(row.carId);
          const record = row.record;
          const out = row.state === 'OUT';
          // A car that has not completed the lap yet keeps its last known gap, muted.
          let gap = '—';
          if (out) gap = 'OUT';
          else if (record) gap = row.state === 'ON_LAP' && row.rank === 1 ? 'LEADER' : gapText(record.gapToLeader);
          const stale = row.state === 'BEHIND' && record !== null;
          return (
            <button
              key={row.carId}
              type="button"
              aria-pressed={own ? undefined : isPinned}
              title={stale && record ? `Has not completed L${replayLap} yet – values from L${record.lap}` : own ? undefined : isPinned ? 'Unpin from the chart' : 'Pin on the chart'}
              className={`grid w-full grid-cols-[16px_36px_1fr_32px_20px_18px] items-center gap-x-1 whitespace-nowrap border-b border-carbon-700/50 px-2 text-left font-mono text-[10px] tabular ${own ? 'bg-carbon-850' : ''} ${hoverId === row.carId ? 'bg-carbon-750' : ''} ${out ? 'opacity-50' : ''}`}
              style={{ height: rowHeight }}
              onPointerEnter={() => onHover(row.carId)}
              onFocus={() => onHover(row.carId)}
              onBlur={() => onHover(null)}
              onClick={() => onTogglePin(row.carId)}
            >
              <span className="text-right text-ink-500">{row.rank}</span>
              <span className="flex items-center gap-1">
                <span className="h-2.5 w-[3px] shrink-0 rounded-[1px]" style={{ backgroundColor: index.color(row.carId), opacity: own || isPinned ? 1 : 0.55 }} />
                <span className={`font-display text-[11px] tracking-wider ${own || isPinned ? 'font-bold text-ink-50' : 'font-medium text-ink-100'}`}>{index.driver(row.carId).code}</span>
              </span>
              <span className={`text-right ${row.state === 'ON_LAP' ? 'text-ink-100' : 'text-ink-500'}`}>{gap}</span>
              <span className="flex items-center justify-end gap-0.5 text-ink-300">
                {row.compound ? <TyreBadge compound={row.compound} size={12} /> : null}
                {row.tyreAge ?? ''}
              </span>
              <span className="text-right text-ink-300">
                {row.delta === null || row.delta === 0 ? '' : row.delta > 0 ? `▲${row.delta}` : `▼${-row.delta}`}
              </span>
              <span className="font-display text-[9px] font-bold tracking-wider text-ink-50">{row.state === 'ON_LAP' && record?.pitIn ? 'PIT' : ''}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
});

// ─────────────────────────────────────────────────── lap chart & gap chart ──

interface ChartCommonProps {
  session: SessionInfo;
  index: SessionIndex;
  laps: LapsByCar;
  lapCount: number;
  latest: number;
  spans: FlagSpan[];
  finalRows: ClassificationRow[];
  retired: ReadonlySet<CarId>;
  pinned: readonly CarId[];
  hoverId: CarId | null;
  onHover: (carId: CarId | null) => void;
  onTogglePin: (carId: CarId) => void;
  replayLap: number;
  live: boolean;
  onReplay: (lap: number) => void;
}

interface CarSeries {
  carId: CarId;
  /** Value per lap (index = laps completed); null where the car has no data. */
  values: (number | null)[];
  lastLap: number;
}

const LinesChart = memo(function LinesChart(props: ChartCommonProps & { metric: Metric; gapRef: string }) {
  const { session, index, laps, lapCount, latest, spans, finalRows, retired, pinned, hoverId, onHover, onTogglePin, replayLap, live, onReplay, metric, gapRef } = props;
  const clipId = useId();
  const [ref, size] = useElementSize<HTMLDivElement>();
  const [cursor, setCursor] = useState<CursorInfo | null>(null);
  const [p1, p2] = session.playerCarIds;
  const carCount = Math.max(2, finalRows.length);
  const xMax = Math.max(latest, 5);
  const margin = { left: 34, right: 44, top: 14, bottom: 18 };
  const plot: PlotRect = { left: margin.left, top: margin.top, width: Math.max(10, size.width - margin.left - margin.right), height: Math.max(10, size.height - margin.top - margin.bottom) };
  const ready = size.width > 140 && size.height > 70;

  const series = useMemo<CarSeries[]>(() => {
    // One lap of gap is the edge of the chart: lapped cars leave through it instead of flattening everyone else.
    const cap = session.track.baseLapTime;
    return finalRows.map(({ carId }) => {
      const records = laps[carId] ?? [];
      const values: (number | null)[] = [];
      const grid = session.grid.indexOf(carId);
      values[0] = metric === 'POSITION' && grid >= 0 ? grid + 1 : null;
      let lastLap = 0;
      for (const record of records) {
        let value: number | null;
        if (metric === 'POSITION') value = record.position;
        else if (gapRef === 'LEADER') value = record.gapToLeader;
        else {
          const reference = recordAt(laps[gapRef], record.lap);
          value = reference ? record.gapToLeader - reference.gapToLeader : null;
        }
        if (metric === 'GAP' && value !== null && Math.abs(value) > cap * 2) value = Math.sign(value) * cap * 2;
        values[record.lap] = value;
        lastLap = record.lap;
      }
      for (let lap = 0; lap <= lastLap; lap++) if (values[lap] === undefined) values[lap] = null;
      return { carId, values, lastLap };
    });
  }, [laps, lapCount, finalRows, metric, gapRef, session]);

  const geometry = useMemo(() => {
    const x = linearScale([0, xMax], [plot.left, plot.left + plot.width]);
    let lo = 1;
    let hi = carCount;
    let clipped = false;
    if (metric === 'GAP') {
      const cap = session.track.baseLapTime;
      const range = extent(series.flatMap((s) => s.values)) ?? [0, 10];
      clipped = range[1] > cap || range[0] < -cap;
      lo = Math.max(range[0], -cap);
      hi = Math.min(range[1], cap);
      const pad = Math.max(0.5, (hi - lo) * 0.04);
      lo = gapRef === 'LEADER' ? 0 : lo - pad;
      hi += pad;
    }
    const y = metric === 'POSITION' ? linearScale([lo, hi], [plot.top + 7, plot.top + plot.height - 7]) : linearScale([lo, hi], [plot.top, plot.top + plot.height]);
    const paths = new Map<CarId, string>();
    for (const s of series) paths.set(s.carId, linePath(s.values.map((v, lap) => (v === null ? null : ([x(lap), y(v)] as const)))));
    const snap: number[] = [];
    for (let lap = 0; lap <= latest; lap++) snap.push(lap);
    const yTicks = metric === 'POSITION' ? [1, 5, 10, 15, 20].filter((p) => p <= carCount) : niceTicks(lo, hi, Math.max(2, Math.floor(plot.height / 40)));
    return { x, y, paths, snap, yTicks, xTicks: lapTicks(0, xMax, plot.width), clipped };
  }, [series, metric, gapRef, carCount, xMax, latest, session, plot.left, plot.top, plot.width, plot.height]);
  const { x, y } = geometry;

  const highlighted = (carId: CarId): boolean => carId === p1 || carId === p2 || pinned.includes(carId) || hoverId === carId;
  const styleOf = (carId: CarId): { color: string; width: number; dash: string | undefined } => {
    const own = carId === p1 || carId === p2;
    if (!highlighted(carId)) return { color: INK.faint, width: 1.25, dash: undefined };
    return { color: index.color(carId), width: own ? 2.5 : 2, dash: index.driver(carId).carNumber === 2 ? '6 4' : undefined };
  };
  // Muted lines first, the user's cars last (on top).
  const paintOrder = [...series].sort((a, b) => Number(highlighted(a.carId)) + Number(a.carId === p1 || a.carId === p2) - (Number(highlighted(b.carId)) + Number(b.carId === p1 || b.carId === p2)));

  // Direct labels: every driver on the lap chart (one row per place), highlighted cars only on the gap chart.
  const labelX = plot.left + plot.width + 6;
  const labelSeries = metric === 'POSITION' ? series : series.filter((s) => highlighted(s.carId) && s.values[s.lastLap] !== null && s.values[s.lastLap] !== undefined);
  const anchors = labelSeries.map((s, i) => {
    if (metric === 'POSITION') return y(i + 1);
    const v = s.values[s.lastLap];
    return y(v === null || v === undefined ? 0 : v);
  });
  const labelYs = metric === 'POSITION' ? anchors : spreadLabels(anchors, 11, plot.top + 5, plot.top + plot.height - 4);

  const cursorLap = cursor && cursor.value <= latest ? cursor.value : null;
  const handleCursor = (info: CursorInfo | null): void => {
    setCursor(info);
    if (!info || info.pointerY === null) {
      if (!info) onHover(null);
      return;
    }
    // Reveal the car whose line is nearest to the pointer at that lap.
    let best: CarId | null = null;
    let bestDistance = 14;
    for (const s of series) {
      const v = s.values[info.value];
      if (v === null || v === undefined) continue;
      const distance = Math.abs(y(v) - (plot.top + info.pointerY));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = s.carId;
      }
    }
    onHover(best);
  };
  const cursorCars =
    cursorLap === null
      ? []
      : series
          .filter((s) => highlighted(s.carId) && s.values[cursorLap] !== null && s.values[cursorLap] !== undefined)
          .map((s) => ({ s, record: recordAt(laps[s.carId], cursorLap), value: s.values[cursorLap] as number }))
          .sort((a, b) => a.value - b.value);
  const valueLabel = (v: number): string => (metric === 'POSITION' ? `P${v}` : Math.abs(v) < 0.0005 ? (gapRef === 'LEADER' ? 'LEADER' : 'REF') : `${formatDelta(v, 1)} s`);
  const cursorFlag = cursorLap !== null && cursorLap > 0 ? spans.find((span) => cursorLap >= span.fromLap && cursorLap <= span.toLap) : undefined;
  const valueText = cursorLap === null ? 'No lap selected' : `Lap ${cursorLap}: ${cursorCars.map((c) => `${index.driver(c.s.carId).code} ${valueLabel(c.value)}`).join(', ')}`;

  return (
    <div ref={ref} className="relative min-h-0 flex-1">
      {ready ? (
        <>
          <svg width={size.width} height={size.height} className="absolute inset-0 block" role="img" aria-label={metric === 'POSITION' ? 'Lap chart: position of every car by lap' : 'Gap chart: gap of every car by lap'}>
            <defs>
              <clipPath id={clipId}>
                <rect x={plot.left - 1} y={plot.top - 1} width={plot.width + 2} height={plot.height + 2} />
              </clipPath>
            </defs>
            <HGrid plot={plot} ys={geometry.yTicks.map((t) => y(t))} />
            <FlagBands plot={plot} spans={spans} x={x} labelAbove />
            <LapAxis plot={plot} ticks={geometry.xTicks} x={x} />
            <ValueAxis plot={plot} ticks={geometry.yTicks} y={y} format={(v) => (metric === 'POSITION' ? `P${v}` : v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v)}`)} />
            <g clipPath={`url(#${clipId})`} fill="none" strokeLinejoin="round" strokeLinecap="round">
              {paintOrder.map((s) => {
                const style = styleOf(s.carId);
                return <path key={s.carId} d={geometry.paths.get(s.carId) ?? ''} stroke={style.color} strokeWidth={style.width} strokeDasharray={style.dash} />;
              })}
              {paintOrder.map((s) => {
                const style = styleOf(s.carId);
                const end = s.values[s.lastLap];
                const marks = [];
                if (highlighted(s.carId)) {
                  for (const record of laps[s.carId] ?? []) {
                    const v = s.values[record.lap];
                    if (record.pitIn && v !== null && v !== undefined) {
                      marks.push(<circle key={`pit-${record.lap}`} cx={x(record.lap)} cy={y(v)} r={3.5} fill={style.color} stroke="var(--color-carbon-900)" strokeWidth={2} />);
                    }
                  }
                }
                if (retired.has(s.carId) && end !== null && end !== undefined && s.lastLap < latest) {
                  const ex = x(s.lastLap);
                  const ey = y(end);
                  marks.push(<path key="out" d={`M${ex - 3.5} ${ey - 3.5}L${ex + 3.5} ${ey + 3.5}M${ex - 3.5} ${ey + 3.5}L${ex + 3.5} ${ey - 3.5}`} stroke={highlighted(s.carId) ? style.color : INK.muted} strokeWidth={1.75} />);
                }
                return marks.length > 0 ? <g key={`m-${s.carId}`}>{marks}</g> : null;
              })}
            </g>
            {geometry.clipped ? (
              <text x={plot.left + 4} y={plot.top + plot.height - 5} className={`fill-ink-500 font-display text-[9px] font-medium tracking-[0.1em] ${TEXT_HALO}`}>
                ▼ MORE THAN A LAP BEHIND
              </text>
            ) : null}
            {live ? null : <VRule plot={plot} x={x(replayLap)} label={`REPLAY L${replayLap}`} labelAtBottom={metric === 'GAP'} />}
            {labelSeries.map((s, i) => {
              const strong = highlighted(s.carId);
              const out = retired.has(s.carId);
              const ly = labelYs[i]!;
              const end = s.values[s.lastLap];
              const ay = end === null || end === undefined ? ly : y(end);
              return (
                <g
                  key={s.carId}
                  className="cursor-pointer"
                  opacity={out && !strong ? 0.55 : 1}
                  onPointerEnter={() => onHover(s.carId)}
                  onPointerLeave={() => onHover(null)}
                  onClick={() => onTogglePin(s.carId)}
                >
                  <rect x={labelX - 4} y={ly - 6} width={margin.right - 2} height={12} fill="transparent" />
                  {!out && Math.abs(ly - ay) > 3 ? <path d={`M${x(s.lastLap) + 1} ${ay}L${labelX - 1} ${ly}`} stroke={INK.faint} fill="none" /> : null}
                  <rect x={labelX} y={ly - 4} width={3} height={8} rx={1} fill={index.color(s.carId)} opacity={strong ? 1 : 0.5} />
                  <text x={labelX + 6} y={ly} dy="0.34em" className={`font-display text-[10px] tracking-[0.06em] ${strong ? 'fill-ink-50 font-bold' : 'fill-ink-500 font-medium'}`}>
                    {index.driver(s.carId).code}
                    {out ? ' ×' : ''}
                  </text>
                </g>
              );
            })}
            {cursorLap !== null ? (
              <g pointerEvents="none">
                <Crosshair plot={plot} x={x(cursorLap)} />
                {cursorCars.map((c) => (
                  <circle key={c.s.carId} cx={x(cursorLap)} cy={y(c.value)} r={3} fill={styleOf(c.s.carId).color} stroke="var(--color-carbon-900)" strokeWidth={1.5} />
                ))}
              </g>
            ) : null}
          </svg>
          <CursorOverlay plot={plot} values={geometry.snap} x={x} cursor={cursorLap} onCursor={handleCursor} onCommit={onReplay} home={replayLap} ariaLabel="Lap cursor: press Enter to replay the lap" valueText={valueText} />
        </>
      ) : null}
      <ChartTooltip anchor={cursorLap !== null ? cursor : null}>
        {cursorLap !== null ? (
          <>
            <TooltipTitle note={cursorFlag ? FLAG_LABEL[cursorFlag.flag] : undefined}>{cursorLap === 0 ? 'Grid' : `Lap ${cursorLap}`}</TooltipTitle>
            <TooltipGrid>
              {cursorCars.map(({ s, record, value }) => {
                const style = styleOf(s.carId);
                return (
                  <TooltipRow
                    key={s.carId}
                    swatch={<LineKey color={style.color} dashed={style.dash !== undefined} weight={style.width} />}
                    value={valueLabel(value)}
                    name={index.driver(s.carId).code}
                    detail={
                      record ? (
                        <>
                          {metric === 'POSITION' ? (record.position === 1 ? 'leader' : gapText(record.gapToLeader)) : `P${record.position}`}
                          <TyreBadge compound={record.compound} size={11} />
                          {record.tyreAge}
                          {record.pitIn ? <span className="rounded-[1px] border border-carbon-500 px-0.5 font-display text-[9px] tracking-wider text-ink-100">PIT</span> : null}
                        </>
                      ) : undefined
                    }
                  />
                );
              })}
            </TooltipGrid>
            <div className="mt-1 border-t border-carbon-700 pt-0.5 font-display text-[9px] uppercase tracking-[0.1em] text-ink-500">Click to replay this lap</div>
          </>
        ) : null}
      </ChartTooltip>
    </div>
  );
});

// ───────────────────────────────────────────────────────────────── stints ──

const StintChart = memo(function StintChart(props: ChartCommonProps) {
  const { session, index, laps, lapCount, latest, spans, finalRows, retired, hoverId, onHover, replayLap, live, onReplay } = props;
  const [ref, size] = useElementSize<HTMLDivElement>();
  const [tip, setTip] = useState<{ stint: Stint; clientX: number; clientY: number } | null>(null);
  const xMax = Math.max(latest, 5);
  const margin = { left: 62, right: 10, top: 14, bottom: 18 };
  const plot: PlotRect = { left: margin.left, top: margin.top, width: Math.max(10, size.width - margin.left - margin.right), height: Math.max(10, size.height - margin.top - margin.bottom) };
  const ready = size.width > 160 && size.height > 70;
  const rowHeight = plot.height / Math.max(1, finalRows.length);
  // Thin bars: never fill the row, cap the thickness.
  const bar = Math.max(5, Math.min(16, rowHeight - 3));
  const stintsByCar = useMemo(() => new Map<CarId, Stint[]>(finalRows.map((row) => [row.carId, carStints(laps[row.carId] ?? [])])), [laps, lapCount, finalRows]);
  const x = linearScale([0, xMax], [plot.left, plot.left + plot.width]);
  const ticks = lapTicks(0, xMax, plot.width);

  const average = (stint: Stint): number | null => {
    const clean = (laps[stint.carId] ?? []).filter((r) => r.lap >= stint.startLap && r.lap <= stint.endLap && !r.pitIn && !r.pitOut && !isNeutralFlag(r.flag));
    return clean.length > 0 ? clean.reduce((sum, r) => sum + r.lapTime, 0) / clean.length : null;
  };
  const tipAverage = tip ? average(tip.stint) : null;

  return (
    <div ref={ref} className="relative min-h-0 flex-1">
      {ready ? (
        <svg width={size.width} height={size.height} className="absolute inset-0 block" role="img" aria-label="Stints of every driver by compound on a shared lap axis" onPointerLeave={() => setTip(null)}>
          <FlagBands plot={plot} spans={spans} x={x} labelAbove />
          <LapAxis plot={plot} ticks={ticks} x={x} />
          {finalRows.map((row, i) => {
            const cy = plot.top + rowHeight * (i + 0.5);
            const own = session.playerCarIds.includes(row.carId);
            const stints = stintsByCar.get(row.carId) ?? [];
            return (
              <g key={row.carId} opacity={retired.has(row.carId) ? 0.6 : 1}>
                {own || hoverId === row.carId ? <rect x={0} y={cy - rowHeight / 2} width={size.width} height={rowHeight} className="fill-carbon-850" /> : null}
                <text x={15} y={cy} dy="0.34em" textAnchor="end" className="fill-ink-500 font-mono text-[9px] tabular">
                  {row.rank}
                </text>
                <rect x={21} y={cy - 4} width={3} height={8} rx={1} fill={index.color(row.carId)} />
                <text x={28} y={cy} dy="0.34em" className={`font-display text-[10px] tracking-[0.06em] ${own ? 'fill-ink-50 font-bold' : 'fill-ink-300 font-medium'}`}>
                  {index.driver(row.carId).code}
                </text>
                {stints.map((stint) => {
                  const x0 = x(stint.startLap - 1) + 1;
                  const width = Math.max(1, x(stint.endLap) - x(stint.startLap - 1) - 2);
                  const full = `${TYRE_LETTERS[stint.compound]} ${stint.laps}`;
                  // Only print what fits inside the bar with padding; the tooltip and the pit-stop table carry the rest.
                  const text = bar >= 8 ? (width >= full.length * 5.6 + 8 ? full : width >= 13 ? TYRE_LETTERS[stint.compound] : '') : '';
                  return (
                    <g
                      key={stint.index}
                      className="cursor-pointer"
                      onPointerMove={(event) => {
                        setTip({ stint, clientX: event.clientX, clientY: event.clientY - 8 });
                        onHover(row.carId);
                      }}
                      onPointerLeave={() => onHover(null)}
                      onClick={() => onReplay(stint.endLap)}
                    >
                      {/* Hit area: the whole row height, larger than the bar. */}
                      <rect x={x0 - 1} y={cy - rowHeight / 2} width={width + 2} height={rowHeight} fill="transparent" />
                      <rect x={x0} y={cy - bar / 2} width={width} height={bar} rx={2} fill={TYRE_COLORS[stint.compound]} opacity={tip?.stint === stint ? 1 : 0.9} />
                      {text ? (
                        <text x={x0 + width / 2} y={cy} dy="0.35em" textAnchor="middle" fill={tyreInkOn(stint.compound)} className="pointer-events-none font-mono text-[9px] font-bold tabular">
                          {text}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </g>
            );
          })}
          {live ? null : <VRule plot={plot} x={x(replayLap)} label={`REPLAY L${replayLap}`} labelAtBottom />}
        </svg>
      ) : null}
      <ChartTooltip anchor={tip}>
        {tip ? (
          <>
            <TooltipTitle note={`Stint ${tip.stint.index + 1}`}>{index.driver(tip.stint.carId).code}</TooltipTitle>
            <div className="flex items-center gap-1.5">
              <TyreBadge compound={tip.stint.compound} size={14} />
              <span className="font-display font-semibold uppercase tracking-wider text-ink-50">{TYRE_LABELS[tip.stint.compound]}</span>
              <span className="font-mono text-ink-300">
                L{tip.stint.startLap}–L{tip.stint.endLap}
              </span>
            </div>
            <div className="mt-0.5 font-mono text-ink-100">
              <span className="font-bold text-ink-50">{tip.stint.laps} laps</span> · tyre age {tip.stint.endAge}
              {tipAverage !== null ? ` · avg green lap ${formatLapTime(tipAverage)}` : ''}
            </div>
            <div className="font-display text-[10px] uppercase tracking-[0.08em] text-ink-500">
              {tip.stint.endedByPit ? `Pitted at the end of L${tip.stint.endLap}` : retired.has(tip.stint.carId) ? 'Retired' : 'Stint in progress'}
            </div>
          </>
        ) : null}
      </ChartTooltip>
    </div>
  );
});

// ────────────────────────────────────────────────────────────── pit stops ──

const VERDICT_TEXT: Record<RivalVerdict['outcome'], string> = {
  UNDERCUT: 'Undercut',
  OVERCUT: 'Overcut',
  JUMPED: 'Pit jump',
  NO_GAIN: 'No gain',
  HELD: 'Held',
  LOST_UNDERCUT: 'Undercut by',
  LOST_OVERCUT: 'Overcut by',
  LOST: 'Pit loss',
  PENDING: 'Pending',
  NO_RESPONSE: 'No answer',
  NO_RIVAL_STOP: 'No stop',
  RETIRED: 'Retired',
};

/** Long form of each verdict, shown as the cell's tooltip. */
const VERDICT_HELP: Record<RivalVerdict['outcome'], string> = {
  UNDERCUT: 'stopped first and came out ahead',
  OVERCUT: 'stayed out longer and came out ahead',
  JUMPED: 'both stopped on the same lap; left the pits ahead',
  NO_GAIN: 'still behind once both had stopped',
  HELD: 'still ahead once both had stopped',
  LOST_UNDERCUT: 'the rival stopped first and came out ahead',
  LOST_OVERCUT: 'the rival stayed out longer and came out ahead',
  LOST: 'both stopped on the same lap; the rival left the pits ahead',
  PENDING: 'the rival has not stopped yet, or the laps needed are not completed',
  NO_RESPONSE: 'the rival did not stop before our next stop',
  NO_RIVAL_STOP: 'the rival never stopped again; compared on the last lap',
  RETIRED: 'one of the two cars retired before the cycle was complete',
};

function Verdict({ verdict, index }: { verdict: RivalVerdict | null; index: SessionIndex }) {
  if (!verdict) return <span className="text-ink-600">—</span>;
  const gained = verdict.relation === 'AHEAD' && verdict.aheadAfter === true;
  const lost = verdict.relation === 'BEHIND' && verdict.aheadAfter === false;
  const undecided = verdict.aheadAfter === null;
  const glyph = undecided ? '·' : gained ? '▲' : lost ? '▼' : '=';
  const describe = `${index.driver(verdict.rivalId).code} was directly ${verdict.relation === 'AHEAD' ? 'ahead' : 'behind'}${verdict.rivalStopLap !== null ? ` and stopped on L${verdict.rivalStopLap}` : ''}: ${VERDICT_HELP[verdict.outcome]}${verdict.evalLap !== null ? ` (compared at the end of L${verdict.evalLap})` : ''}`;
  return (
    <span className="flex items-center gap-1" title={describe}>
      <DriverKey carId={verdict.rivalId} index={index} />
      <span className={`w-2.5 text-center ${gained ? 'text-ok' : lost ? 'text-crit' : 'text-ink-500'}`}>{glyph}</span>
      <span className={`font-display uppercase tracking-[0.06em] ${undecided ? 'text-ink-500' : 'text-ink-100'}`}>{VERDICT_TEXT[verdict.outcome]}</span>
      {verdict.gapAfter !== null ? <span className="text-ink-300">{formatDelta(verdict.gapAfter, 1)}</span> : null}
      {verdict.rivalStopLap !== null ? <span className="text-ink-500">L{verdict.rivalStopLap}</span> : null}
    </span>
  );
}

interface PitStopTableProps {
  impacts: PitStopImpact[];
  session: SessionInfo;
  index: SessionIndex;
  allCars: boolean;
  replayLap: number;
  onReplay: (lap: number) => void;
}

/** Every stop with what it cost and what it achieved: net position and the verdict against both neighbours. */
const PitStopTable = memo(function PitStopTable({ impacts, session, index, allCars, replayLap, onReplay }: PitStopTableProps) {
  const rows = allCars ? impacts : impacts.filter((impact) => session.playerCarIds.includes(impact.stop.carId));
  if (rows.length === 0) {
    return <EmptyState title="No pit stop yet" hint={allCars ? 'Stops appear here as soon as a car comes in.' : 'Your cars have not stopped yet. Switch to ALL CARS to see the rest of the field.'} />;
  }
  const headers: [string, string][] = [
    ['Car', ''],
    ['Lap', 'In-lap'],
    ['Flag', 'Flag shown when the car stopped'],
    ['Tyres', 'Compound removed → fitted'],
    ['Stop', 'Stationary time, plus the time queued behind the team-mate in a double stack'],
    ['Lost', 'Total time lost versus staying out, and the difference to a nominal stop under that flag'],
    ['Position', 'Before the stop → at pit exit'],
    ['Net effect', 'Position five laps after the stop (or on the latest lap) versus before it'],
    ['vs car ahead', 'Who was ahead once both cars had stopped · gap (+ = we are ahead) · rival in-lap'],
    ['vs car behind', 'Who was ahead once both cars had stopped · gap (+ = we are ahead) · rival in-lap'],
  ];
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-2xs">
        <caption className="sr-only">Pit stops and their impact</caption>
        <thead className="sticky top-0 z-10 bg-carbon-850">
          <tr className="text-left">
            {headers.map(([label, title]) => (
              <th key={label} scope="col" title={title || undefined} className="border-b border-carbon-700 px-1.5 py-1 font-normal">
                <span className="pw-label whitespace-nowrap">{label}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono tabular">
          {rows.map((impact) => {
            const { stop } = impact;
            const own = session.playerCarIds.includes(stop.carId);
            const redFlagChange = stop.flag === 'RED' && stop.timeLost === 0;
            const nominal = pitLossUnderFlag(session.track, stop.flag);
            return (
              <tr
                key={`${stop.carId}-${stop.lap}`}
                className={`cursor-pointer border-b border-carbon-700/60 hover:bg-carbon-850 ${own && allCars ? 'bg-carbon-850' : ''} ${stop.lap > replayLap ? 'opacity-45' : ''}`}
                title={`Stop ${impact.stopNumber} · ${stop.reason.replace('_', ' ').toLowerCase()} · click to replay L${stop.lap}`}
                onClick={() => onReplay(stop.lap)}
              >
                <td className="whitespace-nowrap px-1.5 py-1">
                  <DriverKey carId={stop.carId} index={index} strong={own} />
                </td>
                <td className="whitespace-nowrap px-1.5 py-1 text-ink-50">L{stop.lap}</td>
                <td className="whitespace-nowrap px-1.5 py-1 font-display tracking-wider">
                  <FlagChip flag={stop.flag} />
                </td>
                <td className="whitespace-nowrap px-1.5 py-1">
                  <span className="flex items-center gap-1 text-ink-600">
                    <TyreBadge compound={stop.fromCompound} size={13} />
                    →
                    <TyreBadge compound={stop.toCompound} size={13} />
                  </span>
                </td>
                <td className="whitespace-nowrap px-1.5 py-1 text-ink-100">
                  {redFlagChange ? <span className="font-display tracking-wider text-ink-300">RED FLAG</span> : `${stop.stationaryTime.toFixed(2)} s`}
                  {stop.queueTime > 0.05 ? <span className="text-ink-300"> +{stop.queueTime.toFixed(1)} queue</span> : null}
                </td>
                <td className="whitespace-nowrap px-1.5 py-1">
                  {redFlagChange ? (
                    <span className="text-ink-600">—</span>
                  ) : (
                    <>
                      <span className="font-bold text-ink-50">{stop.timeLost.toFixed(1)} s</span> <span className="text-ink-500">{formatDelta(stop.timeLost - nominal, 1)}</span>
                    </>
                  )}
                </td>
                <td className="whitespace-nowrap px-1.5 py-1 text-ink-100">
                  P{stop.positionBefore} → {stop.positionAfter === null ? '…' : `P${stop.positionAfter}`}
                </td>
                <td className="whitespace-nowrap px-1.5 py-1">
                  {impact.netPosition === null || impact.netDelta === null ? (
                    <span className="text-ink-600">…</span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <span className="font-bold text-ink-50">P{impact.netPosition}</span>
                      <span className={impact.netDelta > 0 ? 'text-ok' : impact.netDelta < 0 ? 'text-crit' : 'text-ink-500'}>{impact.netDelta > 0 ? '▲' : impact.netDelta < 0 ? '▼' : '='}</span>
                      <span className="text-ink-100">{impact.netDelta === 0 ? '' : Math.abs(impact.netDelta)}</span>
                      <span className="text-ink-500">
                        L{impact.netLap}
                        {impact.netSettled ? '' : ' prov.'}
                      </span>
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-1.5 py-1">
                  <Verdict verdict={impact.ahead} index={index} />
                </td>
                <td className="whitespace-nowrap px-1.5 py-1">
                  <Verdict verdict={impact.behind} index={index} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});
