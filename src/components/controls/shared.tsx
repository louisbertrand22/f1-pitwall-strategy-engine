/**
 * Small building blocks shared by the three interactive pit-wall components (controls, radio console,
 * strategy planner): status tones, tags, toggle buttons and a few DOM hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { CircleCheck, Info, OctagonAlert, TriangleAlert } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────── tones ──

export type Tone = 'neutral' | 'ok' | 'warn' | 'serious' | 'crit';

export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink-500',
  ok: 'text-ok',
  warn: 'text-warn',
  serious: 'text-serious',
  crit: 'text-crit',
};

const TONE_FRAME: Record<Tone, string> = {
  neutral: 'border-carbon-600 bg-carbon-800',
  ok: 'border-ok/45 bg-ok/10',
  warn: 'border-warn/50 bg-warn/10',
  serious: 'border-serious/50 bg-serious/10',
  crit: 'border-crit/55 bg-crit/10',
};

/** Tyre wear: ok < 0.70 ≤ warn < 0.95 ≤ serious < 1.05 ≤ crit (1.0 is the cliff). */
export function wearTone(wear: number): Tone {
  if (wear < 0.7) return 'ok';
  if (wear < 0.95) return 'warn';
  if (wear < 1.05) return 'serious';
  return 'crit';
}

/** Temperature against a warning and a critical limit. */
export function limitTone(value: number, warnAt: number, critAt: number): Tone {
  if (value >= critAt) return 'crit';
  if (value >= warnAt) return 'warn';
  return 'ok';
}

/** Status glyph: the shape changes with the tone, so the state never relies on colour alone. */
export function ToneIcon({ tone, size = 11, className = '' }: { tone: Tone; size?: number; className?: string }) {
  const Icon = tone === 'ok' ? CircleCheck : tone === 'crit' ? OctagonAlert : tone === 'neutral' ? Info : TriangleAlert;
  return <Icon size={size} strokeWidth={1.75} aria-hidden className={`shrink-0 ${TONE_TEXT[tone]} ${className}`} />;
}

// ──────────────────────────────────────────────────────────────────── tags ──

const TAG_BASE =
  'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[2px] border px-1 font-display text-[10px] font-semibold uppercase leading-[14px] tracking-[0.08em]';

/** Neutral micro tag (speaker, category, car status…). */
export function Tag({ children, className = '', title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`${TAG_BASE} border-carbon-600 bg-carbon-800 text-ink-300 ${className}`}>
      {children}
    </span>
  );
}

/** Status tag: tinted frame + status glyph + word. */
export function StatusTag({
  tone,
  children,
  icon,
  className = '',
  title,
}: {
  tone: Tone;
  children: ReactNode;
  /** Replaces the default status glyph (still coloured by the tone). */
  icon?: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span title={title} className={`${TAG_BASE} ${TONE_FRAME[tone]} text-ink-50 ${className}`}>
      {icon ? <span className={`flex items-center ${TONE_TEXT[tone]}`}>{icon}</span> : <ToneIcon tone={tone} size={10} />}
      {children}
    </span>
  );
}

/** Frameless status readout: glyph + coloured word, for tight rows. */
export function StatusWord({ tone, children, icon }: { tone: Tone; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-display text-[10px] font-semibold uppercase leading-3 tracking-[0.08em]">
      {icon ? <span className={`flex items-center ${TONE_TEXT[tone]}`}>{icon}</span> : <ToneIcon tone={tone} size={10} />}
      <span className={tone === 'neutral' ? 'text-ink-500' : TONE_TEXT[tone]}>{children}</span>
    </span>
  );
}

// ───────────────────────────────────────────────────────────────── buttons ──

export interface ToggleButtonProps {
  pressed: boolean;
  onToggle: (next: boolean) => void;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
  className?: string;
}

/** Two-state order (DEFEND, AUTO-BOX): a pressed button that also spells its state out. */
export function ToggleButton({ pressed, onToggle, label, icon, disabled, title, className = '' }: ToggleButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      data-active={pressed}
      disabled={disabled}
      title={title}
      onClick={() => onToggle(!pressed)}
      className={`pw-btn ${className}`}
    >
      {icon}
      <span className="whitespace-nowrap">{label}</span>
      <span className="font-mono text-3xs font-bold leading-none opacity-70">{pressed ? 'ON' : 'OFF'}</span>
    </button>
  );
}

// ────────────────────────────────────────────────────────────── formatters ──

/** 0.22 → "+22%", −0.07 → "−7%" (typographic minus, like `formatDelta`). */
export function formatSignedPercent(fraction: number, digits = 0): string {
  const value = fraction * 100;
  const rounded = Number(value.toFixed(digits));
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '±';
  return `${sign}${Math.abs(rounded).toFixed(digits)}%`;
}

/** Race duration with tenths: 4662.34 → "1:17:42.3". */
export function formatRaceTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const s = Math.floor((tenths % 600) / 10);
  const t = tenths % 10;
  return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}.${t}`;
}

// ─────────────────────────────────────────────────────────────────── hooks ──

/** Ref that always holds the latest value, for stable callbacks handed to memoised rows. */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

export interface ElementSize {
  width: number;
  height: number;
}

/** Content-box size of an element, tracked with a ResizeObserver. Attach the returned ref callback. */
export function useElementSize<T extends HTMLElement>(): [(node: T | null) => void, ElementSize] {
  const [node, setNode] = useState<T | null>(null);
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    if (!node) return undefined;
    const measure = () => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return [setNode, size];
}

export interface StickToBottom {
  /** Attach to the scrolling viewport. */
  viewportRef: RefObject<HTMLDivElement | null>;
  /** Attach to the single child that holds the rows. */
  contentRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  /** True once the user has scrolled away from the newest entry. */
  detached: boolean;
  jumpToLatest: () => void;
}

/**
 * Log behaviour: the viewport follows the newest entry until the user scrolls up, and re-attaches when
 * he scrolls back down (or jumps). Any change of content or viewport height is caught by a
 * ResizeObserver, so rows that grow after being rendered keep the view pinned too.
 */
export function useStickToBottom(): StickToBottom {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(true);
  const [detached, setDetached] = useState(false);

  const onScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 6;
    stuck.current = atBottom;
    setDetached(!atBottom);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuck.current = true;
    setDetached(false);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return undefined;
    const follow = () => {
      if (stuck.current) viewport.scrollTop = viewport.scrollHeight;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return { viewportRef, contentRef, onScroll, detached, jumpToLatest };
}
