/**
 * View model of the timing tower.
 *
 * A snapshot arrives ~10×/s as a fresh object graph (structured clone from the worker), so the car
 * objects can never be used as stable React props. Each car is flattened here into a record of
 * primitives; `timingRowsEqual` then lets `React.memo` skip every row whose visible content did not
 * change, however often the snapshot is replaced.
 */
import { formatGap, formatLapTime, formatSector } from '../../lib/format';
import { indexSession } from '../../lib/session';
import type {
  CarId,
  CarSnapshot,
  CarStatus,
  RaceSnapshot,
  SectorFlag,
  SessionInfo,
  TyreCompound,
} from '../../simulation/types';

/** What the INT cell shows: a time/laps interval, the leader tag, the pit tag or nothing. */
export type IntervalKind = 'TIME' | 'LEADER' | 'PIT' | 'NONE';
/** FIA colour of the last lap: overall fastest, personal best, ordinary, or no lap yet. */
export type LapTone = 'PURPLE' | 'GREEN' | 'PLAIN' | 'NONE';
export type DrsState = 'NONE' | 'ELIGIBLE' | 'OPEN';

export interface TimingRowModel {
  id: CarId;
  /** 0-based display slot (index in the classification). */
  slot: number;
  position: number;
  code: string;
  /** Team colour (hex). */
  color: string;
  isPlayer: boolean;
  carNumber: 1 | 2;
  status: CarStatus;
  /** Places gained (> 0) or lost (< 0) versus the grid; 0 while it is not meaningful. */
  gridDelta: number;
  interval: string;
  intervalKind: IntervalKind;
  dirtyAir: boolean;
  gap: string;
  compound: TyreCompound;
  tyreAge: number;
  /** Tyre wear in whole percent of the useful life (exceeds 100 past the cliff). */
  wearPct: number;
  s1: string;
  s2: string;
  s3: string;
  f1: SectorFlag;
  f2: SectorFlag;
  f3: SectorFlag;
  /** Sector being driven, or -1 when the car is not on a timed lap. */
  currentSector: -1 | 0 | 1 | 2;
  lastLap: string;
  lastTone: LapTone;
  pitStops: number;
  drs: DrsState;
  /** Pending box call (only ever true for the user's cars). */
  boxCall: boolean;
  fastestLap: boolean;
  battleWith: CarId | null;
  retiredReason: string | null;
}

/** Marker of an on-track fight, drawn on top of the rows. */
export interface BattleMarker {
  key: string;
  /**
   * LINK: the two cars are adjacent in the classification, the marker sits on the line between slot
   * `slot - 1` and `slot`. SOLO: the opponent is elsewhere in the order, the marker sits in row `slot`.
   */
  kind: 'LINK' | 'SOLO';
  slot: number;
  label: string;
}

const DASH = '—';
/** Lap times are compared after rounding to the millisecond shown on screen. */
const LAP_EPSILON = 0.0005;

function sameLap(a: number, b: number): boolean {
  return Math.abs(a - b) < LAP_EPSILON;
}

function lastLapTone(car: CarSnapshot, snapshot: RaceSnapshot): LapTone {
  const last = car.lastLapTime;
  if (last === null) return 'NONE';
  const fastest = snapshot.fastestLap;
  if (fastest !== null && fastest.carId === car.id && sameLap(last, fastest.time)) return 'PURPLE';
  if (car.bestLapTime !== null && sameLap(last, car.bestLapTime)) return 'GREEN';
  return 'PLAIN';
}

function buildRow(car: CarSnapshot, slot: number, session: SessionInfo, snapshot: RaceSnapshot): TimingRowModel {
  const index = indexSession(session);
  const driver = index.driver(car.id);
  const isPlayer = index.isPlayer(car.id);
  const { status } = car;
  const onGrid = status === 'GRID';
  const retired = status === 'RETIRED';
  const inPit = status === 'PIT_LANE' || status === 'PIT_BOX';
  const timed = !onGrid && !retired;
  const leader = timed && car.position === 1;

  let interval = DASH;
  let intervalKind: IntervalKind = 'NONE';
  let gap = DASH;
  if (retired) {
    interval = '';
    gap = 'OUT';
  } else if (timed) {
    if (leader) {
      interval = status === 'FINISHED' ? 'WINNER' : 'LEADER';
      intervalKind = 'LEADER';
      gap = `LAP ${Math.min(snapshot.raceLaps, Math.max(1, snapshot.lap))}`;
    } else {
      interval = formatGap(car.interval, car.intervalLaps);
      intervalKind = 'TIME';
      gap = formatGap(car.gapToLeader, car.lapsDown);
    }
    if (inPit) intervalKind = 'PIT';
  }

  const [c1, c2, c3] = car.sectors;
  const showSectors = timed;
  return {
    id: car.id,
    slot,
    position: car.position,
    code: driver.code,
    color: index.color(car.id),
    isPlayer,
    carNumber: driver.carNumber,
    status,
    gridDelta: timed ? car.gridPosition - car.position : 0,
    interval,
    intervalKind,
    dirtyAir: status === 'RACING' && car.inDirtyAir,
    gap,
    compound: car.tyre.compound,
    tyreAge: car.tyre.ageLaps,
    wearPct: Math.max(0, Math.round(car.tyre.wear * 100)),
    s1: showSectors ? formatSector(c1.time) : DASH,
    s2: showSectors ? formatSector(c2.time) : DASH,
    s3: showSectors ? formatSector(c3.time) : DASH,
    f1: showSectors && c1.time !== null ? c1.flag : 'NONE',
    f2: showSectors && c2.time !== null ? c2.flag : 'NONE',
    f3: showSectors && c3.time !== null ? c3.flag : 'NONE',
    currentSector: status === 'RACING' ? car.currentSector : -1,
    lastLap: onGrid ? DASH : formatLapTime(car.lastLapTime),
    // a retired car keeps its last lap on screen, but no longer in timing colours
    lastTone: onGrid || car.lastLapTime === null ? 'NONE' : retired ? 'PLAIN' : lastLapTone(car, snapshot),
    pitStops: car.pitStops,
    drs: status !== 'RACING' ? 'NONE' : car.drsOpen ? 'OPEN' : car.drsEligible ? 'ELIGIBLE' : 'NONE',
    boxCall: isPlayer && car.boxThisLap && status === 'RACING',
    fastestLap: car.hasFastestLap,
    battleWith: status === 'RACING' ? car.battleWith : null,
    retiredReason: car.retiredReason,
  };
}

/** One row per car, in classification order (retired cars stay wherever `position` puts them). */
export function buildTimingRows(session: SessionInfo, snapshot: RaceSnapshot): TimingRowModel[] {
  const ordered = snapshot.cars.slice().sort((a, b) => a.position - b.position);
  return ordered.map((car, slot) => buildRow(car, slot, session, snapshot));
}

/** Battle markers for the overlay: one per fight, de-duplicated across the two cars involved. */
export function buildBattleMarkers(rows: readonly TimingRowModel[]): BattleMarker[] {
  const slotOf = new Map<CarId, number>();
  for (const row of rows) slotOf.set(row.id, row.slot);
  const markers: BattleMarker[] = [];
  const linked = new Set<number>();
  for (const row of rows) {
    if (row.battleWith === null) continue;
    const other = slotOf.get(row.battleWith);
    if (other !== undefined && Math.abs(other - row.slot) === 1) {
      const boundary = Math.max(other, row.slot);
      if (!linked.has(boundary)) {
        linked.add(boundary);
        const upper = other < row.slot ? row.battleWith : row.id;
        const lower = other < row.slot ? row.id : row.battleWith;
        markers.push({ key: `link-${boundary}`, kind: 'LINK', slot: boundary, label: `${upper} and ${lower} are fighting for position` });
      }
    } else {
      markers.push({ key: `solo-${row.id}`, kind: 'SOLO', slot: row.slot, label: `${row.id} is fighting ${row.battleWith}` });
    }
  }
  return markers;
}

/** Field-by-field equality of two row models (all fields are primitives). */
export function timingRowsEqual(a: TimingRowModel, b: TimingRowModel): boolean {
  return (
    a.id === b.id &&
    a.slot === b.slot &&
    a.position === b.position &&
    a.interval === b.interval &&
    a.gap === b.gap &&
    a.intervalKind === b.intervalKind &&
    a.dirtyAir === b.dirtyAir &&
    a.s1 === b.s1 &&
    a.s2 === b.s2 &&
    a.s3 === b.s3 &&
    a.f1 === b.f1 &&
    a.f2 === b.f2 &&
    a.f3 === b.f3 &&
    a.currentSector === b.currentSector &&
    a.lastLap === b.lastLap &&
    a.lastTone === b.lastTone &&
    a.status === b.status &&
    a.gridDelta === b.gridDelta &&
    a.compound === b.compound &&
    a.tyreAge === b.tyreAge &&
    a.wearPct === b.wearPct &&
    a.pitStops === b.pitStops &&
    a.drs === b.drs &&
    a.boxCall === b.boxCall &&
    a.fastestLap === b.fastestLap &&
    a.battleWith === b.battleWith &&
    a.retiredReason === b.retiredReason &&
    a.code === b.code &&
    a.color === b.color &&
    a.isPlayer === b.isPlayer &&
    a.carNumber === b.carNumber
  );
}

export interface RowLayout {
  /** Top edge of each slot in pixels; `tops[count]` is the total height. */
  tops: number[];
  /** True when the rows do not fit and the body has to scroll. */
  scrolls: boolean;
}

/** Shortest row that still holds one line of timing data with its under-bars. */
export const MIN_ROW_HEIGHT = 28;
/** Beyond this the tower stops stretching and leaves the remaining height empty. */
export const MAX_ROW_HEIGHT = 48;

/**
 * Splits the available height into `count` rows. Row edges are rounded to whole pixels (so hairlines
 * stay crisp) while the rows together fill the height exactly: neighbouring rows may differ by 1 px.
 */
export function computeRowLayout(availableHeight: number, count: number): RowLayout {
  const rows = Math.max(1, count);
  const ideal = availableHeight / rows;
  const height = Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, ideal));
  const tops: number[] = [];
  for (let i = 0; i <= count; i++) tops.push(Math.round(i * height));
  return { tops, scrolls: ideal < MIN_ROW_HEIGHT };
}
