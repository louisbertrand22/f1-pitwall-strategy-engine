/** Formatting helpers shared by every cockpit component. All inputs are seconds unless stated. */

const DASH = '—';

/** 87.345 → "1:27.345" */
export function formatLapTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH;
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(3)}`;
}

/** 28.345 → "28.345" (sector time) */
export function formatSector(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH;
  return seconds.toFixed(3);
}

/** Gap or interval: 1.234 → "+1.234", 62.4 → "+1:02.4", laps → "+1 LAP". */
export function formatGap(seconds: number | null | undefined, laps = 0): string {
  if (laps > 0) return `+${laps} LAP${laps > 1 ? 'S' : ''}`;
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH;
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds - minutes * 60;
    return `+${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
  }
  return `+${seconds.toFixed(3)}`;
}

/** Signed delta: 0.35 → "+0.35", −0.2 → "−0.20". */
export function formatDelta(seconds: number | null | undefined, digits = 2): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH;
  const sign = seconds > 0 ? '+' : seconds < 0 ? '−' : '±';
  return `${sign}${Math.abs(seconds).toFixed(digits)}`;
}

/** Short duration in seconds: 2.34 → "2.3 s". */
export function formatSeconds(seconds: number | null | undefined, digits = 1): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH;
  return `${seconds.toFixed(digits)} s`;
}

/** Race clock: 3725 → "1:02:05". */
export function formatRaceClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = m < 10 ? `0${m}` : `${m}`;
  const ss = s < 10 ? `0${s}` : `${s}`;
  return `${h}:${mm}:${ss}`;
}

/** 0.4567 → "46%" */
export function formatPercent(fraction: number | null | undefined, digits = 0): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return DASH;
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatTemp(celsius: number | null | undefined): string {
  if (celsius === null || celsius === undefined || !Number.isFinite(celsius)) return DASH;
  return `${Math.round(celsius)}°C`;
}

/** 1 → "P1" */
export function formatPosition(position: number | null | undefined): string {
  if (position === null || position === undefined) return DASH;
  return `P${position}`;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
