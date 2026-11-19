import { memo, useId, useMemo, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { ChartLine, Table2 } from 'lucide-react';
import type { StrategyEvaluation } from '../../simulation/physicsModel';
import type { PlanId } from '../../simulation/types';
import { formatLapTime } from '../../lib/format';
import { useElementSize } from './shared';

export interface PaceSeries {
  id: PlanId;
  /** CSS colour of the line (categorical series token). */
  color: string;
  evaluation: StrategyEvaluation;
}

export interface PaceChartProps {
  series: readonly PaceSeries[];
  raceLaps: number;
  /** Reference lap of the circuit (s): bounds how far past the stint pace the y-axis may stretch. */
  baseLapTime: number;
  /** Lap the car is on (live mode), drawn as a marker. */
  nowLap?: number | null;
  className?: string;
}

interface Prepared {
  id: PlanId;
  color: string;
  values: readonly number[];
  /** Per lap index: the lap is an in-lap or an out-lap (pit loss included), or a plain racing lap. */
  pit: readonly ('IN' | 'OUT' | null)[];
  /** Runs of plain racing laps (0-based lap indices, inclusive): one per stint. */
  runs: { from: number; to: number }[];
  /** In-laps (1-based). */
  stops: number[];
}

const MARGIN = { top: 8, right: 18, bottom: 17, left: 42 } as const;
const STEPS = [0.25, 0.5, 1, 2, 5, 10, 20] as const;

function prepare(series: PaceSeries): Prepared {
  const values = series.evaluation.lapTimes;
  const pit: ('IN' | 'OUT' | null)[] = values.map(() => null);
  const runs: { from: number; to: number }[] = [];
  const stops: number[] = [];
  const stints = series.evaluation.stints;
  let cursor = 0;
  stints.forEach((stint, k) => {
    const first = cursor;
    const last = cursor + stint.laps - 1;
    const hasStopBefore = k > 0;
    const hasStopAfter = k < stints.length - 1;
    if (hasStopBefore && first < pit.length) pit[first] = 'OUT';
    if (hasStopAfter && last < pit.length) {
      pit[last] = 'IN';
      stops.push(last + 1);
    }
    const from = first + (hasStopBefore ? 1 : 0);
    const to = Math.min(values.length - 1, last - (hasStopAfter ? 1 : 0));
    if (from <= to) runs.push({ from, to });
    cursor = last + 1;
  });
  return { id: series.id, color: series.color, values, pit, runs, stops };
}

function axisLabel(seconds: number, step: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  const digits = step < 1 ? (step < 0.5 ? 2 : 1) : 0;
  const text = rest.toFixed(digits);
  return `${minutes}:${rest < 10 ? '0' : ''}${text}`;
}

/**
 * Predicted clean-air pace of the three plans, lap time against lap. In- and out-laps carry the pit
 * loss and would flatten everything else, so the lines are cut at each stop (marked by a tick on the
 * axis) and the y-range follows the stint pace; the crosshair read-out still gives every lap's value.
 */
export const PaceChart = memo(function PaceChart({ series, raceLaps, baseLapTime, nowLap = null, className = '' }: PaceChartProps) {
  const [plotRef, size] = useElementSize<HTMLDivElement>();
  const [hoverLap, setHoverLap] = useState<number | null>(null);
  const [tableView, setTableView] = useState(false);
  const clipId = useId();
  const prepared = useMemo(() => series.map(prepare), [series]);

  const { width, height } = size;
  const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(1, height - MARGIN.top - MARGIN.bottom);
  const baseline = MARGIN.top + plotH;

  const scale = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const item of prepared) {
      for (const run of item.runs) {
        for (let i = run.from; i <= run.to; i++) {
          const value = item.values[i];
          if (value === undefined) continue;
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = baseLapTime;
      max = baseLapTime + 4;
    }
    // A stint run far past the cliff shoots up by 10 s+: let it leave the frame instead of squashing the rest.
    max = Math.min(max, min + Math.max(6, baseLapTime * 0.09));
    const span = Math.max(0.5, max - min);
    const maxTicks = Math.max(2, Math.floor(plotH / 26));
    const step = STEPS.find((s) => span / s <= maxTicks) ?? 20;
    const low = Math.floor((min - span * 0.04) / step) * step;
    const high = Math.ceil((max + span * 0.04) / step) * step;
    const ticks: number[] = [];
    for (let t = low; t <= high + 1e-9; t += step) ticks.push(Number(t.toFixed(4)));
    return { low, high, step, ticks };
  }, [prepared, baseLapTime, plotH]);

  const x = (lap: number) => MARGIN.left + ((lap - 1) / Math.max(1, raceLaps - 1)) * plotW;
  const y = (seconds: number) => baseline - ((seconds - scale.low) / Math.max(1e-6, scale.high - scale.low)) * plotH;

  const lapStep = raceLaps > 60 ? 20 : 10;
  const lapTicks: number[] = [1];
  for (let lap = lapStep; lap < raceLaps - lapStep * 0.35; lap += lapStep) lapTicks.push(lap);
  if (raceLaps > 1) lapTicks.push(raceLaps);

  // Direct labels at the line ends, pushed apart when two plans finish on the same pace.
  const endLabels = prepared
    .map((item) => {
      const run = item.runs[item.runs.length - 1];
      const value = run ? item.values[run.to] : undefined;
      if (!run || value === undefined) return null;
      const anchor = Math.min(baseline, Math.max(MARGIN.top, y(value)));
      return { id: item.id, x: x(run.to + 1), anchor, at: anchor };
    })
    .filter((label): label is { id: PlanId; x: number; anchor: number; at: number } => label !== null)
    .sort((a, b) => a.anchor - b.anchor);
  for (let i = 1; i < endLabels.length; i++) {
    const previous = endLabels[i - 1];
    const current = endLabels[i];
    if (previous && current && current.at - previous.at < 10) current.at = previous.at + 10;
  }

  const lapAt = (clientX: number, target: Element): number => {
    const rect = target.getBoundingClientRect();
    const ratio = (clientX - rect.left - MARGIN.left) / plotW;
    return Math.min(raceLaps, Math.max(1, Math.round(1 + ratio * (raceLaps - 1))));
  };
  const onMove = (event: PointerEvent<HTMLDivElement>) => setHoverLap(lapAt(event.clientX, event.currentTarget));
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = hoverLap ?? nowLap ?? 1;
    if (event.key === 'ArrowLeft') setHoverLap(Math.max(1, from - 1));
    else if (event.key === 'ArrowRight') setHoverLap(Math.min(raceLaps, from + 1));
    else if (event.key === 'Home') setHoverLap(1);
    else if (event.key === 'End') setHoverLap(raceLaps);
    else if (event.key === 'Escape') setHoverLap(null);
    else return;
    event.preventDefault();
  };

  const hoverX = hoverLap !== null ? x(hoverLap) : 0;
  const tooltipOnLeft = hoverX > MARGIN.left + plotW * 0.55;
  const ready = width > 0 && height > 0;

  return (
    <figure className={`flex min-h-0 min-w-0 flex-col ${className}`}>
      <figcaption className="flex h-6 shrink-0 items-center gap-2.5 px-2">
        <span className="pw-label text-ink-300">Predicted pace</span>
        {prepared.map((item) => (
          <span key={item.id} className="flex items-center gap-1">
            <span aria-hidden className="h-[2px] w-3.5 rounded-full" style={{ backgroundColor: item.color }} />
            <span className="font-display text-2xs font-semibold leading-none tracking-wider text-ink-300">{item.id}</span>
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span aria-hidden className="h-[5px] w-[2px] bg-ink-300" />
          <span className="pw-label">stop</span>
        </span>
        <button
          type="button"
          aria-pressed={tableView}
          title={tableView ? 'Show the chart' : 'Show the lap times as a table'}
          onClick={() => setTableView((value) => !value)}
          className="pw-btn ml-auto h-[18px] w-[22px] p-0"
        >
          {tableView ? <ChartLine size={11} strokeWidth={1.75} aria-hidden /> : <Table2 size={11} strokeWidth={1.75} aria-hidden />}
          <span className="sr-only">{tableView ? 'Chart view' : 'Table view'}</span>
        </button>
      </figcaption>

      {tableView ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1" tabIndex={0}>
          <table className="w-full border-collapse font-mono text-[10px] tabular">
            <thead className="sticky top-0 bg-carbon-900">
              <tr className="text-ink-500">
                <th scope="col" className="py-0.5 text-left font-medium">
                  LAP
                </th>
                {prepared.map((item) => (
                  <th key={item.id} scope="col" className="py-0.5 text-right font-medium">
                    PLAN {item.id}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: raceLaps }, (_, i) => (
                <tr key={i} className="border-t border-carbon-700/60">
                  <th scope="row" className="py-px text-left font-normal text-ink-500">
                    {i + 1}
                  </th>
                  {prepared.map((item) => (
                    <td key={item.id} className="py-px text-right text-ink-100">
                      {formatLapTime(item.values[i])}
                      <span className="inline-block w-7 text-left text-ink-500">{item.pit[i] ? ` ${item.pit[i]}` : ''}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          ref={plotRef}
          role="group"
          tabIndex={0}
          aria-label="Predicted lap time per lap for plans A, B and C. Use the left and right arrow keys to read a lap."
          onPointerMove={onMove}
          onPointerLeave={() => setHoverLap(null)}
          onBlur={() => setHoverLap(null)}
          onKeyDown={onKey}
          className="relative min-h-0 flex-1 focus-visible:-outline-offset-1"
        >
          {ready ? (
            <svg width={width} height={height} className="absolute inset-0 block" aria-hidden>
              <defs>
                <clipPath id={clipId}>
                  <rect x={MARGIN.left - 1} y={MARGIN.top - 1} width={plotW + 2} height={plotH + 1} />
                </clipPath>
              </defs>
              {scale.ticks.map((tick) => (
                <g key={tick}>
                  <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={Math.round(y(tick)) + 0.5} y2={Math.round(y(tick)) + 0.5} className="stroke-chart-grid" shapeRendering="crispEdges" />
                  <text x={MARGIN.left - 5} y={y(tick)} textAnchor="end" dominantBaseline="central" className="fill-ink-500 font-mono text-3xs">
                    {axisLabel(tick, scale.step)}
                  </text>
                </g>
              ))}
              <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={baseline + 0.5} y2={baseline + 0.5} className="stroke-chart-axis" shapeRendering="crispEdges" />
              {lapTicks.map((lap) => (
                <text key={lap} x={x(lap)} y={height - 3} textAnchor={lap === 1 ? 'start' : lap === raceLaps ? 'end' : 'middle'} className="fill-ink-500 font-mono text-3xs">
                  {lap === 1 ? 'L1' : lap}
                </text>
              ))}
              {nowLap !== null && nowLap >= 1 && nowLap <= raceLaps ? (
                <g>
                  <line x1={Math.round(x(nowLap)) + 0.5} x2={Math.round(x(nowLap)) + 0.5} y1={MARGIN.top} y2={baseline} className="stroke-ink-500" shapeRendering="crispEdges" />
                  <text x={x(nowLap) + 3} y={MARGIN.top + 7} className="fill-ink-300 font-display text-3xs font-semibold tracking-widest">
                    NOW
                  </text>
                </g>
              ) : null}
              <g clipPath={`url(#${clipId})`}>
                {prepared.map((item) =>
                  item.runs.map((run) => {
                    let d = '';
                    for (let i = run.from; i <= run.to; i++) {
                      const value = item.values[i];
                      if (value === undefined) continue;
                      d += `${d === '' ? 'M' : 'L'}${x(i + 1).toFixed(1)},${y(value).toFixed(1)}`;
                    }
                    return <path key={`${item.id}-${run.from}`} d={d} fill="none" stroke={item.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />;
                  }),
                )}
              </g>
              {prepared.map((item, row) =>
                item.stops.map((lap) => (
                  <rect key={`${item.id}-stop-${lap}`} x={x(lap) - 1} y={baseline - 5 - row * 6} width={2} height={5} fill={item.color} />
                )),
              )}
              {endLabels.map((label) => (
                <g key={label.id}>
                  {Math.abs(label.at - label.anchor) > 2 ? (
                    <line x1={label.x + 1} y1={label.anchor} x2={label.x + 5} y2={label.at} className="stroke-ink-600" />
                  ) : null}
                  <text x={label.x + 7} y={label.at} dominantBaseline="central" className="fill-ink-300 font-display text-2xs font-semibold">
                    {label.id}
                  </text>
                </g>
              ))}
              {hoverLap !== null ? (
                <g>
                  <line x1={Math.round(hoverX) + 0.5} x2={Math.round(hoverX) + 0.5} y1={MARGIN.top} y2={baseline} className="stroke-ink-300" shapeRendering="crispEdges" />
                  {prepared.map((item) => {
                    const value = item.values[hoverLap - 1];
                    if (value === undefined || item.pit[hoverLap - 1] || value > scale.high || value < scale.low) return null;
                    return <circle key={item.id} cx={hoverX} cy={y(value)} r={4} fill={item.color} className="stroke-carbon-900" strokeWidth={2} />;
                  })}
                </g>
              ) : null}
            </svg>
          ) : null}
          {hoverLap !== null && ready ? (
            <div
              role="status"
              className="pointer-events-none absolute top-1 z-10 rounded-[2px] border border-carbon-500 bg-carbon-950/95 px-1.5 py-1"
              style={tooltipOnLeft ? { right: width - hoverX + 8 } : { left: hoverX + 8 }}
            >
              <p className="pw-label text-ink-300">Lap {hoverLap}</p>
              {prepared.map((item) => (
                <p key={item.id} className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap">
                  <span aria-hidden className="h-[2px] w-3 rounded-full" style={{ backgroundColor: item.color }} />
                  <span className="font-mono text-2xs font-bold leading-3 tabular text-ink-50">{formatLapTime(item.values[hoverLap - 1])}</span>
                  <span className="font-display text-[10px] font-semibold leading-3 tracking-wider text-ink-300">
                    {item.id}
                    {item.pit[hoverLap - 1] === 'IN' ? ' · in-lap' : item.pit[hoverLap - 1] === 'OUT' ? ' · out-lap' : ''}
                  </span>
                </p>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </figure>
  );
});
