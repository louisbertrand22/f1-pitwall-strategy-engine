import { useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, Check, CloudRain, TriangleAlert } from 'lucide-react';
import type { WeatherRadarProps } from './contracts';
import { Panel, TyreBadge } from './ui';
import { formatPercent, formatTemp } from '../lib/format';
import { indexSession } from '../lib/session';
import { TYRE_COLORS } from '../lib/tyres';
import { COMPOUNDS, WEATHER_CROSSOVER, bestTyreClass } from '../simulation/physicsModel';
import type { TrackDefinition, TyreClass, TyreCompound } from '../simulation/types';
import {
  AXIS_TEXT,
  ChartHeader,
  ChartTooltip,
  Crosshair,
  CursorOverlay,
  HGrid,
  INK,
  LapAxis,
  LegendItem,
  LineKey,
  SERIES,
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
import type { CursorInfo, PlotRect } from './charts/chartKit';
import { areaPath, bandPath, linePath, sectorPath } from './charts/path';
import { lapTicks, linearScale } from './charts/scale';
import {
  detectLapBase,
  findCrossovers,
  forecastPoints,
  interpolateAtTime,
  lapNumberAt,
  observedPoints,
  thinOut,
} from './charts/weatherData';
import type { WeatherPoint } from './charts/weatherData';

const RAIN = SERIES[0]!;
const WETNESS = SERIES[2]!;
const MARGIN = { left: 34, right: 64, top: 6, bottom: 18 };
const CLASS_COMPOUNDS: Record<TyreClass, readonly TyreCompound[]> = { SLICK: ['SOFT', 'MEDIUM', 'HARD'], INTER: ['INTER'], WET: ['WET'] };
const CLASS_COLOR: Record<TyreClass, string> = { SLICK: INK.secondary, INTER: TYRE_COLORS.INTER, WET: TYRE_COLORS.WET };
const CLASSES: readonly TyreClass[] = ['SLICK', 'INTER', 'WET'];
/** Lead time covered by the radar scope (s). */
const SCOPE_RANGE = 1200;

const pct = (fraction: number): string => formatPercent(fraction);

function ClassBadges({ tyreClass, size = 13 }: { tyreClass: TyreClass; size?: number }) {
  return (
    <span className="inline-flex items-center gap-px">
      {CLASS_COMPOUNDS[tyreClass].map((compound) => (
        <TyreBadge key={compound} compound={compound} size={size} />
      ))}
    </span>
  );
}

function Tile({ label, value, children }: { label: string; value?: string; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-auto flex-col justify-center gap-0.5 overflow-hidden border-r border-carbon-700 px-2 last:border-r-0">
      <span className="pw-label whitespace-nowrap text-[9px]">{label}</span>
      <span className="flex items-baseline gap-1.5 whitespace-nowrap">
        {value !== undefined ? <span className="font-mono text-[15px] font-medium leading-none text-ink-50">{value}</span> : null}
        {children}
      </span>
    </div>
  );
}

/** Change expected over the next five minutes, in percentage points. */
function Trend({ now, later }: { now: number; later: number | null }) {
  if (later === null) return null;
  const points = Math.round((later - now) * 100);
  if (Math.abs(points) < 2) return <span className="font-mono text-[10px] text-ink-500">steady</span>;
  return (
    <span className="font-mono text-[10px] text-ink-300">
      {points > 0 ? '▲' : '▼'} {points > 0 ? '+' : '−'}
      {Math.abs(points)} in 5 min
    </span>
  );
}

function atLap(points: readonly WeatherPoint[], lap: number): WeatherPoint | null {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (lap < a.lap || lap > b.lap) continue;
    const f = b.lap > a.lap ? (lap - a.lap) / (b.lap - a.lap) : 0;
    const mix = (u: number, v: number): number => u + (v - u) * f;
    return { lap, raceTime: mix(a.raceTime, b.raceTime), rain: mix(a.rain, b.rain), wetness: mix(a.wetness, b.wetness), rainLow: mix(a.rainLow, b.rainLow), rainHigh: mix(a.rainHigh, b.rainHigh), forecast: b.forecast };
  }
  return null;
}

export function WeatherRadar(props: WeatherRadarProps) {
  const { session, snapshot, history, forecast, className = '' } = props;
  const index = indexSession(session);
  const raceLaps = session.raceLaps;
  const [table, setTable] = useState(false);
  const [cursor, setCursor] = useState<CursorInfo | null>(null);
  const [plotRef, size] = useElementSize<HTMLDivElement>();
  const [scopeRef, scopeBox] = useElementSize<HTMLDivElement>();

  const weather = snapshot.weather;
  const raceTime = snapshot.raceTime;
  const leader = snapshot.cars[0];
  const progress = Math.min(raceLaps, leader ? leader.lapsCompleted + leader.lapFraction : 0);
  const lapBase = detectLapBase(history.weather, forecast, raceTime, progress, session.track.baseLapTime * 1.04);

  const samples = history.weather;
  const observed = useMemo(() => thinOut(observedPoints(samples, lapBase), 260), [samples, samples.length, lapBase]);

  // The forecast only moves every few seconds of race time: bucket the clock so the series (and every
  // path built from it) is not rebuilt at snapshot rate.
  const bucket = Math.floor(raceTime / 4);
  const future = useMemo(() => {
    const now: WeatherPoint = { lap: progress, raceTime, rain: weather.rainIntensity, wetness: weather.trackWetness, rainLow: weather.rainIntensity, rainHigh: weather.rainIntensity, forecast: false };
    const ahead = forecastPoints(forecast, lapBase).filter((p) => p.raceTime > raceTime && p.lap > progress);
    return [now, ...thinOut(ahead, 220)];
  }, [forecast, lapBase, bucket]);
  const nowPoint = future[0]!;

  const crossovers = useMemo(() => findCrossovers(future).slice(0, 3), [future]);
  const classNow = bestTyreClass(weather.trackWetness);
  const inFive = interpolateAtTime(future, raceTime + 300);

  const counts: Record<TyreClass, number> = { SLICK: 0, INTER: 0, WET: 0 };
  let runningCars = 0;
  for (const car of snapshot.cars) {
    if (car.status === 'RETIRED') continue;
    counts[COMPOUNDS[car.tyre.compound].tyreClass] += 1;
    runningCars += 1;
  }
  const playerCars = session.playerCarIds.map((id) => snapshot.cars.find((c) => c.id === id)).filter((c) => c !== undefined);

  // ── main chart geometry ──
  const plot: PlotRect = {
    left: MARGIN.left,
    top: MARGIN.top,
    width: Math.max(10, size.width - MARGIN.left - MARGIN.right),
    height: Math.max(10, size.height - MARGIN.top - MARGIN.bottom),
  };
  const ready = size.width > 140 && size.height > 70;
  const geometry = useMemo(() => {
    const x = linearScale([0, raceLaps], [plot.left, plot.left + plot.width]);
    const y = linearScale([0, 1], [plot.top + plot.height, plot.top]);
    const past = [...observed.filter((p) => p.lap < nowPoint.lap), nowPoint];
    const rainPast = past.map((p) => [x(p.lap), y(p.rain)] as const);
    const cursorPoints = [...past, ...future.slice(1)].filter((p) => p.lap >= 0 && p.lap <= raceLaps);
    const byLap = new Map<number, WeatherPoint>();
    for (const p of cursorPoints) byLap.set(p.lap, p);
    const inRange = future.filter((p) => p.lap <= raceLaps + 0.01);
    return {
      x,
      y,
      past,
      byLap,
      values: [...byLap.keys()].sort((a, b) => a - b),
      rainPast: linePath(rainPast),
      rainWash: areaPath(rainPast, y(0)),
      wetPast: linePath(past.map((p) => [x(p.lap), y(p.wetness)] as const)),
      rainFuture: linePath(inRange.map((p) => [x(p.lap), y(p.rain)] as const)),
      wetFuture: linePath(inRange.map((p) => [x(p.lap), y(p.wetness)] as const)),
      rainBand: bandPath(inRange.map((p) => [x(p.lap), y(p.rainHigh)] as const), inRange.map((p) => [x(p.lap), y(p.rainLow)] as const)),
      xTicks: lapTicks(0, raceLaps, plot.width),
    };
  }, [observed, future, nowPoint, raceLaps, plot.left, plot.top, plot.width, plot.height]);
  const { x, y } = geometry;
  const thresholds: { value: number; label: string }[] = [
    { value: WEATHER_CROSSOVER.slickToInter, label: `WETNESS ${pct(WEATHER_CROSSOVER.slickToInter)} · INTER FASTER ABOVE` },
    { value: WEATHER_CROSSOVER.interToWet, label: `WETNESS ${pct(WEATHER_CROSSOVER.interToWet)} · WET FASTER ABOVE` },
  ];
  const windows: { tyreClass: TyreClass; lo: number; hi: number }[] = [
    { tyreClass: 'SLICK', lo: 0, hi: WEATHER_CROSSOVER.slickToInter },
    { tyreClass: 'INTER', lo: WEATHER_CROSSOVER.slickToInter, hi: WEATHER_CROSSOVER.interToWet },
    { tyreClass: 'WET', lo: WEATHER_CROSSOVER.interToWet, hi: 1 },
  ];

  const cursorPoint = cursor ? (geometry.byLap.get(cursor.value) ?? null) : null;
  const cursorLead = cursorPoint ? (cursorPoint.raceTime - raceTime) / 60 : 0;
  const valueText = cursorPoint
    ? `Lap ${lapNumberAt(cursorPoint.lap, raceLaps)}${cursorPoint.forecast ? ` forecast in ${Math.round(cursorLead)} minutes` : ''}: rain ${pct(cursorPoint.rain)}, track wetness ${pct(cursorPoint.wetness)}, best tyre ${bestTyreClass(cursorPoint.wetness)}`
    : 'No point selected';

  const tableRows = useMemo(() => {
    if (!table) return [];
    const rows = [];
    for (let lap = 1; lap <= raceLaps; lap++) {
      const isPast = lap <= nowPoint.lap;
      const point = isPast ? atLap(geometry.past, lap) : atLap(future, lap);
      if (!point) continue;
      rows.push({
        key: String(lap),
        dimmed: !isPast,
        marked: lap === Math.floor(nowPoint.lap),
        cells: [`L${lap}`, isPast ? 'Observed' : 'Forecast', pct(point.rain), isPast ? '—' : `${pct(point.rainLow)}–${pct(point.rainHigh)}`, pct(point.wetness), bestTyreClass(point.wetness)],
      });
    }
    return rows;
  }, [table, raceLaps, nowPoint, geometry.past, future]);

  const lapsAhead = (lap: number): string => {
    const delta = lap - progress;
    return delta < 0.75 ? 'in <1 lap' : `in ${Math.round(delta)} lap${Math.round(delta) > 1 ? 's' : ''}`;
  };
  const scopeSize = Math.max(0, Math.min(scopeBox.width, scopeBox.height, 176));

  return (
    <Panel
      title="Weather Radar"
      icon={<CloudRain size={14} strokeWidth={1.75} />}
      subtitle={`TRACK GRIP · ${classNow} WINDOW`}
      actions={<ViewToggle table={table} onToggle={setTable} />}
      className={`h-full ${className}`}
      bodyClassName="flex flex-col"
    >
      <div className="flex h-10 shrink-0 border-b border-carbon-700">
        <Tile label="Rain" value={pct(weather.rainIntensity)}>
          <Trend now={weather.rainIntensity} later={inFive ? inFive.rain : null} />
        </Tile>
        <Tile label="Track wetness" value={pct(weather.trackWetness)}>
          <Trend now={weather.trackWetness} later={inFive ? inFive.wetness : null} />
        </Tile>
        <Tile label="Grip" value={pct(weather.gripLevel)} />
        <Tile label="Air / Track" value={`${formatTemp(weather.airTempC)} / ${formatTemp(weather.trackTempC)}`} />
        <Tile label="Best tyre now">
          <span className="font-display text-sm font-semibold leading-none tracking-wider text-ink-50">{classNow}</span>
          <ClassBadges tyreClass={classNow} />
        </Tile>
        <Tile label={`Field on · ${runningCars} cars`}>
          <span className="flex items-center gap-2 font-mono text-xs text-ink-100">
            {CLASSES.map((tyreClass) => (
              <span key={tyreClass} className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-[1px]" style={{ backgroundColor: CLASS_COLOR[tyreClass] }} />
                <span className="font-display text-[10px] tracking-wider text-ink-300">{tyreClass}</span>
                {counts[tyreClass]}
              </span>
            ))}
          </span>
        </Tile>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <ChartHeader title="Rain & track wetness · %">
            <LegendItem swatch={<LineKey color={RAIN} />} label="Rain intensity" />
            <LegendItem swatch={<LineKey color={WETNESS} />} label="Track wetness" />
            <LegendItem swatch={<LineKey color={INK.secondary} dashed />} label="Forecast" />
            <LegendItem swatch={<span className="h-2 w-3 rounded-[1px]" style={{ backgroundColor: RAIN, opacity: 0.25 }} />} label="Rain range" />
          </ChartHeader>
          <div ref={plotRef} className="relative min-h-0 flex-1">
            {table ? (
              <SeriesTable
                caption="Rain intensity and track wetness per lap, observed then forecast"
                columns={[
                  { key: 'lap', label: 'Lap', align: 'left' },
                  { key: 'source', label: 'Source', align: 'left' },
                  { key: 'rain', label: 'Rain', swatch: <LineKey color={RAIN} /> },
                  { key: 'range', label: 'Range' },
                  { key: 'wet', label: 'Wetness', swatch: <LineKey color={WETNESS} /> },
                  { key: 'tyre', label: 'Best tyre' },
                ]}
                rows={tableRows}
              />
            ) : ready ? (
              <>
                <svg width={size.width} height={size.height} className="absolute inset-0 block" role="img" aria-label="Rain intensity and track wetness by lap: observed, then forecast, against the tyre crossover thresholds">
                  <HGrid plot={plot} ys={[0.25, 0.5, 0.75, 1].map((t) => y(t))} />
                  <LapAxis plot={plot} ticks={geometry.xTicks} x={x} />
                  <ValueAxis plot={plot} ticks={[0, 0.25, 0.5, 0.75, 1]} y={y} format={(v) => `${Math.round(v * 100)}`} />
                  {/* Tyre windows: thresholds across the plot, identity confined to the right edge. */}
                  {thresholds.map((t) => (
                    <g key={t.value}>
                      <line className="stroke-chart-axis" shapeRendering="crispEdges" x1={plot.left} x2={plot.left + plot.width + 8} y1={Math.round(y(t.value)) + 0.5} y2={Math.round(y(t.value)) + 0.5} />
                      <text x={plot.left + 4} y={y(t.value) - 3} className={`fill-ink-500 font-display text-[9px] font-medium tracking-[0.1em] ${TEXT_HALO}`}>
                        {t.label}
                      </text>
                    </g>
                  ))}
                  {windows.map((w) => {
                    const top = y(w.hi) + 1;
                    const bottom = y(w.lo) - 1;
                    const middle = (top + bottom) / 2;
                    const compounds = CLASS_COMPOUNDS[w.tyreClass];
                    return (
                      <g key={w.tyreClass}>
                        <rect x={plot.left + plot.width + 3} y={top} width={4} height={Math.max(0, bottom - top)} fill={CLASS_COLOR[w.tyreClass]} opacity={0.55} />
                        <text x={plot.left + plot.width + 12} y={middle - 4} className="fill-ink-300 font-display text-[10px] font-semibold tracking-[0.12em]">
                          {w.tyreClass}
                        </text>
                        <g transform={`translate(${plot.left + plot.width + 12} ${middle})`}>
                          {compounds.map((compound, i) => (
                            <g key={compound} transform={`translate(${i * 13} 0)`}>
                              <TyreBadge compound={compound} size={12} />
                            </g>
                          ))}
                        </g>
                      </g>
                    );
                  })}
                  <path d={geometry.rainBand} fill={RAIN} opacity={0.16} />
                  <path d={geometry.rainWash} fill={RAIN} opacity={0.1} />
                  <g fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round">
                    <path d={geometry.rainPast} stroke={RAIN} />
                    <path d={geometry.rainFuture} stroke={RAIN} strokeDasharray="5 4" />
                    <path d={geometry.wetPast} stroke={WETNESS} />
                    <path d={geometry.wetFuture} stroke={WETNESS} strokeDasharray="5 4" />
                  </g>
                  <VRule plot={plot} x={x(nowPoint.lap)} label="NOW" />
                  <circle cx={x(nowPoint.lap)} cy={y(nowPoint.rain)} r={4} fill={RAIN} stroke="var(--color-carbon-900)" strokeWidth={2} />
                  <circle cx={x(nowPoint.lap)} cy={y(nowPoint.wetness)} r={4} fill={WETNESS} stroke="var(--color-carbon-900)" strokeWidth={2} />
                  {cursorPoint ? (
                    <g pointerEvents="none">
                      <Crosshair plot={plot} x={x(cursorPoint.lap)} />
                      <circle cx={x(cursorPoint.lap)} cy={y(cursorPoint.rain)} r={3} fill={RAIN} stroke="var(--color-carbon-900)" strokeWidth={1.5} />
                      <circle cx={x(cursorPoint.lap)} cy={y(cursorPoint.wetness)} r={3} fill={WETNESS} stroke="var(--color-carbon-900)" strokeWidth={1.5} />
                    </g>
                  ) : null}
                </svg>
                <CursorOverlay plot={plot} values={geometry.values} x={x} cursor={cursorPoint ? cursorPoint.lap : null} onCursor={setCursor} home={nowPoint.lap} ariaLabel="Weather cursor: rain and track wetness by lap" valueText={valueText} />
              </>
            ) : null}
          </div>
        </div>

        <div className="flex w-[236px] shrink-0 flex-col border-l border-carbon-700">
          <div className="shrink-0 border-b border-carbon-700 px-2 py-1.5">
            <div className="pw-label mb-1">Tyre crossover · forecast</div>
            {crossovers.length === 0 ? (
              <p className="flex items-center gap-1.5 text-xs text-ink-100">
                <Check size={12} strokeWidth={2} className="shrink-0 text-ink-500" />
                No tyre change forecast
                <span className="text-ink-500">· stay on {classNow.toLowerCase()}s</span>
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {crossovers.map((c, i) => (
                  <li key={`${c.to}-${c.raceTime}`} className={`flex items-center gap-1.5 whitespace-nowrap ${i === 0 ? '' : 'opacity-75'}`}>
                    <span className="font-display text-xs font-semibold tracking-wider text-ink-100">{c.from}</span>
                    <ArrowRight size={11} strokeWidth={2} className="text-ink-500" />
                    <span className="font-display text-xs font-semibold tracking-wider text-ink-50">{c.to}</span>
                    <ClassBadges tyreClass={c.to} size={12} />
                    <span className="ml-auto font-mono text-xs font-bold text-ink-50">~L{lapNumberAt(c.lap, raceLaps)}</span>
                    <span className="font-mono text-[10px] text-ink-300">{lapsAhead(c.lap)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-1.5 flex items-center gap-3 border-t border-carbon-700 pt-1">
              {playerCars.map((car) => {
                const wrong = car.status !== 'RETIRED' && COMPOUNDS[car.tyre.compound].tyreClass !== classNow;
                return (
                  <span key={car.id} className="flex items-center gap-1 whitespace-nowrap text-2xs" title={wrong ? `${classNow} is the faster tyre family right now` : 'On the right tyre family'}>
                    <span className="h-2.5 w-[3px] rounded-[1px]" style={{ backgroundColor: index.color(car.id) }} />
                    <span className="font-display font-semibold tracking-wider text-ink-100">{index.driver(car.id).code}</span>
                    <TyreBadge compound={car.tyre.compound} size={13} />
                    {wrong ? <TriangleAlert size={11} strokeWidth={2} className="text-warn" /> : <Check size={11} strokeWidth={2} className="text-ok" />}
                    <span className={wrong ? 'text-ink-100' : 'text-ink-500'}>{wrong ? 'wrong' : 'ok'}</span>
                  </span>
                );
              })}
            </div>
          </div>
          <div className="pw-label shrink-0 px-2 pt-1">Radar scope · rain by lead time</div>
          <div ref={scopeRef} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
            {scopeSize >= 80 ? <RadarScope size={scopeSize} series={future} raceTime={raceTime} track={session.track} /> : null}
          </div>
        </div>
      </div>

      <ChartTooltip anchor={cursorPoint && !table ? cursor : null}>
        {cursorPoint ? (
          <>
            <TooltipTitle note={cursorPoint.forecast ? `Forecast +${Math.max(0, Math.round(cursorLead))} min` : 'Observed'}>Lap {lapNumberAt(cursorPoint.lap, raceLaps)}</TooltipTitle>
            <TooltipGrid>
              <TooltipRow swatch={<LineKey color={RAIN} dashed={cursorPoint.forecast} />} value={pct(cursorPoint.rain)} name="Rain" detail={cursorPoint.forecast ? `${pct(cursorPoint.rainLow)}–${pct(cursorPoint.rainHigh)}` : undefined} />
              <TooltipRow swatch={<LineKey color={WETNESS} dashed={cursorPoint.forecast} />} value={pct(cursorPoint.wetness)} name="Track wetness" />
            </TooltipGrid>
            <div className="mt-1 flex items-center gap-1.5 border-t border-carbon-700 pt-1">
              <span className="pw-label">Best tyre</span>
              <span className="font-display font-semibold tracking-wider text-ink-50">{bestTyreClass(cursorPoint.wetness)}</span>
              <ClassBadges tyreClass={bestTyreClass(cursorPoint.wetness)} size={12} />
            </div>
          </>
        ) : null}
      </ChartTooltip>
    </Panel>
  );
}

/** Stable pseudo-random offset in [−1, 1] for a time slot (keeps each echo on its own bearing as it drifts in). */
function slotJitter(slot: number): number {
  const s = Math.sin(slot * 12.9898) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/**
 * Polar view of the same forecast: radius = lead time (rings every 5 minutes, the circuit at the centre),
 * blob size and opacity = rain intensity, faint halo = high estimate. The bearing is a fixed schematic
 * band – only the radius and the blobs carry data. Echoes are tied to race-clock minutes, so they drift
 * inward as time passes.
 */
function RadarScope({ size, series, raceTime, track }: { size: number; series: readonly WeatherPoint[]; raceTime: number; track: TrackDefinition }) {
  const blurId = useId();
  const c = size / 2;
  const radius = size / 2 - 13;
  const bearing = (-140 * Math.PI) / 180;
  const halfWidth = (27 * Math.PI) / 180;
  const echoes: { key: number; x: number; y: number; r: number; halo: number; rain: number }[] = [];
  let firstLead: number | null = null;
  let clearLead: number | null = null;
  let peak = 0;
  let peakLead = 0;
  for (let slot = Math.ceil(raceTime / 60); slot * 60 - raceTime <= SCOPE_RANGE; slot++) {
    const lead = slot * 60 - raceTime;
    const point = interpolateAtTime(series, slot * 60);
    if (!point) continue;
    if (firstLead === null && point.rain >= 0.05) firstLead = lead;
    if (clearLead === null && point.rain < 0.05) clearLead = lead;
    if (point.rain > peak) {
      peak = point.rain;
      peakLead = lead;
    }
    if (point.rain < 0.015) continue;
    const angle = bearing + slotJitter(slot) * halfWidth * 0.7;
    const r = (radius * lead) / SCOPE_RANGE;
    echoes.push({ key: slot, x: c + r * Math.cos(angle), y: c + r * Math.sin(angle), r: 2 + 7 * point.rain, halo: 2 + 7 * point.rainHigh, rain: point.rain });
  }
  const now = series[0];
  const rainNow = now ? now.rain : 0;
  const scale = 20 / Math.max(track.svgViewBox.width, track.svgViewBox.height);
  const minutes = (seconds: number): number => Math.max(1, Math.round(seconds / 60));
  let summary: string;
  if (rainNow >= 0.05) {
    const outlook = peak > rainNow + 0.05 ? `peak ${pct(peak)} +${minutes(peakLead)} min` : clearLead !== null ? `easing in ~${minutes(clearLead)} min` : 'no break within 20 min';
    summary = `Raining now ${pct(rainNow)} · ${outlook}`;
  } else if (peak >= 0.05) {
    summary = `First rain +${minutes(firstLead ?? peakLead)} min · peak ${pct(peak)} +${minutes(peakLead)} min`;
  } else {
    summary = 'No rain within 20 min';
  }
  const labelAngle = (58 * Math.PI) / 180;
  return (
    <svg width={size} height={size} role="img" aria-label={`Radar scope, rain by lead time over the next 20 minutes. ${summary}.`}>
      <defs>
        <filter id={blurId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.4" />
        </filter>
      </defs>
      <path d={sectorPath(c, c, 0, radius, bearing - halfWidth, bearing + halfWidth)} fill={INK.secondary} opacity={0.045} />
      <g fill="none" className="stroke-chart-axis">
        {[5, 10, 15, 20].map((minutes) => (
          <circle key={minutes} cx={c} cy={c} r={(radius * minutes * 60) / SCOPE_RANGE} />
        ))}
      </g>
      <g className="stroke-chart-grid">
        <line x1={c - radius} x2={c + radius} y1={c} y2={c} />
        <line x1={c} x2={c} y1={c - radius} y2={c + radius} />
      </g>
      <g filter={`url(#${blurId})`}>
        {echoes.map((e) => (
          <g key={e.key}>
            <circle cx={e.x} cy={e.y} r={e.halo} fill={RAIN} opacity={0.12} />
            <circle cx={e.x} cy={e.y} r={e.r} fill={RAIN} opacity={0.2 + 0.7 * e.rain} />
          </g>
        ))}
        {rainNow >= 0.015 ? <circle cx={c} cy={c} r={3 + 9 * rainNow} fill={RAIN} opacity={0.2 + 0.7 * rainNow} /> : null}
      </g>
      <path d={track.svgPath} transform={`translate(${c - (track.svgViewBox.width * scale) / 2} ${c - (track.svgViewBox.height * scale) / 2}) scale(${scale})`} fill="none" stroke={INK.primary} strokeWidth={1.25} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      {[5, 10, 15, 20].map((minutes) => {
        const r = (radius * minutes * 60) / SCOPE_RANGE;
        return (
          <text key={minutes} x={c + r * Math.cos(labelAngle)} y={c + r * Math.sin(labelAngle)} dy="0.32em" textAnchor="middle" className={`${AXIS_TEXT} text-[8px] ${TEXT_HALO}`}>
            +{minutes}
            {minutes === 20 ? ' min' : ''}
          </text>
        );
      })}
      <text x={c} y={size - 2} textAnchor="middle" className="fill-ink-300 font-display text-[9px] font-medium uppercase tracking-[0.1em]">
        {summary}
      </text>
    </svg>
  );
}
