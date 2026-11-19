import { RotateCcw, Trophy, X } from 'lucide-react';
import { formatGap, formatLapTime, formatRaceClock } from '../lib/format';
import { indexSession } from '../lib/session';
import type { ClassificationEntry, RaceHistory, RaceSnapshot, SessionInfo } from '../simulation/types';
import { RaceAnalysis } from './RaceAnalysis';
import { DriverTag } from './ui';

export interface ResultsOverlayProps {
  session: SessionInfo;
  snapshot: RaceSnapshot;
  history: RaceHistory;
  classification: ClassificationEntry[];
  onClose: () => void;
  onNewRace: () => void;
}

function gapLabel(entry: ClassificationEntry): string {
  if (entry.status === 'DNF') return 'DNF';
  if (entry.position === 1) return entry.totalTime !== null ? formatRaceClock(entry.totalTime) : 'WINNER';
  return formatGap(entry.gap, entry.lapsDown);
}

/** End-of-race screen: official classification next to the full post-race analysis. */
export function ResultsOverlay({ session, snapshot, history, classification, onClose, onNewRace }: ResultsOverlayProps) {
  const index = indexSession(session);
  const teamPoints = classification.filter((c) => index.isPlayer(c.carId)).reduce((sum, c) => sum + c.points, 0);
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-carbon-950/85 p-4 backdrop-blur-[2px]">
      <div className="pw-panel flex h-full max-h-[980px] w-full max-w-[1820px] flex-col overflow-hidden shadow-[0_24px_64px_rgb(0_0_0/0.7)]">
        <header className="flex items-center gap-4 border-b border-carbon-700 bg-carbon-850 px-4 py-2">
          <Trophy size={20} strokeWidth={1.75} className="text-ink-300" />
          <div>
            <div className="pw-label">Race classification</div>
            <h2 className="font-display text-xl font-bold uppercase leading-tight tracking-[0.16em] text-ink-50">{session.track.grandPrix}</h2>
          </div>
          <div className="border-l border-carbon-700 pl-4 leading-none">
            <div className="pw-label">Team points</div>
            <div className="mt-1 font-mono text-xl font-bold text-ink-50 tabular">{teamPoints}</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" className="pw-btn h-8" onClick={onNewRace}>
              <RotateCcw size={13} strokeWidth={2} />
              New race
            </button>
            <button type="button" className="pw-btn h-8" onClick={onClose} title="Back to the cockpit">
              <X size={13} strokeWidth={2} />
              Close
            </button>
          </div>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-[440px_minmax(0,1fr)]">
          <div className="min-h-0 overflow-auto border-r border-carbon-700">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-carbon-850">
                <tr className="pw-label text-left">
                  <th className="px-2 py-1.5 font-semibold">Pos</th>
                  <th className="px-1 py-1.5 font-semibold">Driver</th>
                  <th className="px-1 py-1.5 text-right font-semibold">Time / gap</th>
                  <th className="px-1 py-1.5 text-right font-semibold">Best</th>
                  <th className="px-1 py-1.5 text-right font-semibold">Pit</th>
                  <th className="px-1 py-1.5 text-right font-semibold">Grid</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Pts</th>
                </tr>
              </thead>
              <tbody>
                {classification.map((entry) => {
                  const driver = index.driver(entry.carId);
                  const mine = index.isPlayer(entry.carId);
                  const delta = entry.gridPosition - entry.position;
                  return (
                    <tr
                      key={entry.carId}
                      className={`border-t border-carbon-700 ${entry.status === 'DNF' ? 'text-ink-500' : 'text-ink-100'}`}
                      style={mine ? { backgroundColor: 'color-mix(in srgb, var(--color-team) 14%, transparent)' } : undefined}
                      title={entry.retiredReason ?? (entry.penaltySeconds > 0 ? `Includes a ${entry.penaltySeconds} s penalty` : undefined)}
                    >
                      <td className="px-2 py-[5px] font-mono font-bold tabular">{entry.position}</td>
                      <td className="px-1 py-[5px]">
                        <DriverTag code={driver.code} color={index.color(driver.id)} strong={mine} />
                      </td>
                      <td className="px-1 py-[5px] text-right font-mono tabular">
                        {gapLabel(entry)}
                        {entry.penaltySeconds > 0 ? <span className="ml-1 text-warn">+{entry.penaltySeconds}s</span> : null}
                      </td>
                      <td className="px-1 py-[5px] text-right font-mono tabular text-ink-300">{formatLapTime(entry.bestLapTime)}</td>
                      <td className="px-1 py-[5px] text-right font-mono tabular text-ink-300">{entry.pitStops}</td>
                      <td className="px-1 py-[5px] text-right font-mono tabular text-ink-300">
                        {entry.gridPosition}
                        {entry.status === 'FINISHED' && delta !== 0 ? (
                          <span className={`ml-1 ${delta > 0 ? 'text-ok' : 'text-crit'}`}>
                            {delta > 0 ? '▲' : '▼'}
                            {Math.abs(delta)}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-2 py-[5px] text-right font-mono font-bold tabular">{entry.points > 0 ? entry.points : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="min-h-0 min-w-0">
            <RaceAnalysis session={session} snapshot={snapshot} history={history} classification={classification} className="h-full border-0" />
          </div>
        </div>
      </div>
    </div>
  );
}
