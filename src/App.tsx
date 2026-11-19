import { Cockpit } from './components/Cockpit';
import { SetupScreen } from './components/SetupScreen';
import { raceStore, useRaceState } from './state/raceStore';

export function App() {
  const state = useRaceState();
  if (state.stage !== 'SESSION' || !state.session || !state.snapshot) {
    return <SetupScreen loading={state.stage === 'LOADING'} error={state.error} onLaunch={(config) => raceStore.init(config)} />;
  }
  return <Cockpit state={state} />;
}
