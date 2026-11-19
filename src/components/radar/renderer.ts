/**
 * Canvas renderer of the track radar. Framework-free: the React component only feeds it frames, the
 * canvas size and the pointer position.
 *
 *  - Static layer (circuit, pit lane, DRS zones, sector ticks, labels): painted once into an offscreen
 *    canvas and blitted every frame; rebuilt on resize, track change, font load, wetness / DRS change.
 *  - Dynamic layer (yellow sectors, incidents, safety car, cars, rejoin ghosts, labels, rain): redrawn
 *    every animation frame from typed arrays that are refreshed whenever a new snapshot arrives, so the
 *    per-frame path allocates nothing.
 */
import { indexSession } from '../../lib/session';
import { TYRE_COLORS } from '../../lib/tyres';
import { getTrackGeometry, pitPointAt, pointAt, speedAt, trackSlice } from '../../simulation/trackGeometry';
import type { TrackGeometry } from '../../simulation/trackGeometry';
import type { CarId, SessionInfo, TrackDefinition } from '../../simulation/types';
import type { LiveFrame } from '../contracts';
import { boxesOverlap, fitViewport, labelReach, wrapSigned } from './layout';
import type { Bounds, Rect, Viewport } from './layout';

/** Canvas cannot read the Tailwind tokens: these mirror `src/index.css`. */
const C = {
  panel: '#0c1016',
  ring: '#07090d',
  asphalt: '#232e3b',
  edge: '#3f4f62',
  centre: '#62748a',
  ink50: '#f7f9fb',
  ink100: '#eef2f6',
  ink300: '#a7b4c2',
  ink500: '#6d7b8b',
  ink600: '#465261',
  green: '#35d96f',
  yellow: '#ffd60a',
  safetyCar: '#ffab1a',
  rain: '#9dc0ff',
  plate: 'rgba(7, 9, 13, 0.88)',
  halo: 'rgba(7, 9, 13, 0.9)',
} as const;

const TAU = Math.PI * 2;
const LABEL_FONT = '600 10px "Barlow Condensed", "Barlow Semi Condensed", sans-serif';
const CAR_FONT = '600 11px "Barlow Condensed", "Barlow Semi Condensed", sans-serif';
const PLAYER_FONT = '700 12px "Barlow Condensed", "Barlow Semi Condensed", sans-serif';
const DIGIT_FONT = '700 9px "JetBrains Mono", ui-monospace, monospace';

const CAR_RADIUS = 4.25;
const PLAYER_RADIUS = 6.25;
const GHOST_RADIUS = 7.5;
const GHOST_LEADER = 13;
const PICK_RADIUS = 12;
/** Extrapolation between two snapshots is capped (s) so a stalled worker cannot fling the cars away. */
const MAX_EXTRAPOLATION = 0.25;
const WET_STEPS = 20;
const MAX_INCIDENTS = 8;
const RAIN_STREAKS = 110;

const FLAG_DRS = 1;
const FLAG_GRID = 2;
const FLAG_ODD = 4;
const FLAG_DIM = 8;

function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const channel = (shift: number): number => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

/** True when dark ink reads better than light ink on top of the colour. */
function isLightColor(hex: string): boolean {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return false;
  const p = parseInt(hex.slice(1), 16);
  return 0.299 * ((p >> 16) & 255) + 0.587 * ((p >> 8) & 255) + 0.114 * (p & 255) > 150;
}

// ───────────────────────────────────────────────────────────── track model ──

interface TrackModel {
  geometry: TrackGeometry;
  lengthMetres: number;
  /** Per sample: +1 where the right-hand side of travel faces away from the circuit, −1 where the left does. */
  outward: Int8Array;
  /** Side of the pit lane as a multiplier of the right-hand normal. */
  pitSide: 1 | -1;
  /** Bounds of the centreline and the pit lane (track units). */
  bounds: Bounds;
}

interface Sample {
  x: number;
  y: number;
  tx: number;
  ty: number;
  /** Multiplier of the right-hand normal (−ty, tx) that points away from the circuit. */
  out: number;
}

const models = new WeakMap<TrackGeometry, TrackModel>();

/** Even-odd point-in-polygon test against the centreline (every `stride`-th sample). */
function insideCircuit(xs: Float32Array, ys: Float32Array, n: number, stride: number, px: number, py: number): boolean {
  let inside = false;
  const last = Math.floor((n - 1) / stride) * stride;
  let jx = xs[last]!;
  let jy = ys[last]!;
  for (let i = 0; i < n; i += stride) {
    const ix = xs[i]!;
    const iy = ys[i]!;
    if (iy > py !== jy > py && px < ((jx - ix) * (py - iy)) / (jy - iy) + ix) inside = !inside;
    jx = ix;
    jy = iy;
  }
  return inside;
}

function modelFor(track: TrackDefinition): TrackModel {
  const geometry = getTrackGeometry(track);
  const cached = models.get(geometry);
  if (cached) return cached;

  const n = geometry.sampleCount;
  const { xs, ys, tx, ty, bounds: b } = geometry;
  // Which side is "outside" is decided locally (a probe just off the track, inside or outside the
  // loop?) rather than from the winding direction, so it stays right on both lobes of a figure of eight.
  const probe = 0.012 * Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const raw = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    raw[i] = insideCircuit(xs, ys, n, 2, xs[i]! - ty[i]! * probe, ys[i]! + tx[i]! * probe) ? -1 : 1;
  }
  // Majority vote over a short window: removes flips where two parts of the circuit run side by side.
  const outward = new Int8Array(n + 1);
  const window = Math.max(2, Math.round(n / 150));
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -window; k <= window; k++) sum += raw[(i + k + n) % n]!;
    outward[i] = sum >= 0 ? 1 : -1;
  }
  outward[n] = outward[0]!;

  let { minX, minY, maxX, maxY } = b;
  const lane = geometry.pitLane;
  for (let i = 0; i < lane.count; i++) {
    minX = Math.min(minX, lane.xs[i]!);
    maxX = Math.max(maxX, lane.xs[i]!);
    minY = Math.min(minY, lane.ys[i]!);
    maxY = Math.max(maxY, lane.ys[i]!);
  }
  const model: TrackModel = {
    geometry,
    lengthMetres: track.lengthKm * 1000,
    outward,
    pitSide: track.pitSide === 'RIGHT' ? 1 : -1,
    bounds: { minX, minY, maxX, maxY },
  };
  models.set(geometry, model);
  return model;
}

/** Allocation-free equivalent of `pointAt` for the frame loop (same interpolation, tangent included). */
function sampleTrack(model: TrackModel, fraction: number, out: Sample): void {
  const g = model.geometry;
  const n = g.sampleCount;
  const idx = (fraction - Math.floor(fraction)) * n;
  const base = Math.floor(idx);
  const i = base % n;
  const t = idx - base;
  out.x = g.xs[i]! + (g.xs[i + 1]! - g.xs[i]!) * t;
  out.y = g.ys[i]! + (g.ys[i + 1]! - g.ys[i]!) * t;
  out.tx = g.tx[i]! + (g.tx[i + 1]! - g.tx[i]!) * t;
  out.ty = g.ty[i]! + (g.ty[i + 1]! - g.ty[i]!) * t;
  out.out = model.outward[i]!;
}

/** Allocation-free equivalent of `pitPointAt`. "Outward" in the pit lane means away from the track. */
function samplePit(model: TrackModel, progress: number, out: Sample): void {
  const lane = model.geometry.pitLane;
  const p = Math.min(1, Math.max(0, progress)) * (lane.count - 1);
  const i = Math.min(lane.count - 2, Math.floor(p));
  const t = p - i;
  const dx = lane.xs[i + 1]! - lane.xs[i]!;
  const dy = lane.ys[i + 1]! - lane.ys[i]!;
  const length = Math.hypot(dx, dy) || 1;
  out.x = lane.xs[i]! + dx * t;
  out.y = lane.ys[i]! + dy * t;
  out.tx = dx / length;
  out.ty = dy / length;
  out.out = model.pitSide;
}

// ──────────────────────────────────────────────────────────────── renderer ──

export interface RadarPoint {
  x: number;
  y: number;
}

export class RadarRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly layer: HTMLCanvasElement;
  private readonly layerCtx: CanvasRenderingContext2D | null;

  private width = 0;
  private height = 0;
  private dpr = 1;
  private obstacles: Rect[] = [];
  private reducedMotion = false;

  private session: SessionInfo | null = null;
  private track: TrackDefinition | null = null;
  private model: TrackModel | null = null;
  private view: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };
  private trackWidth = 11;
  private layoutDirty = true;
  private staticDirty = true;
  private wetStep = 0;
  private drsEnabled = true;

  // screen-space geometry, rebuilt with the layout
  private screenX = new Float32Array(0);
  private screenY = new Float32Array(0);
  private pitScreenX = new Float32Array(0);
  private pitScreenY = new Float32Array(0);
  private trackPath: Path2D | null = null;
  private sectorPaths: Path2D[] = [];
  /** Boxes taken by static labels: [cx, cy, halfW, halfH] each. */
  private readonly staticBoxes = new Float32Array(4 * 64);
  private staticBoxCount = 0;

  // per car, indexed by its slot in `session.drivers`
  private readonly slotOf = new Map<CarId, number>();
  private ids: CarId[] = [];
  private codes: string[] = [];
  private colors: string[] = [];
  private digits: string[] = [];
  private digitInk: string[] = [];
  private isPlayer = new Uint8Array(0);
  private labelWidth = new Float32Array(0);
  private fraction = new Float32Array(0);
  private velocity = new Float32Array(0);
  private pitProgress = new Float32Array(0);
  private sortKey = new Float32Array(0);
  private flags = new Uint8Array(0);
  /** 1 for every car drawn in the current snapshot (retired cars are not). */
  private visible = new Uint8Array(0);
  private order = new Uint8Array(0);
  private orderCount = 0;
  private carX = new Float32Array(0);
  private carY = new Float32Array(0);
  private carNX = new Float32Array(0);
  private carNY = new Float32Array(0);
  private carTX = new Float32Array(0);
  private carTY = new Float32Array(0);
  private labelSide = new Int8Array(0);
  private labelX = new Float32Array(0);
  private labelY = new Float32Array(0);

  // rejoin ghosts of the two player cars
  private readonly ghostOn = new Uint8Array(2);
  private readonly ghostSlot = new Uint8Array(2);
  private readonly ghostFraction = new Float32Array(2);
  private readonly ghostVelocity = new Float32Array(2);
  private readonly ghostPosition = new Int16Array(2);
  private readonly ghostLabel: [string, string] = ['', ''];
  private readonly ghostLabelWidth = new Float32Array(2);
  private readonly ghostSide = new Int8Array(2);
  private readonly ghostX = new Float32Array(2);
  private readonly ghostY = new Float32Array(2);
  private readonly ghostNX = new Float32Array(2);
  private readonly ghostNY = new Float32Array(2);
  private readonly ghostPlateX = new Float32Array(2);
  private readonly ghostPlateY = new Float32Array(2);

  // safety car
  private scOn = false;
  private scFraction = 0;
  private scVelocity = 0;
  private scReceivedAt = 0;
  private scSide = 1;

  private readonly incidentFraction = new Float32Array(MAX_INCIDENTS);
  private incidentCount = 0;
  private readonly yellow = new Uint8Array(3);
  private rainIntensity = 0;
  private readonly rain = new Float32Array(RAIN_STREAKS * 3);
  private rainClock = 0;
  private lastNow = 0;
  private frozen = true;
  private lastSnapshot: LiveFrame['snapshot'] | null = null;

  // label de-cluttering scratch: boxes placed this frame, [cx, cy, halfW, halfH] each
  private readonly placed = new Float32Array(4 * 48);
  private placedCount = 0;
  private placeX = 0;
  private placeY = 0;
  private readonly sample: Sample = { x: 0, y: 0, tx: 1, ty: 0, out: 1 };

  // pointer
  private pointerX = 0;
  private pointerY = 0;
  private pointerInside = false;
  private hoverSlot = -1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layer = document.createElement('canvas');
    this.layerCtx = this.layer.getContext('2d');
    // fixed pseudo-random streak seeds (x, y, speed factor) so the rain needs no per-frame randomness
    let seed = 0x2f6e2b1;
    for (let i = 0; i < this.rain.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      this.rain[i] = seed / 4294967296;
    }
  }

  // ───────────────────────────────────────────────────────────── inputs ──

  setSession(session: SessionInfo): void {
    if (session === this.session) return;
    this.session = session;
    const index = indexSession(session);
    const count = session.drivers.length;
    this.slotOf.clear();
    this.ids = [];
    this.codes = [];
    this.colors = [];
    this.digits = [];
    this.digitInk = [];
    this.isPlayer = new Uint8Array(count);
    session.drivers.forEach((driver, slot) => {
      const color = index.color(driver.id);
      const player = index.isPlayer(driver.id);
      this.slotOf.set(driver.id, slot);
      this.ids.push(driver.id);
      this.codes.push(driver.code);
      this.colors.push(color);
      this.digits.push(player ? String(driver.carNumber) : '');
      this.digitInk.push(isLightColor(color) ? C.ring : C.ink50);
      this.isPlayer[slot] = player ? 1 : 0;
    });
    this.labelWidth = new Float32Array(count);
    this.fraction = new Float32Array(count);
    this.velocity = new Float32Array(count);
    this.pitProgress = new Float32Array(count).fill(-1);
    this.sortKey = new Float32Array(count);
    this.flags = new Uint8Array(count);
    this.visible = new Uint8Array(count);
    this.order = new Uint8Array(count);
    this.orderCount = 0;
    this.carX = new Float32Array(count);
    this.carY = new Float32Array(count);
    this.carNX = new Float32Array(count);
    this.carNY = new Float32Array(count);
    this.carTX = new Float32Array(count);
    this.carTY = new Float32Array(count);
    this.labelSide = new Int8Array(count);
    this.labelX = new Float32Array(count);
    this.labelY = new Float32Array(count);
    this.ghostOn.fill(0);
    this.ghostPosition.fill(0);
    this.scOn = false;
    this.hoverSlot = -1;
    this.lastSnapshot = null;
    this.track = session.track;
    this.model = modelFor(session.track);
    this.layoutDirty = true;
  }

  /** CSS size of the canvas and the device pixel ratio of its backing store. */
  resize(width: number, height: number, dpr: number): void {
    const w = Math.max(0, Math.floor(width));
    const h = Math.max(0, Math.floor(height));
    if (w === this.width && h === this.height && dpr === this.dpr) return;
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.layoutDirty = true;
  }

  /** HUD boxes (CSS px, canvas coordinates) the circuit should be laid out around. */
  setObstacles(rects: readonly Rect[]): void {
    const same =
      rects.length === this.obstacles.length &&
      rects.every((r, i) => {
        const o = this.obstacles[i]!;
        return Math.abs(r.x - o.x) < 1 && Math.abs(r.y - o.y) < 1 && Math.abs(r.w - o.w) < 1 && Math.abs(r.h - o.h) < 1;
      });
    if (same) return;
    this.obstacles = rects.map((r) => ({ ...r }));
    this.layoutDirty = true;
  }

  /** Repaint the static layer (call when web fonts finish loading). */
  invalidate(): void {
    this.staticDirty = true;
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  setPointer(x: number, y: number, inside: boolean): void {
    this.pointerX = x;
    this.pointerY = y;
    this.pointerInside = inside;
  }

  /** Car under the pointer as of the last rendered frame. */
  get hoveredCarId(): CarId | null {
    return this.hoverSlot >= 0 ? (this.ids[this.hoverSlot] ?? null) : null;
  }

  /** Screen position of the hovered car as of the last rendered frame. */
  hoverPoint(out: RadarPoint): boolean {
    if (this.hoverSlot < 0) return false;
    out.x = this.carX[this.hoverSlot]!;
    out.y = this.carY[this.hoverSlot]!;
    return true;
  }

  /** Car within picking distance of a canvas point, using the positions of the last rendered frame. */
  carAt(x: number, y: number): CarId | null {
    const slot = this.pick(x, y, -1);
    return slot >= 0 ? (this.ids[slot] ?? null) : null;
  }

  private pick(x: number, y: number, sticky: number): number {
    let best = -1;
    let bestDistance = PICK_RADIUS;
    for (let k = 0; k < this.orderCount; k++) {
      const i = this.order[k]!;
      // the car already hovered keeps a small bonus so two close cars do not flicker
      const distance = Math.hypot(this.carX[i]! - x, this.carY[i]! - y) - (i === sticky ? 4 : 0);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  }

  // ───────────────────────────────────────────────────────────── layout ──

  private layout(): void {
    const model = this.model;
    const track = this.track;
    if (!model || !track) return;
    const g = model.geometry;
    const n = g.sampleCount;
    this.trackWidth = Math.min(12, Math.max(8, Math.min(this.width, this.height) * 0.022));
    this.view = fitViewport({
      width: this.width,
      height: this.height,
      bounds: model.bounds,
      padding: { top: 30, right: 40, bottom: 30, left: 40 },
      obstacles: this.obstacles,
      points: [{ xs: g.xs, ys: g.ys, count: n }, g.pitLane],
      clearance: this.trackWidth / 2 + 12,
    });
    const { scale, offsetX, offsetY } = this.view;

    if (this.screenX.length !== n + 1) {
      this.screenX = new Float32Array(n + 1);
      this.screenY = new Float32Array(n + 1);
    }
    const path = new Path2D();
    for (let i = 0; i <= n; i++) {
      const x = g.xs[i]! * scale + offsetX;
      const y = g.ys[i]! * scale + offsetY;
      this.screenX[i] = x;
      this.screenY[i] = y;
      if (i === 0) path.moveTo(x, y);
      else if (i < n) path.lineTo(x, y);
    }
    path.closePath();
    this.trackPath = path;

    const lane = g.pitLane;
    if (this.pitScreenX.length !== lane.count) {
      this.pitScreenX = new Float32Array(lane.count);
      this.pitScreenY = new Float32Array(lane.count);
    }
    for (let i = 0; i < lane.count; i++) {
      this.pitScreenX[i] = lane.xs[i]! * scale + offsetX;
      this.pitScreenY[i] = lane.ys[i]! * scale + offsetY;
    }

    const [s1, s2] = track.sectors;
    this.sectorPaths = [this.slicePath(g, 0, s1), this.slicePath(g, s1, s2), this.slicePath(g, s2, 1)];
    this.layoutDirty = false;
    this.staticDirty = true;
  }

  private slicePath(geometry: TrackGeometry, start: number, end: number): Path2D {
    const { scale, offsetX, offsetY } = this.view;
    const path = new Path2D();
    trackSlice(geometry, start, end).forEach((p, i) => {
      if (i === 0) path.moveTo(p.x * scale + offsetX, p.y * scale + offsetY);
      else path.lineTo(p.x * scale + offsetX, p.y * scale + offsetY);
    });
    return path;
  }

  // ─────────────────────────────────────────────────────── static layer ──

  /** True when a label box is inside the canvas and clear of the HUD, other labels, the track and the pit lane. */
  private boxFree(cx: number, cy: number, hw: number, hh: number, trackPad: number): boolean {
    if (cx - hw < 2 || cy - hh < 2 || cx + hw > this.width - 2 || cy + hh > this.height - 2) return false;
    for (const r of this.obstacles) {
      if (boxesOverlap(cx, cy, hw, hh, r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 2)) return false;
    }
    const boxes = this.staticBoxes;
    for (let i = 0; i < this.staticBoxCount; i++) {
      const o = i * 4;
      if (boxesOverlap(cx, cy, hw, hh, boxes[o]!, boxes[o + 1]!, boxes[o + 2]!, boxes[o + 3]!, 3)) return false;
    }
    const sx = this.screenX;
    const sy = this.screenY;
    for (let i = 0; i < sx.length; i++) {
      if (Math.abs(sx[i]! - cx) < hw + trackPad && Math.abs(sy[i]! - cy) < hh + trackPad) return false;
    }
    const px = this.pitScreenX;
    const py = this.pitScreenY;
    for (let i = 0; i < px.length; i++) {
      if (Math.abs(px[i]! - cx) < hw + 3 && Math.abs(py[i]! - cy) < hh + 3) return false;
    }
    return true;
  }

  /**
   * Draws `text` pushed away from the anchor along (nx, ny) if the spot is free and registers its box.
   * `boxed` labels get a plate and a hairline frame (sector tags), the others are plain text.
   */
  private staticLabel(
    g: CanvasRenderingContext2D,
    text: string,
    ax: number,
    ay: number,
    nx: number,
    ny: number,
    gap: number,
    color: string,
    boxed: boolean,
  ): boolean {
    const w = g.measureText(text).width + (boxed ? 8 : 2);
    const h = boxed ? 13 : 11;
    const reach = labelReach(nx, ny, w, h, gap);
    const cx = Math.round(ax + nx * reach);
    const cy = Math.round(ay + ny * reach);
    if (!this.boxFree(cx, cy, w / 2, h / 2, this.trackWidth / 2 + 3)) return false;
    if (boxed) {
      g.fillStyle = C.panel;
      g.fillRect(cx - w / 2, cy - h / 2, w, h);
      g.strokeStyle = C.ink600;
      g.lineWidth = 1;
      g.strokeRect(Math.round(cx - w / 2) + 0.5, Math.round(cy - h / 2) + 0.5, Math.round(w) - 1, h - 1);
    }
    g.fillStyle = color;
    g.fillText(text, cx, cy + 0.5);
    if (this.staticBoxCount < this.staticBoxes.length / 4) {
      const o = this.staticBoxCount++ * 4;
      this.staticBoxes[o] = cx;
      this.staticBoxes[o + 1] = cy;
      this.staticBoxes[o + 2] = w / 2;
      this.staticBoxes[o + 3] = h / 2;
    }
    return true;
  }

  private rebuildStatic(): void {
    const g = this.layerCtx;
    const model = this.model;
    const track = this.track;
    const path = this.trackPath;
    if (!g || !model || !track || !path) return;
    const geometry = model.geometry;
    const tw = this.trackWidth;
    const { scale, offsetX, offsetY } = this.view;
    const S = this.sample;

    if (this.layer.width !== this.canvas.width || this.layer.height !== this.canvas.height) {
      this.layer.width = this.canvas.width;
      this.layer.height = this.canvas.height;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.layer.width, this.layer.height);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    this.staticBoxCount = 0;

    // pit lane first, so its tapered ends tuck under the asphalt
    g.beginPath();
    for (let i = 0; i < this.pitScreenX.length; i++) {
      if (i === 0) g.moveTo(this.pitScreenX[i]!, this.pitScreenY[i]!);
      else g.lineTo(this.pitScreenX[i]!, this.pitScreenY[i]!);
    }
    g.strokeStyle = C.ink500;
    g.lineWidth = 1.5;
    g.stroke();

    // asphalt, tinted towards the wet-tyre blue as the track gets wetter
    const wet = this.wetStep / WET_STEPS;
    g.strokeStyle = mixHex(C.edge, TYRE_COLORS.WET, wet * 0.4);
    g.lineWidth = tw + 2.5;
    g.stroke(path);
    g.strokeStyle = mixHex(C.asphalt, TYRE_COLORS.WET, wet * 0.62);
    g.lineWidth = tw;
    g.stroke(path);
    g.strokeStyle = mixHex(C.centre, C.ink100, wet * 0.5);
    g.globalAlpha = 0.5;
    g.lineWidth = 1;
    g.stroke(path);
    g.globalAlpha = 1;

    // DRS zones: a line parallel to the track on the side away from the pit lane, plus the detection point
    const drsSide = -model.pitSide;
    const drsOffset = tw / 2 + 4.5;
    g.lineCap = 'butt';
    g.strokeStyle = C.green;
    g.globalAlpha = this.drsEnabled ? 1 : 0.4;
    for (const zone of track.drsZones) {
      const points = trackSlice(geometry, zone.start, zone.end);
      g.beginPath();
      for (let i = 0; i < points.length; i++) {
        const a = points[Math.max(0, i - 1)]!;
        const b = points[Math.min(points.length - 1, i + 1)]!;
        const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const px = points[i]!.x * scale + offsetX + (-(b.y - a.y) / length) * drsSide * drsOffset;
        const py = points[i]!.y * scale + offsetY + ((b.x - a.x) / length) * drsSide * drsOffset;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.lineWidth = 2;
      g.setLineDash(this.drsEnabled ? [] : [4, 3]);
      g.stroke();
      g.setLineDash([]);

      const detection = pointAt(geometry, zone.detection);
      const dx = detection.x * scale + offsetX - Math.sin(detection.angle) * drsSide * drsOffset;
      const dy = detection.y * scale + offsetY + Math.cos(detection.angle) * drsSide * drsOffset;
      g.beginPath();
      g.moveTo(dx, dy - 3.5);
      g.lineTo(dx + 3.5, dy);
      g.lineTo(dx, dy + 3.5);
      g.lineTo(dx - 3.5, dy);
      g.closePath();
      g.fillStyle = C.panel;
      g.fill();
      g.lineWidth = 1.25;
      g.stroke();
    }
    g.globalAlpha = 1;

    // start/finish line: a chequered strip across the track
    const line = pointAt(geometry, 0);
    const cell = Math.max(2, Math.round(tw / 4));
    const rows = Math.ceil((tw + 4) / cell);
    g.save();
    g.translate(line.x * scale + offsetX, line.y * scale + offsetY);
    g.rotate(line.angle);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < 2; c++) {
        g.fillStyle = (r + c) % 2 === 0 ? C.ink50 : C.ring;
        g.fillRect((c - 1) * cell, -(rows * cell) / 2 + r * cell, cell, cell);
      }
    }
    g.restore();

    // sector boundaries
    for (const boundary of track.sectors) {
      const p = pointAt(geometry, boundary);
      g.save();
      g.translate(p.x * scale + offsetX, p.y * scale + offsetY);
      g.rotate(p.angle);
      g.fillStyle = C.ink100;
      g.fillRect(-1, -(tw / 2 + 4), 2, tw + 8);
      g.restore();
    }

    // direction of travel: two chevrons on the asphalt just after the line
    const lapPixels = geometry.lengthUnits * scale;
    g.lineCap = 'round';
    g.strokeStyle = C.ink100;
    g.lineWidth = 1.5;
    g.globalAlpha = 0.85;
    for (let k = 0; k < 2; k++) {
      const p = pointAt(geometry, (cell * 2 + 8 + k * 6) / lapPixels);
      const h = Math.max(2.5, tw * 0.28);
      g.save();
      g.translate(p.x * scale + offsetX, p.y * scale + offsetY);
      g.rotate(p.angle);
      g.beginPath();
      g.moveTo(-h * 0.8, -h);
      g.lineTo(0, 0);
      g.lineTo(-h * 0.8, h);
      g.stroke();
      g.restore();
    }
    g.globalAlpha = 1;

    // ── labels, most important first: each one takes its box and the later ones work around it
    g.font = LABEL_FONT;
    g.letterSpacing = '0.6px';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const labelGap = tw / 2 + 8;

    for (const zone of track.drsZones) {
      const span = zone.end - zone.start;
      // zone length, wrap-aware (a zone may straddle the line)
      const length = span - Math.floor(span) || 1;
      for (const share of [0.5, 0.25, 0.75]) {
        sampleTrack(model, zone.start + length * share, S);
        const placed = this.staticLabel(
          g,
          'DRS',
          S.x * scale + offsetX,
          S.y * scale + offsetY,
          -S.ty * drsSide,
          S.tx * drsSide,
          drsOffset + 4,
          this.drsEnabled ? C.ink300 : C.ink500,
          false,
        );
        if (placed) break;
      }
    }

    const sectorBounds = [0, track.sectors[0], track.sectors[1], 1];
    for (let k = 0; k < 3; k++) {
      const start = sectorBounds[k]!;
      const length = sectorBounds[k + 1]! - start;
      let placed = false;
      for (const share of [0.5, 0.38, 0.62, 0.26, 0.74]) {
        // inside of the circuit first: corner names live on the outside
        for (const side of [-1, 1]) {
          sampleTrack(model, start + length * share, S);
          placed = this.staticLabel(
            g,
            `S${k + 1}`,
            S.x * scale + offsetX,
            S.y * scale + offsetY,
            -S.ty * S.out * side,
            S.tx * S.out * side,
            labelGap,
            C.ink300,
            true,
          );
          if (placed) break;
        }
        if (placed) break;
      }
    }

    for (const progress of [0.5, 0.32, 0.68]) {
      const p = pitPointAt(geometry, progress);
      const nx = -Math.sin(p.angle) * model.pitSide;
      const ny = Math.cos(p.angle) * model.pitSide;
      if (this.staticLabel(g, 'PIT', p.x * scale + offsetX, p.y * scale + offsetY, nx, ny, 5, C.ink500, false)) break;
    }

    for (const corner of track.corners) {
      sampleTrack(model, corner.at, S);
      const ax = S.x * scale + offsetX;
      const ay = S.y * scale + offsetY;
      const name = corner.name.toUpperCase();
      // just outside the track; on the inside when that spot is taken; otherwise the name is dropped
      if (!this.staticLabel(g, name, ax, ay, -S.ty * S.out, S.tx * S.out, labelGap, C.ink500, false)) {
        this.staticLabel(g, name, ax, ay, S.ty * S.out, -S.tx * S.out, labelGap, C.ink500, false);
      }
    }
    g.letterSpacing = '0px';

    // widths of the dynamic labels depend on the fonts that are loaded right now
    g.font = CAR_FONT;
    for (let i = 0; i < this.codes.length; i++) {
      g.font = this.isPlayer[i] ? PLAYER_FONT : CAR_FONT;
      this.labelWidth[i] = g.measureText(this.codes[i]!).width;
    }
    this.ghostLabelWidth.fill(0);
    this.staticDirty = false;
  }

  // ───────────────────────────────────────────────────────── snapshots ──

  /** Copies what the frame loop needs out of a new snapshot into the typed arrays. */
  private ingest(frame: LiveFrame, model: TrackModel): void {
    const snapshot = frame.snapshot;
    // lap fraction per second for 1 km/h: the documented extrapolation of `LiveFrameSource`
    const perKph = snapshot.timeScale / (3.6 * model.lengthMetres);
    this.pitProgress.fill(-1);
    this.visible.fill(0);
    let count = 0;
    for (const car of snapshot.cars) {
      const i = this.slotOf.get(car.id);
      if (i === undefined || car.status === 'RETIRED') continue;
      const pit = car.pitLaneProgress;
      this.visible[i] = 1;
      this.fraction[i] = car.lapFraction;
      this.pitProgress[i] = pit === null ? -1 : pit;
      // cars in the pit lane are not extrapolated
      this.velocity[i] = pit === null ? car.speedKph * perKph : 0;
      this.sortKey[i] = (this.isPlayer[i] ? 1000 : 0) - car.position;
      this.flags[i] =
        (car.drsOpen ? FLAG_DRS : 0) |
        (car.status === 'GRID' ? FLAG_GRID : 0) |
        (car.gridPosition % 2 === 1 ? FLAG_ODD : 0) |
        (car.status === 'FINISHED' ? FLAG_DIM : 0);
      if (count < this.order.length) this.order[count++] = i;
    }
    // draw order: back-markers first, the leader later, the user's two cars last (always on top)
    for (let a = 1; a < count; a++) {
      const slot = this.order[a]!;
      const key = this.sortKey[slot]!;
      let b = a - 1;
      while (b >= 0 && this.sortKey[this.order[b]!]! > key) {
        this.order[b + 1] = this.order[b]!;
        b--;
      }
      this.order[b + 1] = slot;
    }
    this.orderCount = count;

    for (let k = 0; k < 2; k++) {
      const telemetry = snapshot.player.cars[k]!;
      const rejoin = telemetry.rejoin;
      const slot = this.slotOf.get(telemetry.carId);
      if (rejoin === null || slot === undefined || !this.visible[slot] || this.pitProgress[slot]! >= 0) {
        this.ghostOn[k] = 0;
        continue;
      }
      this.ghostOn[k] = 1;
      this.ghostSlot[k] = slot;
      this.ghostFraction[k] = rejoin.ghostLapFraction;
      // The ghost is "extrapolated like a car": it runs at its car's pace relative to the reference lap,
      // taken at the reference speed of the place where the ghost is.
      const ownReference = speedAt(model.geometry, this.fraction[slot]!);
      const ratio = ownReference > 1 ? speedAt(model.geometry, rejoin.ghostLapFraction) / ownReference : 1;
      this.ghostVelocity[k] = this.velocity[slot]! * Math.min(3, Math.max(0.2, ratio));
      if (this.ghostPosition[k] !== rejoin.position || this.ghostLabel[k] === '') {
        this.ghostPosition[k] = rejoin.position;
        this.ghostLabel[k] = `#${telemetry.carNumber} REJOIN P${rejoin.position}`;
        this.ghostLabelWidth[k] = 0;
      }
    }

    // The safety car has no speed in the snapshot: estimate it from its last two positions.
    const sc = snapshot.raceControl.safetyCarLapFraction;
    if (sc === null) {
      this.scOn = false;
      this.scVelocity = 0;
    } else {
      if (this.scOn) {
        const dt = (frame.receivedAt - this.scReceivedAt) / 1000;
        if (dt > 0.004 && dt < 1) {
          const v = Math.min(0.03 * snapshot.timeScale, Math.max(0, wrapSigned(sc - this.scFraction) / dt));
          this.scVelocity = this.scVelocity > 0 ? this.scVelocity * 0.6 + v * 0.4 : v;
        }
      }
      this.scOn = true;
      this.scFraction = sc;
      this.scReceivedAt = frame.receivedAt;
    }

    const incidents = snapshot.raceControl.incidents;
    this.incidentCount = Math.min(MAX_INCIDENTS, incidents.length);
    for (let i = 0; i < this.incidentCount; i++) this.incidentFraction[i] = incidents[i]!.lapFraction;
    const yellow = snapshot.raceControl.yellowSectors;
    this.yellow[0] = yellow[0] ? 1 : 0;
    this.yellow[1] = yellow[1] ? 1 : 0;
    this.yellow[2] = yellow[2] ? 1 : 0;
    this.rainIntensity = snapshot.weather.rainIntensity;
    this.frozen = snapshot.paused || snapshot.phase !== 'RACING';

    const wetStep = Math.round(Math.min(1, Math.max(0, snapshot.weather.trackWetness)) * WET_STEPS);
    if (wetStep !== this.wetStep || snapshot.raceControl.drsEnabled !== this.drsEnabled) {
      this.wetStep = wetStep;
      this.drsEnabled = snapshot.raceControl.drsEnabled;
      this.staticDirty = true;
    }
  }

  // ───────────────────────────────────────────────────── label placement ──

  private labelCost(cx: number, cy: number, hw: number, hh: number, self: number, pad: number): number {
    let cost = 0;
    if (cx - hw < 2 || cy - hh < 2 || cx + hw > this.width - 2 || cy + hh > this.height - 2) cost += 60;
    const placed = this.placed;
    for (let i = 0; i < this.placedCount; i++) {
      const o = i * 4;
      if (boxesOverlap(cx, cy, hw, hh, placed[o]!, placed[o + 1]!, placed[o + 2]!, placed[o + 3]!, pad)) {
        cost += 100;
        break;
      }
    }
    for (let k = 0; k < this.orderCount; k++) {
      const i = this.order[k]!;
      if (i === self) continue;
      const r = this.isPlayer[i] ? PLAYER_RADIUS + 3 : CAR_RADIUS + 2;
      if (boxesOverlap(cx, cy, hw, hh, this.carX[i]!, this.carY[i]!, r, r, pad)) {
        cost += 100;
        break;
      }
    }
    const boxes = this.staticBoxes;
    for (let i = 0; i < this.staticBoxCount; i++) {
      const o = i * 4;
      if (boxesOverlap(cx, cy, hw, hh, boxes[o]!, boxes[o + 1]!, boxes[o + 2]!, boxes[o + 3]!, 0)) {
        cost += 12;
        break;
      }
    }
    for (const r of this.obstacles) {
      if (boxesOverlap(cx, cy, hw, hh, r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0)) {
        cost += 40;
        break;
      }
    }
    return cost;
  }

  /**
   * Chooses the side of the track for a label (+1 outside, −1 inside, 0 hidden) and leaves its centre in
   * `placeX/placeY`. The previous side is favoured and a hidden label needs extra room to come back, so
   * labels do not flicker while cars run nose to tail. `must` labels are never hidden.
   */
  private placeLabel(
    ax: number,
    ay: number,
    nx: number,
    ny: number,
    hw: number,
    hh: number,
    gap: number,
    previous: number,
    must: boolean,
    self: number,
  ): number {
    const reach = labelReach(nx, ny, hw * 2, hh * 2, gap);
    let bestSide = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let side = 1; side >= -1; side -= 2) {
      const cx = ax + nx * side * reach;
      const cy = ay + ny * side * reach;
      let cost = this.labelCost(cx, cy, hw, hh, self, previous === side ? 0 : 2.5);
      if (previous !== side && previous !== 0) cost += 3;
      if (side === -1) cost += 1;
      if (cost < bestCost) {
        bestCost = cost;
        bestSide = side;
        this.placeX = cx;
        this.placeY = cy;
      }
    }
    if (bestCost >= 100 && !must) return 0;
    if (this.placedCount < this.placed.length / 4) {
      const o = this.placedCount++ * 4;
      this.placed[o] = this.placeX;
      this.placed[o + 1] = this.placeY;
      this.placed[o + 2] = hw;
      this.placed[o + 3] = hh;
    }
    return bestSide;
  }

  private placeCarLabel(i: number, must: boolean): void {
    const radius = this.isPlayer[i] ? PLAYER_RADIUS + 3.5 : CAR_RADIUS + 2;
    const side = this.placeLabel(
      this.carX[i]!,
      this.carY[i]!,
      this.carNX[i]!,
      this.carNY[i]!,
      this.labelWidth[i]! / 2 + 1,
      5.5,
      radius + 2,
      this.labelSide[i]!,
      must,
      i,
    );
    this.labelSide[i] = side;
    this.labelX[i] = this.placeX;
    this.labelY[i] = this.placeY;
  }

  // ───────────────────────────────────────────────────────────── frame ──

  /**
   * Draws one animation frame. `now` must come from the same clock as `frame.receivedAt`
   * (`performance.now()`).
   */
  render(frame: LiveFrame | null, now: number, selectedId: CarId | null): void {
    const ctx = this.ctx;
    const model = this.model;
    if (!ctx || !model || this.width < 2 || this.height < 2) return;
    if (frame && frame.snapshot !== this.lastSnapshot) {
      this.lastSnapshot = frame.snapshot;
      this.ingest(frame, model);
    }
    if (this.layoutDirty) this.layout();
    if (this.staticDirty) this.rebuildStatic();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.layer.width > 0 && this.layer.height > 0) ctx.drawImage(this.layer, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const elapsed = this.lastNow === 0 ? 0 : Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    if (!frame) {
      this.hoverSlot = -1;
      return;
    }
    // Δt since the snapshot reached the UI thread; zero while paused or outside the RACING phase
    const dt = this.frozen ? 0 : Math.min(MAX_EXTRAPOLATION, Math.max(0, (now - frame.receivedAt) / 1000));
    if (!frame.snapshot.paused && !this.reducedMotion) this.rainClock += elapsed;

    const { scale, offsetX, offsetY } = this.view;
    const tw = this.trackWidth;
    const S = this.sample;
    const selected = selectedId === null ? -1 : (this.slotOf.get(selectedId) ?? -1);
    ctx.lineJoin = 'round';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // sectors under local yellow, slowly pulsing
    if (this.yellow[0] || this.yellow[1] || this.yellow[2]) {
      const pulse = this.reducedMotion ? 1 : 0.5 + 0.5 * Math.cos((now / 1000) * (TAU / 1.6));
      ctx.lineCap = 'butt';
      ctx.strokeStyle = C.yellow;
      ctx.lineWidth = tw - 1;
      ctx.globalAlpha = 0.3 + 0.5 * pulse;
      for (let k = 0; k < 3; k++) {
        const sector = this.sectorPaths[k];
        if (this.yellow[k] && sector) ctx.stroke(sector);
      }
      ctx.globalAlpha = 1;
    }

    // ── positions, extrapolated from the snapshot
    for (let k = 0; k < this.orderCount; k++) {
      const i = this.order[k]!;
      const pit = this.pitProgress[i]!;
      if (pit >= 0) samplePit(model, pit, S);
      else sampleTrack(model, this.fraction[i]! + this.velocity[i]! * dt, S);
      let x = S.x * scale + offsetX;
      let y = S.y * scale + offsetY;
      const flags = this.flags[i]!;
      if (flags & FLAG_GRID) {
        // two-by-two grid: odd slots on one side of the track, even slots on the other
        const lateral = tw * 0.24 * (flags & FLAG_ODD ? -1 : 1);
        x += -S.ty * lateral;
        y += S.tx * lateral;
      }
      this.carX[i] = x;
      this.carY[i] = y;
      this.carTX[i] = S.tx;
      this.carTY[i] = S.ty;
      this.carNX[i] = -S.ty * S.out;
      this.carNY[i] = S.tx * S.out;
    }

    // ── incidents: warning triangle beside the track
    for (let k = 0; k < this.incidentCount; k++) {
      sampleTrack(model, this.incidentFraction[k]!, S);
      const reach = tw / 2 + 10;
      const cx = S.x * scale + offsetX - S.ty * S.out * reach;
      const cy = S.y * scale + offsetY + S.tx * S.out * reach;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 7);
      ctx.lineTo(cx + 6.5, cy + 4.5);
      ctx.lineTo(cx - 6.5, cy + 4.5);
      ctx.closePath();
      ctx.strokeStyle = C.ring;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = C.yellow;
      ctx.fill();
      ctx.fillStyle = C.ring;
      ctx.font = DIGIT_FONT;
      ctx.fillText('!', cx, cy + 0.5);
    }

    // ── label de-cluttering, in order of priority: ghosts, safety car, selected car, user's cars, rest
    this.placedCount = 0;
    ctx.font = LABEL_FONT;
    for (let k = 0; k < 2; k++) {
      if (!this.ghostOn[k]) continue;
      sampleTrack(model, this.ghostFraction[k]! + this.ghostVelocity[k]! * dt, S);
      const gx = S.x * scale + offsetX;
      const gy = S.y * scale + offsetY;
      const nx = -S.ty * S.out;
      const ny = S.tx * S.out;
      if (this.ghostLabelWidth[k] === 0) this.ghostLabelWidth[k] = ctx.measureText(this.ghostLabel[k]!).width;
      const side = this.placeLabel(gx, gy, nx, ny, this.ghostLabelWidth[k]! / 2 + 5, 7, GHOST_RADIUS + GHOST_LEADER, this.ghostSide[k]!, true, -1);
      this.ghostSide[k] = side;
      this.ghostX[k] = gx;
      this.ghostY[k] = gy;
      this.ghostNX[k] = nx * side;
      this.ghostNY[k] = ny * side;
      this.ghostPlateX[k] = this.placeX;
      this.ghostPlateY[k] = this.placeY;
    }
    let scX = 0;
    let scY = 0;
    let scLabelX = 0;
    let scLabelY = 0;
    if (this.scOn) {
      sampleTrack(model, this.scFraction + this.scVelocity * dt, S);
      scX = S.x * scale + offsetX;
      scY = S.y * scale + offsetY;
      this.scSide = this.placeLabel(scX, scY, -S.ty * S.out, S.tx * S.out, 9, 6.5, 10, this.scSide, true, -1) || 1;
      scLabelX = this.placeX;
      scLabelY = this.placeY;
    }
    const selectedDrawn = selected >= 0 && this.visible[selected] === 1;
    if (selectedDrawn) this.placeCarLabel(selected, true);
    for (let k = this.orderCount - 1; k >= 0; k--) {
      const i = this.order[k]!;
      if (i !== selected) this.placeCarLabel(i, this.isPlayer[i] === 1);
    }

    // ── cars: the field first, then ghosts and safety car, then the user's cars on top
    for (let k = 0; k < this.orderCount; k++) {
      const i = this.order[k]!;
      if (!this.isPlayer[i]) this.drawCar(ctx, i);
    }
    for (let k = 0; k < 2; k++) {
      if (!this.ghostOn[k]) continue;
      const gx = this.ghostX[k]!;
      const gy = this.ghostY[k]!;
      const color = this.colors[this.ghostSlot[k]!]!;
      ctx.beginPath();
      ctx.arc(gx, gy, GHOST_RADIUS, 0, TAU);
      ctx.strokeStyle = C.halo;
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.setLineDash([3.5, 2.5]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.75;
      ctx.stroke();
      ctx.setLineDash([]);
      // leader from the ring to its plate
      const hw = this.ghostLabelWidth[k]! / 2 + 5;
      ctx.beginPath();
      ctx.moveTo(gx + this.ghostNX[k]! * (GHOST_RADIUS + 1.5), gy + this.ghostNY[k]! * (GHOST_RADIUS + 1.5));
      ctx.lineTo(gx + this.ghostNX[k]! * (GHOST_RADIUS + GHOST_LEADER), gy + this.ghostNY[k]! * (GHOST_RADIUS + GHOST_LEADER));
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
      const px = Math.round(this.ghostPlateX[k]!);
      const py = Math.round(this.ghostPlateY[k]!);
      ctx.fillStyle = C.plate;
      ctx.fillRect(px - hw, py - 7, hw * 2, 14);
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(Math.round(px - hw) + 0.5, py - 6.5, Math.round(hw * 2) - 1, 13);
      ctx.setLineDash([]);
      ctx.font = LABEL_FONT;
      ctx.fillStyle = C.ink100;
      ctx.fillText(this.ghostLabel[k]!, px, py + 0.5);
    }
    if (this.scOn) {
      ctx.beginPath();
      ctx.moveTo(scX, scY - 8);
      ctx.lineTo(scX + 8, scY);
      ctx.lineTo(scX, scY + 8);
      ctx.lineTo(scX - 8, scY);
      ctx.closePath();
      ctx.fillStyle = C.ring;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(scX, scY - 5.5);
      ctx.lineTo(scX + 5.5, scY);
      ctx.lineTo(scX, scY + 5.5);
      ctx.lineTo(scX - 5.5, scY);
      ctx.closePath();
      ctx.fillStyle = C.safetyCar;
      ctx.fill();
      const lx = Math.round(scLabelX);
      const ly = Math.round(scLabelY);
      ctx.fillStyle = C.ring;
      ctx.fillRect(lx - 9, ly - 6.5, 18, 13);
      ctx.fillStyle = C.safetyCar;
      ctx.fillRect(lx - 8, ly - 5.5, 16, 11);
      ctx.fillStyle = C.ring;
      ctx.font = PLAYER_FONT;
      ctx.fillText('SC', lx, ly + 0.5);
    }
    for (let k = 0; k < this.orderCount; k++) {
      const i = this.order[k]!;
      if (this.isPlayer[i]) this.drawCar(ctx, i);
    }

    // ── hover and selection rings
    this.hoverSlot = this.pointerInside ? this.pick(this.pointerX, this.pointerY, this.hoverSlot) : -1;
    if (this.hoverSlot >= 0 && this.hoverSlot !== selected) {
      const r = (this.isPlayer[this.hoverSlot] ? PLAYER_RADIUS + 3.5 : CAR_RADIUS + 2) + 2.5;
      ctx.beginPath();
      ctx.arc(this.carX[this.hoverSlot]!, this.carY[this.hoverSlot]!, r, 0, TAU);
      ctx.strokeStyle = C.ink300;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (selectedDrawn) {
      const x = this.carX[selected]!;
      const y = this.carY[selected]!;
      const r = (this.isPlayer[selected] ? PLAYER_RADIUS + 3.5 : CAR_RADIUS + 2) + 3.5;
      ctx.strokeStyle = C.ink50;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      // cross-hair ticks so the ring also reads on a light team colour
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + r + 4, y);
      ctx.moveTo(x - r, y);
      ctx.lineTo(x - r - 4, y);
      ctx.moveTo(x, y + r);
      ctx.lineTo(x, y + r + 4);
      ctx.moveTo(x, y - r);
      ctx.lineTo(x, y - r - 4);
      ctx.stroke();
    }

    // ── three-letter codes
    ctx.strokeStyle = C.halo;
    ctx.lineWidth = 3;
    ctx.font = CAR_FONT;
    for (let k = 0; k < this.orderCount; k++) {
      const i = this.order[k]!;
      if (this.isPlayer[i] || this.labelSide[i] === 0) continue;
      const x = Math.round(this.labelX[i]!);
      const y = Math.round(this.labelY[i]!) + 0.5;
      if (this.flags[i]! & FLAG_DIM) ctx.globalAlpha = 0.5;
      ctx.strokeText(this.codes[i]!, x, y);
      ctx.fillStyle = i === selected ? C.ink50 : C.ink300;
      ctx.fillText(this.codes[i]!, x, y);
      ctx.globalAlpha = 1;
    }
    ctx.font = PLAYER_FONT;
    ctx.fillStyle = C.ink50;
    for (let k = 0; k < this.orderCount; k++) {
      const i = this.order[k]!;
      if (!this.isPlayer[i] || this.labelSide[i] === 0) continue;
      const x = Math.round(this.labelX[i]!);
      const y = Math.round(this.labelY[i]!) + 0.5;
      if (this.flags[i]! & FLAG_DIM) ctx.globalAlpha = 0.5;
      ctx.strokeText(this.codes[i]!, x, y);
      ctx.fillText(this.codes[i]!, x, y);
      ctx.globalAlpha = 1;
    }

    // ── light rain streaks
    if (this.rainIntensity > 0.05) {
      const intensity = Math.min(1, this.rainIntensity);
      const streaks = Math.min(RAIN_STREAKS, Math.round(24 + 110 * intensity));
      const spanX = this.width + 40;
      const spanY = this.height + 40;
      const t = this.rainClock;
      ctx.beginPath();
      for (let i = 0; i < streaks; i++) {
        const k = this.rain[i * 3 + 2]!;
        const speed = 300 + 260 * k;
        const length = 8 + 10 * k;
        const y = ((this.rain[i * 3 + 1]! * spanY + t * speed) % spanY) - 20;
        let x = (this.rain[i * 3]! * spanX - t * speed * 0.3) % spanX;
        if (x < 0) x += spanX;
        x -= 20;
        ctx.moveTo(x, y);
        ctx.lineTo(x - length * 0.3, y + length);
      }
      ctx.lineCap = 'butt';
      ctx.strokeStyle = C.rain;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.12 + 0.2 * intensity;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  private drawCar(ctx: CanvasRenderingContext2D, i: number): void {
    const x = this.carX[i]!;
    const y = this.carY[i]!;
    const player = this.isPlayer[i] === 1;
    const r = player ? PLAYER_RADIUS : CAR_RADIUS;
    const flags = this.flags[i]!;
    if (flags & FLAG_DIM) ctx.globalAlpha = 0.5;
    if (flags & FLAG_DRS) {
      // open flap: a short green bar across the tail of the car
      const reach = r + (player ? 5 : 3.5);
      const bx = x - this.carTX[i]! * reach;
      const by = y - this.carTY[i]! * reach;
      const px = -this.carTY[i]! * 3.5;
      const py = this.carTX[i]! * 3.5;
      ctx.beginPath();
      ctx.moveTo(bx - px, by - py);
      ctx.lineTo(bx + px, by + py);
      ctx.lineCap = 'butt';
      ctx.strokeStyle = C.green;
      ctx.lineWidth = 2.25;
      ctx.stroke();
    }
    // dark ring keeps overlapping dots apart
    ctx.beginPath();
    ctx.arc(x, y, r + (player ? 3.5 : 2), 0, TAU);
    ctx.fillStyle = C.ring;
    ctx.fill();
    if (player) {
      ctx.beginPath();
      ctx.arc(x, y, r + 1.75, 0, TAU);
      ctx.strokeStyle = C.ink50;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = this.colors[i]!;
    ctx.fill();
    if (player) {
      // car number (#1 / #2) inside the dot: the two team cars share one colour
      ctx.font = DIGIT_FONT;
      ctx.fillStyle = this.digitInk[i]!;
      ctx.fillText(this.digits[i]!, x, y + 0.5);
    }
    ctx.globalAlpha = 1;
  }
}
