import type { RandomSource } from './types';

/** FNV-1a hash of a string, mixed with a numeric seed → 32-bit unsigned integer. */
function hashSeed(seed: number, label: string): number {
  let h = (2166136261 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // final avalanche (murmur3 fmix32)
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Deterministic pseudo-random generator (sfc32). Every stochastic element of the race – incidents, pit
 * stop times, weather cells, driver noise, Monte-Carlo sampling – draws from a `SeededRandom`, so a race
 * is fully reproducible from its seed and the list of commands it received.
 */
export class SeededRandom implements RandomSource {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private readonly seed: number;
  private spareNormal: number | null = null;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.a = hashSeed(this.seed, 'a');
    this.b = hashSeed(this.seed, 'b');
    this.c = hashSeed(this.seed, 'c');
    this.d = 1;
    for (let i = 0; i < 12; i++) this.next();
  }

  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** Box–Muller transform; caches the second deviate. */
  normal(): number {
    if (this.spareNormal !== null) {
      const v = this.spareNormal;
      this.spareNormal = null;
      return v;
    }
    let u = 0;
    while (u < 1e-12) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    const theta = 2 * Math.PI * v;
    this.spareNormal = r * Math.sin(theta);
    return r * Math.cos(theta);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('SeededRandom.pick: empty list');
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))] as T;
  }

  fork(label: string): SeededRandom {
    return new SeededRandom(hashSeed(this.seed, label));
  }
}

export function createRng(seed: number): SeededRandom {
  return new SeededRandom(seed);
}
