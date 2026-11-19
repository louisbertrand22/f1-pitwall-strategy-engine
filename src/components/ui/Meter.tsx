export type MeterTone = 'neutral' | 'ok' | 'warn' | 'serious' | 'crit';

const TONE_COLORS: Record<MeterTone, string> = {
  neutral: 'var(--color-ink-300)',
  ok: 'var(--color-ok)',
  warn: 'var(--color-warn)',
  serious: 'var(--color-serious)',
  crit: 'var(--color-crit)',
};

export interface MeterProps {
  /** Fill level in [0, 1]. */
  value: number;
  tone?: MeterTone;
  /** Explicit fill colour (overrides `tone`), e.g. a tyre compound colour. */
  color?: string;
  /** Threshold ticks in [0, 1]. */
  markers?: readonly number[];
  /** Bar thickness in pixels. */
  height?: number;
  ariaLabel: string;
  className?: string;
}

/** Thin horizontal gauge. The empty track is a faint wash of the fill colour so state reads across the whole bar. */
export function Meter({ value, tone = 'neutral', color, markers, height = 4, ariaLabel, className = '' }: MeterProps) {
  const level = Math.min(1, Math.max(0, value));
  const fill = color ?? TONE_COLORS[tone];
  return (
    <div
      role="meter"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level * 100)}
      className={`relative w-full overflow-hidden rounded-full ${className}`}
      style={{ height, backgroundColor: `color-mix(in srgb, ${fill} 16%, var(--color-carbon-800))` }}
    >
      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${level * 100}%`, backgroundColor: fill }} />
      {markers?.map((m) => (
        <span
          key={m}
          className="absolute inset-y-0 w-px bg-carbon-950"
          style={{ left: `${Math.min(1, Math.max(0, m)) * 100}%` }}
        />
      ))}
    </div>
  );
}
