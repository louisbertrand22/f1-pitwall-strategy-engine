import { useState } from 'react';
import { Flag } from 'lucide-react';
import type { FlagStatus } from '../../simulation/types';
import { ChequeredFlagGlyph } from './glyphs';

export interface FlagChipProps {
  flag: FlagStatus;
  /** Sectors under local yellow, listed next to the YELLOW label. */
  yellowSectors: readonly [boolean, boolean, boolean];
}

const LABELS: Record<FlagStatus, string> = {
  GREEN: 'GREEN',
  YELLOW: 'YELLOW',
  VSC: 'VSC',
  SC: 'SC',
  RED: 'RED',
  CHEQUERED: 'FINISH',
};

const SPOKEN: Record<FlagStatus, string> = {
  GREEN: 'green flag',
  YELLOW: 'yellow flag',
  VSC: 'virtual safety car',
  SC: 'safety car',
  RED: 'red flag',
  CHEQUERED: 'chequered flag',
};

/** A calm outlined chip under green; every other state fills the chip with its flag colour. */
const STYLES: Record<FlagStatus, string> = {
  GREEN: 'border-carbon-600 bg-carbon-800 text-ink-300',
  YELLOW: 'border-flag-yellow bg-flag-yellow text-carbon-950',
  VSC: 'border-flag-sc bg-flag-sc text-carbon-950',
  SC: 'border-flag-sc bg-flag-sc text-carbon-950',
  RED: 'border-flag-red bg-flag-red text-white',
  CHEQUERED: 'border-ink-100 bg-ink-100 text-carbon-950',
};

/** Compact track-status chip for a panel header. Blinks three times whenever the status changes. */
export function FlagChip({ flag, yellowSectors }: FlagChipProps) {
  const sectors = yellowSectors
    .map((yellow, i) => (yellow ? `S${i + 1}` : ''))
    .filter((s) => s !== '')
    .join('·');
  const label = flag === 'YELLOW' && sectors !== '' ? `${LABELS.YELLOW} ${sectors}` : LABELS[flag];

  // Count the changes since mount: the chip must not blink for the status it was first shown with.
  const [seen, setSeen] = useState({ label, changes: 0 });
  if (seen.label !== label) setSeen({ label, changes: seen.changes + 1 });
  const blink = seen.changes > 0;

  return (
    <span role="status" aria-label={`Track status: ${SPOKEN[flag]}${flag === 'YELLOW' && sectors !== '' ? ` in ${sectors.replaceAll('·', ', ')}` : ''}`}>
      <span
        key={seen.changes}
        className={`inline-flex h-[18px] items-center gap-1 rounded-[2px] border px-1.5 font-display text-2xs font-semibold leading-none tracking-[0.12em] ${STYLES[flag]} ${blink ? 'pw-blink' : ''}`}
        style={blink ? { animationIterationCount: 3 } : undefined}
      >
        {flag === 'CHEQUERED' ? (
          <ChequeredFlagGlyph size={10} />
        ) : (
          <Flag size={10} strokeWidth={2} fill="currentColor" className={flag === 'GREEN' ? 'text-flag-green' : ''} aria-hidden="true" />
        )}
        <span className="whitespace-nowrap">{label}</span>
      </span>
    </span>
  );
}
