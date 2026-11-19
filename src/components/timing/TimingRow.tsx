import { memo } from 'react';
import { Timer, Wind } from 'lucide-react';
import { TYRE_LABELS } from '../../lib/tyres';
import type { CarId, SectorFlag } from '../../simulation/types';
import { DriverTag, TyreBadge } from '../ui';
import { ChequeredFlagGlyph, TriangleGlyph } from './glyphs';
import { timingRowsEqual } from './rowModel';
import type { LapTone, TimingRowModel } from './rowModel';

/**
 * Column template shared by the header, the rows and the battle overlay (CSS variable `--tt-cols`, set
 * by the tower). Order: POS · Δ grid · driver · INT · GAP · TYRE · S1 · S2 · S3 · LAST · PIT · DRS.
 */
export const ROW_GRID = 'grid grid-cols-(--tt-cols) items-center pl-[6px] pr-[5px]';

const SECTOR_TEXT: Record<SectorFlag, string> = {
  PURPLE: 'text-timing-purple',
  GREEN: 'text-timing-green',
  YELLOW: 'text-timing-yellow',
  NONE: 'text-ink-600',
};

const LAP_TEXT: Record<LapTone, string> = {
  PURPLE: 'text-timing-purple',
  GREEN: 'text-timing-green',
  PLAIN: 'text-ink-100',
  NONE: 'text-ink-600',
};

const NUMERIC = 'font-mono tabular leading-none [font-size:var(--tt-num)]';
const TAG = 'inline-flex shrink-0 items-center rounded-[2px] font-display text-[9px] leading-none';

function SectorTime({ text, flag, current, dim }: { text: string; flag: SectorFlag; current: boolean; dim: string }) {
  return (
    <span role="cell" className={`flex justify-end ${dim}`} title={current ? 'Sector in progress' : undefined}>
      <span className={`relative font-mono tabular leading-none [font-size:var(--tt-sec)] ${SECTOR_TEXT[flag]}`}>
        {/* the time on screen is the previous lap's until this sector is completed */}
        <span className={current ? 'opacity-55' : undefined}>{text}</span>
        {current ? <span aria-hidden="true" className="absolute inset-x-0 -bottom-[5px] h-[2px] bg-ink-500" /> : null}
      </span>
    </span>
  );
}

function wearBarClass(wearPct: number): string {
  if (wearPct >= 95) return 'bg-crit';
  if (wearPct >= 75) return 'bg-warn';
  return 'bg-ink-300';
}

export interface TimingRowProps {
  row: TimingRowModel;
  /** Top edge and height of the slot the row currently occupies (px). */
  top: number;
  height: number;
  selected: boolean;
  /** Roving tab stop: the one row reachable with Tab. */
  tabStop: boolean;
  /** Must be referentially stable, otherwise every row re-renders with each snapshot. */
  onSelect: (carId: CarId) => void;
}

function TimingRowView({ row, top, height, selected, tabStop, onSelect }: TimingRowProps) {
  const retired = row.status === 'RETIRED';
  const inPit = row.intervalKind === 'PIT';
  // Dim the content, never the row itself: the background has to stay opaque while rows cross.
  const dim = retired ? 'opacity-40' : inPit ? 'opacity-60' : '';
  const life = Math.min(100, Math.max(0, 100 - row.wearPct));
  const tyreTitle = `${TYRE_LABELS[row.compound]} · ${row.tyreAge} lap${row.tyreAge === 1 ? '' : 's'} · wear ${row.wearPct}%`;

  let background = 'bg-carbon-900 hover:bg-carbon-850';
  if (selected) background = 'bg-carbon-800 shadow-[inset_0_0_0_1px_var(--color-ink-100)]';

  return (
    <div
      role="row"
      aria-rowindex={row.slot + 2}
      aria-selected={selected}
      tabIndex={tabStop ? 0 : -1}
      data-slot={row.slot}
      data-car={row.id}
      title={retired ? `Retired — ${row.retiredReason ?? 'reason unknown'}` : undefined}
      onClick={() => onSelect(row.id)}
      className={`${ROW_GRID} absolute inset-x-0 top-0 cursor-pointer select-none border-b border-carbon-700 contain-strict will-change-transform transition-transform duration-300 ease-[cubic-bezier(0.2,0,0,1)] group-data-[resizing=true]/tower:transition-none motion-reduce:transition-none focus-visible:outline-dashed focus-visible:-outline-offset-2 ${background}`}
      style={{ height, transform: `translate3d(0, ${top}px, 0)` }}
    >
      {row.isPlayer ? (
        <>
          <span aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-[0.13]" style={{ backgroundColor: row.color }} />
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-[2px]" style={{ backgroundColor: row.color }} />
        </>
      ) : null}

      <span role="cell" className={`text-right font-mono tabular text-[12px] font-bold leading-none text-ink-50 ${dim}`}>
        {row.position}
      </span>

      <span role="cell" className={`flex items-center justify-center font-mono tabular text-[9px] leading-none ${dim}`}>
        {row.boxCall ? (
          <span className={`${TAG} pw-blink h-[13px] bg-ink-50 px-[1px] font-bold tracking-[0.02em] text-carbon-950`} title="Box call pending for the end of this lap">
            BOX
          </span>
        ) : row.gridDelta > 0 ? (
          <span className="inline-flex items-center gap-px text-ok" title={`Up ${row.gridDelta} from grid`}>
            <TriangleGlyph direction="up" size={5} />
            {row.gridDelta}
          </span>
        ) : row.gridDelta < 0 ? (
          <span className="inline-flex items-center gap-px text-crit" title={`Down ${-row.gridDelta} from grid`}>
            <TriangleGlyph direction="down" size={5} />
            {-row.gridDelta}
          </span>
        ) : null}
      </span>

      <span role="cell" className="flex min-w-0 items-center gap-[5px] overflow-hidden pl-[3px]">
        <DriverTag code={row.code} color={row.color} strong={row.isPlayer} className={`shrink-0 ${dim}`} />
        {/* car number set tighter than DriverTag's own: the column has no room to spare */}
        {row.isPlayer ? <span className={`-ml-[2px] shrink-0 font-mono text-3xs leading-none text-ink-500 ${dim}`}>#{row.carNumber}</span> : null}
        {row.fastestLap ? (
          <span className={`flex shrink-0 text-timing-purple ${dim}`} title="Fastest lap of the race">
            <Timer size={11} strokeWidth={2} aria-label="Fastest lap" />
          </span>
        ) : null}
        {row.status === 'FINISHED' ? <ChequeredFlagGlyph size={10} className="text-ink-300" title="Finished" /> : null}
      </span>

      <span role="cell" className="flex items-center justify-end gap-[3px]">
        {inPit ? (
          <span
            className={`${TAG} h-[14px] border border-carbon-500 bg-carbon-800 px-1 font-semibold tracking-[0.1em] text-ink-100`}
            title={row.status === 'PIT_BOX' ? 'Stationary in the pit box' : 'In the pit lane'}
          >
            IN PIT
          </span>
        ) : row.intervalKind === 'LEADER' ? (
          <span className="font-display text-[11px] font-semibold leading-none tracking-[0.1em] text-ink-300">{row.interval}</span>
        ) : (
          <>
            {row.dirtyAir ? (
              <span className="flex shrink-0 text-warn" title="Running in dirty air">
                <Wind size={9} strokeWidth={2.25} aria-label="Dirty air" />
              </span>
            ) : null}
            <span className={`${NUMERIC} font-medium ${row.intervalKind === 'TIME' ? 'text-ink-50' : 'text-ink-600'} ${dim}`}>{row.interval}</span>
          </>
        )}
      </span>

      <span role="cell" className={`flex items-center justify-end ${dim}`}>
        {retired ? (
          <span className="font-display text-[11px] font-semibold leading-none tracking-[0.1em] text-ink-100">{row.gap}</span>
        ) : row.intervalKind === 'LEADER' ? (
          <span className="font-display text-[11px] font-medium leading-none tracking-[0.08em] text-ink-500">{row.gap}</span>
        ) : (
          <span className={`${NUMERIC} ${row.intervalKind === 'NONE' ? 'text-ink-600' : 'text-ink-300'}`}>{row.gap}</span>
        )}
      </span>

      <span role="cell" className={`flex items-center justify-center ${dim}`} title={tyreTitle}>
        <span className="relative inline-flex items-center gap-[3px]">
          <TyreBadge compound={row.compound} size={15} title={tyreTitle} />
          <span className="w-[13px] text-right font-mono tabular text-[10px] leading-none text-ink-300">{row.tyreAge}</span>
          <span aria-hidden="true" className={`absolute inset-x-0 -bottom-[4px] h-[2px] ${row.wearPct >= 100 ? 'bg-crit' : 'bg-carbon-700'}`}>
            <span className={`absolute inset-y-0 left-0 ${wearBarClass(row.wearPct)}`} style={{ width: `${life}%` }} />
          </span>
        </span>
      </span>

      <SectorTime text={row.s1} flag={row.f1} current={row.currentSector === 0} dim={dim} />
      <SectorTime text={row.s2} flag={row.f2} current={row.currentSector === 1} dim={dim} />
      <SectorTime text={row.s3} flag={row.f3} current={row.currentSector === 2} dim={dim} />

      <span role="cell" className={`text-right font-mono tabular leading-none [font-size:var(--tt-sec)] ${LAP_TEXT[row.lastTone]} ${dim}`}>
        {row.lastLap}
      </span>

      <span role="cell" className={`text-right ${NUMERIC} ${row.pitStops > 0 ? 'text-ink-300' : 'text-ink-600'} ${dim}`}>{row.pitStops}</span>

      <span role="cell" className="flex items-center justify-end">
        {row.drs !== 'NONE' ? (
          <span
            className={`${TAG} h-[13px] border px-[2px] font-bold tracking-[0.04em] ${
              row.drs === 'OPEN' ? 'border-timing-green bg-timing-green text-carbon-950' : 'border-timing-green/70 text-ink-300'
            }`}
            title={row.drs === 'OPEN' ? 'DRS open' : 'Within one second: DRS available in the next zone'}
          >
            DRS
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** One car of the timing tower. Re-renders only when its own visible content, slot or selection changes. */
export const TimingRow = memo(
  TimingRowView,
  (a, b) =>
    a.top === b.top &&
    a.height === b.height &&
    a.selected === b.selected &&
    a.tabStop === b.tabStop &&
    a.onSelect === b.onSelect &&
    timingRowsEqual(a.row, b.row),
);
