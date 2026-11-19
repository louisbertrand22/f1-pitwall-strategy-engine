import { useEffect, useRef, useState } from 'react';
import { CloudRain, Droplets, FastForward, Flag, LogOut, Pause, Play, Siren, SlidersHorizontal, Thermometer } from 'lucide-react';
import { formatPercent, formatRaceClock } from '../lib/format';
import { indexSession } from '../lib/session';
import type { FlagStatus, RaceSnapshot, SessionInfo, TimeScale } from '../simulation/types';
import type { RaceControlAction } from '../workers/protocol';
import { TIME_SCALES } from '../workers/protocol';

export interface SessionHeaderProps {
  session: SessionInfo;
  snapshot: RaceSnapshot;
  autoSlow: boolean;
  onSetPaused: (paused: boolean) => void;
  onSetTimeScale: (scale: TimeScale) => void;
  onSetAutoSlow: (enabled: boolean) => void;
  onRaceControl: (action: RaceControlAction) => void;
  onEndSession: () => void;
}

const FLAG_LABEL: Record<FlagStatus, string> = {
  GREEN: 'GREEN FLAG',
  YELLOW: 'YELLOW',
  VSC: 'VIRTUAL SC',
  SC: 'SAFETY CAR',
  RED: 'RED FLAG',
  CHEQUERED: 'CHEQUERED',
};

const FLAG_STYLE: Record<FlagStatus, string> = {
  GREEN: 'border-flag-green/60 bg-flag-green/15 text-flag-green',
  YELLOW: 'border-flag-yellow bg-flag-yellow text-carbon-950',
  VSC: 'border-flag-sc bg-flag-sc text-carbon-950',
  SC: 'border-flag-sc bg-flag-sc text-carbon-950',
  RED: 'border-flag-red bg-flag-red text-white',
  CHEQUERED: 'border-ink-100 bg-ink-100 text-carbon-950',
};

const DIRECTOR_ACTIONS: { action: RaceControlAction; label: string; hint: string }[] = [
  { action: 'SAFETY_CAR', label: 'Safety car', hint: 'Full neutralisation, field bunches up' },
  { action: 'VIRTUAL_SAFETY_CAR', label: 'Virtual safety car', hint: 'Everyone on the delta, gaps frozen' },
  { action: 'RED_FLAG', label: 'Red flag', hint: 'Suspension, free tyre change, standing restart' },
  { action: 'RAIN_SHOWER', label: 'Rain shower', hint: 'A cell reaches the circuit in about a minute' },
  { action: 'DRY_UP', label: 'Dry up', hint: 'The rain stops, the track starts drying' },
];

/** Five start lights that come on one per second, then go out. */
function StartLights({ countdown }: { countdown: number }) {
  const lit = Math.min(5, Math.max(0, 5 - Math.floor(countdown)));
  return (
    <span className="flex items-center gap-1" aria-label={`Start lights: ${lit} of 5 on`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`h-3 w-3 rounded-full border ${i < lit ? 'border-flag-red bg-flag-red shadow-[0_0_8px_var(--color-flag-red)]' : 'border-carbon-500 bg-carbon-800'}`}
        />
      ))}
    </span>
  );
}

function Readout({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex flex-col justify-center leading-none" title={title}>
      <span className="pw-label">{label}</span>
      <span className="pw-value mt-1 text-[13px]">{value}</span>
    </div>
  );
}

/** Top strip of the cockpit: session identity, flag state, clock, weather and simulation controls. */
export function SessionHeader({
  session,
  snapshot,
  autoSlow,
  onSetPaused,
  onSetTimeScale,
  onSetAutoSlow,
  onRaceControl,
  onEndSession,
}: SessionHeaderProps) {
  const [directorOpen, setDirectorOpen] = useState(false);
  const directorRef = useRef<HTMLDivElement>(null);
  const team = indexSession(session).team(session.playerTeamId);
  const { raceControl, weather, phase } = snapshot;
  const flag = raceControl.flag;
  const racing = phase === 'RACING';
  const yellowSectors = raceControl.yellowSectors.map((on, i) => (on ? `S${i + 1}` : null)).filter(Boolean).join(' ');

  useEffect(() => {
    if (!directorOpen) return undefined;
    const close = (event: MouseEvent): void => {
      if (directorRef.current && !directorRef.current.contains(event.target as Node)) setDirectorOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [directorOpen]);

  let flagLabel = FLAG_LABEL[flag];
  if (flag === 'YELLOW' && yellowSectors) flagLabel = `YELLOW ${yellowSectors}`;
  if (flag === 'SC' && raceControl.safetyCarInThisLap) flagLabel = 'SC IN THIS LAP';
  if (phase === 'GRID') flagLabel = raceControl.countdown === null ? 'ON THE GRID' : 'START';
  if (phase === 'SUSPENDED') flagLabel = 'RED FLAG';
  if (phase === 'FINISHED') flagLabel = 'RACE FINISHED';
  const flagStyle = phase === 'GRID' ? 'border-carbon-500 bg-carbon-800 text-ink-100' : FLAG_STYLE[flag];
  const attention = flag === 'YELLOW' || flag === 'RED' || (flag === 'SC' && raceControl.safetyCarInThisLap);

  return (
    <header className="flex h-12 shrink-0 items-stretch gap-4 border-b border-carbon-700 bg-carbon-900 px-3">
      <div className="flex shrink-0 items-center gap-2.5 whitespace-nowrap">
        <span className="h-7 w-1 rounded-[1px] bg-team" />
        <div className="leading-none">
          <div className="font-display text-[17px] font-bold tracking-[0.2em] text-ink-50">PIT WALL</div>
          <div className="pw-label mt-0.5 text-ink-300">{team.name}</div>
        </div>
      </div>

      <div className="hidden shrink-0 items-center whitespace-nowrap border-l border-carbon-700 pl-4 min-[1560px]:flex">
        <div className="leading-none">
          <div className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">{session.track.grandPrix}</div>
          <div className="pw-label mt-1">
            {session.track.shortName} · {session.track.lengthKm.toFixed(3)} km · seed {session.config.seed}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-4 whitespace-nowrap border-l border-carbon-700 pl-4">
        <div className="leading-none">
          <span className="pw-label">Lap</span>
          <div className="mt-0.5 font-mono text-[19px] font-bold leading-none text-ink-50 tabular">
            {snapshot.lap}
            <span className="text-[12px] font-medium text-ink-500">/{snapshot.raceLaps}</span>
          </div>
        </div>
        <div
          className={`flex h-7 min-w-[132px] items-center justify-center gap-2 rounded-[2px] border px-3 font-display text-[13px] font-bold tracking-[0.16em] ${flagStyle} ${attention ? 'pw-blink' : ''}`}
          role="status"
          aria-live="polite"
        >
          {flag === 'SC' || flag === 'VSC' ? <Siren size={14} strokeWidth={2} /> : <Flag size={13} strokeWidth={2} />}
          <span className="whitespace-nowrap">{flagLabel}</span>
        </div>
        {phase === 'GRID' && raceControl.countdown !== null ? <StartLights countdown={raceControl.countdown} /> : null}
        {phase === 'SUSPENDED' && raceControl.countdown !== null ? (
          <Readout label="Restart in" value={formatRaceClock(raceControl.countdown).slice(2)} />
        ) : null}
        <Readout label="Race clock" value={formatRaceClock(snapshot.raceTime)} />
        <div className="hidden min-w-0 max-w-[260px] flex-col justify-center leading-none min-[1760px]:flex">
          <span className="pw-label">Race control</span>
          <span className="mt-1 truncate text-2xs text-ink-300">{raceControl.message}</span>
        </div>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-3 whitespace-nowrap border-l border-carbon-700 pl-4 min-[1560px]:gap-4">
        <div className="flex items-center gap-1.5" title="Rain intensity">
          <CloudRain size={14} strokeWidth={1.75} className="text-ink-500" />
          <Readout label="Rain" value={formatPercent(weather.rainIntensity)} />
        </div>
        <div className="flex items-center gap-1.5" title="Track wetness">
          <Droplets size={14} strokeWidth={1.75} className="text-ink-500" />
          <Readout label="Track wet" value={formatPercent(weather.trackWetness)} />
        </div>
        <div className="flex items-center gap-1.5" title="Air / track temperature">
          <Thermometer size={14} strokeWidth={1.75} className="text-ink-500" />
          <Readout label="Air / Track" value={`${Math.round(weather.airTempC)}° / ${Math.round(weather.trackTempC)}°`} />
        </div>
        <div className="flex flex-col justify-center leading-none" title="DRS availability">
          <span className="pw-label">DRS</span>
          <span className={`mt-1 font-display text-2xs font-bold tracking-widest ${raceControl.drsEnabled ? 'text-timing-green' : 'text-ink-600'}`}>
            {raceControl.drsEnabled ? '● ENABLED' : '○ DISABLED'}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 whitespace-nowrap border-l border-carbon-700 pl-4">
        <button
          type="button"
          className="pw-btn h-7 w-8 px-0"
          onClick={() => onSetPaused(!snapshot.paused)}
          disabled={phase === 'FINISHED'}
          title={snapshot.paused ? 'Resume (Space)' : 'Pause (Space)'}
          aria-label={snapshot.paused ? 'Resume simulation' : 'Pause simulation'}
          data-active={snapshot.paused}
        >
          {snapshot.paused ? <Play size={13} strokeWidth={2} /> : <Pause size={13} strokeWidth={2} />}
        </button>
        <div className="flex" role="radiogroup" aria-label="Time scale">
          {TIME_SCALES.map((scale, index) => (
            <button
              key={scale}
              type="button"
              role="radio"
              aria-checked={snapshot.timeScale === scale}
              data-active={snapshot.timeScale === scale}
              className={`pw-btn h-7 min-w-[34px] rounded-none px-1.5 font-mono tracking-normal first:rounded-l-[2px] last:rounded-r-[2px] ${index > 0 ? '-ml-px' : ''}`}
              onClick={() => onSetTimeScale(scale)}
              title={`Simulation speed x${scale} (key ${index + 1})`}
            >
              x{scale}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="pw-btn h-7"
          data-active={autoSlow}
          aria-label="Auto-slow"
          aria-pressed={autoSlow}
          onClick={() => onSetAutoSlow(!autoSlow)}
          title="Auto-slow: drop to x2 whenever the pit wall is asked for a decision"
        >
          <FastForward size={12} strokeWidth={2} />
          <span className="hidden min-[1500px]:inline">Auto-slow</span>
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-2 whitespace-nowrap border-l border-carbon-700 pl-4">
        <div className="relative" ref={directorRef}>
          <button
            type="button"
            className="pw-btn h-7"
            aria-haspopup="menu"
            aria-label="Race director"
            aria-expanded={directorOpen}
            onClick={() => setDirectorOpen((open) => !open)}
            disabled={!racing}
            title="Race director sandbox: inject events to rehearse a strategy"
          >
            <SlidersHorizontal size={12} strokeWidth={2} />
            <span className="hidden min-[1640px]:inline">Race director</span>
          </button>
          {directorOpen ? (
            <div role="menu" className="pw-panel absolute right-0 top-9 z-40 w-72 p-1 shadow-[0_12px_32px_rgb(0_0_0/0.6)]">
              <div className="pw-label px-2 py-1.5">Sandbox — inject an event</div>
              {DIRECTOR_ACTIONS.map((item) => (
                <button
                  key={item.action}
                  type="button"
                  role="menuitem"
                  className="flex w-full flex-col items-start rounded-[2px] px-2 py-1.5 text-left hover:bg-carbon-750"
                  onClick={() => {
                    onRaceControl(item.action);
                    setDirectorOpen(false);
                  }}
                >
                  <span className="font-display text-xs font-semibold uppercase tracking-widest text-ink-100">{item.label}</span>
                  <span className="text-2xs text-ink-500">{item.hint}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button type="button" className="pw-btn h-7" onClick={onEndSession} aria-label="End session" title="Leave this race and go back to the setup screen">
          <LogOut size={12} strokeWidth={2} />
          <span className="hidden min-[1640px]:inline">End</span>
        </button>
      </div>
    </header>
  );
}
