import { useMemo, useState } from 'react';
import { ArrowRight, Dices } from 'lucide-react';
import { DEFAULT_PLAYER_TEAM, DRIVERS, TEAMS } from '../simulation/gridData';
import { DEFAULT_TRACK_ID, TRACK_LIST } from '../simulation/trackData';
import type { SessionConfig, TeamId, TrackDefinition, TrackId, WeatherMode } from '../simulation/types';
import { Segmented } from './ui';

export interface SetupScreenProps {
  loading: boolean;
  error: string | null;
  onLaunch: (config: SessionConfig) => void;
}

const WEATHER_OPTIONS: { value: WeatherMode; label: string; title: string }[] = [
  { value: 'AUTO', label: 'Forecast', title: 'Drawn from the circuit’s rain probability' },
  { value: 'DRY', label: 'Dry', title: 'No rain all race' },
  { value: 'MIXED', label: 'Mixed', title: 'One or two showers during the race' },
  { value: 'WET', label: 'Wet', title: 'Raining at the start' },
];

const INCIDENT_OPTIONS: { value: '0' | '1' | '2'; label: string; title: string }[] = [
  { value: '0', label: 'Off', title: 'No random incidents or failures' },
  { value: '1', label: 'Realistic', title: 'Calibrated on each circuit’s safety-car history' },
  { value: '2', label: 'Chaos', title: 'Incident rates multiplied' },
];

function randomSeed(): number {
  return Math.floor(Math.random() * 900000) + 100000;
}

function TrackOutline({ track, active }: { track: TrackDefinition; active: boolean }) {
  return (
    <svg viewBox={`0 0 ${track.svgViewBox.width} ${track.svgViewBox.height}`} className="h-14 w-24 shrink-0" aria-hidden="true">
      <path
        d={track.svgPath}
        fill="none"
        stroke={active ? 'var(--color-ink-50)' : 'var(--color-ink-500)'}
        strokeWidth={track.svgViewBox.width / 55}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="leading-none">
      <div className="pw-label">{label}</div>
      <div className="pw-value mt-1 text-xs">{value}</div>
    </div>
  );
}

/** Pre-session screen: circuit, team, weather and seed. */
export function SetupScreen({ loading, error, onLaunch }: SetupScreenProps) {
  const [trackId, setTrackId] = useState<TrackId>(DEFAULT_TRACK_ID);
  const [teamId, setTeamId] = useState<TeamId>(DEFAULT_PLAYER_TEAM);
  const [weatherMode, setWeatherMode] = useState<WeatherMode>('AUTO');
  const [incidents, setIncidents] = useState<'0' | '1' | '2'>('1');
  const [seed, setSeed] = useState<number>(() => randomSeed());

  const track = useMemo(() => TRACK_LIST.find((t) => t.id === trackId) ?? TRACK_LIST[0]!, [trackId]);
  const team = TEAMS.find((t) => t.id === teamId) ?? TEAMS[0]!;
  const teamDrivers = DRIVERS.filter((d) => d.teamId === team.id).sort((a, b) => a.carNumber - b.carNumber);
  const maxPace = Math.max(...TEAMS.map((t) => t.carPace));

  const launch = (): void => {
    onLaunch({ trackId, seed, playerTeamId: teamId, weatherMode, incidentLevel: Number(incidents) as 0 | 1 | 2 });
  };

  return (
    <div className="bg-carbon-weave flex h-full min-h-[720px] items-center justify-center overflow-auto p-6" style={{ ['--team-color' as string]: team.color }}>
      <div className="w-full max-w-[1240px]">
        <header className="mb-4 flex items-end justify-between">
          <div>
            <div className="flex items-center gap-3">
              <span className="h-9 w-1.5 rounded-[1px] bg-team" />
              <h1 className="font-display text-4xl font-bold leading-none tracking-[0.22em] text-ink-50">PIT WALL</h1>
            </div>
            <p className="pw-title mt-2 text-ink-500">Race strategy engine · real-time simulator</p>
          </div>
          <p className="max-w-md text-right text-xs text-ink-500">
            Run both cars of one team from the pit wall: pace and ERS orders, box calls, undercuts, weather crossovers —
            against nine rival strategists.
          </p>
        </header>

        <div className="grid grid-cols-[1.1fr_1fr_0.9fr] gap-2">
          <section className="pw-panel overflow-hidden" aria-label="Circuit">
            <h2 className="pw-title border-b border-carbon-700 bg-carbon-850 px-3 py-1.5">01 · Circuit</h2>
            <div role="radiogroup" aria-label="Circuit">
              {TRACK_LIST.map((t) => {
                const active = t.id === trackId;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setTrackId(t.id)}
                    className={`flex w-full items-center gap-3 border-b border-carbon-700 px-3 py-2 text-left last:border-b-0 ${active ? 'bg-carbon-750 shadow-[inset_3px_0_0_var(--color-ink-50)]' : 'hover:bg-carbon-850'}`}
                  >
                    <TrackOutline track={t} active={active} />
                    <div className="min-w-0 flex-1">
                      <div className={`font-display text-[15px] font-semibold uppercase tracking-[0.12em] ${active ? 'text-ink-50' : 'text-ink-100'}`}>{t.grandPrix}</div>
                      <div className="truncate text-2xs text-ink-500">{t.name}</div>
                      <div className="mt-1.5 grid grid-cols-5 gap-2">
                        <Stat label="Laps" value={String(t.raceLaps)} />
                        <Stat label="Length" value={`${t.lengthKm.toFixed(2)} km`} />
                        <Stat label="Pit loss" value={`${t.pitLossSeconds.toFixed(1)} s`} />
                        <Stat label="SC" value={`${Math.round(t.safetyCarProbability * 100)}%`} />
                        <Stat label="Rain" value={`${Math.round(t.rainProbability * 100)}%`} />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="pw-panel overflow-hidden" aria-label="Team">
            <h2 className="pw-title border-b border-carbon-700 bg-carbon-850 px-3 py-1.5">02 · Team</h2>
            <div role="radiogroup" aria-label="Team">
              {TEAMS.map((t) => {
                const active = t.id === teamId;
                const drivers = DRIVERS.filter((d) => d.teamId === t.id).sort((a, b) => a.carNumber - b.carNumber);
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setTeamId(t.id)}
                    className={`flex w-full items-center gap-3 border-b border-carbon-700 px-3 py-[7px] text-left last:border-b-0 ${active ? 'bg-carbon-750' : 'hover:bg-carbon-850'}`}
                    style={active ? { boxShadow: `inset 3px 0 0 ${t.color}` } : undefined}
                  >
                    <span className="h-7 w-1 shrink-0 rounded-[1px]" style={{ backgroundColor: t.color }} />
                    <div className="min-w-0 flex-1">
                      <div className={`font-display text-sm font-semibold uppercase tracking-[0.12em] ${active ? 'text-ink-50' : 'text-ink-100'}`}>{t.name}</div>
                      <div className="font-mono text-2xs text-ink-500">{drivers.map((d) => `${d.code} #${d.number}`).join(' · ')}</div>
                    </div>
                    <div className="w-24 shrink-0" title={`Car pace deficit: +${t.carPace.toFixed(2)} s per lap`}>
                      <div className="pw-label mb-1 flex justify-between">
                        <span>Pace</span>
                        <span className="font-mono tracking-normal text-ink-300">+{t.carPace.toFixed(2)}</span>
                      </div>
                      <div className="h-1 rounded-full bg-carbon-700">
                        <div className="h-full rounded-full bg-ink-300" style={{ width: `${100 - (t.carPace / maxPace) * 78}%` }} />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="pw-panel flex flex-col overflow-hidden" aria-label="Session">
            <h2 className="pw-title border-b border-carbon-700 bg-carbon-850 px-3 py-1.5">03 · Session</h2>
            <div className="flex flex-1 flex-col gap-4 p-3">
              <div>
                <div className="pw-label mb-1.5">Weather</div>
                <Segmented options={WEATHER_OPTIONS} value={weatherMode} onChange={setWeatherMode} ariaLabel="Weather" />
                <p className="mt-1.5 text-2xs text-ink-500">{WEATHER_OPTIONS.find((o) => o.value === weatherMode)?.title}</p>
              </div>
              <div>
                <div className="pw-label mb-1.5">Incidents &amp; reliability</div>
                <Segmented options={INCIDENT_OPTIONS} value={incidents} onChange={setIncidents} ariaLabel="Incident level" />
                <p className="mt-1.5 text-2xs text-ink-500">{INCIDENT_OPTIONS.find((o) => o.value === incidents)?.title}</p>
              </div>
              <div>
                <label className="pw-label mb-1.5 block" htmlFor="seed">
                  Race seed
                </label>
                <div className="flex gap-1.5">
                  <input
                    id="seed"
                    type="number"
                    min={0}
                    max={4294967295}
                    value={seed}
                    onChange={(e) => setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                    className="h-8 min-w-0 flex-1 rounded-[2px] border border-carbon-600 bg-carbon-800 px-2 font-mono text-sm text-ink-100 tabular outline-none focus:border-ink-300"
                  />
                  <button type="button" className="pw-btn h-8" onClick={() => setSeed(randomSeed())} title="Draw a new seed">
                    <Dices size={13} strokeWidth={1.75} />
                    New
                  </button>
                </div>
                <p className="mt-1.5 text-2xs text-ink-500">Same seed and same orders replay exactly the same race.</p>
              </div>

              <div className="mt-auto border-t border-carbon-700 pt-3">
                <div className="pw-label">Your garage</div>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="h-8 w-1 rounded-[1px] bg-team" />
                  <div className="leading-tight">
                    <div className="font-display text-base font-semibold uppercase tracking-[0.12em] text-ink-50">{team.name}</div>
                    <div className="font-mono text-2xs text-ink-300">
                      {teamDrivers.map((d) => `#${d.carNumber} ${d.firstName} ${d.lastName}`).join('  ·  ')}
                    </div>
                  </div>
                </div>
                <div className="mt-2 text-2xs text-ink-500">
                  {track.grandPrix} · {track.raceLaps} laps · {(track.raceLaps * track.lengthKm).toFixed(0)} km
                </div>
                {error ? (
                  <p className="mt-2 rounded-[2px] border border-crit/60 bg-crit/10 px-2 py-1 font-mono text-2xs text-crit" role="alert">
                    {error}
                  </p>
                ) : null}
                <button
                  type="button"
                  onClick={launch}
                  disabled={loading}
                  className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-[2px] bg-ink-50 font-display text-base font-bold uppercase tracking-[0.2em] text-carbon-950 transition-colors hover:bg-white disabled:opacity-50"
                >
                  {loading ? 'Building the grid…' : 'Go to the grid'}
                  <ArrowRight size={16} strokeWidth={2.25} />
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
