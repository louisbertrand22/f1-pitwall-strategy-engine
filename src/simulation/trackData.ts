/**
 * Circuit database: the five Grand Prix venues of the simulator.
 *
 * Each centreline is a hand-authored SVG path (straights and corner arcs written as cubic Béziers) that
 * starts on the start/finish line and runs in the racing direction. Every lap distance fraction below
 * (sectors, DRS zones, pit entry/exit, corner apexes, overtaking spots) was measured on that path as it is
 * sampled by `buildTrackGeometry`, so the markers sit on the corners they name.
 *
 * Conventions: all pit lanes are on the driver's right; a DRS zone on the start/finish straight wraps the
 * line (`end < start`) and every zone ends at the braking point of the next corner; `overtakingSpots` are
 * the apexes of the classic heavy-braking passing places (the race engine adds the end of each DRS zone
 * itself). Sector lines follow the real timing loops where the reference lap splits sensibly; at Monaco,
 * Spa and Suzuka they are shifted so that no sector is shorter than a quarter of the lap.
 */
import type { TrackDefinition, TrackId } from './types';

/*
 * Circuit de Monaco — drawn north-up: the harbour section on the left, the Casino loop on the right.
 * Lap: start on Boulevard Albert 1er → Sainte Dévote → up Beau Rivage → Massenet → Casino → Mirabeau →
 * Grand Hotel Hairpin → Mirabeau Bas → Portier → Tunnel → Nouvelle Chicane → Tabac → Swimming Pool
 * (Louis Chiron, then the second chicane) → La Rascasse → Anthony Noghès. The gap between the start
 * straight and the Swimming Pool is drawn wider than life so the pit lane stays legible.
 */
const MONACO: TrackDefinition = {
  id: 'monaco',
  name: 'Circuit de Monaco',
  shortName: 'MONACO',
  grandPrix: 'Monaco Grand Prix',
  country: 'MCO',
  lengthKm: 3.337,
  raceLaps: 78,
  baseLapTime: 72,
  pitLossSeconds: 19.5,
  pitSpeedLimitKph: 60,
  pitEntry: 0.903,
  pitExit: 0.062,
  pitSide: 'RIGHT',
  abrasiveness: 0.7,
  tyreStress: 0.85,
  overtakingDifficulty: 0.98,
  safetyCarProbability: 0.55,
  vscProbability: 0.35,
  rainProbability: 0.2,
  fuelEffectPerKg: 0.024,
  fuelPerLapKg: 1.32,
  dirtyAirSensitivity: 0.8,
  compoundGap: [0.35, 0.3],
  airTempC: 23,
  trackTempC: 40,
  sectors: [0.309, 0.673],
  drsZones: [
    { name: 'Start/finish straight', detection: 0.835, start: 0.9, end: 0.036 },
  ],
  overtakingSpots: [0.606],
  corners: [
    { name: 'Sainte Dévote', at: 0.073 },
    { name: 'Beau Rivage', at: 0.144 },
    { name: 'Massenet', at: 0.251 },
    { name: 'Casino', at: 0.278 },
    { name: 'Mirabeau', at: 0.331 },
    { name: 'Grand Hotel Hairpin', at: 0.363 },
    { name: 'Portier', at: 0.409 },
    { name: 'Tunnel', at: 0.473 },
    { name: 'Nouvelle Chicane', at: 0.606 },
    { name: 'Tabac', at: 0.714 },
    { name: 'Swimming Pool', at: 0.776 },
    { name: 'La Rascasse', at: 0.856 },
    { name: 'Anthony Noghès', at: 0.892 },
  ],
  svgPath:
    'M 163.5 268.3 L 247.3 110.7 C 251.3 103.2 260.2 99.8 268.2 102.7 L 388.2 146.4 ' +
    'C 419.9 157.9 453 165.2 486.5 168.2 L 565 175.1 C 591.9 177.5 619 177 645.8 173.7 L 682.2 169.3 ' +
    'C 694.1 167.8 704.8 161.5 711.7 151.8 C 718.6 142.1 721.1 129.9 718.7 118.2 L 714.8 99.8 ' +
    'C 712.4 88.9 718.9 77.9 729.6 74.6 L 838.8 41.3 C 841.9 40.4 845.2 40.8 847.9 42.6 ' +
    'C 850.6 44.3 852.3 47.1 852.7 50.3 L 860.9 117 C 861.3 119.9 863.7 122 866.6 122.1 L 867 122.1 ' +
    'C 869.9 122.2 872.3 120.1 872.8 117.2 L 881 65.7 C 881.7 60.9 886 57.6 890.8 57.9 L 929.9 60.6 ' +
    'C 933.3 60.9 936.3 62.6 938.2 65.4 C 940.1 68.3 940.5 71.8 939.4 75 L 923.2 122 ' +
    'C 899.3 191.3 842 243.8 770.8 261.6 L 536.8 319.8 C 534.8 320.3 533 321.6 532 323.4 ' +
    'L 528.9 328.5 C 526.5 332.4 521.8 334.3 517.4 333 L 292 267 ' +
    'C 272.5 261.3 251.8 271.8 244.8 290.9 L 223.8 348.7 C 219.8 359.9 219.2 372.1 222.3 383.5 ' +
    'L 222.5 384.1 C 225.5 395.5 225 407.7 221 418.9 L 203.1 468.1 ' +
    'C 201.5 472.4 198.1 475.8 193.8 477.4 L 178.3 483 C 174 484.6 170.6 487.9 169 492.2 ' +
    'L 131.8 594.6 C 131 596.8 129.1 598.5 126.7 599 C 124.4 599.5 122 598.8 120.3 597.1 L 63.2 540 ' +
    'C 60.2 537 59.2 532.6 60.7 528.6 L 121.5 361.8 C 132.5 331.4 145.7 301.8 160.9 273.3 ' +
    'L 163.5 268.3 Z',
  svgViewBox: { width: 1000, height: 640 },
};

/*
 * Silverstone Circuit — Arena Grand Prix layout, Copse at the top, Stowe bottom right, Luffield far left.
 * Lap: start on the Hamilton Straight → Abbey → Farm → Village → The Loop → Aintree → Wellington Straight →
 * Brooklands → Luffield → Woodcote → National pits straight → Copse → Maggotts → Becketts → Chapel →
 * Hangar Straight → Stowe → Vale → Club.
 */
const SILVERSTONE: TrackDefinition = {
  id: 'silverstone',
  name: 'Silverstone Circuit',
  shortName: 'SILVERSTONE',
  grandPrix: 'British Grand Prix',
  country: 'GBR',
  lengthKm: 5.891,
  raceLaps: 52,
  baseLapTime: 87.5,
  pitLossSeconds: 20.5,
  pitSpeedLimitKph: 80,
  pitEntry: 0.946,
  pitExit: 0.063,
  pitSide: 'RIGHT',
  abrasiveness: 1.1,
  tyreStress: 1.1,
  overtakingDifficulty: 0.45,
  safetyCarProbability: 0.65,
  vscProbability: 0.3,
  rainProbability: 0.3,
  fuelEffectPerKg: 0.031,
  fuelPerLapKg: 2.05,
  dirtyAirSensitivity: 1.15,
  compoundGap: [0.6, 0.4],
  airTempC: 21,
  trackTempC: 33,
  sectors: [0.31, 0.715],
  drsZones: [
    { name: 'Wellington Straight', detection: 0.163, start: 0.223, end: 0.317 },
    { name: 'Hangar Straight', detection: 0.603, start: 0.699, end: 0.809 },
  ],
  overtakingSpots: [0.172, 0.343, 0.836],
  corners: [
    { name: 'Abbey', at: 0.067 },
    { name: 'Farm', at: 0.112 },
    { name: 'Village', at: 0.172 },
    { name: 'The Loop', at: 0.191 },
    { name: 'Brooklands', at: 0.343 },
    { name: 'Luffield', at: 0.368 },
    { name: 'Woodcote', at: 0.393 },
    { name: 'Copse', at: 0.498 },
    { name: 'Maggotts', at: 0.578 },
    { name: 'Becketts', at: 0.629 },
    { name: 'Chapel', at: 0.679 },
    { name: 'Stowe', at: 0.836 },
    { name: 'Vale', at: 0.911 },
    { name: 'Club', at: 0.934 },
  ],
  svgPath:
    'M 590.9 601.5 L 475.3 559.4 C 452.9 551.3 434.9 534 425.8 512 ' +
    'C 416.7 489.9 417.2 465.1 427.3 443.4 L 439.3 417.7 C 448 398.9 452.6 378.4 452.6 357.7 ' +
    'L 452.6 225.3 C 452.6 221.6 454.1 218 456.9 215.5 C 459.6 213 463.3 211.8 467 212.1 ' +
    'L 492.9 214.3 C 499.7 214.9 505.6 209.9 506.2 203.2 C 506.8 196.4 501.8 190.4 495 189.8 ' +
    'L 466.8 187.4 C 456.4 186.5 446 187.8 436.3 191.4 L 115.6 308.1 ' +
    'C 108.4 310.7 102.7 316.4 100 323.7 C 97.4 330.9 98.1 338.9 102 345.6 L 111.4 362 ' +
    'C 116.9 371.5 113.6 383.6 104.1 389.1 C 94.6 394.6 82.5 391.3 77 381.8 ' +
    'C 63.1 357.7 58.1 329.5 63 302.2 L 97.5 106.5 C 104.9 64 145.4 35.7 187.9 43.2 L 327.6 67.8 ' +
    'C 346.7 71.2 366.2 70.3 384.9 65.3 C 414.6 57.4 446.3 63 471.5 80.6 ' +
    'C 488.8 92.7 511.3 94.7 530.4 85.8 C 543.1 79.9 557.6 79.6 570.4 84.9 ' +
    'C 583.3 90.2 593.3 100.7 598.1 113.8 C 605.2 133.3 617.3 150.6 633.2 163.9 L 916.9 402 ' +
    'C 930.8 413.7 938.9 430.9 938.9 449.1 C 938.9 467.3 930.8 484.5 916.9 496.2 L 797.3 596.5 ' +
    'C 793.4 599.8 792.2 605.4 794.3 610 L 799.3 620.7 C 801.6 625.6 801.1 631.4 798 635.8 ' +
    'C 784.5 655.1 759.7 662.9 737.6 654.9 L 590.9 601.5 Z',
  svgViewBox: { width: 1000, height: 700 },
};

/*
 * Circuit de Spa-Francorchamps — La Source is the left tip, Les Combes top right, Stavelot at the bottom.
 * Lap: La Source → Eau Rouge → Raidillon → Kemmel Straight → Les Combes → Malmedy → Rivage → Pouhon →
 * Fagnes → Campus → Stavelot → Blanchimont → Bus Stop chicane.
 */
const SPA: TrackDefinition = {
  id: 'spa',
  name: 'Circuit de Spa-Francorchamps',
  shortName: 'SPA',
  grandPrix: 'Belgian Grand Prix',
  country: 'BEL',
  lengthKm: 7.004,
  raceLaps: 44,
  baseLapTime: 104.5,
  pitLossSeconds: 18.5,
  pitSpeedLimitKph: 80,
  pitEntry: 0.959,
  pitExit: 0.03,
  pitSide: 'RIGHT',
  abrasiveness: 1.1,
  tyreStress: 1.1,
  overtakingDifficulty: 0.25,
  safetyCarProbability: 0.55,
  vscProbability: 0.3,
  rainProbability: 0.5,
  fuelEffectPerKg: 0.036,
  fuelPerLapKg: 2.45,
  dirtyAirSensitivity: 0.95,
  compoundGap: [0.7, 0.45],
  airTempC: 18,
  trackTempC: 28,
  sectors: [0.316, 0.667],
  drsZones: [
    { name: 'Kemmel Straight', detection: 0.109, start: 0.212, end: 0.303 },
    { name: 'Start/finish straight', detection: 0.93, start: 0.959, end: 0.027 },
  ],
  overtakingSpots: [0.948],
  corners: [
    { name: 'La Source', at: 0.048 },
    { name: 'Eau Rouge', at: 0.133 },
    { name: 'Raidillon', at: 0.157 },
    { name: 'Les Combes', at: 0.325 },
    { name: 'Malmedy', at: 0.355 },
    { name: 'Rivage', at: 0.409 },
    { name: 'Pouhon', at: 0.523 },
    { name: 'Fagnes', at: 0.623 },
    { name: 'Campus', at: 0.679 },
    { name: 'Stavelot', at: 0.713 },
    { name: 'Blanchimont', at: 0.848 },
    { name: 'Bus Stop', at: 0.948 },
  ],
  svgPath:
    'M 193.9 182.7 L 71.6 138.2 C 68.9 137.2 67.2 134.6 67.5 131.7 C 67.7 128.8 69.9 126.5 72.7 126 ' +
    'L 279.9 89.4 C 292.3 87.2 304 82 313.9 74.3 L 320.5 69.1 C 342.6 51.8 371.7 46.4 398.5 54.6 ' +
    'L 411.5 58.6 C 428.8 63.9 447.1 65.1 465 62.1 L 554.3 47.4 C 585.3 42.3 616.7 40.8 648 42.9 ' +
    'L 822.3 54.7 C 829.9 55.2 836.2 60.6 837.9 68 L 839.9 76.6 C 841.8 85 849.1 91 857.7 91.3 ' +
    'L 875.9 91.9 C 891.2 92.5 904.3 103.2 907.8 118.2 L 932.2 224.3 ' +
    'C 933 227.9 932.3 231.7 930.3 234.8 C 928.3 237.9 925.1 240 921.4 240.7 L 920.8 240.8 ' +
    'C 917.2 241.5 913.4 240.7 910.4 238.5 C 907.4 236.3 905.4 233 904.9 229.4 L 898.9 186.1 ' +
    'C 897.8 178.8 893.9 172.1 888 167.6 C 882 163.2 874.6 161.2 867.2 162.3 L 706.2 184.9 ' +
    'C 688.3 187.4 672.7 198.3 664.2 214.2 L 662.4 217.6 C 649.7 241.4 652.3 270.3 668.9 291.5 ' +
    'L 780.9 433.7 C 789.1 444.2 789.9 458.8 782.8 470.1 L 776.3 480.6 ' +
    'C 770 490.6 770.7 503.4 778 512.7 L 823.5 570.9 C 831.8 581.6 830.6 596.9 820.7 606.2 ' +
    'L 780.8 643.5 C 769 654.4 753.1 659.6 737.1 657.6 L 729.2 656.7 ' +
    'C 685.3 651.2 646.7 624.7 626 585.6 L 615.2 565.2 C 595.2 527.6 581.3 487.1 573.9 445.1 ' +
    'L 570.9 427.8 C 564.9 393.6 547.1 362.6 520.6 340.1 L 506.3 327.9 ' +
    'C 489.9 314 471.2 303.1 451 295.7 L 314.3 246 C 312.9 245.5 311.7 244.3 311.3 242.8 ' +
    'C 310.8 241.4 311.1 239.8 311.9 238.5 L 315.7 233.1 C 316.5 231.9 316.8 230.5 316.3 229.1 ' +
    'C 315.9 227.8 314.9 226.7 313.6 226.2 L 193.9 182.7 Z',
  svgViewBox: { width: 1000, height: 700 },
};

/*
 * Autodromo Nazionale Monza — main straight along the bottom (running right to left), Lesmos top left,
 * Parabolica far right.
 * Lap: Variante del Rettifilo → Curva Grande → Variante della Roggia → Lesmo 1 → Lesmo 2 → Serraglio →
 * Variante Ascari → back straight → Parabolica.
 */
const MONZA: TrackDefinition = {
  id: 'monza',
  name: 'Autodromo Nazionale Monza',
  shortName: 'MONZA',
  grandPrix: 'Italian Grand Prix',
  country: 'ITA',
  lengthKm: 5.793,
  raceLaps: 53,
  baseLapTime: 80.5,
  pitLossSeconds: 24,
  pitSpeedLimitKph: 80,
  pitEntry: 0.952,
  pitExit: 0.061,
  pitSide: 'RIGHT',
  abrasiveness: 0.85,
  tyreStress: 0.95,
  overtakingDifficulty: 0.2,
  safetyCarProbability: 0.45,
  vscProbability: 0.3,
  rainProbability: 0.2,
  fuelEffectPerKg: 0.028,
  fuelPerLapKg: 2,
  dirtyAirSensitivity: 0.65,
  compoundGap: [0.5, 0.35],
  airTempC: 27,
  trackTempC: 42,
  sectors: [0.318, 0.589],
  drsZones: [
    { name: 'Start/finish straight', detection: 0.822, start: 0.02, end: 0.091 },
    { name: 'Serraglio straight', detection: 0.427, start: 0.476, end: 0.591 },
  ],
  overtakingSpots: [0.342, 0.613],
  corners: [
    { name: 'Variante del Rettifilo', at: 0.119 },
    { name: 'Curva Grande', at: 0.192 },
    { name: 'Variante della Roggia', at: 0.342 },
    { name: 'Lesmo 1', at: 0.391 },
    { name: 'Lesmo 2', at: 0.443 },
    { name: 'Serraglio', at: 0.532 },
    { name: 'Variante Ascari', at: 0.634 },
    { name: 'Parabolica', at: 0.837 },
  ],
  svgPath:
    'M 619.6 501.5 L 380.9 489 C 378.3 488.8 376.3 486.8 376.1 484.3 L 375.8 480.9 ' +
    'C 375.6 479.6 375 478.4 374 477.6 C 373 476.8 371.7 476.4 370.4 476.6 L 360.2 477.8 ' +
    'C 358.8 478 357.4 478 356 477.9 L 335.6 476.1 C 269 470.3 212.6 424.6 193.1 360.8 L 133.2 164.7 ' +
    'C 132.4 162.3 130.6 160.3 128.3 159.4 L 125.1 158.2 C 122.5 157.2 120.6 155 120 152.3 ' +
    'L 106.5 88.8 C 103.7 75.5 110.8 62.1 123.4 57 C 146.6 47.6 170.4 39.7 194.6 33.2 ' +
    'C 202.8 31 211.6 33.4 217.7 39.4 L 319.1 140.8 C 329.8 151.6 342.1 160.7 355.6 167.8 ' +
    'L 470.1 228.7 C 477.8 232.8 487 232.9 494.7 228.9 L 500.8 225.8 ' +
    'C 515.6 218.3 533.6 222.5 543.6 235.7 L 547.7 241.2 C 553.1 248.4 560.3 254 568.6 257.5 ' +
    'L 874.3 387.3 C 888.2 393.2 896.2 407.9 893.6 422.8 C 888.8 450.2 870.8 473.5 845.6 485.3 ' +
    'C 810.1 501.8 771.2 509.4 732.1 507.4 L 619.6 501.5 Z',
  svgViewBox: { width: 1000, height: 540 },
};

/*
 * Suzuka International Racing Course — figure of eight: First Curve far right, Spoon far left. The path
 * crosses itself once, where the back straight bridges over the run from Degner to the Hairpin.
 * Lap: First Curve → Turn 2 → S Curves → Dunlop → Degner 1 → Degner 2 → (under the bridge) → Hairpin →
 * 200R → Spoon → back straight (over the bridge) → 130R → Casio Triangle → Last Curve.
 */
const SUZUKA: TrackDefinition = {
  id: 'suzuka',
  name: 'Suzuka International Racing Course',
  shortName: 'SUZUKA',
  grandPrix: 'Japanese Grand Prix',
  country: 'JPN',
  lengthKm: 5.807,
  raceLaps: 53,
  baseLapTime: 89.5,
  pitLossSeconds: 22.5,
  pitSpeedLimitKph: 80,
  pitEntry: 0.964,
  pitExit: 0.045,
  pitSide: 'RIGHT',
  abrasiveness: 1.25,
  tyreStress: 1.12,
  overtakingDifficulty: 0.7,
  safetyCarProbability: 0.5,
  vscProbability: 0.3,
  rainProbability: 0.35,
  fuelEffectPerKg: 0.031,
  fuelPerLapKg: 2,
  dirtyAirSensitivity: 1.2,
  compoundGap: [0.6, 0.4],
  airTempC: 20,
  trackTempC: 30,
  sectors: [0.348, 0.724],
  drsZones: [
    { name: 'Start/finish straight', detection: 0.911, start: 0.988, end: 0.084 },
  ],
  overtakingSpots: [0.528, 0.922],
  corners: [
    { name: 'First Curve', at: 0.1 },
    { name: 'Turn 2', at: 0.163 },
    { name: 'S Curves', at: 0.196 },
    { name: 'Dunlop', at: 0.284 },
    { name: 'Degner 1', at: 0.405 },
    { name: 'Degner 2', at: 0.419 },
    { name: 'Hairpin', at: 0.528 },
    { name: '200R', at: 0.577 },
    { name: 'Spoon', at: 0.678 },
    { name: '130R', at: 0.863 },
    { name: 'Casio Triangle', at: 0.922 },
    { name: 'Last Curve', at: 0.949 },
  ],
  svgPath:
    'M 689.1 93.9 L 904.8 206.1 C 924.5 216.3 937 236.4 937.5 258.6 L 940 373.3 ' +
    'C 940.2 382.1 935.6 390.3 928.1 394.7 C 920.5 399.2 911.1 399.2 903.5 394.8 L 894.2 389.3 ' +
    'C 885.3 384.2 874.6 383.5 865.2 387.6 L 863.7 388.2 C 849 394.5 832 387.8 825.5 373.1 ' +
    'L 814.4 347.7 C 807.7 332.5 790 325.5 774.7 332 L 769.5 334.2 ' +
    'C 755.3 340.4 738.7 333.8 732.4 319.6 L 717.7 285.8 C 709.8 267.9 694.7 254.1 676 248 ' +
    'C 657.4 242 637 244.1 620.1 254 L 397.1 383.8 C 387.4 389.5 375.9 391.2 364.9 388.8 ' +
    'L 349.4 385.3 C 343.9 384 340.1 378.9 340.6 373.2 L 354.2 218.5 ' +
    'C 354.6 213.8 355.6 209.2 357.1 204.7 L 393.7 94.3 C 394.3 92.6 393.8 90.7 392.4 89.5 ' +
    'L 391.7 88.9 C 390.5 87.9 389 87.6 387.6 88 C 386.2 88.4 385 89.5 384.6 90.9 L 365.8 147.3 ' +
    'C 352 188.8 317 219.6 274.1 228.1 L 91 264.1 C 71.1 268 57.6 286.7 60.3 306.8 L 66.3 352.1 ' +
    'C 67.5 361.1 72.7 369.1 80.4 373.9 C 88.1 378.7 97.6 379.8 106.2 376.8 L 434.2 265.2 ' +
    'C 457 257.5 474.8 239.5 482.4 216.7 L 520.5 101.8 C 520.9 100.6 521.9 99.6 523.1 99.2 ' +
    'C 524.3 98.8 525.6 99 526.7 99.7 L 528.9 101.2 C 529.9 101.9 531.2 102 532.3 101.6 ' +
    'C 533.4 101.1 534.2 100.1 534.5 98.9 L 539.5 74.3 C 542 61.9 550.2 51.3 561.7 45.9 ' +
    'C 573.1 40.4 586.5 40.6 597.8 46.5 L 689.1 93.9 Z',
  svgViewBox: { width: 1000, height: 440 },
};

export const TRACKS: Readonly<Record<TrackId, TrackDefinition>> = {
  monaco: MONACO,
  silverstone: SILVERSTONE,
  spa: SPA,
  monza: MONZA,
  suzuka: SUZUKA,
};

/** Calendar order: monaco, silverstone, spa, monza, suzuka. */
export const TRACK_LIST: readonly TrackDefinition[] = [MONACO, SILVERSTONE, SPA, MONZA, SUZUKA];

export const DEFAULT_TRACK_ID: TrackId = 'silverstone';

/** Looks a circuit up by id; throws on an id that is not in the calendar. */
export function getTrack(id: TrackId): TrackDefinition {
  const track: TrackDefinition | undefined = Object.hasOwn(TRACKS, id) ? TRACKS[id] : undefined;
  if (!track) throw new Error(`Unknown track id: ${String(id)}`);
  return track;
}
