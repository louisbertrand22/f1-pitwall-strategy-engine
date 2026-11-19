import type { ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Tooltip. */
  title?: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** Stretch the segments to fill the available width. */
  fill?: boolean;
  className?: string;
}

/** Exclusive choice rendered as a row of joined buttons (pace mode, ERS mode, tabs…). */
export function Segmented<T extends string>({ options, value, onChange, ariaLabel, fill = true, className = '' }: SegmentedProps<T>) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`flex ${fill ? 'w-full' : ''} ${className}`}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          data-active={option.value === value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={`pw-btn ${fill ? 'flex-1' : ''} ${index > 0 ? '-ml-px' : ''} rounded-none first:rounded-l-[2px] last:rounded-r-[2px]`}
        >
          {option.icon}
          <span className="whitespace-nowrap">{option.label}</span>
        </button>
      ))}
    </div>
  );
}
