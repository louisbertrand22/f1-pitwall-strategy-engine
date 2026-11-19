/**
 * The grid: ten fictional teams and twenty fictional drivers.
 *
 * Pace figures are deficits in seconds per 90 s reference lap; they are scaled to each circuit's lap
 * length by the race engine. Edit this file to change the field – nothing else depends on the names.
 */
import type { DriverInfo, TeamId, TeamInfo } from './types';

export const TEAMS: readonly TeamInfo[] = [
  {
    id: 'halcyon', name: 'Halcyon Racing', shortName: 'Halcyon', color: '#FF8A1F',
    carPace: 0.0, unreliability: 0.85, pitCrewTime: 2.25, pitBoxPosition: 0.2,
    profile: { aggression: 0.45, weatherRisk: 0.4, reactivity: 0.9 },
  },
  {
    id: 'rossini', name: 'Rossini Corse', shortName: 'Rossini', color: '#E8203A',
    carPace: 0.1, unreliability: 1.0, pitCrewTime: 2.35, pitBoxPosition: 0.26,
    profile: { aggression: 0.7, weatherRisk: 0.65, reactivity: 0.7 },
  },
  {
    id: 'kestrel', name: 'Kestrel Grand Prix', shortName: 'Kestrel', color: '#3D7BFF',
    carPace: 0.16, unreliability: 0.9, pitCrewTime: 2.15, pitBoxPosition: 0.32,
    profile: { aggression: 0.6, weatherRisk: 0.5, reactivity: 0.95 },
  },
  {
    id: 'nordheim', name: 'Nordheim Motorsport', shortName: 'Nordheim', color: '#2FE0C8',
    carPace: 0.26, unreliability: 0.8, pitCrewTime: 2.3, pitBoxPosition: 0.38,
    profile: { aggression: 0.35, weatherRisk: 0.35, reactivity: 0.8 },
  },
  {
    id: 'emerald', name: 'Emerald Works', shortName: 'Emerald', color: '#1F9E6E',
    carPace: 0.6, unreliability: 1.05, pitCrewTime: 2.45, pitBoxPosition: 0.44,
    profile: { aggression: 0.5, weatherRisk: 0.55, reactivity: 0.6 },
  },
  {
    id: 'atlas', name: 'Atlas Racing Team', shortName: 'Atlas', color: '#7CC8FF',
    carPace: 0.72, unreliability: 1.1, pitCrewTime: 2.4, pitBoxPosition: 0.5,
    profile: { aggression: 0.55, weatherRisk: 0.45, reactivity: 0.75 },
  },
  {
    id: 'aurelia', name: 'Aurelia F1 Team', shortName: 'Aurelia', color: '#FF7EB6',
    carPace: 0.86, unreliability: 1.2, pitCrewTime: 2.55, pitBoxPosition: 0.56,
    profile: { aggression: 0.8, weatherRisk: 0.75, reactivity: 0.55 },
  },
  {
    id: 'hartmann', name: 'Hartmann Engineering', shortName: 'Hartmann', color: '#C9CED6',
    carPace: 0.95, unreliability: 1.0, pitCrewTime: 2.5, pitBoxPosition: 0.62,
    profile: { aggression: 0.4, weatherRisk: 0.3, reactivity: 0.65 },
  },
  {
    id: 'sovereign', name: 'Sovereign GP', shortName: 'Sovereign', color: '#D4A72C',
    carPace: 1.08, unreliability: 1.15, pitCrewTime: 2.6, pitBoxPosition: 0.68,
    profile: { aggression: 0.65, weatherRisk: 0.6, reactivity: 0.5 },
  },
  {
    id: 'voltaic', name: 'Voltaic Racing', shortName: 'Voltaic', color: '#9BE22D',
    carPace: 1.22, unreliability: 1.3, pitCrewTime: 2.7, pitBoxPosition: 0.74,
    profile: { aggression: 0.85, weatherRisk: 0.8, reactivity: 0.45 },
  },
];

type DriverSeed = Omit<DriverInfo, 'code'>;

const DRIVER_SEEDS: readonly DriverSeed[] = [
  { id: 'VAR', firstName: 'Elias', lastName: 'Varga', number: 7, teamId: 'halcyon', carNumber: 1, paceDelta: 0.0, consistency: 0.07, racecraft: 0.9, wetSkill: 0.92, tyreWearFactor: 0.96, errorProneness: 0.75 },
  { id: 'WHI', firstName: 'Jonah', lastName: 'Whitlock', number: 19, teamId: 'halcyon', carNumber: 2, paceDelta: 0.06, consistency: 0.08, racecraft: 0.8, wetSkill: 0.8, tyreWearFactor: 0.98, errorProneness: 0.95 },
  { id: 'BEL', firstName: 'Matteo', lastName: 'Bellandi', number: 16, teamId: 'rossini', carNumber: 1, paceDelta: 0.02, consistency: 0.09, racecraft: 0.88, wetSkill: 0.82, tyreWearFactor: 1.04, errorProneness: 1.1 },
  { id: 'LAU', firstName: 'Sébastien', lastName: 'Laurent', number: 5, teamId: 'rossini', carNumber: 2, paceDelta: 0.08, consistency: 0.07, racecraft: 0.92, wetSkill: 0.97, tyreWearFactor: 0.94, errorProneness: 0.8 },
  { id: 'NAK', firstName: 'Kai', lastName: 'Nakamura', number: 22, teamId: 'kestrel', carNumber: 1, paceDelta: 0.01, consistency: 0.06, racecraft: 0.97, wetSkill: 0.98, tyreWearFactor: 0.97, errorProneness: 0.7 },
  { id: 'BRA', firstName: 'Oliver', lastName: 'Brandt', number: 33, teamId: 'kestrel', carNumber: 2, paceDelta: 0.14, consistency: 0.1, racecraft: 0.72, wetSkill: 0.76, tyreWearFactor: 1.03, errorProneness: 1.15 },
  { id: 'ALD', firstName: 'Henrik', lastName: 'Aldersen', number: 63, teamId: 'nordheim', carNumber: 1, paceDelta: 0.03, consistency: 0.07, racecraft: 0.85, wetSkill: 0.88, tyreWearFactor: 0.99, errorProneness: 0.9 },
  { id: 'MOR', firstName: 'Luca', lastName: 'Moretti', number: 12, teamId: 'nordheim', carNumber: 2, paceDelta: 0.12, consistency: 0.11, racecraft: 0.74, wetSkill: 0.78, tyreWearFactor: 1.05, errorProneness: 1.25 },
  { id: 'REY', firstName: 'Callum', lastName: 'Reyes', number: 14, teamId: 'emerald', carNumber: 1, paceDelta: 0.0, consistency: 0.06, racecraft: 0.96, wetSkill: 0.95, tyreWearFactor: 0.93, errorProneness: 0.7 },
  { id: 'SOK', firstName: 'Dmitri', lastName: 'Sokolov', number: 18, teamId: 'emerald', carNumber: 2, paceDelta: 0.22, consistency: 0.12, racecraft: 0.62, wetSkill: 0.7, tyreWearFactor: 1.06, errorProneness: 1.3 },
  { id: 'ORT', firstName: 'Pablo', lastName: 'Ortega', number: 10, teamId: 'atlas', carNumber: 1, paceDelta: 0.04, consistency: 0.08, racecraft: 0.84, wetSkill: 0.86, tyreWearFactor: 1.0, errorProneness: 0.95 },
  { id: 'FIS', firstName: 'Noah', lastName: 'Fischer', number: 43, teamId: 'atlas', carNumber: 2, paceDelta: 0.18, consistency: 0.12, racecraft: 0.66, wetSkill: 0.72, tyreWearFactor: 1.04, errorProneness: 1.35 },
  { id: 'MEH', firstName: 'Arjun', lastName: 'Mehta', number: 31, teamId: 'aurelia', carNumber: 1, paceDelta: 0.06, consistency: 0.09, racecraft: 0.8, wetSkill: 0.84, tyreWearFactor: 1.01, errorProneness: 1.05 },
  { id: 'SIL', firstName: 'Tomás', lastName: 'Silva', number: 87, teamId: 'aurelia', carNumber: 2, paceDelta: 0.1, consistency: 0.1, racecraft: 0.78, wetSkill: 0.8, tyreWearFactor: 1.02, errorProneness: 1.1 },
  { id: 'HAR', firstName: 'Felix', lastName: 'Hartmann', number: 27, teamId: 'hartmann', carNumber: 1, paceDelta: 0.03, consistency: 0.07, racecraft: 0.86, wetSkill: 0.9, tyreWearFactor: 0.95, errorProneness: 0.85 },
  { id: 'TAN', firstName: 'Yuto', lastName: 'Tanabe', number: 6, teamId: 'hartmann', carNumber: 2, paceDelta: 0.11, consistency: 0.1, racecraft: 0.76, wetSkill: 0.83, tyreWearFactor: 1.03, errorProneness: 1.2 },
  { id: 'OKA', firstName: 'Zane', lastName: 'Okafor', number: 23, teamId: 'sovereign', carNumber: 1, paceDelta: 0.02, consistency: 0.08, racecraft: 0.87, wetSkill: 0.85, tyreWearFactor: 0.98, errorProneness: 0.9 },
  { id: 'COS', firstName: 'Rafael', lastName: 'Costa', number: 55, teamId: 'sovereign', carNumber: 2, paceDelta: 0.07, consistency: 0.08, racecraft: 0.84, wetSkill: 0.87, tyreWearFactor: 0.97, errorProneness: 0.95 },
  { id: 'LAI', firstName: 'Mikko', lastName: 'Laine', number: 77, teamId: 'voltaic', carNumber: 1, paceDelta: 0.05, consistency: 0.08, racecraft: 0.82, wetSkill: 0.9, tyreWearFactor: 0.96, errorProneness: 0.9 },
  { id: 'PAR', firstName: 'Julian', lastName: 'Park', number: 24, teamId: 'voltaic', carNumber: 2, paceDelta: 0.16, consistency: 0.11, racecraft: 0.7, wetSkill: 0.74, tyreWearFactor: 1.04, errorProneness: 1.25 },
];

export const DRIVERS: readonly DriverInfo[] = DRIVER_SEEDS.map((d) => ({ ...d, code: d.id }));

export const DEFAULT_PLAYER_TEAM: TeamId = 'kestrel';

export function getTeam(teamId: TeamId): TeamInfo {
  const team = TEAMS.find((t) => t.id === teamId);
  if (!team) throw new Error(`Unknown team: ${teamId}`);
  return team;
}

export function getTeamDrivers(teamId: TeamId): [DriverInfo, DriverInfo] {
  const first = DRIVERS.find((d) => d.teamId === teamId && d.carNumber === 1);
  const second = DRIVERS.find((d) => d.teamId === teamId && d.carNumber === 2);
  if (!first || !second) throw new Error(`Team ${teamId} does not have two drivers`);
  return [first, second];
}

/** FIA points for the top ten finishers. */
export const POINTS_TABLE: readonly number[] = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
