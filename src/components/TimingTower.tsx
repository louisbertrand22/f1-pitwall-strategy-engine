import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ListOrdered, Swords } from 'lucide-react';
import type { CarId } from '../simulation/types';
import type { TimingTowerProps } from './contracts';
import { FlagChip } from './timing/FlagChip';
import { ROW_GRID, TimingRow } from './timing/TimingRow';
import { buildBattleMarkers, buildTimingRows, computeRowLayout } from './timing/rowModel';
import type { BattleMarker, RowLayout } from './timing/rowModel';
import { Panel } from './ui';

/**
 * Column tracks in `fr` so the whole table scales with the panel (440–520 px). The type steps with the
 * container width so the longest strings ("+1:02.4", "1:27.345") always clear their neighbours:
 * `--tt-num` is the size of INT / GAP / PIT, `--tt-sec` the size of the colour-coded sector and lap times.
 * Order: POS · Δ grid · driver · INT · GAP · TYRE · S1 · S2 · S3 · LAST · PIT · DRS.
 */
const TABLE_VARS =
  '[--tt-cols:16fr_17fr_58fr_48fr_50fr_37fr_42fr_42fr_42fr_56fr_17fr_23fr] [--tt-num:10px] [--tt-sec:10px] ' +
  '@min-[462px]:[--tt-cols:16fr_21fr_69fr_50fr_52fr_39fr_40fr_40fr_40fr_53fr_20fr_23fr] @min-[462px]:[--tt-num:11px] ' +
  '@min-[500px]:[--tt-cols:16fr_21fr_66fr_50fr_52fr_38fr_42fr_42fr_42fr_58fr_19fr_23fr] @min-[500px]:[--tt-sec:11px]';

const HEADER_HEIGHT = 20;
/** Row height assumed for the very first render, before the body has been measured. */
const FALLBACK_BODY_HEIGHT = 20 * 40;

const HEADER_CELL = 'pw-label tracking-[0.1em]';

const TableHeader = memo(function TableHeader() {
  return (
    <div
      role="row"
      aria-rowindex={1}
      className={`${ROW_GRID} sticky top-0 z-20 border-b border-carbon-700 bg-carbon-900`}
      style={{ height: HEADER_HEIGHT }}
    >
      <span role="columnheader" className={`${HEADER_CELL} text-right`} title="Position">
        P
      </span>
      <span role="columnheader" aria-label="Places gained or lost versus the grid" />
      <span role="columnheader" className={`${HEADER_CELL} pl-[12px]`}>
        Driver
      </span>
      <span role="columnheader" className={`${HEADER_CELL} text-right`} title="Interval to the car ahead">
        Int
      </span>
      <span role="columnheader" className={`${HEADER_CELL} text-right`} title="Gap to the leader">
        Gap
      </span>
      <span role="columnheader" className={`${HEADER_CELL} text-center`} title="Compound and laps on the set">
        Tyre
      </span>
      <span role="columnheader" className={`${HEADER_CELL} text-right`}>
        S1
      </span>
      <span role="columnheader" className={`${HEADER_CELL} text-right`}>
        S2
      </span>
      <span role="columnheader" className={`${HEADER_CELL} text-right`}>
        S3
      </span>
      <span role="columnheader" className={`${HEADER_CELL} text-right`} title="Last lap">
        Last
      </span>
      <span role="columnheader" className={`${HEADER_CELL} text-right`} title="Pit stops">
        Pit
      </span>
      <span role="columnheader" className={`${HEADER_CELL} text-right`}>
        DRS
      </span>
    </div>
  );
});

interface BattleOverlayProps {
  markers: BattleMarker[];
  layout: RowLayout;
}

/** Crossed swords on the line between two cars fighting for position (or inside the row for a lone marker). */
const BattleOverlay = memo(
  function BattleOverlay({ markers, layout }: BattleOverlayProps) {
    return (
      <>
        {markers.map((marker) => {
          const top = layout.tops[marker.slot] ?? 0;
          const bottom = layout.tops[marker.slot + 1] ?? top;
          const y = marker.kind === 'LINK' ? top : bottom - 9;
          return (
            <div
              key={marker.key}
              className={`${ROW_GRID} pointer-events-none absolute inset-x-0 top-0 z-10 h-0`}
              style={{ transform: `translate3d(0, ${y}px, 0)` }}
            >
              <span
                role="img"
                aria-label={marker.label}
                className="col-start-2 flex h-[13px] w-[15px] -translate-y-1/2 items-center justify-center justify-self-center rounded-[2px] border border-carbon-500 bg-carbon-900 text-ink-100"
              >
                <Swords size={9} strokeWidth={2} aria-hidden="true" />
              </span>
            </div>
          );
        })}
      </>
    );
  },
  (a, b) =>
    a.layout === b.layout &&
    a.markers.length === b.markers.length &&
    a.markers.every((marker, i) => marker.key === b.markers[i]?.key && marker.label === b.markers[i]?.label),
);

/**
 * FIA-style live timing tower: one row per car, ordered by race position. Rows are keyed by car and kept
 * in a fixed DOM order; a change of position only changes their `transform`, so they glide to the new
 * slot like on a broadcast tower and never cause layout.
 */
export function TimingTower({ session, snapshot, selectedCarId, onSelectCar, className = '' }: TimingTowerProps) {
  const rows = useMemo(() => buildTimingRows(session, snapshot), [session, snapshot]);
  const markers = useMemo(() => buildBattleMarkers(rows), [rows]);

  // ── vertical layout: the rows share the body height, down to a minimum below which the body scrolls
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState<number | null>(null);
  const [resizing, setResizing] = useState(true);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const measure = (): void => {
      setBodyHeight(Math.max(0, scroller.clientHeight - HEADER_HEIGHT));
      // rows must snap, not glide, while the panel itself is being resized
      setResizing(true);
      if (settle !== undefined) clearTimeout(settle);
      settle = setTimeout(() => setResizing(false), 200);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => {
      observer.disconnect();
      if (settle !== undefined) clearTimeout(settle);
    };
  }, []);
  const layout = useMemo(
    () => computeRowLayout(bodyHeight ?? FALLBACK_BODY_HEIGHT, rows.length),
    [bodyHeight, rows.length],
  );

  // ── selection (stable callback so memoised rows are not invalidated by a new handler identity)
  const selection = useRef({ selectedCarId, onSelectCar });
  useLayoutEffect(() => {
    selection.current = { selectedCarId, onSelectCar };
  });
  const toggleCar = useCallback((carId: CarId) => {
    const current = selection.current;
    current.onSelectCar(current.selectedCarId === carId ? null : carId);
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const scroller = scrollerRef.current;
    if (!scroller || !(event.target instanceof HTMLElement)) return;
    const rowElement = event.target.closest<HTMLElement>('[data-slot]');
    if (!rowElement) return;
    const slot = Number(rowElement.dataset.slot);
    let next = slot;
    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(rows.length - 1, slot + 1);
        break;
      case 'ArrowUp':
        next = Math.max(0, slot - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = rows.length - 1;
        break;
      // Enter only: Space stays free for the cockpit's pause shortcut
      case 'Enter': {
        event.preventDefault();
        const carId = rowElement.dataset.car;
        if (carId !== undefined) toggleCar(carId);
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    scroller.querySelector<HTMLElement>(`[data-slot="${next}"]`)?.focus();
  };

  // Fixed DOM order (the grid), independent of the running order: React never moves a row element, so a
  // transform transition is never interrupted by a re-insertion.
  const domOrder = useMemo(() => {
    const ids = [...session.grid];
    const known = new Set(ids);
    for (const driver of session.drivers) {
      if (!known.has(driver.id)) {
        known.add(driver.id);
        ids.push(driver.id);
      }
    }
    return ids;
  }, [session]);
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  const tabStopId = selectedCarId !== null && rowById.has(selectedCarId) ? selectedCarId : (rows[0]?.id ?? null);

  return (
    <Panel
      title="Live Timing"
      icon={<ListOrdered size={14} strokeWidth={1.75} />}
      subtitle={`LAP ${snapshot.lap}/${snapshot.raceLaps}`}
      actions={<FlagChip flag={snapshot.raceControl.flag} yellowSectors={snapshot.raceControl.yellowSectors} />}
      className={`h-full ${className}`}
      bodyClassName="@container flex flex-col"
    >
      <div
        ref={scrollerRef}
        role="grid"
        aria-label="Race classification"
        aria-rowcount={rows.length + 1}
        data-resizing={resizing}
        onKeyDown={handleKeyDown}
        className={`group/tower relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto ${TABLE_VARS}`}
      >
        <TableHeader />
        <div className="relative" style={{ height: layout.tops[rows.length] ?? 0 }}>
          {domOrder.map((carId) => {
            const row = rowById.get(carId);
            if (!row) return null;
            const top = layout.tops[row.slot] ?? 0;
            return (
              <TimingRow
                key={carId}
                row={row}
                top={top}
                height={(layout.tops[row.slot + 1] ?? top) - top}
                selected={carId === selectedCarId}
                tabStop={carId === tabStopId}
                onSelect={toggleCar}
              />
            );
          })}
          <BattleOverlay markers={markers} layout={layout} />
        </div>
      </div>
    </Panel>
  );
}
