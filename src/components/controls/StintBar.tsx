import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { Lock, Trash2, X } from 'lucide-react';
import type { PlanId, StintPlan, TyreCompound, TyreSet } from '../../simulation/types';
import { TYRE_COLORS, TYRE_LABELS, TYRE_LETTERS, TYRE_ORDER, tyreInkOn } from '../../lib/tyres';
import { TyreBadge } from '../ui';
import {
  boundaryRange,
  canEditCompound,
  canRemoveStint,
  moveBoundary,
  removeStint,
  sameStints,
  setStintCompound,
  setsLeftForStint,
  stintEndLap,
  stintStartLap,
} from './planModel';
import type { PlanLock } from './planModel';

export interface StintBarProps {
  planId: PlanId;
  stints: readonly StintPlan[];
  raceLaps: number;
  lock: PlanLock;
  /** Tyre allocation of the car, to know which compounds still have a set. */
  sets: readonly TyreSet[];
  /** Rendered width of the bar in px (0 until measured): decides which labels fit. */
  width: number;
  height: number;
  /** Open the compound popover above the bar (last row of a table). */
  popoverAbove?: boolean;
  /** Nothing can be edited (car out of the race). */
  frozen?: boolean;
  /** Live preview while a stop is being dragged; null cancels the preview. */
  onDraft: (stints: StintPlan[] | null) => void;
  onCommit: (stints: StintPlan[]) => void;
}

interface DragState {
  index: number;
  pointerId: number;
  base: StintPlan[];
  last: StintPlan[];
}

/** Segment widths (px) from which each inline element fits without being clipped. */
const FIT = { letter: 14, laps: 38, remove: 64 } as const;

/**
 * One plan as a tall segmented bar over the lap axis: a block per stint in its compound colour, a 2 px
 * surface gap at every stop. Stops are dragged (pointer capture, whole laps) or moved with the arrow
 * keys; a click on a block opens the compound picker.
 */
export function StintBar({
  planId,
  stints,
  raceLaps,
  lock,
  sets,
  width,
  height,
  popoverAbove = false,
  frozen = false,
  onDraft,
  onCommit,
}: StintBarProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const open = openIndex !== null && openIndex < stints.length ? openIndex : null;

  // The popover closes on a click elsewhere or Escape.
  useEffect(() => {
    if (open === null) return undefined;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && popoverRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-stint-segment]') && barRef.current?.contains(target)) return;
      setOpenIndex(null);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpenIndex(null);
      barRef.current?.querySelector<HTMLElement>(`[data-stint-segment="${open}"]`)?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open !== null) popoverRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, [open]);

  const percent = (lap: number) => (raceLaps > 0 ? (lap / raceLaps) * 100 : 0);

  // ── dragging a stop ──────────────────────────────────────────────────────
  const onHandleDown = (event: PointerEvent<HTMLDivElement>, index: number) => {
    if (event.button !== 0 || frozen) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const base = stints.map((s) => ({ ...s }));
    drag.current = { index, pointerId: event.pointerId, base, last: base };
    setDragging(index);
    setOpenIndex(null);
  };

  const onHandleMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    const rect = barRef.current?.getBoundingClientRect();
    if (!state || state.pointerId !== event.pointerId || !rect || rect.width <= 0) return;
    const lap = ((event.clientX - rect.left) / rect.width) * raceLaps;
    const next = moveBoundary(state.base, state.index, lap, raceLaps, lock);
    if (sameStints(next, state.last)) return;
    state.last = next;
    onDraft(next);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (commit && !sameStints(state.last, state.base)) onCommit(state.last);
    else onDraft(null);
  };

  const onHandleKey = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const stint = stints[index];
    if (!stint || frozen) return;
    const range = boundaryRange(stints, index, raceLaps, lock);
    let target: number;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') target = stint.endLap - 1;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') target = stint.endLap + 1;
    else if (event.key === 'PageDown') target = stint.endLap - 5;
    else if (event.key === 'PageUp') target = stint.endLap + 5;
    else if (event.key === 'Home') target = range.min;
    else if (event.key === 'End') target = range.max;
    else return;
    event.preventDefault();
    const next = moveBoundary(stints, index, target, raceLaps, lock);
    if (!sameStints(next, stints)) onCommit(next);
  };

  const pickCompound = (index: number, compound: TyreCompound) => {
    setOpenIndex(null);
    if (stints[index]?.compound !== compound) onCommit(setStintCompound(stints, index, compound));
  };

  const remove = (index: number) => {
    setOpenIndex(null);
    onCommit(removeStint(stints, index, raceLaps, lock));
  };

  const openStart = open !== null ? stintStartLap(stints, open) : 1;
  const openEnd = open !== null ? stintEndLap(stints, open, raceLaps) : 1;
  const openLeft = open !== null ? setsLeftForStint(sets, stints, open, lock) : null;
  const openOnRight = (openStart - 1 + openEnd) / 2 > raceLaps / 2;

  const donePercent = lock.live ? percent(Math.max(0, lock.nowLap - 1)) : 0;

  return (
    <div ref={barRef} className="relative w-full" style={{ height }}>
      {lock.live ? (
        <>
          {/* what has been run is dimmed; the marker sits at the start of the lap the car is on */}
          <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 z-[15] bg-carbon-900/55" style={{ width: `${donePercent}%` }} />
          <span
            aria-hidden
            className="pointer-events-none absolute -bottom-[3px] -top-[3px] z-[25] w-[2px] -translate-x-1/2 bg-ink-50 shadow-[0_0_0_1px_var(--color-carbon-950)]"
            style={{ left: `${donePercent}%` }}
          />
        </>
      ) : null}
      {stints.map((stint, index) => {
        const start = stintStartLap(stints, index);
        const end = stintEndLap(stints, index, raceLaps);
        const laps = end - start + 1;
        if (laps <= 0) return null;
        const px = (width * laps) / Math.max(1, raceLaps) - 2;
        const editable = !frozen && canEditCompound(index, lock);
        const removable = !frozen && canRemoveStint(stints, index, lock);
        const history = lock.live && index <= lock.currentStint;
        const ink = tyreInkOn(stint.compound);
        return (
          <div key={`${index}-${stint.compound}`} className="absolute inset-y-0 z-10 px-px" style={{ left: `${percent(start - 1)}%`, width: `${percent(laps)}%` }}>
            <button
              type="button"
              data-stint-segment={index}
              disabled={!editable}
              aria-haspopup="dialog"
              aria-expanded={open === index}
              aria-label={`Plan ${planId} stint ${index + 1}: ${TYRE_LABELS[stint.compound]}, laps ${start} to ${end} (${laps} laps)${editable ? '. Choose compound' : ', locked'}`}
              title={`Stint ${index + 1} · ${TYRE_LABELS[stint.compound]} · L${start}–L${end} · ${laps} laps${history ? (index === lock.currentStint ? ' · on the car' : ' · completed') : ''}`}
              onClick={() => setOpenIndex(open === index ? null : index)}
              className="flex h-full w-full items-center gap-1 rounded-[2px] pl-1 text-left transition-[filter] enabled:hover:brightness-110 disabled:cursor-default focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-carbon-950"
              style={{ backgroundColor: TYRE_COLORS[stint.compound], color: ink }}
            >
              {px >= FIT.letter ? <span className="font-display text-[13px] font-bold leading-none">{TYRE_LETTERS[stint.compound]}</span> : null}
              {px >= FIT.laps ? <span className="font-mono text-2xs font-bold leading-none tabular">{laps}</span> : null}
              {history && px >= FIT.remove ? <Lock size={10} strokeWidth={2} aria-hidden className="ml-auto mr-1.5 opacity-70" /> : null}
            </button>
            {removable && px >= FIT.remove ? (
              <button
                type="button"
                aria-label={`Remove stint ${index + 1} of plan ${planId}`}
                title="Remove this stint and the stop before it"
                onClick={() => remove(index)}
                className="absolute right-[5px] top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-[2px] opacity-55 transition-opacity hover:bg-black/20 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-carbon-950"
                style={{ color: ink }}
              >
                <X size={11} strokeWidth={2.25} aria-hidden />
              </button>
            ) : null}
          </div>
        );
      })}

      {stints.map((stint, index) => {
        if (index >= stints.length - 1 || frozen) return null;
        const range = boundaryRange(stints, index, raceLaps, lock);
        if (range.locked) return null;
        const active = dragging === index;
        return (
          <div
            key={`handle-${index}`}
            role="slider"
            tabIndex={0}
            aria-orientation="horizontal"
            aria-label={`Plan ${planId} stop ${index + 1}: in-lap`}
            aria-valuemin={range.min}
            aria-valuemax={range.max}
            aria-valuenow={stint.endLap}
            aria-valuetext={`Lap ${stint.endLap}`}
            title={`Stop ${index + 1} at the end of lap ${stint.endLap} — drag, or use the arrow keys`}
            onPointerDown={(event) => onHandleDown(event, index)}
            onPointerMove={onHandleMove}
            onPointerUp={(event) => endDrag(event, true)}
            onPointerCancel={(event) => endDrag(event, false)}
            onLostPointerCapture={(event) => endDrag(event, false)}
            onKeyDown={(event) => onHandleKey(event, index)}
            className="group absolute -bottom-[3px] -top-[3px] z-20 w-3 -translate-x-1/2 cursor-col-resize touch-none select-none outline-none"
            style={{ left: `${percent(stint.endLap)}%` }}
          >
            <span
              className={`absolute inset-y-0 left-1/2 w-[4px] -translate-x-1/2 rounded-[2px] border transition-colors group-hover:border-ink-50 group-hover:bg-carbon-700 group-focus-visible:border-ink-50 group-focus-visible:bg-carbon-700 ${
                active ? 'border-ink-50 bg-carbon-700' : 'border-ink-300 bg-carbon-950'
              }`}
            />
            <span
              className={`pointer-events-none absolute -top-[15px] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-[2px] bg-ink-100 px-1 font-mono text-3xs font-bold leading-[13px] text-carbon-950 group-hover:block group-focus-visible:block ${
                active ? 'block' : 'hidden'
              }`}
            >
              L{stint.endLap}
            </span>
          </div>
        );
      })}

      {open !== null && openLeft ? (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={`Compound for stint ${open + 1} of plan ${planId}`}
          className={`absolute z-40 rounded-[3px] border border-carbon-500 bg-carbon-950 p-1.5 ${popoverAbove ? 'bottom-full mb-1.5' : 'top-full mt-1.5'}`}
          style={openOnRight ? { right: `${100 - percent(openEnd)}%` } : { left: `${percent(openStart - 1)}%` }}
        >
          <p className="pw-label mb-1 whitespace-nowrap text-ink-300">
            Stint {open + 1} · L{openStart}–L{openEnd} · {openEnd - openStart + 1} laps
          </p>
          <div className="flex items-stretch gap-1">
            {TYRE_ORDER.map((compound) => {
              const current = stints[open]?.compound === compound;
              const left = openLeft[compound];
              return (
                <button
                  key={compound}
                  type="button"
                  aria-pressed={current}
                  disabled={left <= 0 && !current}
                  title={left > 0 ? `${TYRE_LABELS[compound]} · ${left} set${left === 1 ? '' : 's'} free` : `${TYRE_LABELS[compound]} · no set left`}
                  onClick={() => pickCompound(open, compound)}
                  className={`flex w-8 flex-col items-center gap-0.5 rounded-[2px] border py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                    current ? 'border-ink-100 bg-carbon-750' : 'border-carbon-700 bg-carbon-850 enabled:hover:border-carbon-500'
                  }`}
                >
                  <TyreBadge compound={compound} size={18} />
                  <span className="font-mono text-3xs leading-none tabular text-ink-300">×{Math.max(0, left)}</span>
                </button>
              );
            })}
            {canRemoveStint(stints, open, lock) ? (
              <button
                type="button"
                aria-label={`Remove stint ${open + 1}`}
                title="Remove this stint and the stop before it"
                onClick={() => remove(open)}
                className="pw-btn ml-1 w-8 flex-col gap-1 px-0 py-1"
              >
                <Trash2 size={12} strokeWidth={1.75} aria-hidden />
                <span className="text-3xs tracking-normal">Del</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
