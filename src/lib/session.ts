import type { CarId, DriverInfo, SessionInfo, TeamId, TeamInfo } from '../simulation/types';

export interface SessionIndex {
  driver(carId: CarId): DriverInfo;
  team(teamId: TeamId): TeamInfo;
  teamOf(carId: CarId): TeamInfo;
  /** Team colour of a car (hex). */
  color(carId: CarId): string;
  isPlayer(carId: CarId): boolean;
}

const cache = new WeakMap<SessionInfo, SessionIndex>();

/** O(1) lookups of drivers and teams for a session (memoised per session object). */
export function indexSession(session: SessionInfo): SessionIndex {
  const cached = cache.get(session);
  if (cached) return cached;

  const drivers = new Map<CarId, DriverInfo>(session.drivers.map((d) => [d.id, d]));
  const teams = new Map<TeamId, TeamInfo>(session.teams.map((t) => [t.id, t]));
  const players = new Set<CarId>(session.playerCarIds);

  const driver = (carId: CarId): DriverInfo => {
    const d = drivers.get(carId);
    if (!d) throw new Error(`Unknown car: ${carId}`);
    return d;
  };
  const team = (teamId: TeamId): TeamInfo => {
    const t = teams.get(teamId);
    if (!t) throw new Error(`Unknown team: ${teamId}`);
    return t;
  };
  const index: SessionIndex = {
    driver,
    team,
    teamOf: (carId) => team(driver(carId).teamId),
    color: (carId) => team(driver(carId).teamId).color,
    isPlayer: (carId) => players.has(carId),
  };
  cache.set(session, index);
  return index;
}
