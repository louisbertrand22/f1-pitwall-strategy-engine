export interface DriverTagProps {
  code: string;
  /** Team colour (hex). */
  color: string;
  /** Car number within the team shown as a subscript, e.g. #1 / #2. */
  carNumber?: number;
  /** Emphasise (the user's own cars). */
  strong?: boolean;
  className?: string;
}

/** Timing-screen driver identifier: team colour bar + three-letter code. */
export function DriverTag({ code, color, carNumber, strong = false, className = '' }: DriverTagProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span className="h-3.5 w-[3px] shrink-0 rounded-[1px]" style={{ backgroundColor: color }} />
      <span className={`font-display text-[13px] leading-none tracking-wider ${strong ? 'font-bold text-ink-50' : 'font-semibold text-ink-100'}`}>
        {code}
      </span>
      {carNumber !== undefined ? <span className="font-mono text-3xs text-ink-500">#{carNumber}</span> : null}
    </span>
  );
}
