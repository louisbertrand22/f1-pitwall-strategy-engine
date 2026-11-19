import type { TrackDefinition } from '../types';

/**
 * Synthetic circuit used by unit tests and component harnesses: a clockwise loop with a long pit
 * straight, a hairpin, a chicane and a fast sweeper. Not part of the selectable calendar.
 */
export const TEST_TRACK: TrackDefinition = {
  id: 'silverstone',
  name: 'Test Circuit',
  shortName: 'TEST',
  grandPrix: 'Test Grand Prix',
  country: 'TST',
  lengthKm: 5.2,
  raceLaps: 50,
  baseLapTime: 90,
  pitLossSeconds: 21,
  pitSpeedLimitKph: 80,
  pitEntry: 0.95,
  pitExit: 0.05,
  pitSide: 'RIGHT',
  abrasiveness: 1,
  tyreStress: 1,
  overtakingDifficulty: 0.45,
  safetyCarProbability: 0.5,
  vscProbability: 0.35,
  rainProbability: 0.25,
  fuelEffectPerKg: 0.03,
  fuelPerLapKg: 2.1,
  dirtyAirSensitivity: 1,
  compoundGap: [0.6, 0.4],
  airTempC: 24,
  trackTempC: 36,
  sectors: [0.33, 0.68],
  drsZones: [
    { name: 'Main straight', detection: 0.9, start: 0.96, end: 0.1 },
    { name: 'Back straight', detection: 0.44, start: 0.48, end: 0.6 },
  ],
  overtakingSpots: [0.3],
  corners: [
    { name: 'T1', at: 0.14 },
    { name: 'Hairpin', at: 0.3 },
    { name: 'Chicane', at: 0.64 },
    { name: 'Sweeper', at: 0.84 },
  ],
  svgPath:
    'M 420 560 L 760 560 C 880 560 930 500 920 420 C 912 350 860 330 820 290 C 780 250 800 190 760 150 ' +
    'C 720 110 640 110 600 150 C 570 180 560 230 520 240 L 300 250 C 250 252 240 210 200 200 ' +
    'C 150 188 90 230 80 300 C 68 390 110 470 180 520 C 230 556 300 560 420 560 Z',
  svgViewBox: { width: 1000, height: 680 },
};
