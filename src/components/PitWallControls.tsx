import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Check,
  Flag,
  Flame,
  Layers,
  Shield,
  Siren,
  SlidersHorizontal,
  Snowflake,
  Swords,
  Wrench,
  X,
} from 'lucide-react';
import type { PitWallActions, PitWallControlsProps } from './contracts';
import type {
  CarId,
  CarSnapshot,
  DoubleStackEstimate,
  ErsMode,
  FlagStatus,
  PaceMode,
  PlanId,
  PlayerCarTelemetry,
  RacePhase,
  TeamOrderMode,
  TrackDefinition,
  TyreSet,
  TyreState,
} from '../simulation/types';
import {
  CLIFF_WEAR,
  COMPOUNDS,
  ERS_MODES,
  PACE_MODES,
  TEMP_LIMITS,
  lapScale,
  pitLossUnderFlag,
} from '../simulation/physicsModel';
import { formatDelta, formatGap, formatLapTime, formatPercent, formatPosition, formatSeconds, formatTemp } from '../lib/format';
import { indexSession } from '../lib/session';
import type { SessionIndex } from '../lib/session';
import { TYRE_LABELS, TYRE_ORDER } from '../lib/tyres';
import { DriverTag, Meter, Panel, Segmented, TyreBadge } from './ui';
import type { SegmentedOption } from './ui';
import { StatusTag, StatusWord, Tag, ToggleButton, ToneIcon, formatSignedPercent, limitTone, wearTone } from './controls/shared';
import type { Tone } from './controls/shared';

/** Full scale of the wear gauge: 30% of headroom beyond the cliff. */
const WEAR_SCALE = 1.3;
/** A set this worn is shown dimmed in the picker. */
const WORN_OUT_WEAR = 0.9;
/** Rows of a car column; both columns share them through a subgrid so the blocks line up. */
const COLUMN_ROWS = 10;

const ICON = { size: 11, strokeWidth: 1.75 } as const;
/** Compact joined buttons for the 200 px car columns. */
const SEGMENTED_TIGHT = '[&>button]:px-1 [&>button]:py-[5px] [&>button]:tracking-[0.04em]';

const PLAN_OPTIONS: readonly SegmentedOption<PlanId>[] = [
  { value: 'A', label: 'A', title: 'Plan A' },
  { value: 'B', label: 'B', title: 'Plan B' },
  { value: 'C', label: 'C', title: 'Plan C' },
];

const TEAM_ORDER_OPTIONS: readonly SegmentedOption<TeamOrderMode>[] = [
  { value: 'FREE', label: 'Free race', title: 'The two cars are free to race each other' },
  { value: 'HOLD', label: 'Hold position', title: 'The two cars hold station' },
];

const FLAG_LABELS: Record<FlagStatus, string> = {
  GREEN: 'GREEN',
  YELLOW: 'YELLOW',
  VSC: 'VSC',
  SC: 'SAFETY CAR',
  RED: 'RED FLAG',
  CHEQUERED: 'CHEQUERED',
};

const FLAG_SWATCH: Record<FlagStatus, string> = {
  GREEN: 'bg-flag-green',
  YELLOW: 'bg-flag-yellow',
  VSC: 'bg-flag-sc',
  SC: 'bg-flag-sc',
  RED: 'bg-flag-red',
  CHEQUERED: 'bg-ink-100',
};

// ───────────────────────────────────────────────────────────────── helpers ──

function isInPit(car: CarSnapshot): boolean {
  return car.status === 'PIT_LANE' || car.status === 'PIT_BOX';
}

/** Why the car cannot take orders at all (retired, classified, race over), or null. */
function outOfRaceReason(car: CarSnapshot, phase: RacePhase): string | null {
  if (car.status === 'RETIRED') return 'Car retired';
  if (car.status === 'FINISHED' || phase === 'FINISHED') return 'Race finished';
  return null;
}

/** Sets that can be bolted on at the next stop, in S M H I W order, freshest first. */
function availableSets(telemetry: PlayerCarTelemetry): TyreSet[] {
  return telemetry.tyreSets
    .filter((set) => !set.fitted)
    .sort(
      (a, b) =>
        TYRE_ORDER.indexOf(a.compound) - TYRE_ORDER.indexOf(b.compound) || a.wear - b.wear || a.laps - b.laps || a.id.localeCompare(b.id),
    );
}

/** Default choice of the picker: the least-worn set of the next planned compound. */
function plannedSetId(telemetry: PlayerCarTelemetry, sets: readonly TyreSet[]): string | null {
  const compound = telemetry.nextPlannedStop?.compound;
  if (!compound) return null;
  return sets.find((set) => set.compound === compound)?.id ?? null;
}

function describeSet(set: TyreSet): string {
  return set.isNew && set.laps === 0 ? 'NEW' : `${set.laps} L · ${formatPercent(set.wear)}`;
}

function paceTradeOff(mode: PaceMode, scale: number): ReactNode {
  const spec = PACE_MODES[mode];
  return (
    <>
      <Num>{formatDelta(spec.lapDelta * scale, 2)}</Num> s/lap · wear <Num>{formatSignedPercent(spec.wear - 1)}</Num> · fuel{' '}
      <Num>{formatSignedPercent(spec.fuel - 1, 1)}</Num>
    </>
  );
}

/** Tooltip of an ERS mode: lap-time effect and battery drift per lap. */
function ersTitle(mode: ErsMode, scale: number): string {
  const spec = ERS_MODES[mode];
  return `${spec.label}: ${formatDelta(spec.lapDelta * scale, 2)} s/lap · battery ${formatSignedPercent(spec.chargePerLap)}/lap`;
}

function paceTitle(mode: PaceMode, scale: number): string {
  const spec = PACE_MODES[mode];
  return `${spec.label}: ${formatDelta(spec.lapDelta * scale, 2)} s/lap · wear ${formatSignedPercent(spec.wear - 1)} · fuel ${formatSignedPercent(spec.fuel - 1, 1)}`;
}

function tyreWindow(tyre: TyreState): { label: string; tone: Tone; icon: ReactNode } {
  const [low, high] = COMPOUNDS[tyre.compound].windowC;
  if (tyre.tempC > high) return { label: 'Hot', tone: 'serious', icon: <Flame {...ICON} /> };
  if (tyre.tempC < low || tyre.readiness < 0.8) return { label: 'Cold', tone: 'warn', icon: <Snowflake {...ICON} /> };
  return { label: 'In window', tone: 'ok', icon: <Check {...ICON} /> };
}

function cliffReadout(lifeLaps: number, wear: number): { text: string; tone: Tone } {
  if (wear >= CLIFF_WEAR) return { text: 'Past the cliff', tone: 'crit' };
  if (!Number.isFinite(lifeLaps)) return { text: 'Cliff —', tone: 'neutral' };
  const laps = Math.max(0, Math.floor(lifeLaps));
  if (laps < 1) return { text: 'Cliff in < 1 lap', tone: 'serious' };
  return { text: `Cliff in ${laps} lap${laps === 1 ? '' : 's'}`, tone: laps <= 3 ? 'warn' : 'neutral' };
}

// ───────────────────────────────────────────────────────────── small parts ──

function Num({ children }: { children: ReactNode }) {
  return <span className="font-mono tabular text-ink-300">{children}</span>;
}

function Cell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`min-w-0 border-t border-carbon-700 px-1.5 py-[3px] ${className}`}>{children}</div>;
}

/** Label column + content, the row pattern of the car columns. */
function Row({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`grid grid-cols-[30px_minmax(0,1fr)] items-center gap-x-1 ${className}`}>
      <span className="pw-label">{label}</span>
      {children}
    </div>
  );
}

function Neighbour({
  direction,
  car,
  gap,
  index,
}: {
  direction: 'ahead' | 'behind';
  car: CarSnapshot | undefined;
  gap: string;
  index: SessionIndex;
}) {
  const Arrow = direction === 'ahead' ? ArrowUp : ArrowDown;
  return (
    <span className="flex min-w-0 items-center gap-1" title={direction === 'ahead' ? 'Interval to the car ahead' : 'Interval to the car behind'}>
      <Arrow size={10} strokeWidth={1.75} aria-hidden className="shrink-0 text-ink-500" />
      {car ? (
        <>
          <span className="h-2.5 w-[2px] shrink-0 rounded-[1px]" style={{ backgroundColor: index.color(car.id) }} />
          <span className="font-display text-2xs font-semibold leading-none tracking-wider text-ink-300">{car.id}</span>
          <span className="font-mono text-[10px] leading-none tabular text-ink-100">{gap}</span>
        </>
      ) : (
        <span className="font-mono text-[10px] leading-none text-ink-600">—</span>
      )}
    </span>
  );
}

function TempReadout({ label, value, warnAt, critAt }: { label: string; value: number; warnAt: number; critAt: number }) {
  const tone = limitTone(value, warnAt, critAt);
  return (
    <span className="flex items-center gap-1" title={`${label} temperature · warning ${warnAt}°C · critical ${critAt}°C`}>
      <span className="pw-label">{label}</span>
      <ToneIcon tone={tone} size={10} />
      <span className={`font-mono text-2xs font-medium tabular ${tone === 'ok' ? 'text-ink-100' : tone === 'warn' ? 'text-warn' : 'text-crit'}`}>
        {formatTemp(value)}
      </span>
    </span>
  );
}

// ────────────────────────────────────────────────────────────── car column ──

interface CarColumnProps {
  track: TrackDefinition;
  index: SessionIndex;
  telemetry: PlayerCarTelemetry;
  car: CarSnapshot;
  ahead: CarSnapshot | undefined;
  behind: CarSnapshot | undefined;
  phase: RacePhase;
  /** FIA colour class of the last lap (purple / green) or neutral ink. */
  lastLapClass: string;
  selected: boolean;
  sets: readonly TyreSet[];
  chosenSet: TyreSet | undefined;
  onPickSet: (carId: CarId, setId: string) => void;
  onSelectCar: (carId: CarId | null) => void;
  actions: PitWallActions;
  className?: string;
}

function CarColumn({
  track,
  index,
  telemetry,
  car,
  ahead,
  behind,
  phase,
  lastLapClass,
  selected,
  sets,
  chosenSet,
  onPickSet,
  onSelectCar,
  actions,
  className = '',
}: CarColumnProps) {
  const carId = telemetry.carId;
  const driver = index.driver(carId);
  const color = index.color(carId);
  const scale = lapScale(track);
  const outReason = outOfRaceReason(car, phase);
  const locked = outReason !== null;
  const tyre = car.tyre;
  const fittedSet = telemetry.tyreSets.find((set) => set.fitted);
  const wearToneNow = wearTone(tyre.wear);
  const cliff = cliffReadout(telemetry.tyreLifeLaps, tyre.wear);
  const thermal = tyreWindow(tyre);
  const [windowLow, windowHigh] = COMPOUNDS[tyre.compound].windowC;
  const fuelShort = telemetry.fuelMarginLaps < 0;
  const batteryLow = telemetry.ersCharge < 0.1;

  const paceOptions: SegmentedOption<PaceMode>[] = [
    { value: 'PUSH', label: 'Push', title: paceTitle('PUSH', scale), disabled: locked },
    { value: 'BALANCED', label: 'Balanced', title: paceTitle('BALANCED', scale), disabled: locked },
    { value: 'CONSERVE', label: 'Lift & coast', title: paceTitle('CONSERVE', scale), disabled: locked },
  ];
  const ersOptions: SegmentedOption<ErsMode>[] = [
    { value: 'OVERTAKE', label: 'Overtake', title: ersTitle('OVERTAKE', scale), disabled: locked },
    { value: 'BALANCED', label: 'Balanced', title: ersTitle('BALANCED', scale), disabled: locked },
    { value: 'HARVEST', label: 'Harvest', title: ersTitle('HARVEST', scale), disabled: locked },
  ];
  const planOptions = locked ? PLAN_OPTIONS.map((option) => ({ ...option, disabled: true })) : PLAN_OPTIONS;

  return (
    <section
      aria-label={`Car ${telemetry.carNumber} ${driver.code}`}
      className={`grid min-w-0 grid-rows-subgrid ${className}`}
      style={{ gridRow: `1 / span ${COLUMN_ROWS}` }}
    >
      {/* ── driver header ─────────────────────────────────────────────── */}
      <button
        type="button"
        aria-pressed={selected}
        title={selected ? 'Deselect this car' : 'Select this car on the timing screens'}
        onClick={() => onSelectCar(selected ? null : carId)}
        className={`relative flex min-w-0 flex-col gap-1 px-1.5 pb-[3px] pt-[5px] text-left transition-colors hover:bg-carbon-800 focus-visible:-outline-offset-1 ${selected ? 'bg-carbon-850' : ''}`}
      >
        <span aria-hidden className={`absolute inset-x-0 top-0 h-[2px] ${selected ? 'bg-team' : 'bg-transparent'}`} />
        <span className="flex w-full items-center gap-1.5">
          <DriverTag code={driver.code} color={color} carNumber={telemetry.carNumber} strong />
          <span className="font-mono text-xs font-bold leading-none tabular text-ink-50">{formatPosition(car.position)}</span>
          {car.status === 'RETIRED' ? (
            <StatusTag tone="crit">Retired</StatusTag>
          ) : car.status === 'FINISHED' ? (
            <Tag>
              <Flag size={10} strokeWidth={1.75} aria-hidden />
              Finished
            </Tag>
          ) : isInPit(car) ? (
            <StatusTag tone="warn" icon={<Wrench size={10} strokeWidth={1.75} aria-hidden />}>
              {car.status === 'PIT_BOX' ? 'In box' : 'In pit'}
            </StatusTag>
          ) : car.status === 'GRID' ? (
            <Tag>Grid</Tag>
          ) : car.battleWith ? (
            <Tag title={`In a battle with ${car.battleWith}`}>
              <Swords size={10} strokeWidth={1.75} aria-hidden />
              {car.battleWith}
            </Tag>
          ) : null}
          <span className={`ml-auto font-mono text-2xs font-medium leading-none tabular ${lastLapClass}`} title="Last lap">
            {formatLapTime(car.lastLapTime)}
          </span>
        </span>
        {car.status === 'RETIRED' ? (
          <span className="w-full truncate text-2xs leading-3 text-ink-300">{car.retiredReason ?? 'Out of the race'}</span>
        ) : (
          <span className="flex w-full items-center justify-between gap-2">
            <Neighbour direction="ahead" car={ahead} gap={formatGap(car.interval, car.intervalLaps)} index={index} />
            <Neighbour
              direction="behind"
              car={behind}
              gap={behind ? formatGap(behind.interval, behind.intervalLaps) : '—'}
              index={index}
            />
          </span>
        )}
      </button>

      {/* ── tyres ─────────────────────────────────────────────────────── */}
      <Cell>
        <div className="flex items-center gap-1.5">
          <TyreBadge compound={tyre.compound} size={20} used={fittedSet ? !fittedSet.isNew : false} />
          <span className="truncate font-display text-xs font-semibold uppercase leading-none tracking-wider text-ink-100">
            {TYRE_LABELS[tyre.compound]}
          </span>
          <span className="whitespace-nowrap font-mono text-[10px] leading-none tabular text-ink-300" title="Laps on this set">
            {tyre.ageLaps} L
          </span>
          <span className="ml-auto flex items-center gap-1" title="Tyre wear (100% = the cliff)">
            <ToneIcon tone={wearToneNow} />
            <span className="pw-value text-xs leading-none">{formatPercent(tyre.wear)}</span>
          </span>
        </div>
        <div className="relative mt-1">
          <Meter
            value={tyre.wear / WEAR_SCALE}
            tone={wearToneNow}
            markers={[CLIFF_WEAR / WEAR_SCALE]}
            height={5}
            ariaLabel={`Tyre wear ${formatPercent(tyre.wear)} of the life to the cliff`}
          />
          {/* cliff tick: reaches past the gauge so the 100% mark reads at a glance */}
          <span
            aria-hidden
            className="absolute -bottom-[3px] -top-[3px] w-px bg-ink-300"
            style={{ left: `${(CLIFF_WEAR / WEAR_SCALE) * 100}%` }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between gap-1">
          <span className="flex min-w-0 items-center gap-1 font-display text-[10px] font-semibold uppercase leading-3 tracking-[0.08em]">
            {cliff.tone !== 'neutral' ? <ToneIcon tone={cliff.tone} size={10} /> : null}
            <span className={`truncate ${cliff.tone === 'neutral' ? 'text-ink-300' : cliff.tone === 'warn' ? 'text-warn' : cliff.tone === 'serious' ? 'text-serious' : 'text-crit'}`}>
              {cliff.text}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1" title={`Tread temperature · window ${windowLow}–${windowHigh}°C`}>
            <span className="font-mono text-[10px] leading-none tabular text-ink-100">{formatTemp(tyre.tempC)}</span>
            <StatusWord tone={thermal.tone} icon={thermal.icon}>
              {thermal.label}
            </StatusWord>
          </span>
        </div>
      </Cell>

      {/* ── car ───────────────────────────────────────────────────────── */}
      <Cell className="flex flex-col gap-0.5">
        <Row label="Fuel">
          <span className="flex items-center justify-between gap-1">
            <span className="pw-value text-2xs">
              {telemetry.fuelKg.toFixed(1)}
              <span className="ml-0.5 text-[10px] font-normal text-ink-500">kg</span>
            </span>
            <span className="flex items-center gap-1" title="Laps of fuel in hand at balanced pace">
              {fuelShort ? <ToneIcon tone="crit" size={10} /> : null}
              <span className={`font-mono text-2xs font-medium tabular ${fuelShort ? 'text-crit' : 'text-ink-300'}`}>
                {formatDelta(telemetry.fuelMarginLaps, 1)}
              </span>
              <span className="pw-label">{fuelShort ? 'laps short' : 'laps'}</span>
            </span>
          </span>
        </Row>
        <Row label="Batt">
          <span className="flex items-center gap-1.5">
            <Meter
              value={telemetry.ersCharge}
              tone={batteryLow ? 'warn' : 'neutral'}
              height={5}
              ariaLabel={`Battery state of charge ${formatPercent(telemetry.ersCharge)}`}
            />
            {batteryLow ? <ToneIcon tone="warn" size={10} /> : null}
            <span className="pw-value w-[30px] shrink-0 text-right text-2xs">{formatPercent(telemetry.ersCharge)}</span>
          </span>
        </Row>
        <div className="flex items-center justify-between gap-1">
          <TempReadout label="PU" value={telemetry.engineTempC} warnAt={TEMP_LIMITS.engineWarn} critAt={TEMP_LIMITS.engineCritical} />
          <TempReadout label="Brk" value={telemetry.brakeTempC} warnAt={TEMP_LIMITS.brakeWarn} critAt={TEMP_LIMITS.brakeCritical} />
        </div>
      </Cell>

      {/* ── pace ──────────────────────────────────────────────────────── */}
      <Cell>
        <Row label="Pace">
          <Segmented
            options={paceOptions}
            value={car.paceMode}
            onChange={(mode) => actions.setPaceMode(carId, mode)}
            ariaLabel={`Pace mode, ${driver.code}`}
            className={SEGMENTED_TIGHT}
          />
        </Row>
        <p className="mt-1 whitespace-nowrap text-[10px] leading-3 text-ink-500">{paceTradeOff(car.paceMode, scale)}</p>
      </Cell>

      {/* ── ERS ───────────────────────────────────────────────────────── */}
      <Cell>
        <Row label="ERS">
          <Segmented
            options={ersOptions}
            value={car.ersMode}
            onChange={(mode) => actions.setErsMode(carId, mode)}
            ariaLabel={`ERS mode, ${driver.code}`}
            className={SEGMENTED_TIGHT}
          />
        </Row>
      </Cell>

      {/* ── standing orders ───────────────────────────────────────────── */}
      <Cell className="flex items-center gap-1">
        <ToggleButton
          pressed={telemetry.defend}
          onToggle={(next) => actions.setDefend(carId, next)}
          label="Defend"
          icon={<Shield size={12} strokeWidth={1.75} aria-hidden />}
          disabled={locked}
          title="Instruct the driver to defend his position"
          className="flex-1 px-1 py-[5px] tracking-[0.06em]"
        />
        <ToggleButton
          pressed={telemetry.strategy.autoBox}
          onToggle={(next) => actions.setAutoBox(carId, next)}
          label="Auto-box"
          disabled={locked}
          title="When on, the race engineer calls the planned stops himself"
          className="flex-1 px-1 py-[5px] tracking-[0.06em]"
        />
      </Cell>

      {/* ── box, box ──────────────────────────────────────────────────── */}
      <Cell>
        <BoxControl
          telemetry={telemetry}
          car={car}
          phase={phase}
          outReason={outReason}
          sets={sets}
          chosenSet={chosenSet}
          driverCode={driver.code}
          onPick={(setId) => onPickSet(carId, setId)}
          onBox={(setId) => actions.box(carId, setId)}
          onCancel={() => actions.cancelBox(carId)}
        />
      </Cell>

      {/* ── rejoin ────────────────────────────────────────────────────── */}
      <Cell>
        <RejoinReadout telemetry={telemetry} index={index} />
      </Cell>

      {/* ── undercut / threat ─────────────────────────────────────────── */}
      <Cell className="flex flex-col gap-0.5">
        <UndercutReadout telemetry={telemetry} index={index} />
      </Cell>

      {/* ── plan ──────────────────────────────────────────────────────── */}
      <Cell className="flex items-center gap-1.5">
        <span className="pw-label">Plan</span>
        <Segmented
          options={planOptions}
          value={telemetry.strategy.activePlan}
          onChange={(planId) => actions.setActivePlan(carId, planId)}
          ariaLabel={`Active plan, ${driver.code}`}
          fill={false}
          className="[&>button]:w-6 [&>button]:px-0 [&>button]:py-[5px]"
        />
        <span className="ml-auto flex items-center gap-1" title="Next stop of the active plan">
          <span className="pw-label">Next</span>
          {telemetry.nextPlannedStop ? (
            <>
              <span className="pw-value text-2xs">L{telemetry.nextPlannedStop.lap}</span>
              <span aria-hidden className="text-ink-500">
                →
              </span>
              <TyreBadge compound={telemetry.nextPlannedStop.compound} size={16} />
            </>
          ) : (
            <span className="font-mono text-2xs text-ink-500">no stop</span>
          )}
        </span>
      </Cell>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── box box ──

interface BoxControlProps {
  telemetry: PlayerCarTelemetry;
  car: CarSnapshot;
  phase: RacePhase;
  outReason: string | null;
  sets: readonly TyreSet[];
  chosenSet: TyreSet | undefined;
  driverCode: string;
  onPick: (setId: string) => void;
  onBox: (setId: string) => void;
  onCancel: () => void;
}

function BoxControl({ telemetry, car, phase, outReason, sets, chosenSet, driverCode, onPick, onBox, onCancel }: BoxControlProps) {
  const suspended = phase === 'SUSPENDED';
  // On the grid the same order simply chooses the starting set.
  const onGrid = phase === 'GRID';
  // Under a red flag the cars sit in the pit lane and a free tyre change is exactly what is on offer.
  const blocked = outReason ?? (isInPit(car) && !suspended ? 'In the pit lane' : null);
  const call = telemetry.boxCall;

  if (blocked) {
    return (
      <div className="flex h-full min-h-[80px] flex-col items-center justify-center gap-1 rounded-[2px] border border-carbon-700 bg-carbon-850 px-2 text-center">
        <span className="flex items-center gap-1.5 font-display text-2xs font-semibold uppercase tracking-[0.1em] text-ink-300">
          {outReason ? <Flag {...ICON} aria-hidden /> : <Wrench {...ICON} aria-hidden />}
          {blocked}
        </span>
        <span className="text-[10px] leading-3 text-ink-500">
          {outReason ? 'No box call possible' : call ? `Fitting ${TYRE_LABELS[call.compound]} ${call.setId}` : 'Stop in progress'}
        </span>
      </div>
    );
  }

  if (call) {
    const eta = Math.max(0, Math.round(call.etaSeconds));
    return (
      <div role="status" className="flex h-full min-h-[80px] flex-col justify-between gap-1 rounded-[2px] border border-warn/60 bg-warn/10 p-1">
        <div className="flex items-center gap-1.5">
          <Siren size={13} strokeWidth={1.75} aria-hidden className="pw-blink shrink-0 text-warn" />
          <span className="pw-blink font-display text-xs font-bold uppercase leading-none tracking-[0.12em] text-ink-50">
            {suspended ? 'Restart set confirmed' : 'Box confirmed'}
          </span>
          <span className="pw-label ml-auto text-ink-300" title="Reason of the call">
            {call.reason.replace('_', ' ')}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <TyreBadge compound={call.compound} size={16} />
          <span className="font-display text-2xs font-semibold uppercase leading-none tracking-wider text-ink-100">
            {TYRE_LABELS[call.compound]} <span className="font-mono text-[10px] font-normal tracking-normal text-ink-300">{call.setId}</span>
          </span>
          {suspended ? null : (
            <span className="ml-auto whitespace-nowrap text-[10px] uppercase leading-none tracking-wide text-ink-300">
              pit entry in <span className="pw-value text-2xs normal-case text-ink-50">{eta} s</span>
            </span>
          )}
        </div>
        <button type="button" onClick={onCancel} className="pw-btn w-full py-[5px]" title={`Cancel the box call for ${driverCode}`}>
          <X size={12} strokeWidth={1.75} aria-hidden />
          Cancel
        </button>
      </div>
    );
  }

  const groups = TYRE_ORDER.map((compound) => sets.filter((set) => set.compound === compound)).filter((group) => group.length > 0);
  const armed = chosenSet !== undefined;

  return (
    <div className="flex h-full min-h-[80px] flex-col gap-1">
      <div className="flex items-center justify-between gap-1">
        <span className="pw-label">{onGrid ? 'Start tyres' : suspended ? 'Restart tyres' : 'Box, box'}</span>
        <span className="truncate font-mono text-[10px] leading-3 tabular text-ink-300">
          {chosenSet ? `${chosenSet.id} · ${describeSet(chosenSet)}` : 'select a set'}
        </span>
      </div>
      {groups.length > 0 ? (
        <div role="radiogroup" aria-label={onGrid ? `Starting tyre set, ${driverCode}` : `Tyre set for the next stop, ${driverCode}`} className="flex flex-wrap gap-x-[5px] gap-y-0.5">
          {groups.map((group) => (
            <div key={group[0]?.compound} className="flex gap-px">
              {group.map((set) => {
                const selected = chosenSet?.id === set.id;
                const fresh = set.isNew && set.laps === 0;
                return (
                  <button
                    key={set.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={`${TYRE_LABELS[set.compound]} ${set.id}, ${fresh ? 'new' : `${set.laps} laps, wear ${formatPercent(set.wear)}`}`}
                    title={`${TYRE_LABELS[set.compound]} ${set.id} · ${describeSet(set)}${set.wear > WORN_OUT_WEAR ? ' · worn out' : ''}`}
                    onClick={() => onPick(set.id)}
                    className={`flex w-[23px] flex-col items-center gap-px rounded-[2px] border pb-px pt-0.5 transition-colors focus-visible:outline-offset-0 ${
                      selected ? 'border-ink-100 bg-carbon-750' : 'border-transparent hover:border-carbon-500 hover:bg-carbon-800'
                    } ${set.wear > WORN_OUT_WEAR ? 'opacity-45' : ''}`}
                  >
                    <TyreBadge compound={set.compound} size={18} used={!set.isNew} />
                    <span className="font-display text-3xs font-semibold leading-[9px] tracking-wide text-ink-300">
                      {fresh ? 'NEW' : `${set.laps}L`}
                    </span>
                    <span className="font-display text-3xs font-medium leading-[9px] text-ink-500">{fresh ? ' ' : formatPercent(set.wear)}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <span className="flex-1 text-2xs text-ink-500">No set left in the allocation</span>
      )}
      <button
        type="button"
        disabled={!armed}
        onClick={() => {
          if (chosenSet) onBox(chosenSet.id);
        }}
        className={`mt-auto flex h-[26px] w-full shrink-0 items-center justify-center gap-1.5 rounded-[2px] border font-display text-xs font-bold uppercase leading-none tracking-[0.12em] transition-colors ${
          armed
            ? 'border-ink-100 bg-ink-100 text-carbon-950 hover:border-ink-50 hover:bg-ink-50'
            : 'border-carbon-600 bg-carbon-800 text-ink-500 opacity-60'
        }`}
      >
        {onGrid ? 'Start on this set' : suspended ? 'Fit for restart' : 'Box this lap'}
        {chosenSet ? <TyreBadge compound={chosenSet.compound} size={14} used={!chosenSet.isNew} /> : null}
      </button>
    </div>
  );
}

// ───────────────────────────────────────────────────────── strategy readouts ──

function RejoinReadout({ telemetry, index }: { telemetry: PlayerCarTelemetry; index: SessionIndex }) {
  const rejoin = telemetry.rejoin;
  if (!rejoin) {
    return (
      <div className="flex min-h-[28px] items-center gap-1.5">
        <span className="pw-label">Rejoin</span>
        <span className="font-mono text-2xs text-ink-600">—</span>
        <span className="pw-label ml-auto text-ink-600">no estimate</span>
      </div>
    );
  }
  const lost = rejoin.positionsLost;
  const change = lost > 0 ? `−${lost}` : lost < 0 ? `+${-lost}` : '±0';
  return (
    <div className="flex min-h-[28px] flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className="pw-label">Rejoin</span>
        <span className="pw-value text-xs font-bold leading-none text-ink-50">{formatPosition(rejoin.position)}</span>
        <span className="font-mono text-[10px] leading-none tabular text-ink-300" title="Positions lost by stopping now">
          ({change})
        </span>
        <span className="ml-auto">
          {rejoin.clearAir ? <StatusWord tone="ok">Clear air</StatusWord> : <StatusWord tone="warn">Traffic</StatusWord>}
        </span>
      </div>
      <div className="flex items-center justify-between gap-1">
        <ExitNeighbour direction="ahead" carId={rejoin.carAhead} gap={rejoin.gapAhead} index={index} />
        <ExitNeighbour direction="behind" carId={rejoin.carBehind} gap={rejoin.gapBehind} index={index} />
        <span className="flex items-center gap-1" title="Pit loss used for the estimate under the current flag">
          <span className="pw-label">Loss</span>
          <span className="font-mono text-[10px] leading-none tabular text-ink-100">{formatSeconds(rejoin.pitLoss)}</span>
        </span>
      </div>
    </div>
  );
}

function ExitNeighbour({
  direction,
  carId,
  gap,
  index,
}: {
  direction: 'ahead' | 'behind';
  carId: CarId | null;
  gap: number | null;
  index: SessionIndex;
}) {
  const Arrow = direction === 'ahead' ? ArrowUp : ArrowDown;
  return (
    <span className="flex items-center gap-1" title={direction === 'ahead' ? 'Car ahead at pit exit' : 'Car behind at pit exit'}>
      <Arrow size={10} strokeWidth={1.75} aria-hidden className="shrink-0 text-ink-500" />
      {carId ? (
        <>
          <span className="h-2.5 w-[2px] shrink-0 rounded-[1px]" style={{ backgroundColor: index.color(carId) }} />
          <span className="font-display text-2xs font-semibold leading-none tracking-wider text-ink-300">{carId}</span>
          <span className="font-mono text-[10px] leading-none tabular text-ink-100">{gap === null ? '—' : gap.toFixed(1)}</span>
        </>
      ) : (
        <span className="font-mono text-[10px] leading-none text-ink-600">—</span>
      )}
    </span>
  );
}

function UndercutReadout({ telemetry, index }: { telemetry: PlayerCarTelemetry; index: SessionIndex }) {
  const { undercut, threat } = telemetry;
  return (
    <>
      <div className="flex min-h-[14px] items-center gap-1.5">
        <span className="pw-label">Undercut</span>
        {undercut ? (
          <>
            <DriverTag code={undercut.targetId} color={index.color(undercut.targetId)} />
            <span className="ml-auto">
              {undercut.feasible ? (
                <StatusWord tone="ok">
                  {undercut.lapsNeeded === null ? 'On' : `Works in ${undercut.lapsNeeded} lap${undercut.lapsNeeded === 1 ? '' : 's'}`}
                </StatusWord>
              ) : (
                <StatusWord tone="neutral">Not on</StatusWord>
              )}
            </span>
          </>
        ) : (
          <span className="pw-label ml-auto text-ink-600">no target</span>
        )}
      </div>
      {undercut ? (
        <p className="whitespace-nowrap text-[10px] leading-3 text-ink-500">
          gap <Num>{formatSeconds(undercut.gap)}</Num> · gain <Num>{formatSeconds(undercut.gainPerLap)}</Num>/lap
        </p>
      ) : null}
      <div className="flex min-h-[14px] items-center gap-1.5">
        <span className="pw-label">Threat</span>
        {threat ? (
          <>
            <DriverTag code={threat.rivalId} color={index.color(threat.rivalId)} />
            <span className="whitespace-nowrap font-mono text-[10px] leading-none tabular text-ink-100">{formatSeconds(threat.gap)}</span>
            <span className="ml-auto">
              {threat.undercutRisk ? <StatusWord tone="warn">Undercut risk</StatusWord> : <StatusWord tone="neutral">Covered</StatusWord>}
            </span>
          </>
        ) : (
          <span className="pw-label ml-auto text-ink-600">nobody close</span>
        )}
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────── team strip ──

const RISK_TONE: Record<DoubleStackEstimate['risk'], Tone> = { LOW: 'ok', MEDIUM: 'warn', HIGH: 'crit' };

interface TeamStripProps {
  index: SessionIndex;
  teamOrder: TeamOrderMode;
  swapPending: boolean;
  estimate: DoubleStackEstimate | null;
  /** Set each car would take, per car number [#1, #2]. */
  stackSets: [TyreSet | undefined, TyreSet | undefined];
  /** Reason the double stack cannot be called, or null. */
  stackBlocked: string | null;
  swapBlocked: string | null;
  ordersLocked: boolean;
  actions: PitWallActions;
}

function TeamStrip({ index, teamOrder, swapPending, estimate, stackSets, stackBlocked, swapBlocked, ordersLocked, actions }: TeamStripProps) {
  const [first, second] = stackSets;
  const ready = stackBlocked === null && first !== undefined && second !== undefined;
  const orderOptions = ordersLocked ? TEAM_ORDER_OPTIONS.map((option) => ({ ...option, disabled: true })) : TEAM_ORDER_OPTIONS;

  return (
    <div className="shrink-0 border-t border-carbon-600 bg-carbon-850">
      <div className="flex items-center gap-2 px-1.5 py-[3px]">
        <span className="pw-label shrink-0">Team orders</span>
        <Segmented
          options={orderOptions}
          value={teamOrder}
          onChange={(order) => actions.setTeamOrder(order)}
          ariaLabel="Team orders"
          className="[&>button]:px-1.5 [&>button]:py-[5px]"
        />
        <button
          type="button"
          disabled={swapPending || swapBlocked !== null}
          aria-busy={swapPending}
          title={swapBlocked ?? (swapPending ? 'Swap ordered — waiting for the cars to trade places' : 'Order the two cars to swap positions on track')}
          onClick={() => actions.swapPositions()}
          className={`pw-btn shrink-0 px-1.5 py-[5px] ${swapPending ? 'border-warn/60 text-ink-50 disabled:opacity-100' : ''}`}
        >
          <ArrowLeftRight size={12} strokeWidth={1.75} aria-hidden className={swapPending ? 'pw-blink text-warn' : ''} />
          {swapPending ? 'Swap pending' : 'Swap positions'}
        </button>
      </div>

      <div className="flex items-stretch gap-2 border-t border-carbon-700 px-1.5 py-[3px]">
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
          <div className="flex items-center gap-1.5">
            <span className="pw-label shrink-0">Double stack</span>
            {estimate ? (
              <>
                <DriverTag code={estimate.leadCarId} color={index.color(estimate.leadCarId)} />
                <span className="pw-label">leads</span>
                <span className="ml-auto">
                  <StatusTag tone={RISK_TONE[estimate.risk]}>{estimate.risk} risk</StatusTag>
                </span>
              </>
            ) : (
              <span className="pw-label ml-auto text-ink-600">not applicable now</span>
            )}
          </div>
          {estimate ? (
            <div className="flex items-center justify-between gap-2">
              <Stat label="Gap" value={formatSeconds(estimate.gap)} title="Gap between the two cars at pit entry" />
              <Stat label="Queue" value={formatSeconds(estimate.expectedWait)} title="Expected time the second car queues" />
              <Stat label="Prob" value={formatPercent(estimate.queueProbability)} title="Probability that the second car loses time queueing" />
              <Stat label="Traffic" value={`${estimate.pitLaneTraffic}`} title="Rival cars expected in the pit lane at the same time" />
            </div>
          ) : (
            <p className="text-[10px] leading-3 text-ink-500">Both cars must be on track to stack.</p>
          )}
        </div>
        <button
          type="button"
          disabled={!ready}
          title={stackBlocked ?? (ready ? 'Box both cars this lap' : 'Select a tyre set for each car first')}
          onClick={() => {
            if (first && second) actions.doubleStack([first.id, second.id]);
          }}
          className="pw-btn w-[132px] shrink-0 flex-col gap-1 px-1.5 py-1"
        >
          <span className="flex items-center gap-1.5">
            <Layers size={12} strokeWidth={1.75} aria-hidden />
            Double stack
          </span>
          <span className="flex items-center gap-1 font-mono text-[10px] font-normal normal-case tracking-normal">
            {first && second ? (
              <>
                <TyreBadge compound={first.compound} size={13} used={!first.isNew} />
                {first.id}
                <span className="opacity-60">+</span>
                <TyreBadge compound={second.compound} size={13} used={!second.isNew} />
                {second.id}
              </>
            ) : (
              'choose both sets'
            )}
          </span>
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title: string }) {
  return (
    <span className="flex items-baseline gap-1" title={title}>
      <span className="pw-label">{label}</span>
      <span className="font-mono text-2xs font-medium tabular text-ink-100">{value}</span>
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────── root ──

/**
 * Live orders to both cars at once: pace, ERS, defend, box calls with tyre choice, plan switch, plus
 * the team strip (team orders, position swap, double stack). The snapshot is the single source of
 * truth; the only local state is the tyre set highlighted in each picker before the call is made.
 */
export function PitWallControls({ session, snapshot, actions, selectedCarId, onSelectCar, className = '' }: PitWallControlsProps) {
  const [pickedSets, setPickedSets] = useState<Record<CarId, string>>({});
  const index = indexSession(session);
  const flag = snapshot.raceControl.flag;
  const pitLoss = pitLossUnderFlag(session.track, flag);

  const columns = snapshot.player.cars.map((telemetry) => {
    const position = snapshot.cars.findIndex((car) => car.id === telemetry.carId);
    const car = position >= 0 ? snapshot.cars[position] : undefined;
    const sets = availableSets(telemetry);
    // A pending call fixes the set; otherwise the user's pick, falling back to the planned compound
    // (not on the grid, where the order picks the starting set and nothing should be pre-armed).
    const chosenId = telemetry.boxCall?.setId ?? pickedSets[telemetry.carId] ?? null;
    const fallbackId = snapshot.phase === 'GRID' ? null : plannedSetId(telemetry, sets);
    const chosenSet = sets.find((set) => set.id === chosenId) ?? sets.find((set) => set.id === fallbackId);
    return {
      telemetry,
      car,
      ahead: position > 0 ? snapshot.cars[position - 1] : undefined,
      behind: position >= 0 ? snapshot.cars[position + 1] : undefined,
      sets,
      chosenSet,
    };
  });

  const pickSet = (carId: CarId, setId: string) => setPickedSets((prev) => (prev[carId] === setId ? prev : { ...prev, [carId]: setId }));

  const [one, two] = columns;
  const carOne = one?.car;
  const carTwo = two?.car;
  const bothOnTrack = carOne?.status === 'RACING' && carTwo?.status === 'RACING';
  const raceOver = snapshot.phase === 'FINISHED';
  const stackBlocked = raceOver
    ? 'Race finished'
    : !bothOnTrack
      ? 'Both cars must be on track'
      : snapshot.player.doubleStack === null
        ? 'Double stack not applicable now'
        : null;
  const swapBlocked = raceOver ? 'Race finished' : !bothOnTrack ? 'Both cars must be on track' : null;

  const lastLapClass = (car: CarSnapshot): string => {
    if (car.lastLapTime === null) return 'text-ink-500';
    if (snapshot.fastestLap?.carId === car.id && snapshot.fastestLap.time === car.lastLapTime) return 'text-timing-purple';
    if (car.bestLapTime !== null && car.lastLapTime <= car.bestLapTime) return 'text-timing-green';
    return 'text-ink-100';
  };

  return (
    <Panel
      title="Pit wall"
      icon={<SlidersHorizontal size={14} strokeWidth={1.75} aria-hidden />}
      subtitle={`pit loss ${formatSeconds(pitLoss)}`}
      actions={
        <span className="flex items-center gap-1.5" title="Track status the pit loss is computed for">
          <span aria-hidden className={`h-2 w-2 rounded-[1px] ${FLAG_SWATCH[flag]}`} />
          <span className="pw-label text-ink-300">{FLAG_LABELS[flag]}</span>
        </span>
      }
      className={`h-full ${className}`}
      bodyClassName="flex flex-col"
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-2" style={{ gridTemplateRows: `repeat(${COLUMN_ROWS}, auto)` }}>
          {columns.map(({ telemetry, car, ahead, behind, sets, chosenSet }, i) =>
            car ? (
              <CarColumn
                key={telemetry.carId}
                track={session.track}
                index={index}
                telemetry={telemetry}
                car={car}
                ahead={ahead}
                behind={behind}
                phase={snapshot.phase}
                lastLapClass={lastLapClass(car)}
                selected={selectedCarId === telemetry.carId}
                sets={sets}
                chosenSet={chosenSet}
                onPickSet={pickSet}
                onSelectCar={onSelectCar}
                actions={actions}
                className={i > 0 ? 'border-l border-carbon-700' : ''}
              />
            ) : null,
          )}
        </div>
      </div>
      <TeamStrip
        index={index}
        teamOrder={snapshot.player.teamOrder}
        swapPending={snapshot.player.swapPending}
        estimate={snapshot.player.doubleStack}
        stackSets={[one?.chosenSet, two?.chosenSet]}
        stackBlocked={stackBlocked}
        swapBlocked={swapBlocked}
        ordersLocked={raceOver}
        actions={actions}
      />
    </Panel>
  );
}
