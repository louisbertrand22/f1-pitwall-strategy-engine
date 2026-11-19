import type { ReactNode } from 'react';

export interface PanelProps {
  title: string;
  /** Small icon rendered before the title (lucide icon at 14px). */
  icon?: ReactNode;
  /** Secondary text after the title. */
  subtitle?: ReactNode;
  /** Controls aligned to the right of the header. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/** Standard cockpit panel: hairline frame, compact header strip, body. */
export function Panel({ title, icon, subtitle, actions, children, className = '', bodyClassName = '' }: PanelProps) {
  return (
    <section className={`pw-panel flex min-h-0 min-w-0 flex-col overflow-hidden ${className}`}>
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-carbon-700 bg-carbon-850 px-2">
        {icon ? <span className="flex shrink-0 items-center text-ink-500">{icon}</span> : null}
        <h2 className="pw-title shrink-0 whitespace-nowrap">{title}</h2>
        {subtitle ? (
          <span className="min-w-0 truncate font-mono text-2xs text-ink-500">{subtitle}</span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>
      </header>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}
