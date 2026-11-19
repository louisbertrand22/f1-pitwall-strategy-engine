import type { TyreCompound } from '../simulation/types';

/** Pirelli colour codes (same values as the `--color-tyre-*` tokens, for canvas / SVG use). */
export const TYRE_COLORS: Record<TyreCompound, string> = {
  SOFT: '#ff3b3b',
  MEDIUM: '#ffd12e',
  HARD: '#f4f4f4',
  INTER: '#43d15a',
  WET: '#3a8dff',
};

export const TYRE_LETTERS: Record<TyreCompound, string> = {
  SOFT: 'S',
  MEDIUM: 'M',
  HARD: 'H',
  INTER: 'I',
  WET: 'W',
};

export const TYRE_LABELS: Record<TyreCompound, string> = {
  SOFT: 'Soft',
  MEDIUM: 'Medium',
  HARD: 'Hard',
  INTER: 'Intermediate',
  WET: 'Full Wet',
};

export const TYRE_ORDER: readonly TyreCompound[] = ['SOFT', 'MEDIUM', 'HARD', 'INTER', 'WET'];

/** Text colour that stays readable on top of a filled compound swatch. */
export function tyreInkOn(compound: TyreCompound): string {
  return compound === 'SOFT' || compound === 'WET' ? '#ffffff' : '#0b0b0b';
}
