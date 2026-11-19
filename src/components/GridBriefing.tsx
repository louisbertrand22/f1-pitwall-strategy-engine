import { ArrowLeft, CloudRain, Flag } from 'lucide-react';
import { formatPercent } from '../lib/format';
import { indexSession } from '../lib/session';
import { WEATHER_CROSSOVER } from '../simulation/physicsModel';
import type { RaceSnapshot, SessionInfo, WeatherForecastPoint } from '../simulation/types';
import type { PitWallActions } from './contracts';
import { StrategyPlanner } from './StrategyPlanner';
import { DriverTag, TyreBadge } from './ui';

export interface GridBriefingProps {
  session: SessionInfo;
  snapshot: RaceSnapshot;
  forecast: WeatherForecastPoint[];
  actions: PitWallActions;
  onLightsOut: () => void;
  onBack: () => void;
}

/** One-line reading of the forecast for the strategy briefing. */
function forecastHeadline(snapshot: RaceSnapshot, forecast: WeatherForecastPoint[]): string {
  const wetNow = snapshot.weather.trackWetness;
  if (wetNow >= WEATHER_CROSSOVER.interToWet) return `Wet track at the start (${formatPercent(wetNow)}): full-wet conditions.`;
  if (wetNow >= WEATHER_CROSSOVER.slickToInter) return `Damp track at the start (${formatPercent(wetNow)}): intermediate conditions.`;
  const shower = forecast.find((p) => p.rainIntensity > 0.12);
  if (!shower) return 'Dry race expected. No rain on the radar.';
  const peak = Math.max(...forecast.map((p) => p.rainHigh));
  const strength = peak > 0.6 ? 'Heavy' : peak > 0.3 ? 'Moderate' : 'Light';
  return `${strength} rain possible from around lap ${Math.max(1, Math.round(shower.lap))} — timing uncertain.`;
}

/** Pre-race overlay: the grid slots of both cars, the forecast and the Plan A/B/C editor. */
export function GridBriefing({ session, snapshot, forecast, actions, onLightsOut, onBack }: GridBriefingProps) {
  const index = indexSession(session);
  const counting = snapshot.raceControl.countdown !== null;
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-carbon-950/80 p-4 backdrop-blur-[2px]">
      <div className="pw-panel flex max-h-full w-full max-w-[1480px] flex-col overflow-hidden shadow-[0_24px_64px_rgb(0_0_0/0.7)]">
        <header className="flex items-center gap-4 border-b border-carbon-700 bg-carbon-850 px-4 py-2.5">
          <div>
            <div className="pw-label">Grid briefing</div>
            <h2 className="font-display text-xl font-bold uppercase leading-tight tracking-[0.16em] text-ink-50">
              {session.track.grandPrix} · {session.raceLaps} laps
            </h2>
          </div>
          <div className="flex items-center gap-5 border-l border-carbon-700 pl-4">
            {snapshot.player.cars.map((telemetry) => {
              const car = snapshot.cars.find((c) => c.id === telemetry.carId);
              const driver = index.driver(telemetry.carId);
              return (
                <div key={telemetry.carId} className="flex items-center gap-2">
                  <div className="font-mono text-2xl font-bold leading-none text-ink-50 tabular">P{car?.gridPosition ?? '—'}</div>
                  <div className="leading-tight">
                    <DriverTag code={driver.code} color={index.color(driver.id)} carNumber={driver.carNumber} strong />
                    <div className="text-2xs text-ink-500">
                      {driver.firstName} {driver.lastName}
                    </div>
                  </div>
                  {car ? <TyreBadge compound={car.tyre.compound} size={22} used={car.tyre.ageLaps > 0} /> : null}
                </div>
              );
            })}
          </div>
          <div className="flex min-w-0 items-center gap-2 border-l border-carbon-700 pl-4 text-xs text-ink-300">
            <CloudRain size={15} strokeWidth={1.75} className="shrink-0 text-ink-500" />
            <span className="truncate">{forecastHeadline(snapshot, forecast)}</span>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button type="button" className="pw-btn h-9" onClick={onBack} disabled={counting}>
              <ArrowLeft size={13} strokeWidth={2} />
              Setup
            </button>
            <button
              type="button"
              onClick={onLightsOut}
              disabled={counting}
              className="flex h-9 items-center gap-2 rounded-[2px] bg-flag-red px-5 font-display text-sm font-bold uppercase tracking-[0.2em] text-white transition-colors hover:brightness-110 disabled:opacity-60"
            >
              <Flag size={14} strokeWidth={2.25} />
              {counting ? 'Lights…' : 'Lights out'}
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto" style={{ height: 'min(640px, calc(100vh - 220px))' }}>
          <StrategyPlanner session={session} snapshot={snapshot} mode="PRE_RACE" actions={actions} className="border-0" />
        </div>
        <footer className="border-t border-carbon-700 bg-carbon-850 px-4 py-1.5 text-2xs text-ink-500">
          The active plan sets the starting tyres. With AUTO-BOX on, your race engineer calls the planned stops; you can
          switch plan, override or box manually at any time during the race.
        </footer>
      </div>
    </div>
  );
}
