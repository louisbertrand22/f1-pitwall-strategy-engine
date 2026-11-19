import { useCallback, useEffect, useState } from 'react';
import { ChartLine, ChartSpline, ClipboardList, CloudSun, Trophy } from 'lucide-react';
import { indexSession } from '../lib/session';
import type { CarId, TimeScale } from '../simulation/types';
import { raceStore } from '../state/raceStore';
import type { RaceUiState } from '../state/raceStore';
import { TIME_SCALES } from '../workers/protocol';
import { GridBriefing } from './GridBriefing';
import { PitWallControls } from './PitWallControls';
import { RaceAnalysis } from './RaceAnalysis';
import { RadioConsole } from './RadioConsole';
import { ResultsOverlay } from './ResultsOverlay';
import { SessionHeader } from './SessionHeader';
import { StrategyGraph } from './StrategyGraph';
import { StrategyPlanner } from './StrategyPlanner';
import { TimingTower } from './TimingTower';
import { TrackRadarCanvas } from './TrackRadarCanvas';
import { WeatherRadar } from './WeatherRadar';

type BottomTab = 'STRATEGY' | 'WEATHER' | 'ANALYSIS' | 'PLANS';

const TABS: { id: BottomTab; label: string; short: string; icon: typeof ChartLine }[] = [
  { id: 'STRATEGY', label: 'Undercut simulator', short: 'Undercut', icon: ChartLine },
  { id: 'WEATHER', label: 'Weather radar', short: 'Weather', icon: CloudSun },
  { id: 'ANALYSIS', label: 'Race analysis', short: 'Analysis', icon: ChartSpline },
  { id: 'PLANS', label: 'Plans A/B/C', short: 'Plans', icon: ClipboardList },
];

export interface CockpitProps {
  state: RaceUiState;
}

/** The pit wall itself: timing tower, track radar, strategy tools, car controls and radio. */
export function Cockpit({ state }: CockpitProps) {
  const { session, snapshot, history, forecast, radio, projections, classification } = state;
  const [selectedCarId, setSelectedCarId] = useState<CarId | null>(null);
  const [focusCarId, setFocusCarId] = useState<CarId | null>(null);
  const [tab, setTab] = useState<BottomTab>('STRATEGY');
  const [resultsDismissed, setResultsDismissed] = useState(false);

  const paused = snapshot?.paused ?? false;
  const finished = snapshot?.phase === 'FINISHED';

  const onKey = useCallback(
    (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === 'Space') {
        // Space is the simulation clock, except on a button the user has tabbed to (native activation).
        if (target && target.tagName === 'BUTTON') return;
        event.preventDefault();
        if (!finished) raceStore.setPaused(!paused);
        return;
      }
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < TIME_SCALES.length) {
        raceStore.setTimeScale(TIME_SCALES[index] as TimeScale);
      }
    },
    [paused, finished],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  // A button clicked with the mouse must not keep the focus, or the next press of Space would press it
  // again instead of pausing. Keyboard activation (detail 0) and slider handles keep their focus.
  useEffect(() => {
    const release = (event: MouseEvent): void => {
      if (event.detail === 0) return;
      const active = document.activeElement;
      if (active instanceof HTMLButtonElement && active.getAttribute('role') !== 'slider') active.blur();
    };
    window.addEventListener('click', release);
    return () => window.removeEventListener('click', release);
  }, []);

  if (!session || !snapshot) return null;

  const team = indexSession(session).team(session.playerTeamId);
  const focus = focusCarId && session.playerCarIds.includes(focusCarId) ? focusCarId : session.playerCarIds[0];
  const preRace = snapshot.phase === 'GRID' && snapshot.raceTime === 0;
  const showResults = classification !== null && !resultsDismissed;

  return (
    <div className="flex h-full min-h-[760px] min-w-[1360px] flex-col bg-carbon-950" style={{ ['--team-color' as string]: team.color }}>
      <SessionHeader
        session={session}
        snapshot={snapshot}
        autoSlow={state.autoSlow}
        onSetPaused={(value) => raceStore.setPaused(value)}
        onSetTimeScale={(scale) => raceStore.setTimeScale(scale)}
        onSetAutoSlow={(enabled) => raceStore.setAutoSlow(enabled)}
        onRaceControl={raceStore.actions.raceControl}
        onEndSession={() => raceStore.reset()}
      />

      {state.error ? (
        <div className="border-b border-crit/60 bg-crit/10 px-3 py-1 font-mono text-2xs text-crit" role="alert">
          Simulation error: {state.error}
        </div>
      ) : null}

      <main className="relative grid min-h-0 flex-1 grid-cols-[minmax(440px,476px)_minmax(0,1fr)_minmax(420px,452px)] gap-1.5 p-1.5">
        <TimingTower session={session} snapshot={snapshot} selectedCarId={selectedCarId} onSelectCar={setSelectedCarId} className="h-full" />

        <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1.22fr)_minmax(0,1fr)] gap-1.5">
          <TrackRadarCanvas
            session={session}
            snapshot={snapshot}
            frames={raceStore.frames}
            selectedCarId={selectedCarId}
            onSelectCar={setSelectedCarId}
            className="h-full"
          />
          <div className="flex min-h-0 min-w-0 flex-col">
            <div className="flex shrink-0 items-end gap-px" role="tablist" aria-label="Strategy tools">
              {TABS.map((item) => {
                const Icon = item.icon;
                const active = tab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-label={item.label}
                    onClick={() => setTab(item.id)}
                    className={`flex h-7 items-center gap-1.5 whitespace-nowrap rounded-t-[3px] border border-b-0 px-3 font-display text-2xs font-semibold uppercase tracking-[0.14em] transition-colors ${
                      active ? 'border-carbon-600 bg-carbon-850 text-ink-50' : 'border-transparent bg-carbon-900 text-ink-500 hover:text-ink-100'
                    }`}
                  >
                    <Icon size={12} strokeWidth={1.75} />
                    <span className="hidden min-[1700px]:inline">{item.label}</span>
                    <span className="min-[1700px]:hidden">{item.short}</span>
                  </button>
                );
              })}
              {classification !== null ? (
                <button
                  type="button"
                  className="ml-auto flex h-7 items-center gap-1.5 px-3 font-display text-2xs font-semibold uppercase tracking-[0.14em] text-ink-300 hover:text-ink-50"
                  onClick={() => setResultsDismissed(false)}
                >
                  <Trophy size={12} strokeWidth={1.75} />
                  Classification
                </button>
              ) : null}
            </div>
            <div className="min-h-0 flex-1" role="tabpanel">
              {tab === 'STRATEGY' ? (
                <StrategyGraph
                  session={session}
                  snapshot={snapshot}
                  history={history}
                  projections={projections}
                  focusCarId={focus}
                  onFocusCar={setFocusCarId}
                  actions={raceStore.actions}
                  className="h-full rounded-tl-none"
                />
              ) : null}
              {tab === 'WEATHER' ? <WeatherRadar session={session} snapshot={snapshot} history={history} forecast={forecast} className="h-full rounded-tl-none" /> : null}
              {tab === 'ANALYSIS' ? (
                <RaceAnalysis session={session} snapshot={snapshot} history={history} classification={classification} className="h-full rounded-tl-none" />
              ) : null}
              {tab === 'PLANS' ? (
                <StrategyPlanner session={session} snapshot={snapshot} mode="LIVE" actions={raceStore.actions} className="h-full rounded-tl-none" />
              ) : null}
            </div>
          </div>
        </div>

        <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1.7fr)_minmax(0,1fr)] gap-1.5">
          <PitWallControls
            session={session}
            snapshot={snapshot}
            actions={raceStore.actions}
            selectedCarId={selectedCarId}
            onSelectCar={setSelectedCarId}
            className="h-full"
          />
          <RadioConsole session={session} snapshot={snapshot} messages={radio} events={history.events} actions={raceStore.actions} className="h-full" />
        </div>

        {preRace ? (
          <GridBriefing
            session={session}
            snapshot={snapshot}
            forecast={forecast}
            actions={raceStore.actions}
            onLightsOut={() => raceStore.startRace()}
            onBack={() => raceStore.reset()}
          />
        ) : null}

        {showResults && classification ? (
          <ResultsOverlay
            session={session}
            snapshot={snapshot}
            history={history}
            classification={classification}
            onClose={() => setResultsDismissed(true)}
            onNewRace={() => raceStore.reset()}
          />
        ) : null}
      </main>
    </div>
  );
}
