/**
 * Vertical de-collision of direct labels.
 *
 * Every label stays as close as possible to its anchor (least squares) while neighbours keep at least
 * `minGap` between them and everything stays inside [min, max]. Displaced labels are meant to be tied
 * back to their mark with a leader line. Returns the positions in input order.
 */
export function spreadLabels(anchors: readonly number[], minGap: number, min: number, max: number): number[] {
  const n = anchors.length;
  if (n === 0) return [];
  const order = anchors.map((_, index) => index).sort((a, b) => anchors[a]! - anchors[b]!);
  // When the labels cannot all fit, share the available height instead of overflowing the bounds.
  const gap = n > 1 ? Math.min(minGap, Math.max(0, max - min) / (n - 1)) : minGap;

  // With q_k = p_k − k·gap the spacing constraint becomes "q is non-decreasing": isotonic regression,
  // solved by pooling adjacent violators.
  const blocks: { sum: number; count: number }[] = [];
  order.forEach((index, k) => {
    blocks.push({ sum: anchors[index]! - k * gap, count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!;
      const previous = blocks[blocks.length - 2]!;
      if (previous.sum / previous.count <= last.sum / last.count) break;
      previous.sum += last.sum;
      previous.count += last.count;
      blocks.pop();
    }
  });

  const sorted: number[] = [];
  for (const block of blocks) {
    const mean = block.sum / block.count;
    for (let i = 0; i < block.count; i++) sorted.push(mean + sorted.length * gap);
  }
  for (let k = 0; k < n; k++) sorted[k] = Math.max(sorted[k]!, min + k * gap);
  for (let k = n - 1; k >= 0; k--) sorted[k] = Math.min(sorted[k]!, max - (n - 1 - k) * gap);

  const result = new Array<number>(n).fill(0);
  order.forEach((index, k) => {
    result[index] = sorted[k]!;
  });
  return result;
}
