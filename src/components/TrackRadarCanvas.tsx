import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent, ReactNode } from 'react';
import { Droplets, Radar, TriangleAlert, Wind } from 'lucide-react';
import { formatGap, formatPercent, formatSeconds } from '../lib/format';
import { indexSession } from '../lib/session';
import type { CarId, CarSnapshot, PlayerCarTelemetry, RaceSnapshot, RejoinEstimate, SessionInfo } from '../simulation/types';
import type { LiveFrame, LiveFrameSource, TrackRadarCanvasProps } from './contracts';
import type { Rect } from './radar/layout';
import { RadarRenderer } from './radar/renderer';
import { TriangleGlyph } from './timing/glyphs';
import { DriverTag, Panel, TyreBadge } from './ui';

const TOOLTIP_WIDTH = 172;
const TOOLTIP_HEIGHT = 46;
const CHIP = 'inline-flex h-[18px] items-center gap-1 rounded-[2px] border px-1.5 font-display text-2xs font-semibold leading-none tracking-[0.12em]';

/** What the animation loop reads each frame; kept in a ref so the loop never restarts with the props. */
interface LiveInputs {
  session: SessionInfo;
  frames: LiveFrameSource;
  selectedCarId: CarId | null;
  /** The React-rate snapshot, used while the frame source has nothing yet. */
  fallback: LiveFrame;
}

function RejoinReadout({ telemetry, rejoin, session }: { telemetry: PlayerCarTelemetry; rejoin: RejoinEstimate; session: SessionInfo }) {
  const index = indexSession(session);
  const lost = rejoin.positionsLost;
  const delta = lost > 0 ? `−${lost}` : lost < 0 ? `+${-lost}` : '±0';
  return (
    <div className="border border-carbon-700 bg-carbon-900/90 px-2 py-[5px]">
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <DriverTag code={index.driver(telemetry.carId).code} color={index.color(telemetry.carId)} carNumber={telemetry.carNumber} strong />
        <span className="pw-label ml-0.5">Rejoin</span>
        <span className="font-mono tabular text-xs font-bold leading-none text-ink-50">P{rejoin.position}</span>
        <span className="font-mono tabular text-2xs leading-none text-ink-300" title="Positions lost by stopping this lap">
          ({delta})
        </span>
        <span
          className={`ml-auto inline-flex items-center gap-1 font-display text-2xs font-semibold leading-none tracking-[0.1em] ${rejoin.clearAir ? 'text-ok' : 'text-warn'}`}
        >
          {rejoin.clearAir ? <Wind size={11} strokeWidth={2} aria-hidden="true" /> : <TriangleAlert size={11} strokeWidth={2} aria-hidden="true" />}
          {rejoin.clearAir ? 'CLEAR AIR' : 'TRAFFIC'}
        </span>
      </div>
      <div className="mt-[5px] flex items-center gap-2.5 whitespace-nowrap font-mono tabular text-2xs leading-none text-ink-300">
        <span className="inline-flex items-center gap-1" title="Car ahead on track at pit exit">
          <TriangleGlyph direction="up" className="text-ink-500" />
          <span className="font-display font-semibold tracking-wider text-ink-100">{rejoin.carAhead ?? '—'}</span>
          {rejoin.gapAhead !== null ? `+${formatSeconds(rejoin.gapAhead)}` : null}
        </span>
        <span className="inline-flex items-center gap-1" title="Car behind on track at pit exit">
          <TriangleGlyph direction="down" className="text-ink-500" />
          <span className="font-display font-semibold tracking-wider text-ink-100">{rejoin.carBehind ?? '—'}</span>
          {rejoin.gapBehind !== null ? formatSeconds(rejoin.gapBehind) : null}
        </span>
        <span className="ml-auto inline-flex items-center gap-1" title="Pit loss used for the estimate under the current flag">
          <span className="pw-label">Loss</span>
          {formatSeconds(rejoin.pitLoss)}
        </span>
      </div>
    </div>
  );
}

function CarTooltip({ car, session }: { car: CarSnapshot; session: SessionInfo }) {
  const index = indexSession(session);
  const driver = index.driver(car.id);
  const inPit = car.pitLaneProgress !== null;
  const interval = inPit
    ? 'IN PIT'
    : car.status === 'GRID'
      ? 'GRID'
      : car.position === 1
        ? 'LEADER'
        : formatGap(car.interval, car.intervalLaps);
  return (
    <>
      <div className="flex items-center gap-2">
        <DriverTag code={driver.code} color={index.color(car.id)} carNumber={index.isPlayer(car.id) ? driver.carNumber : undefined} strong />
        <span className="font-mono tabular text-xs font-bold leading-none text-ink-50">P{car.position}</span>
        <span className="ml-auto font-mono tabular text-2xs leading-none text-ink-100">{interval}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 font-mono tabular text-2xs leading-none text-ink-300">
        <TyreBadge compound={car.tyre.compound} size={14} />
        <span>
          {car.tyre.ageLaps} lap{car.tyre.ageLaps === 1 ? '' : 's'}
        </span>
        <span className="ml-auto text-ink-100">{Math.round(car.speedKph)} km/h</span>
      </div>
    </>
  );
}

function LegendItem({ swatch, label }: { swatch: ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="flex w-4 shrink-0 items-center justify-center">{swatch}</span>
      <span className="pw-label whitespace-nowrap">{label}</span>
    </span>
  );
}

function neutralisationBanner(snapshot: RaceSnapshot): { label: string; className: string } | null {
  const control = snapshot.raceControl;
  switch (control.flag) {
    case 'SC':
      return { label: control.safetyCarInThisLap ? 'SAFETY CAR IN THIS LAP' : 'SAFETY CAR', className: 'border-flag-sc bg-flag-sc text-carbon-950' };
    case 'VSC':
      return { label: 'VIRTUAL SAFETY CAR', className: 'border-flag-sc bg-flag-sc text-carbon-950' };
    case 'RED':
      return {
        label: control.countdown !== null ? `RED FLAG · RESTART IN ${Math.ceil(control.countdown)} S` : 'RED FLAG',
        className: 'border-flag-red bg-flag-red text-white',
      };
    default:
      return null;
  }
}

/**
 * Live GPS map of the circuit. The canvas is drawn every animation frame straight from
 * `frames.getFrame()` (never from React state) with the cars extrapolated between snapshots; React only
 * renders the HUD on top, at snapshot rate.
 */
export function TrackRadarCanvas({ session, snapshot, frames, selectedCarId, onSelectCar, className = '' }: TrackRadarCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const rejoinRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<RadarRenderer | null>(null);
  const [hoveredId, setHoveredId] = useState<CarId | null>(null);

  const live = useRef<LiveInputs>({ session, frames, selectedCarId, fallback: { snapshot, receivedAt: 0 } });
  useLayoutEffect(() => {
    const current = live.current;
    current.session = session;
    current.frames = frames;
    current.selectedCarId = selectedCarId;
    if (current.fallback.snapshot !== snapshot || current.fallback.receivedAt === 0) {
      current.fallback = { snapshot, receivedAt: performance.now() };
    }
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return undefined;
    const renderer = new RadarRenderer(canvas);
    rendererRef.current = renderer;
    renderer.setSession(live.current.session);

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const applyMotion = (): void => renderer.setReducedMotion(motion.matches);
    applyMotion();
    motion.addEventListener('change', applyMotion);

    // Canvas size, device pixel ratio and the HUD boxes the circuit is laid out around.
    let width = 0;
    let height = 0;
    const measure = (): void => {
      const box = container.getBoundingClientRect();
      width = container.clientWidth;
      height = container.clientHeight;
      renderer.resize(width, height, Math.min(3, window.devicePixelRatio || 1));
      const obstacles: Rect[] = [];
      for (const ref of [titleRef, rejoinRef, legendRef]) {
        const rect = ref.current?.getBoundingClientRect();
        if (rect && rect.width > 0 && rect.height > 0) {
          obstacles.push({ x: rect.left - box.left, y: rect.top - box.top, w: rect.width, h: rect.height });
        }
      }
      renderer.setObstacles(obstacles);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    for (const ref of [titleRef, rejoinRef, legendRef]) if (ref.current) observer.observe(ref.current);
    window.addEventListener('resize', measure);
    measure();

    // Text baked into the static layer must be repainted once the web fonts are in.
    const repaint = (): void => renderer.invalidate();
    document.fonts.addEventListener('loadingdone', repaint);
    for (const font of ['600 11px "Barlow Condensed"', '700 12px "Barlow Condensed"', '700 9px "JetBrains Mono"']) {
      document.fonts.load(font).then(repaint, () => undefined);
    }

    let raf = 0;
    let running = false;
    let hovered: CarId | null = null;
    const point = { x: 0, y: 0 };
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const inputs = live.current;
      renderer.render(inputs.frames.getFrame() ?? inputs.fallback, performance.now(), inputs.selectedCarId);

      const id = renderer.hoveredCarId;
      if (id !== hovered) {
        hovered = id;
        canvas.style.cursor = id === null ? 'default' : 'pointer';
        setHoveredId(id);
      }
      const tooltip = tooltipRef.current;
      if (tooltip && id !== null && renderer.hoverPoint(point)) {
        // follows the car; flips to the other side near the right and top edges
        let x = point.x + 14;
        let y = point.y - TOOLTIP_HEIGHT - 12;
        if (x + TOOLTIP_WIDTH > width - 4) x = point.x - TOOLTIP_WIDTH - 14;
        if (y < 4) y = point.y + 14;
        tooltip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      }
    };
    const start = (): void => {
      if (running || document.hidden) return;
      running = true;
      raf = requestAnimationFrame(tick);
    };
    const stop = (): void => {
      running = false;
      cancelAnimationFrame(raf);
    };
    // no drawing at all while the tab is hidden
    const onVisibility = (): void => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);
    start();

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      document.fonts.removeEventListener('loadingdone', repaint);
      window.removeEventListener('resize', measure);
      motion.removeEventListener('change', applyMotion);
      observer.disconnect();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setSession(session);
  }, [session]);

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>): void => {
    rendererRef.current?.setPointer(event.nativeEvent.offsetX, event.nativeEvent.offsetY, true);
  };
  const handlePointerLeave = (): void => {
    rendererRef.current?.setPointer(0, 0, false);
  };
  const handleClick = (event: MouseEvent<HTMLCanvasElement>): void => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const carId = renderer.carAt(event.nativeEvent.offsetX, event.nativeEvent.offsetY);
    if (carId !== null) onSelectCar(carId);
    else if (selectedCarId !== null) onSelectCar(null);
  };

  const { track } = session;
  const { raceControl, weather } = snapshot;
  let onTrack = 0;
  let inPit = 0;
  for (const car of snapshot.cars) {
    if (car.status === 'RETIRED') continue;
    if (car.pitLaneProgress !== null) inPit++;
    else onTrack++;
  }
  const banner = neutralisationBanner(snapshot);
  const hoveredCar = hoveredId === null ? undefined : snapshot.cars.find((car) => car.id === hoveredId);
  const playerColor = indexSession(session).color(session.playerCarIds[0]);

  return (
    <Panel
      title="Track Radar"
      icon={<Radar size={14} strokeWidth={1.75} />}
      subtitle={`${onTrack} ON TRACK · ${inPit} IN PIT`}
      actions={
        <>
          {weather.trackWetness >= 0.03 ? (
            <span className={`${CHIP} border-carbon-600 bg-carbon-800 text-ink-100`} title="Track wetness">
              <Droplets size={11} strokeWidth={2} className="text-tyre-wet" aria-hidden="true" />
              WET {formatPercent(weather.trackWetness)}
            </span>
          ) : null}
          <span className={`${CHIP} border-carbon-600 bg-carbon-800 ${raceControl.drsEnabled ? 'text-ink-100' : 'text-ink-500'}`}>
            <span aria-hidden="true" className={`h-[6px] w-[6px] rounded-full ${raceControl.drsEnabled ? 'bg-timing-green' : 'border border-ink-500'}`} />
            DRS {raceControl.drsEnabled ? 'ENABLED' : 'DISABLED'}
          </span>
        </>
      }
      className={`h-full ${className}`}
      bodyClassName="relative"
    >
      <div ref={containerRef} className="absolute inset-0 overflow-hidden">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Live track map of ${track.name}: car positions, pit lane, DRS zones and pit rejoin estimates`}
          className="absolute inset-0 block h-full w-full touch-none"
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          onClick={handleClick}
        />

        <div ref={titleRef} className="pointer-events-none absolute left-2 top-2 bg-carbon-900/80 px-1.5 py-1">
          <div className="pw-label">{track.grandPrix}</div>
          <div className="mt-0.5 flex items-baseline gap-2 whitespace-nowrap">
            <span className="font-display text-sm font-semibold uppercase leading-none tracking-[0.08em] text-ink-100">{track.name}</span>
            <span className="font-mono tabular text-2xs leading-none text-ink-300">{track.lengthKm.toFixed(3)} km</span>
          </div>
        </div>

        {banner ? (
          <div
            role="status"
            className={`pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 whitespace-nowrap rounded-[2px] border px-2 py-1 font-display text-xs font-bold leading-none tracking-[0.14em] ${banner.className}`}
          >
            {banner.label}
          </div>
        ) : null}

        {/* the height of two readouts is always reserved, so the circuit does not move when one appears */}
        <div ref={rejoinRef} className="pointer-events-none absolute right-2 top-2 flex min-h-[86px] w-[250px] flex-col gap-1">
          {snapshot.player.cars.map((telemetry) =>
            telemetry.rejoin ? <RejoinReadout key={telemetry.carId} telemetry={telemetry} rejoin={telemetry.rejoin} session={session} /> : null,
          )}
        </div>

        <div ref={legendRef} className="pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%-16px)] flex-wrap items-center gap-x-3 gap-y-1 bg-carbon-900/80 px-1.5 py-1">
          <LegendItem swatch={<span className="h-[2px] w-4 bg-timing-green" />} label="DRS zone" />
          <LegendItem swatch={<span className="h-[6px] w-[6px] rotate-45 border border-timing-green" />} label="Detection" />
          <LegendItem swatch={<span className="h-px w-4 bg-ink-500" />} label="Pit lane" />
          <LegendItem swatch={<span className="h-[10px] w-[10px] rounded-full border-[1.5px] border-dashed" style={{ borderColor: playerColor }} />} label="Rejoin ghost" />
          <LegendItem swatch={<span className="h-[5px] w-4 bg-flag-yellow" />} label="Yellow sector" />
        </div>

        <div
          ref={tooltipRef}
          role="tooltip"
          className={`pointer-events-none absolute left-0 top-0 z-20 border border-carbon-500 bg-carbon-850 px-2 py-1.5 ${hoveredCar ? '' : 'invisible'}`}
          style={{ width: TOOLTIP_WIDTH }}
        >
          {hoveredCar ? <CarTooltip car={hoveredCar} session={session} /> : null}
        </div>
      </div>
    </Panel>
  );
}
