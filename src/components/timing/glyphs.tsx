/**
 * Tiny inline glyphs of the timing screens. They are drawn as SVG rather than typed as ▲ / ▼ characters
 * because those code points are outside the subsets of the bundled fonts and would fall back to whatever
 * the operating system provides.
 */

export interface TriangleGlyphProps {
  direction: 'up' | 'down';
  /** Edge length in pixels. */
  size?: number;
  className?: string;
}

/** Solid ▲ / ▼ in the current text colour. */
export function TriangleGlyph({ direction, size = 6, className = '' }: TriangleGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 6 6" aria-hidden="true" className={`shrink-0 ${className}`}>
      <path d={direction === 'up' ? 'M3 0.6 L5.8 5.4 H0.2 Z' : 'M3 5.4 L5.8 0.6 H0.2 Z'} fill="currentColor" />
    </svg>
  );
}

export interface ChequeredFlagGlyphProps {
  size?: number;
  className?: string;
  title?: string;
}

/** Chequered flag on its pole, in the current text colour. */
export function ChequeredFlagGlyph({ size = 11, className = '', title }: ChequeredFlagGlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 11 11"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      shapeRendering="crispEdges"
      className={`shrink-0 ${className}`}
    >
      {title ? <title>{title}</title> : null}
      <rect x="0" y="0" width="1" height="11" fill="currentColor" />
      <rect x="1.5" y="0.5" width="9" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
      <rect x="2" y="1" width="3" height="2.5" fill="currentColor" />
      <rect x="7.5" y="1" width="2.5" height="2.5" fill="currentColor" />
      <rect x="5" y="3.5" width="2.5" height="2.5" fill="currentColor" />
    </svg>
  );
}
