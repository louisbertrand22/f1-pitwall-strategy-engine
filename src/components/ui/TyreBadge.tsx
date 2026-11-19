import type { TyreCompound } from '../../simulation/types';
import { TYRE_COLORS, TYRE_LABELS, TYRE_LETTERS } from '../../lib/tyres';

export interface TyreBadgeProps {
  compound: TyreCompound;
  /** Outer diameter in pixels. */
  size?: number;
  /** Used ("scrubbed") set: drawn with a broken sidewall ring. */
  used?: boolean;
  /** Dim the badge (unavailable / worn-out set). */
  dimmed?: boolean;
  className?: string;
  title?: string;
}

/** Pirelli-style tyre marker: coloured sidewall ring with the compound letter. */
export function TyreBadge({ compound, size = 18, used = false, dimmed = false, className = '', title }: TyreBadgeProps) {
  const color = TYRE_COLORS[compound];
  const stroke = Math.max(2, size * 0.16);
  const r = size / 2 - stroke / 2 - 0.5;
  const circumference = 2 * Math.PI * r;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={title ?? `${TYRE_LABELS[compound]}${used ? ' (used)' : ''}`}
      className={`shrink-0 ${dimmed ? 'opacity-40' : ''} ${className}`}
    >
      <title>{title ?? `${TYRE_LABELS[compound]}${used ? ' (used)' : ''}`}</title>
      <circle cx={size / 2} cy={size / 2} r={size / 2 - 0.5} fill="#07090d" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={used ? `${circumference * 0.19} ${circumference * 0.06}` : undefined}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x={size / 2}
        y={size / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fill={color}
        fontFamily="'Barlow Condensed', sans-serif"
        fontWeight={700}
        fontSize={size * 0.56}
      >
        {TYRE_LETTERS[compound]}
      </text>
    </svg>
  );
}
