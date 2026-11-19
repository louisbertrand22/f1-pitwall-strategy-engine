/**
 * Shared building blocks of the hand-rolled SVG charts: measuring, axes, flag bands, legend keys, the
 * crosshair cursor (pointer + keyboard) and the single tooltip that follows it.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode, RefCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChartLine, Table2 } from 'lucide-react';
import type { FlagSpan, NeutralFlag } from './raceData';

// ───────────────────────────────────────────────────────────────── tokens ──

/**
 * Tailwind 4 only emits the theme variables it sees used by a utility class. Naming these utilities
 * keeps the `var(--color-…)` paints used in inline SVG attributes below alive in the stylesheet.
 */
export const TOKEN_UTILITIES =
  'stroke-series-1 stroke-series-2 stroke-series-3 stroke-series-4 stroke-series-5 stroke-series-6 stroke-series-7 stroke-series-8 ' +
  'stroke-chart-grid stroke-chart-axis stroke-ink-50 stroke-ink-100 stroke-ink-300 stroke-ink-500 stroke-ink-600 ' +
  'fill-carbon-900 fill-carbon-850 fill-flag-sc fill-flag-yellow fill-flag-red fill-tyre-inter fill-tyre-wet fill-tyre-hard';

/** Validated categorical order (dataviz validator, dark surface #0c1016) – assign in sequence, never cycle. */
export const SERIES: readonly string[] = [
  'var(--color-series-1)',
  'var(--color-series-2)',
  'var(--color-series-3)',
  'var(--color-series-4)',
  'var(--color-series-5)',
  'var(--color-series-6)',
  'var(--color-series-7)',
  'var(--color-series-8)',
];

export const INK = {
  strong: 'var(--color-ink-50)',
  primary: 'var(--color-ink-100)',
  secondary: 'var(--color-ink-300)',
  muted: 'var(--color-ink-500)',
  faint: 'var(--color-ink-600)',
} as const;

export const SURFACE = 'var(--color-carbon-900)';

export const FLAG_COLOR: Record<NeutralFlag, string> = {
  SC: 'var(--color-flag-sc)',
  VSC: 'var(--color-flag-sc)',
  YELLOW: 'var(--color-flag-yellow)',
  RED: 'var(--color-flag-red)',
};

export const FLAG_LABEL: Record<NeutralFlag, string> = { SC: 'SC', VSC: 'VSC', YELLOW: 'YEL', RED: 'RED' };

/** Axis / annotation text: muted ink, tabular mono figures. */
export const AXIS_TEXT = 'fill-ink-500 font-mono text-[10px] tabular';
/** Surface-coloured outline that keeps a label readable where it crosses a line. */
export const TEXT_HALO = 'stroke-carbon-900 [paint-order:stroke] [stroke-width:3px] [stroke-linejoin:round]';

// ────────────────────────────────────────────────────────────── measuring ──

export interface ElementSize {
  width: number;
  height: number;
}

export interface PlotRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Size of an element, tracked with a ResizeObserver. Attach the returned ref callback to the element. */
export function useElementSize<T extends HTMLElement>(): [RefCallback<T>, ElementSize] {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  const ref = useCallback((node: T | null) => {
    if (!node) return undefined;
    const update = (width: number, height: number): void => {
      const w = Math.floor(width);
      const h = Math.floor(height);
      setSize((previous) => (previous.width === w && previous.height === h ? previous : { width: w, height: h }));
    };
    update(node.clientWidth, node.clientHeight);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) update(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

// ───────────────────────────────────────────────────────────── svg pieces ──

/** Horizontal hairlines. Solid and recessive: dashing is reserved for projections. */
export function HGrid({ plot, ys }: { plot: PlotRect; ys: readonly number[] }) {
  return (
    <g className="stroke-chart-grid" shapeRendering="crispEdges">
      {ys.map((y) => (
        <line key={y} x1={plot.left} x2={plot.left + plot.width} y1={Math.round(y) + 0.5} y2={Math.round(y) + 0.5} />
      ))}
    </g>
  );
}

export interface LapAxisProps {
  plot: PlotRect;
  ticks: readonly number[];
  x: (lap: number) => number;
  /** Vertical hairlines at the ticks. */
  grid?: boolean;
  title?: string;
}

/** Bottom lap axis: baseline, tick labels and optional vertical hairlines. */
export function LapAxis({ plot, ticks, x, grid = true, title = 'LAP' }: LapAxisProps) {
  const bottom = plot.top + plot.height;
  return (
    <g>
      {grid ? (
        <g className="stroke-chart-grid" shapeRendering="crispEdges">
          {ticks.map((lap) => (
            <line key={lap} x1={Math.round(x(lap)) + 0.5} x2={Math.round(x(lap)) + 0.5} y1={plot.top} y2={bottom} />
          ))}
        </g>
      ) : null}
      <line className="stroke-chart-axis" shapeRendering="crispEdges" x1={plot.left} x2={plot.left + plot.width} y1={Math.round(bottom) + 0.5} y2={Math.round(bottom) + 0.5} />
      {ticks.map((lap) => (
        <text key={lap} x={x(lap)} y={bottom + 12} textAnchor="middle" className={AXIS_TEXT}>
          {lap}
        </text>
      ))}
      <text x={plot.left - 14} y={bottom + 12} textAnchor="end" className="fill-ink-600 font-display text-[9px] font-semibold tracking-[0.12em]">
        {title}
      </text>
    </g>
  );
}

export interface ValueAxisProps {
  plot: PlotRect;
  ticks: readonly number[];
  y: (value: number) => number;
  format: (value: number) => string;
}

/** Left value axis: tick labels only (the grid carries the lines). */
export function ValueAxis({ plot, ticks, y, format }: ValueAxisProps) {
  return (
    <g>
      {ticks.map((value) => (
        <text key={value} x={plot.left - 6} y={y(value)} dy="0.32em" textAnchor="end" className={AXIS_TEXT}>
          {format(value)}
        </text>
      ))}
    </g>
  );
}

export interface FlagBandsProps {
  plot: PlotRect;
  spans: readonly FlagSpan[];
  /** Laps-completed → px. A lap L covers [L − 1, L]. */
  x: (lap: number) => number;
  /** Print the labels in the top margin (needs ≥ 12 px) instead of inside the plot. */
  labelAbove?: boolean;
}

/**
 * Neutralisations as background bands: a faint full-height tint, a solid strip along the top edge and a
 * text label (never colour alone). Local yellows only get the strip – they do not change strategy.
 */
export function FlagBands({ plot, spans, x, labelAbove = false }: FlagBandsProps) {
  const right = plot.left + plot.width;
  let lastLabelX = -Infinity;
  return (
    <g>
      {spans.map((span) => {
        const x0 = Math.max(plot.left, x(span.fromLap - 1));
        const x1 = Math.min(right, x(span.toLap));
        if (x1 <= x0) return null;
        const color = FLAG_COLOR[span.flag];
        const showLabel = x0 - lastLabelX >= 24;
        if (showLabel) lastLabelX = x0;
        return (
          <g key={`${span.flag}-${span.fromLap}`}>
            {span.flag === 'YELLOW' ? null : <rect x={x0} y={plot.top} width={x1 - x0} height={plot.height} fill={color} opacity={span.flag === 'VSC' ? 0.06 : 0.1} />}
            <rect x={x0} y={plot.top} width={x1 - x0} height={span.flag === 'YELLOW' ? 2 : 3} fill={color} opacity={0.9} />
            {showLabel ? (
              <text x={x0 + (labelAbove ? 0 : 3)} y={labelAbove ? plot.top - 3 : plot.top + 13} className={`fill-ink-300 font-display text-[9px] font-semibold tracking-[0.1em] ${TEXT_HALO}`}>
                {FLAG_LABEL[span.flag]}
              </text>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

export interface VRuleProps {
  plot: PlotRect;
  x: number;
  label?: string;
  color?: string;
  /** Put the label at the bottom of the plot instead of the top. */
  labelAtBottom?: boolean;
}

/** Vertical reference rule (NOW, REPLAY) with its label kept inside the plot. */
export function VRule({ plot, x, label, color = INK.secondary, labelAtBottom = false }: VRuleProps) {
  if (x < plot.left - 0.5 || x > plot.left + plot.width + 0.5) return null;
  const px = Math.round(x) + 0.5;
  const flip = x > plot.left + plot.width - 44;
  return (
    <g>
      <line x1={px} x2={px} y1={plot.top} y2={plot.top + plot.height} stroke={color} shapeRendering="crispEdges" />
      {label ? (
        <text
          x={flip ? px - 4 : px + 4}
          y={labelAtBottom ? plot.top + plot.height - 5 : plot.top + 10}
          textAnchor={flip ? 'end' : 'start'}
          className={`fill-ink-100 font-display text-[9px] font-semibold tracking-[0.12em] ${TEXT_HALO}`}
        >
          {label}
        </text>
      ) : null}
    </g>
  );
}

export type MarkerShapeName = 'circle' | 'square' | 'diamond' | 'triangle' | 'triangleDown';

/** Shape per series slot: a second channel next to hue (orange and yellow sit close under CVD). */
export const SLOT_SHAPES: readonly MarkerShapeName[] = ['circle', 'square', 'diamond', 'triangle', 'triangleDown', 'circle', 'square', 'diamond'];

export interface MarkerProps {
  shape: MarkerShapeName;
  x: number;
  y: number;
  /** Half-size in px (≥ 4 for a data marker). */
  r?: number;
  color: string;
  /** Surface ring that keeps the marker legible where it sits on a line. */
  ring?: boolean;
}

export function Marker({ shape, x, y, r = 4.5, color, ring = true }: MarkerProps) {
  const common = { fill: color, stroke: ring ? SURFACE : 'none', strokeWidth: ring ? 2 : 0, paintOrder: 'stroke' as const };
  switch (shape) {
    case 'square':
      return <rect x={x - r * 0.85} y={y - r * 0.85} width={r * 1.7} height={r * 1.7} {...common} />;
    case 'diamond':
      return <path d={`M${x} ${y - r * 1.15}L${x + r * 1.15} ${y}L${x} ${y + r * 1.15}L${x - r * 1.15} ${y}Z`} {...common} />;
    case 'triangle':
      return <path d={`M${x} ${y - r * 1.1}L${x + r * 1.1} ${y + r * 0.85}L${x - r * 1.1} ${y + r * 0.85}Z`} {...common} />;
    case 'triangleDown':
      return <path d={`M${x} ${y + r * 1.1}L${x + r * 1.1} ${y - r * 0.85}L${x - r * 1.1} ${y - r * 0.85}Z`} {...common} />;
    default:
      return <circle cx={x} cy={y} r={r} {...common} />;
  }
}

// ──────────────────────────────────────────────────────── legend & header ──

export interface LineKeyProps {
  color: string;
  dashed?: boolean;
  /** Stroke width in px. */
  weight?: number;
  width?: number;
  marker?: MarkerShapeName;
}

/** Short stroke of a series' colour: the key used in legends, tables and tooltip rows. */
export function LineKey({ color, dashed = false, weight = 2, width = 18, marker }: LineKeyProps) {
  return (
    <svg width={width} height={10} viewBox={`0 0 ${width} 10`} className="shrink-0" aria-hidden="true">
      <line x1={1} x2={width - 1} y1={5} y2={5} stroke={color} strokeWidth={weight} strokeLinecap="round" strokeDasharray={dashed ? '4 3' : undefined} />
      {marker ? <Marker shape={marker} x={width / 2} y={5} r={3.2} color={color} ring={false} /> : null}
    </svg>
  );
}

export function LegendItem({ swatch, label }: { swatch: ReactNode; label: string }) {
  return (
    <span className="flex items-center gap-1 whitespace-nowrap font-display text-[10px] font-medium uppercase tracking-[0.08em] text-ink-300">
      {swatch}
      {label}
    </span>
  );
}

/** Strip above a plot: what the y-axis measures on the left, the legend on the right. */
export function ChartHeader({ title, note, children }: { title: string; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-[18px] shrink-0 items-center gap-3 overflow-hidden px-2">
      <span className="pw-label shrink-0 whitespace-nowrap">{title}</span>
      {note ? <span className="min-w-0 truncate font-mono text-[10px] text-ink-500">{note}</span> : null}
      <div className="ml-auto flex shrink-0 items-center gap-3">{children}</div>
    </div>
  );
}

export function EmptyState({ icon, title, hint, children }: { icon?: ReactNode; title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-1.5 px-4 text-center">
      {icon ? <span className="text-ink-600">{icon}</span> : null}
      <p className="pw-title text-ink-300">{title}</p>
      {hint ? <p className="max-w-md text-xs text-ink-500">{hint}</p> : null}
      {children}
    </div>
  );
}

/** Chart ⇄ data-table switch: every chart has a table twin so no value is gated behind hover. */
export function ViewToggle({ table, onToggle }: { table: boolean; onToggle: (table: boolean) => void }) {
  return (
    <button
      type="button"
      className="pw-btn px-1.5 py-1"
      aria-pressed={table}
      data-active={table}
      title={table ? 'Show the chart' : 'Show the data table'}
      aria-label={table ? 'Show the chart' : 'Show the data table'}
      onClick={() => onToggle(!table)}
    >
      {table ? <ChartLine size={12} strokeWidth={1.75} /> : <Table2 size={12} strokeWidth={1.75} />}
    </button>
  );
}

export interface SeriesTableColumn {
  key: string;
  label: string;
  swatch?: ReactNode;
  align?: 'left' | 'right';
}

export interface SeriesTableRow {
  key: string;
  cells: ReactNode[];
  /** Highlight (current lap, replay lap…). */
  marked?: boolean;
  dimmed?: boolean;
}

/** Dense scrollable table twin of a chart. */
export function SeriesTable({ columns, rows, caption }: { columns: readonly SeriesTableColumn[]; rows: readonly SeriesTableRow[]; caption: string }) {
  return (
    <div className="h-full min-h-0 overflow-auto">
      <table className="w-full border-collapse text-2xs">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-10 bg-carbon-850">
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={`border-b border-carbon-700 px-2 py-1 font-normal ${column.align === 'left' ? 'text-left' : 'text-right'}`}>
                <span className={`pw-label inline-flex items-center gap-1 ${column.align === 'left' ? '' : 'justify-end'}`}>
                  {column.swatch}
                  {column.label}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono tabular">
          {rows.map((row) => (
            <tr key={row.key} className={`border-b border-carbon-700/60 ${row.marked ? 'bg-carbon-800 text-ink-50' : 'text-ink-100'} ${row.dimmed ? 'opacity-60' : ''}`}>
              {row.cells.map((cell, i) => (
                <td key={columns[i]?.key ?? i} className={`whitespace-nowrap px-2 py-[3px] ${columns[i]?.align === 'left' ? 'text-left' : 'text-right'}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ──────────────────────────────────────────────────────── cursor & tooltip ──

export interface CursorInfo {
  /** Snapped data position (lap). */
  value: number;
  /** Viewport coordinates of the crosshair's top end, for the tooltip. */
  clientX: number;
  clientY: number;
  /** Pointer height inside the plot (px from the plot top); null when driven from the keyboard. */
  pointerY: number | null;
}

export interface CursorOverlayProps {
  plot: PlotRect;
  /** Ascending snap positions in data units. */
  values: readonly number[];
  /** Data → px (same coordinates as `plot`). */
  x: (value: number) => number;
  cursor: number | null;
  onCursor: (info: CursorInfo | null) => void;
  /** Click / Enter on the current position. */
  onCommit?: (value: number) => void;
  /** Position taken when the cursor is first moved from the keyboard (defaults to the last one). */
  home?: number;
  ariaLabel: string;
  /** Text equivalent of the tooltip at the cursor, announced to assistive technology. */
  valueText: string;
}

function nearestIndex(values: readonly number[], x: (value: number) => number, px: number): number {
  let lo = 0;
  let hi = values.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x(values[mid]!) <= px) lo = mid;
    else hi = mid;
  }
  return Math.abs(x(values[hi]!) - px) < Math.abs(x(values[lo]!) - px) ? hi : lo;
}

/**
 * Transparent hit layer over the plot. The pointer only has to be near an x position (never on a 2 px
 * line); the same cursor is reachable from the keyboard as a slider (←/→, Home/End, Esc).
 */
export function CursorOverlay({ plot, values, x, cursor, onCursor, onCommit, home, ariaLabel, valueText }: CursorOverlayProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const byKeyboard = useRef(false);

  const emit = (index: number, pointerY: number | null): void => {
    const node = ref.current;
    const value = values[index];
    if (!node || value === undefined) return;
    const rect = node.getBoundingClientRect();
    onCursor({ value, clientX: rect.left + x(value) - plot.left, clientY: rect.top + 2, pointerY });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (values.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    byKeyboard.current = false;
    emit(nearestIndex(values, x, event.clientX - rect.left + plot.left), event.clientY - rect.top);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (values.length === 0) return;
    const last = values.length - 1;
    let current = cursor === null ? -1 : values.indexOf(cursor);
    if (current < 0) current = home !== undefined ? nearestIndex(values, (v) => v, home) : last;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = cursor === null ? current : Math.max(0, current - 1);
        break;
      case 'ArrowRight':
        next = cursor === null ? current : Math.min(last, current + 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      case 'Escape':
        onCursor(null);
        return;
      case 'Enter':
      case ' ':
        if (cursor !== null && onCommit) {
          event.preventDefault();
          onCommit(cursor);
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    byKeyboard.current = true;
    emit(next, null);
  };

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      aria-valuemin={values[0] ?? 0}
      aria-valuemax={values[values.length - 1] ?? 0}
      aria-valuenow={cursor ?? values[values.length - 1] ?? 0}
      aria-valuetext={valueText}
      className="absolute cursor-crosshair touch-none"
      style={{ left: plot.left, top: plot.top, width: plot.width, height: plot.height }}
      onPointerMove={onPointerMove}
      onPointerLeave={() => {
        if (!byKeyboard.current) onCursor(null);
      }}
      onClick={() => {
        if (cursor !== null && onCommit) onCommit(cursor);
      }}
      onKeyDown={onKeyDown}
      onBlur={() => {
        byKeyboard.current = false;
        onCursor(null);
      }}
    />
  );
}

/** Crosshair hairline drawn inside the SVG at the cursor position. */
export function Crosshair({ plot, x }: { plot: PlotRect; x: number }) {
  const px = Math.round(x) + 0.5;
  return <line x1={px} x2={px} y1={plot.top} y2={plot.top + plot.height} stroke={INK.muted} shapeRendering="crispEdges" pointerEvents="none" />;
}

/**
 * The single tooltip of a chart. Rendered in a portal with fixed positioning so that the panel's
 * `overflow: hidden` never clips it; it flips to the left of the crosshair near the right edge.
 */
export function ChartTooltip({ anchor, children }: { anchor: { clientX: number; clientY: number } | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const ax = anchor ? anchor.clientX : null;
  const ay = anchor ? anchor.clientY : null;

  // Runs after every render: the content (hence the size) changes with the cursor position.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || ax === null || ay === null) return;
    const { width, height } = node.getBoundingClientRect();
    const margin = 6;
    let left = ax + 12;
    if (left + width > window.innerWidth - margin) left = ax - 12 - width;
    left = Math.max(margin, left);
    const top = Math.max(margin, Math.min(ay, window.innerHeight - height - margin));
    setPosition((previous) => (previous && previous.left === left && previous.top === top ? previous : { left, top }));
  });

  if (ax === null || ay === null) return null;
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-50 rounded-[2px] border border-carbon-500 bg-carbon-850 px-2 py-1.5 text-2xs text-ink-100"
      style={{ left: position ? position.left : -9999, top: position ? position.top : -9999, colorScheme: 'dark' }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function TooltipTitle({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-3 border-b border-carbon-700 pb-1">
      <span className="font-display text-xs font-semibold uppercase tracking-[0.12em] text-ink-50">{children}</span>
      {note ? <span className="font-display text-[10px] uppercase tracking-[0.1em] text-ink-500">{note}</span> : null}
    </div>
  );
}

export interface TooltipRowProps {
  /** Line key of the series. */
  swatch: ReactNode;
  /** The number the reader wants: strong. */
  value: string;
  /** Series name: secondary. */
  name: string;
  detail?: ReactNode;
}

/** Tooltip rows live in a 4-column grid: key · value · name · detail. Values lead, names follow. */
export function TooltipRow({ swatch, value, name, detail }: TooltipRowProps) {
  return (
    <>
      <span className="flex items-center">{swatch}</span>
      <span className="text-right font-mono font-bold tabular text-ink-50">{value}</span>
      <span className="font-display uppercase tracking-[0.06em] text-ink-300">{name}</span>
      <span className="flex items-center gap-1 font-mono tabular text-ink-500">{detail}</span>
    </>
  );
}

export function TooltipGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[auto_auto_auto_auto] items-center gap-x-2 gap-y-0.5 whitespace-nowrap">{children}</div>;
}
