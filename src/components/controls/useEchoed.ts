import { useEffect, useState } from 'react';

/** Wall-clock time the engine gets to echo an edit while newer snapshots keep arriving (ms). */
const ECHO_GRACE_MS = 2000;

interface Pending<T> {
  value: T;
  /** The truth when the first edit was made, plus every value committed since (their echoes may still arrive). */
  expected: T[];
  seq: number;
  at: number;
}

/**
 * Optimistic value for an order that is echoed back in the snapshot. It shows what the user committed
 * until the snapshot catches up, so an edit never flicks back to the stale value while the command is
 * in flight. The override is dropped as soon as the truth
 *  - matches it (echo received),
 *  - moves to something that was never ordered (the engine normalised or replaced the edit), or
 *  - has not moved for the grace period although newer snapshots arrived (the edit was rejected).
 * Returns the value to display and a function recording a freshly committed value.
 */
export function useEchoed<T>(truth: T, seq: number, equals: (a: T, b: T) => boolean): [T, (value: T) => void] {
  const [pending, setPending] = useState<Pending<T> | null>(null);

  useEffect(() => {
    if (!pending) return;
    const echoed = equals(truth, pending.value);
    const foreign = !pending.expected.some((value) => equals(truth, value));
    const rejected = seq > pending.seq && performance.now() - pending.at > ECHO_GRACE_MS;
    if (echoed || foreign || rejected) setPending(null);
  }, [truth, seq, pending, equals]);

  const commit = (value: T) => {
    setPending((prev) => ({
      value,
      expected: prev ? [...prev.expected, prev.value] : [truth],
      seq,
      at: performance.now(),
    }));
  };

  return [pending ? pending.value : truth, commit];
}
