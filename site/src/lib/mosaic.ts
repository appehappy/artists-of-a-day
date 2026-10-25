// WebGL2 mosaic: every artwork is an instanced tile drawn from a texture array of
// sprite sheets (scripts/build_colourmaps.py). Tiles can be grid squares or rotated,
// rounded shapes such as pills (the Colour Field's Orbits). Layout changes animate on the GPU:
// each tile flies from where it is to where it's going, staggered along the
// gradient; works joining grow in, works leaving shrink out. Until its sprite sheet
// arrives each tile is drawn in its slot's colour, so a layout shows at once and its
// images fade in. From far away each tile is tinted towards that colour (the zoom
// tint); layouts with a sun (Orbits) can let their rings drift when idle, and show
// loading progress as a clock around the sun (others, as a gradient bar beneath). As tiles grow on screen they
// swap to sharper copies of the real thumbnails, and close up a 2D overlay draws the
// thumbnails themselves.

import { tintAmount } from "./tint";

export interface AtlasInfo {
  tile: number; sheet: number; perRow: number; perSheet: number; sheets: number; count: number;
  levels?: number; // mipmap levels shipped as files (atlas-NN-L.webp); otherwise generated
}

export interface MosaicOptions {
  thumbUrl: (row: number) => string;
  onHover: (row: number | null, x: number, y: number) => void;
  onSelect: (row: number | null) => void;
}

export interface Layout {
  rows: Int32Array; // artwork per slot
  /** Grid layouts: top-left cell of a 1×1 tile. Shaped layouts (with w/h): the centre. */
  x: Int32Array | Float32Array;
  y: Int32Array | Float32Array;
  t: Float32Array; // stagger order
  slotRgb: Float32Array;
  w?: Float32Array; // tile size in cells (default 1×1)
  h?: Float32Array;
  rot?: Float32Array; // radians, clockwise
  round?: number; // corner radius as a fraction of the tile's shorter side (0.5 = pill)
  /** A solid disc drawn under the tiles, e.g. the dark sun at the centre of Orbits;
   *  with no colour, just the place the loading clock is drawn. */
  disc?: { x: number; y: number; r: number; rgb: [number, number, number] | null };
  /** Names drawn over the tiles: level 0 from afar, level 1 closer in. */
  labels?: { text: string; x: number; y: number; size?: number; level?: number }[];
  /** Ambient life (Constellation): distant tiles glint now and then. */
  twinkle?: boolean;
  /** Fit the view to all but this share of tiles at each edge (0–0.5), so a sparse halo
   *  of outliers doesn't shrink the whole (Constellation). Default 0: every tile. */
  fitTrim?: number;
  /** Responsive (Constellation): tiles the pointer brushes past are knocked aside and
   *  spring back, each in its own way, and the area around it is lit; selecting a
   *  work knocks its neighbours out and back, and dims all but it and its links. */
  lively?: boolean;
  /** While a work is selected, everything but it and its linked works is dimmed to
   *  this brightness (0–1). Responsive layouts dim by default (tune.focusDim). */
  focusDim?: number;
  /** Colour of the lines and rings joining a selected work to its linked works. */
  linkColour?: string;
  linkWidth?: number; // their line width, px (default 1.25)
  /** Circles marking linked works, and a selected or hovered work too small to
   *  outline (default true); without them, a 3px dot at each end of every line. */
  linkRings?: boolean;
  /** Radians per second the whole layout (names and links too) turns when idle. */
  rotate?: number;
  /** Lines between points, like a star chart's: x1, y1, x2, y2, strength (0–1). */
  links?: [number, number, number, number, number][];
  /** Radians per second each tile turns about the disc when idle. */
  spin?: Float32Array;
  stagger?: number; // ms from the first tile's flight to the last's (default STAGGER)
  /** How works joining fly in: from nearby (default), spiralling out from the disc, or
   *  trailing along the gradient (from a slot a little earlier in `t`), so the shape
   *  draws itself like a brushstroke. */
  enter?: "scatter" | "spiral" | "trail";
  /** Colour stops for the loading bar drawn beneath shapes without a disc. */
  gradient?: string[];
}

interface Cam { x: number; y: number; s: number } // centre in cells; CSS px per cell

/** Sprite sheet layout, each tile's texture coordinates, and each work's colour as
 *  OKLab (scripts/build_colourmaps.py): `colour.bin` (mean) or `signature.bin`
 *  (strongest hue, with its share). Throws if the data hasn't been built. */
export async function loadMosaicData(base = "/fields/maps", colours = "colour.bin") {
  const ok = (r: Response) => { if (!r.ok) throw new Error(r.url); return r; };
  const [atlas, lab]: [AtlasInfo, Float32Array] = await Promise.all([
    fetch(`${base}/atlas.json`).then(ok).then((r) => r.json()),
    fetch(`${base}/${colours}`).then(ok).then((r) => r.arrayBuffer()).then((b) => new Float32Array(b)),
  ]);
  const uvs = new Float32Array(atlas.count * 3);
  for (let i = 0; i < atlas.count; i++) {
    const j = i % atlas.perSheet;
    uvs[i * 3] = ((j % atlas.perRow) * atlas.tile) / atlas.sheet;
    uvs[i * 3 + 1] = (Math.floor(j / atlas.perRow) * atlas.tile) / atlas.sheet;
    uvs[i * 3 + 2] = Math.floor(i / atlas.perSheet);
  }
  return { base, atlas, uvs, lab };
}

const DURATION = 1100; // ms per tile flight
const STAGGER = 650; // ms from the start of the gradient to its end (by default)
const UPLOAD_PIXELS = 2048 * 128; // sprite sheet pixels per upload call (under ~1ms)
const UPLOAD_BUDGET = 4; // ms of uploads per frame
/** The feel of responsive layouts' motion and light (Constellation), read live, so the
 *  ?tune panel can adjust it while you watch. */
export const tune = {
  brushReach: 40, // px: how close the pointer must pass to touch a work
  brushGive: 0.1, // share of the pointer's movement passed to a work it touches
  brushMax: 4, // px: furthest it moves any work directly (disturbances carry further)
  brushCarry: 0.08, // share of the pointer's speed a touched work keeps
  springStiffness: 4, // rad/s: how briskly touched works spring back
  springDamping: 0.45, // below 1 overshoots a little; 1 and above glides home
  stirStrength: 7, // px: furthest the pointer's disturbance moves a work
  stirEvery: 150, // ms between the pointer's disturbances
  stirReach: 220, // px they spread before fading
  selectStrength: 12, // px: a selection's disturbance
  selectReach: 360, // px
  waveSpeed: 0.45, // px/ms a disturbance spreads out
  driftOut: 520, // ms: how quickly a work drifts out when one reaches it...
  driftBack: 3150, // ...and glides back
  depthFar: 0.3, // how far the farthest works drift, relative to the nearest
  depthDelay: 120, // ms the farthest lag the nearest
  spotRadius: 170, // px of the pointer's spotlight
  spotDim: 0.75, // brightness outside it
  focusDim: 0.22, // brightness of all but a selected work and its links
  twinkle: 0.4, // how bright a glint is
  turnSpeed: 1, // × the idle turn
};
export const TUNE_DEFAULTS = { ...tune };

/** How far a drift-and-glide goes at its peak, so a disturbance's strength is its
 *  furthest reach. */
const driftPeak = () => {
  const k = Math.log(1 + tune.driftBack / tune.driftOut);
  return (1 - Math.exp(-k)) * Math.exp(-(tune.driftOut / tune.driftBack) * k);
};
const DECODERS = 3; // workers decoding sprite sheets
// Worker: fetch an image and return its raw RGBA pixels (transferred, not copied).
const DECODER = `onmessage = async (e) => {
  const { url, ...job } = e.data;
  try {
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    postMessage({ ...job, width: bmp.width, height: bmp.height, data }, [data.buffer]);
  } catch {
    postMessage(job);
  }
};`;
const HI_LEVELS = 5; // 128px → 8px
const FADE = 700; // ms for a sprite sheet's images to fade in over the colours
const IDLE = 3000; // ms without input before rings start to drift
// Three levels of detail: 24px sprite tiles far out; 128px tiles from a cache filled
// with real thumbnails as tiles grow on screen; full thumbnails drawn over the top
// when even 128px isn't enough.
const SPRITE_MAX = 30; // device px a sprite tile can show sharply (24px source)
const SLOT = 128; // px per high-res tile
const SLOT_SHEET = 2048;
const SLOTS_PER_ROW = SLOT_SHEET / SLOT;
const SLOT_LAYERS = 6; // 6 × 256 = 1,536 high-res tiles
const MAX_LOADING = 16;
const OVERLAY_FROM = 150; // device px per tile above which the full thumbnail is drawn
const MAX_SCALE = 360;
/** Two repeatable numbers in [0, 1] per work (a PCG hash; the same in the shader). */
const jitter = (row: number): [number, number] => {
  let h = (Math.imul(row, 747796405) + 2891336453) >>> 0;
  h = Math.imul(((h >>> ((h >>> 28) + 4)) ^ h) >>> 0, 277803737) >>> 0;
  h = ((h >>> 22) ^ h) >>> 0;
  return [(h & 1023) / 1023, ((h >>> 10) & 1023) / 1023];
};

/** (x, y) turned by `a` radians (clockwise on screen) about `p`. */
const turnAbout = (x: number, y: number, p: { x: number; y: number }, a: number): [number, number] => {
  const c = Math.cos(a), s = Math.sin(a), dx = x - p.x, dy = y - p.y;
  return [p.x + dx * c - dy * s, p.y + dx * s + dy * c];
};

/** Pixel position and layer of a high-res slot. */
const slotPos = (slot: number) => {
  const j = slot % (SLOTS_PER_ROW * SLOTS_PER_ROW);
  return [(j % SLOTS_PER_ROW) * SLOT, Math.floor(j / SLOTS_PER_ROW) * SLOT, Math.floor(slot / (SLOTS_PER_ROW * SLOTS_PER_ROW))];
};
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;


const VERT = `#version 300 es
layout(location=0) in vec3 a_from;   // x, y, alpha
layout(location=1) in vec3 a_to;
layout(location=2) in float a_delay;
layout(location=3) in vec3 a_tint;
layout(location=4) in vec3 a_uv;     // u0, v0, sheet
layout(location=5) in vec4 a_shape;  // w, h (cells), rotation, corner radius fraction
layout(location=6) in vec3 a_hi;     // u0, v0, layer of a high-res tile, or layer -1
layout(location=7) in float a_spin;  // radians per second of drift about the pivot
layout(location=8) in vec2 a_offset; // cells: where a knock has moved it (springs back)
uniform vec2 u_view;      // canvas size, CSS px
uniform vec3 u_cam;       // centre x, y (cells), px per cell
uniform float u_time;     // ms since the layout change
uniform float u_duration;
uniform float u_gap;      // px between tiles
uniform float u_tileUv;   // tile size in uv units
uniform float u_slotUv;   // high-res tile size in uv units
uniform float u_drift;    // seconds of drift so far
uniform vec2 u_pivot;     // centre of the drift, cells
uniform float u_sheetFade[16]; // 0 until a sheet's images arrive, then up to 1
uniform float u_clock;    // seconds, for twinkling
uniform float u_twinkle;  // how bright a glint is (0 = none)
uniform vec3 u_mouse;     // pointer x, y (screen px), spotlight 0–1
uniform int u_focus[16];  // the selected work and its linked works (rows)
uniform int u_focusCount;
uniform float u_focusAmt; // how far everything else is dimmed, 0–1
uniform vec4 u_wave;      // disturbances: speed (px/ms), drift out, back (ms), peak
uniform vec4 u_look;      // spotlight radius (px), its dimming, focus dimming, glint
uniform vec2 u_depth;     // farthest works' share of the drift, and their lag (ms)
uniform vec4 u_waves[16];    // disturbances: source x, y (cells), start (s), strength (px)
uniform vec4 u_waveDirs[16]; // their push direction x, y and reach (px)
uniform int u_waveCount;
out float v_light;
out float v_fade;
out float v_glint;
out vec3 v_uv;
out vec3 v_hi;
out vec3 v_tint;
out float v_alpha;
out vec2 v_local;   // px from the tile centre, unrotated
out vec2 v_half;    // half the tile size, px
out float v_radius; // corner radius, px
float ease(float t) { return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0; }
void main() {
  vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  float e = ease(clamp((u_time - a_delay) / u_duration, 0.0, 1.0));
  vec2 p = mix(a_from.xy, a_to.xy, e);
  // A gentle arc instead of a straight line, bending one way or the other.
  vec2 d = a_to.xy - a_from.xy;
  float side = fract(sin(dot(a_to.xy, vec2(12.9898, 78.233))) * 43758.5453) > 0.5 ? 1.0 : -1.0;
  p += vec2(-d.y, d.x) * 0.18 * side * sin(3.14159 * e);
  float turn = a_spin * u_drift;
  float tc = cos(turn), ts = sin(turn);
  vec2 q0 = p - u_pivot;
  p = u_pivot + vec2(q0.x * tc - q0.y * ts, q0.x * ts + q0.y * tc) + a_offset;
  float alpha = mix(a_from.z, a_to.z, e);
  v_alpha = alpha;
  // Hidden tiles (most of the archive in Orbits and Colour maps) skip the rest.
  if (alpha < 0.01) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  float size = 0.35 + 0.65 * alpha;   // works joining grow in, leaving shrink out
  vec2 half_ = max(vec2(0.5), (a_shape.xy * u_cam.z * size - vec2(u_gap)) * 0.5);
  vec2 local = (corner * 2.0 - 1.0) * half_;
  float c = cos(a_shape.z + turn), s = sin(a_shape.z + turn);
  bool focused = false;
  for (int i = 0; i < 16; i++) {
    if (i >= u_focusCount) break;
    if (u_focus[i] == gl_InstanceID) focused = true;
  }
  // Spotlight: tiles near the pointer (170px) stay lit while everything else dims.
  vec2 at = (p - u_cam.xy) * u_cam.z + u_view * 0.5;
  vec2 dm = at - u_mouse.xy;
  float lit = exp(-dot(dm, dm) / (u_look.x * u_look.x));
  v_light = focused ? 1.0 : mix(1.0, u_look.y + (1.0 - u_look.y) * lit, u_mouse.z) * mix(1.0, u_look.z, u_focusAmt);
  // Disturbances spread out through space from where they started (u_wave.x); a tile
  // one reaches drifts outward and glides back, with no bounce, by less the further
  // away it is. Each tile has a depth: nearer ones drift further and sooner, farther
  // ones less and later, like parallax. Mirrored in MosaicView.stirred().
  uint h = uint(gl_InstanceID) * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  float j1 = float(h & 1023u) / 1023.0, j2 = float((h >> 10u) & 1023u) / 1023.0;
  float depth = u_depth.x + (1.0 - u_depth.x) * j1; // 1 = nearest
  if (!focused) {
    for (int k = 0; k < 16; k++) {
      if (k >= u_waveCount) break;
      vec4 w = u_waves[k], wd = u_waveDirs[k];
      vec2 rel = at - ((w.xy - u_cam.xy) * u_cam.z + u_view * 0.5);
      float r = length(rel);
      float since = (u_clock - w.z) * 1000.0 - r / u_wave.x - (1.0 - depth) * u_depth.y - (j2 - 0.5) * 60.0;
      if (since <= 0.0) continue;
      float amp = w.w * exp(-r / wd.z) * depth
                * (1.0 - exp(-since / u_wave.y)) * exp(-since / u_wave.z) / u_wave.w;
      vec2 dir = (r > 0.001 ? rel / r : vec2(0.0)) * 0.7 + wd.xy * 0.3;
      at += dir / max(length(dir), 0.001) * amp;
    }
  }
  vec2 px = at + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  gl_Position = alpha < 0.01 ? vec4(2.0, 2.0, 0.0, 1.0)
                             : vec4(px / u_view * 2.0 - 1.0, 0.0, 1.0) * vec4(1.0, -1.0, 1.0, 1.0);
  // Cover-crop the square tile to the shape's aspect ratio.
  vec2 crop = a_shape.xy / max(a_shape.x, a_shape.y);
  v_uv = vec3(a_uv.xy + (0.5 + (corner - 0.5) * crop) * u_tileUv, a_uv.z);
  v_hi = vec3(a_hi.xy + (0.5 + (corner - 0.5) * crop) * u_slotUv, a_hi.z);
  v_tint = a_tint;
  v_fade = a_hi.z >= 0.0 ? 1.0 : u_sheetFade[int(a_uv.z)];
  v_local = local;
  v_half = half_;
  // Tiles only a pixel or two across drop the rounding, so they stay bright.
  v_radius = a_shape.w * 2.0 * min(half_.x, half_.y) * smoothstep(1.0, 3.0, min(half_.x, half_.y));
  // Twinkle: each tile on its own slow rhythm (every 10–25s) glints for a moment,
  // only while it's a speck (never an artwork you're looking at).
  float id = float(gl_InstanceID);
  float phase = fract(sin(id * 12.9898) * 43758.5453);
  float rate = 0.04 + 0.06 * fract(sin(id * 78.233) * 12345.678);
  float wave = 0.5 + 0.5 * sin(6.28318 * (u_clock * rate + phase));
  v_glint = u_twinkle * (1.0 - smoothstep(1.5, 5.0, min(half_.x, half_.y))) * pow(wave, 60.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray u_atlas;
uniform sampler2DArray u_hi;
uniform float u_tintAmt;
in vec3 v_uv;
in vec3 v_hi;
in vec3 v_tint;
in float v_fade;
in float v_light;
in float v_glint;
in float v_alpha;
in vec2 v_local;
in vec2 v_half;
in float v_radius;
out vec4 colour;
void main() {
  // Rounded-rectangle mask with a one-pixel soft edge.
  vec2 q = abs(v_local) - v_half + v_radius;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - v_radius;
  float a = v_alpha * clamp(0.5 - d, 0.0, 1.0);
  vec3 c = v_hi.z >= 0.0 ? texture(u_hi, v_hi).rgb : texture(u_atlas, v_uv).rgb;
  c = mix(mix(c, v_tint, max(u_tintAmt, 1.0 - v_fade)), vec3(1.0), v_glint) * v_light;
  colour = vec4(c * a, a);
}`;

class ImageCache {
  private map = new Map<string, HTMLImageElement | "loading" | "missing">();
  constructor(private limit: number, private onLoad: () => void) {}
  get(url: string): HTMLImageElement | null {
    const v = this.map.get(url);
    if (v instanceof HTMLImageElement) { this.map.delete(url); this.map.set(url, v); return v; }
    if (v === undefined) {
      this.map.set(url, "loading");
      const img = new Image();
      img.onload = () => {
        this.map.set(url, img);
        for (const [k, x] of this.map) { if (this.map.size <= this.limit) break; if (x instanceof HTMLImageElement) this.map.delete(k); }
        this.onLoad();
      };
      img.onerror = () => this.map.set(url, "missing");
      img.src = url;
    }
    return null;
  }
}

export class MosaicView {
  readonly cam: Cam = { x: 0, y: 0, s: 4 };
  private gl: WebGL2RenderingContext;
  private overlay: CanvasRenderingContext2D;
  private prog: WebGLProgram;
  private buf: Record<"from" | "to" | "delay" | "tint" | "shape" | "hi" | "spin" | "offset", WebGLBuffer>;
  // Loading: when each sprite sheet arrived, and the clock around the sun.
  private sheetAt: number[];
  private clock = { shown: 0, gone: 0 };
  // Idle drift: per artwork, radians per second about the pivot; seconds so far.
  private spin: Float32Array;
  private drift = 0;
  private driftRate = 0;
  private pivot = { x: 0, y: 0 };
  private lastInput = 0;
  private lastFrame = 0;
  private hashDrift = 0; // the drift the hit-test hash was built at
  // When every tile turns alike (or none do), the hash keeps their resting places
  // and lookups turn the query back instead of rebuilding it as tiles move.
  private uniformSpin: number | null = 0;
  private turnCache = { turn: 0, cos: 1, sin: 0 };
  private textWidths = new Map<string, number>();
  // Placed works biggest first, with their sizes (cells), to find those big enough
  // on screen to need something without looking at every work.
  private bySize = new Int32Array(0);
  private sizeOf = new Float32Array(0);
  private stagger = STAGGER;
  private atlasTex!: WebGLTexture;
  // Decoded sheet images (each mip level separately), not yet on the GPU.
  private uploads: { sheet: number; level: number; width: number; height: number; data: Uint8Array; row: number }[] = [];
  private sheetLeft: number[] = []; // levels of each sheet still to upload
  private mipsShipped = false;
  private hiReady = false;
  private startPending = false; // the entrance clock starts on the first frame drawn
  private gradient: string[] | null = null;
  private labels: NonNullable<Layout["labels"]> = [];
  private links: NonNullable<Layout["links"]> = [];
  private linked: number[] = []; // works joined to the selected one by lines
  private maxSize = 1; // the widest tile, cells
  private twinkle = false;
  // Responsive layouts: where the pointer is, how hard it's pushing (from its speed),
  // the spotlight, a selection's shockwave, and the works kept lit when selected.
  private lively = false;
  private pointer = { x: -1e5, y: -1e5, inside: false, speed: 0, dx: 0, dy: 0, movedAt: 0 };
  private livelyAt = 0;
  private dragging = false;
  private mouse = { x: -1e5, y: -1e5, spot: 0 };
  // Knocks: each work's offset and velocity (cells), springing back to rest.
  private offset: Float32Array;
  private velocity: Float32Array;
  private moving = new Set<number>();
  // Disturbances spreading out: from the moving pointer, and from a selected work.
  private waves: { x: number; y: number; t0: number; amp: number; dx: number; dy: number; reach: number; life: number; big: boolean }[] = [];
  private waveAt = 0;
  private focusRows: number[] = [];
  private focusSet = new Set<number>();
  private focusAmt = 0;
  private focusOn = false; // this layout dims around a selection
  private focusDim: number | null = null; // its brightness, or null for tune.focusDim
  private linkColour = "rgba(239, 106, 76, 0.75)";
  private linkWidth = 1.25;
  private linkRings = true;
  private focusAt = 0;
  private rotate = 0; // rad/s the whole layout turns when idle (names and links follow)
  private lastAmbient = 0;
  private readonly born = performance.now();
  // High-res tile cache: which slot holds which artwork, and when it was last on screen.
  private hiTex: WebGLTexture;
  private slotOfRow: Int32Array;
  private rowOfSlot = new Int32Array(SLOTS_PER_ROW * SLOTS_PER_ROW * SLOT_LAYERS).fill(-1);
  private slotUsed = new Float64Array(SLOTS_PER_ROW * SLOTS_PER_ROW * SLOT_LAYERS);
  private loadingRows = new Set<number>();
  private slotCanvases = Array.from({ length: HI_LEVELS }, (_, level) =>
    Object.assign(document.createElement("canvas"), { width: SLOT >> level, height: SLOT >> level }));
  private lastUpgrade = 0;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private n: number;
  // Per artwork: where its current flight starts and ends.
  private from: Float32Array;
  private to: Float32Array;
  private delay: Float32Array;
  private start = 0;
  private layout: Layout | null = null;
  // Per artwork in the current layout: size (cells), rotation and corner radius.
  private shape: Float32Array;
  private placedRows: Int32Array = new Int32Array(0);
  private placed = new Set<number>();
  private hash = new Map<number, number[]>(); // floor(centre) key -> rows, for hit testing
  private bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };
  /** Screen px covered by panels on either side, kept clear when fitting the shape.
   *  The left panel only reaches `insetLeftBottom` px down, so a shape that passes
   *  beneath it (a wide band) can use the full width. */
  insetRight = 0;
  insetLeft = 0;
  private insetLeftBottom = Infinity;
  private w = 0;
  private h = 0;
  private dirty = true;
  private destroyed = false;
  private anim: { from: Cam; to: Cam; t0: number; ms: number } | null = null;
  private disc: Layout["disc"] | null = null;
  private thumbs: ImageCache;
  private cleanup: (() => void)[] = [];
  hovered: number | null = null;
  selected: number | null = null;

  constructor(private canvas: HTMLCanvasElement, private top: HTMLCanvasElement, base: string,
              atlas: AtlasInfo, uvs: Float32Array, private opts: MosaicOptions) {
    // ?capture keeps the drawn frame readable, so a page capture (e.g. into Figma) gets it.
    const keep = new URLSearchParams(location.search).has("capture");
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: keep });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.overlay = top.getContext("2d")!;
    // Names are measured once and cached; measure again once the web fonts arrive.
    document.fonts?.ready.then(() => { this.textWidths.clear(); this.invalidate(); });
    this.n = atlas.count;
    this.from = new Float32Array(this.n * 3);
    this.to = new Float32Array(this.n * 3);
    this.delay = new Float32Array(this.n);
    this.shape = new Float32Array(this.n * 4);
    this.slotOfRow = new Int32Array(this.n).fill(-1);
    this.spin = new Float32Array(this.n);
    this.offset = new Float32Array(this.n * 2);
    this.velocity = new Float32Array(this.n * 2);
    this.lastInput = performance.now();
    this.sheetAt = new Array(atlas.sheets).fill(Infinity);
    this.thumbs = new ImageCache(400, () => this.invalidate());

    this.prog = this.program();
    for (const name of ["u_view", "u_cam", "u_time", "u_duration", "u_gap", "u_tileUv", "u_slotUv", "u_tintAmt", "u_atlas", "u_hi", "u_drift", "u_pivot", "u_sheetFade", "u_clock", "u_twinkle",
                      "u_mouse", "u_focus", "u_focusCount", "u_focusAmt",
                      "u_waves", "u_waveDirs", "u_waveCount", "u_wave", "u_look", "u_depth"]) {
      this.u[name] = gl.getUniformLocation(this.prog, name);
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const attrib = (loc: number, size: number, data: Float32Array) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(loc, 1);
      return b;
    };
    this.buf = {
      from: attrib(0, 3, this.from), to: attrib(1, 3, this.to),
      delay: attrib(2, 1, this.delay), tint: attrib(3, 3, new Float32Array(this.n * 3)),
      shape: attrib(5, 4, this.shape),
      hi: attrib(6, 3, new Float32Array(this.n * 3).map((_, i) => (i % 3 === 2 ? -1 : 0))),
      spin: attrib(7, 1, this.spin),
      offset: attrib(8, 2, this.offset),
    };
    attrib(4, 3, uvs);

    // Texture array: one layer per sprite sheet, filled in as each loads.
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 4, gl.RGBA8, atlas.sheet, atlas.sheet, atlas.sheets);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, 3); // 24px → 3px tiles
    // Sheets and their smaller sizes (shipped as files) are decoded to raw pixels in
    // workers, then copied to the GPU a few milliseconds' worth per frame, so the
    // entrance never stalls. (Uploading an <img> decodes it on the main thread, ~170ms
    // a sheet; even an ImageBitmap costs 10–60ms per upload; regenerating mipmaps for
    // the whole array costs up to ~90ms.)
    this.atlasTex = tex!;
    const levels = atlas.levels ?? 1;
    this.mipsShipped = levels > 1;
    this.sheetLeft = new Array(atlas.sheets).fill(levels);
    const files: { sheet: number; level: number; url: string }[] = [];
    for (let s = 0; s < atlas.sheets; s++) { // sheet by sheet, so they complete (and fade in) in turn
      for (let level = 0; level < levels; level++) {
        files.push({ sheet: s, level,
                     url: new URL(`${base}/atlas-${String(s).padStart(2, "0")}${level ? `-${level}` : ""}.webp`, location.href).href });
      }
    }
    const workerUrl = URL.createObjectURL(new Blob([DECODER], { type: "text/javascript" }));
    for (let w = 0; w < DECODERS; w++) {
      const worker = new Worker(workerUrl);
      const next = () => {
        const file = files.shift();
        if (file && !this.destroyed) worker.postMessage(file); else worker.terminate();
      };
      worker.onmessage = (e: MessageEvent<{ sheet: number; level: number; width: number; height: number; data?: Uint8ClampedArray }>) => {
        const { data, ...job } = e.data;
        if (data) this.uploads.push({ ...job, data: new Uint8Array(data.buffer), row: 0 });
        next();
      };
      next();
      this.cleanup.push(() => worker.terminate());
    }
    URL.revokeObjectURL(workerUrl);
    // The high-res tile cache is only allocated when first needed (zooming in); until
    // then a 1×1 placeholder keeps the sampler complete.
    this.hiTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.hiTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);

    gl.useProgram(this.prog);
    gl.uniform1f(this.u.u_tileUv, atlas.tile / atlas.sheet);
    gl.uniform1f(this.u.u_slotUv, SLOT / SLOT_SHEET);
    gl.uniform1i(this.u.u_hi, 1);
    gl.uniform1f(this.u.u_duration, DURATION);
    gl.uniform1i(this.u.u_atlas, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this.resize();
    const ro = new ResizeObserver(() => { this.resize(); this.invalidate(); });
    ro.observe(canvas);
    this.cleanup.push(() => ro.disconnect());
    this.bindInput();
    const loop = () => {
      if (this.destroyed) return;
      requestAnimationFrame(loop); // first, so an error in one frame can't stop the next
      this.stepCamera();
      const now = performance.now();
      if (this.startPending) this.start = now;
      this.uploadStrip(now);
      const loading = this.loadingVisible(now);
      const animating = loading || now - this.start < this.stagger + DURATION + 50;
      this.stepDrift(now);
      this.stepLively(now);
      this.stepFocus(now);
      if (now - this.lastUpgrade > 120) { this.lastUpgrade = now; this.upgrade(); }
      // Ambient life (twinkling) needs frames, but ~30 a second is plenty.
      const ambient = this.twinkle && !reducedMotion() && now - this.lastAmbient > 33;
      if (ambient) this.lastAmbient = now;
      if (this.dirty || animating || this.startPending) { this.draw(); this.dirty = false; }
      else if (ambient) this.drawTiles(); // twinkling only: names, lines and outlines are unchanged
      // Time the entrance from the end of its first frame, which can be slow (the GPU
      // commits texture memory on first use), so that frame's cost can't jump it ahead.
      if (this.startPending) { this.start = performance.now(); this.startPending = false; }
    };
    requestAnimationFrame(loop);
  }

  destroy() {
    this.destroyed = true;
    this.cleanup.forEach((f) => f());
    this.uploads = [];
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  invalidate() { this.dirty = true; }

  private program() {
    const gl = this.gl;
    const shader = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
      return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    return p;
  }

  // ── layout ────────────────────────────────────────────────────────────────

  /** Show a layout, flying tiles from where they are. With animateIn, even a first
   *  layout animates: tiles grow in from nearby, in order of `t`. */
  setLayout(layout: Layout, { animateIn = false } = {}) {
    const animate = !reducedMotion() && (this.layout !== null || animateIn);
    const now = performance.now();
    const shaped = layout.w !== undefined;
    const centreX = (i: number) => layout.x[i] + (shaped ? 0 : 0.5);
    const centreY = (i: number) => layout.y[i] + (shaped ? 0 : 0.5);
    // Centre the new shape on the origin so shapes overlap as they change.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < layout.rows.length; i++) {
      const r = shaped ? Math.max(layout.w![i], layout.h![i]) / 2 : 0.5;
      x0 = Math.min(x0, centreX(i) - r); y0 = Math.min(y0, centreY(i) - r);
      x1 = Math.max(x1, centreX(i) + r); y1 = Math.max(y1, centreY(i) + r);
    }
    if (layout.fitTrim) { // the extent of all but the outermost few, along each axis
      const n = layout.rows.length, lo = Math.floor(layout.fitTrim * n), hi = Math.max(lo, n - 1 - lo);
      const xs = Float32Array.from({ length: n }, (_, i) => centreX(i)).sort();
      const ys = Float32Array.from({ length: n }, (_, i) => centreY(i)).sort();
      [x0, x1, y0, y1] = [xs[lo] - 0.5, xs[hi] + 0.5, ys[lo] - 0.5, ys[hi] + 0.5];
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    this.bounds = { x0: x0 - cx, y0: y0 - cy, x1: x1 - cx, y1: y1 - cy };
    this.disc = layout.disc ? { ...layout.disc, x: layout.disc.x - cx, y: layout.disc.y - cy } : null;
    this.gradient = layout.gradient ?? null;
    // Labels in order of drawing priority (systems first, bigger first), and links,
    // moved like the tiles so the shape is centred.
    this.twinkle = layout.twinkle ?? false;
    this.lively = layout.lively ?? false;
    this.focusOn = layout.focusDim !== undefined || this.lively;
    this.focusDim = layout.focusDim ?? null;
    this.linkColour = layout.linkColour ?? "rgba(239, 106, 76, 0.75)";
    this.linkWidth = layout.linkWidth ?? 1.25;
    this.linkRings = layout.linkRings ?? true;
    this.rotate = layout.rotate ?? 0;
    this.labels = (layout.labels ?? []).map((l) => ({ ...l, x: l.x - cx, y: l.y - cy }))
      .sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || (b.size ?? 0) - (a.size ?? 0));
    this.links = (layout.links ?? []).map(([x1, y1, x2, y2, k]) => [x1 - cx, y1 - cy, x2 - cx, y2 - cy, k]);
    this.linked = [];
    const stagger = layout.stagger ?? STAGGER;
    const spiral = layout.enter === "spiral";
    // For a trail: where each slot comes from, a few percent earlier along the gradient.
    const source = new Int32Array(layout.rows.length);
    if (layout.enter === "trail") {
      const order = [...source.keys()].sort((p, q) => layout.t[p] - layout.t[q]);
      const lag = Math.max(1, Math.round(order.length * 0.05));
      order.forEach((slot, rank) => { source[slot] = order[Math.max(0, rank - lag)]; });
    }
    const slotOf = new Int32Array(this.n).fill(-1);
    layout.rows.forEach((row, i) => { slotOf[row] = i; });
    const oldPivot = this.pivot, oldTurn = this.drift;
    const pivot = this.disc ? { x: this.disc.x, y: this.disc.y } : { x: 0, y: 0 };
    const spin = new Float32Array(this.n);
    let maxSize = 1;

    const nextFrom = new Float32Array(this.n * 3);
    const nextTo = new Float32Array(this.n * 3);
    const nextDelay = new Float32Array(this.n);
    const tint = new Float32Array(this.n * 3);
    const shape = new Float32Array(this.n * 4);
    const placed = new Uint8Array(this.n);
    this.hash.clear();
    for (let i = 0; i < layout.rows.length; i++) {
      const row = layout.rows[i];
      const x = centreX(i) - cx, y = centreY(i) - cy;
      placed[row] = 1;
      const key = Math.floor(x) * 100000 + Math.floor(y);
      const bucket = this.hash.get(key);
      if (bucket) bucket.push(row); else this.hash.set(key, [row]);
      const k4 = row * 4, k3 = row * 3;
      shape[k4] = shaped ? layout.w![i] : 1;
      shape[k4 + 1] = shaped ? layout.h![i] : 1;
      shape[k4 + 2] = layout.rot?.[i] ?? 0;
      shape[k4 + 3] = layout.round ?? 0;
      maxSize = Math.max(maxSize, shape[k4], shape[k4 + 1]);
      spin[row] = layout.spin?.[i] ?? layout.rotate ?? 0;
      nextTo[k3] = x; nextTo[k3 + 1] = y; nextTo[k3 + 2] = 1;
      tint[k3] = layout.slotRgb[i * 3]; tint[k3 + 1] = layout.slotRgb[i * 3 + 1]; tint[k3 + 2] = layout.slotRgb[i * 3 + 2];
      nextDelay[row] = animate ? layout.t[i] * stagger + Math.random() * 120 : -DURATION;
    }
    for (let row = 0; row < this.n; row++) {
      const k3 = row * 3, k4 = row * 4;
      let px = 0, py = 0, pa = 0;
      if (animate) {
        const t = Math.min(1, Math.max(0, (now - this.start - this.delay[row]) / DURATION));
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        const f = this.from, o = this.to;
        px = f[k3] + (o[k3] - f[k3]) * e;
        py = f[k3 + 1] + (o[k3 + 1] - f[k3 + 1]) * e;
        pa = f[k3 + 2] + (o[k3 + 2] - f[k3 + 2]) * e;
        if (this.spin[row] !== 0) [px, py] = turnAbout(px, py, oldPivot, this.spin[row] * oldTurn); // where it has drifted
      }
      if (placed[row]) {
        if (pa > 0.01) { nextFrom[k3] = px; nextFrom[k3 + 1] = py; nextFrom[k3 + 2] = pa; } // showing: fly over
        else {
          if (layout.enter === "trail") {
            const j = source[slotOf[row]];
            nextFrom[k3] = centreX(j) - cx;
            nextFrom[k3 + 1] = centreY(j) - cy;
          } else if (spiral) {
            // joining: spiral out from the sun, a little behind where it's going
            const [sx, sy] = turnAbout(nextTo[k3], nextTo[k3 + 1], pivot, -0.7);
            nextFrom[k3] = pivot.x + (sx - pivot.x) * 0.3;
            nextFrom[k3 + 1] = pivot.y + (sy - pivot.y) * 0.3;
          } else {
            // joining: start just off its spot, scattered, and grow in
            const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 18;
            nextFrom[k3] = nextTo[k3] + Math.cos(a) * r;
            nextFrom[k3 + 1] = nextTo[k3 + 1] + Math.sin(a) * r;
          }
          nextFrom[k3 + 2] = 0;
        }
      } else {
        // leaving (or never shown): shrink out where it is, keeping its shape
        for (let j = 0; j < 4; j++) shape[k4 + j] = this.shape[k4 + j];
        nextFrom[k3] = px; nextFrom[k3 + 1] = py; nextFrom[k3 + 2] = pa;
        nextTo[k3] = px; nextTo[k3 + 1] = py; nextTo[k3 + 2] = 0;
        nextDelay[row] = animate ? Math.random() * 200 : -DURATION;
      }
    }
    this.from = nextFrom;
    this.to = nextTo;
    this.delay = nextDelay;
    this.shape = shape;
    this.spin = spin;
    this.uniformSpin = layout.spin ? null : layout.rotate ?? 0;
    this.offset.fill(0);
    this.velocity.fill(0);
    this.moving.clear();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buf.offset);
    this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, this.offset);
    this.maxSize = maxSize;
    this.pivot = pivot;
    this.drift = 0;
    this.hashDrift = 0;
    this.stagger = stagger;
    this.placedRows = layout.rows;
    this.bySize = Int32Array.from(layout.rows).sort((p, q) =>
      Math.max(shape[q * 4], shape[q * 4 + 1]) - Math.max(shape[p * 4], shape[p * 4 + 1]));
    this.sizeOf = Float32Array.from(this.bySize, (r) => Math.max(shape[r * 4], shape[r * 4 + 1]));
    this.placed = new Set(layout.rows);
    this.start = now;
    this.startPending = true; // not before the frame: setup work would eat the first frames
    const gl = this.gl;
    for (const [key, data] of [["from", nextFrom], ["to", nextTo], ["delay", nextDelay], ["tint", tint],
                               ["shape", shape], ["spin", spin]] as const) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf[key]);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    }
    const first = this.layout === null;
    this.layout = layout;
    this.selected = null;
    this.fit(!first);
  }

  // ── camera ────────────────────────────────────────────────────────────────

  private scaleFor(left: number) {
    const { x0, y0, x1, y1 } = this.bounds;
    return Math.min((this.w - left - this.insetRight) / (x1 - x0 + 16), this.h / (y1 - y0 + 16));
  }

  /** The left inset to fit around: none if the shape, fitted without it, passes
   *  beneath the left panel. */
  private leftInset() {
    if (!this.insetLeft) return 0;
    const top = this.h / 2 + this.bounds.y0 * this.scaleFor(0); // shapes are centred on y = 0
    return top >= this.insetLeftBottom + 12 ? 0 : this.insetLeft;
  }

  private fitScale() { return this.scaleFor(this.leftInset()); }

  /** Fit the whole shape into the area between any side panels. */
  fit(animate = true) {
    const left = this.leftInset();
    const s = this.scaleFor(left);
    this.flyTo({ x: (this.insetRight - left) / (2 * s), y: 0, s }, animate ? 900 : 0);
  }

  /** Keep a panel `px` wide (reaching `bottom` px down the canvas) clear on the left. */
  setInsetLeft(px: number, bottom = Infinity) {
    this.insetLeft = px;
    this.insetLeftBottom = bottom;
    this.fit(false);
  }

  flyTo(to: Partial<Cam>, ms = 700) {
    const target = { ...this.cam, ...to };
    target.s = Math.min(MAX_SCALE, Math.max(this.fitScale() * 0.5, target.s));
    if (ms === 0 || reducedMotion()) { Object.assign(this.cam, target); this.invalidate(); return; }
    this.anim = { from: { ...this.cam }, to: target, t0: performance.now(), ms };
  }

  flyToRow(row: number, s = 140) {
    const [x, y] = this.centre(row);
    this.flyTo({ x, y, s });
  }

  /** Fly to show these works together, clear of the side panels and `right` px more
   *  (e.g. an open card), zoomed in no further than `maxScale`. */
  frameRows(rows: number[], right = 0, maxScale = 60) {
    rows = rows.filter((r) => this.placed.has(r)); // only works in this layout
    if (!rows.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const row of rows) {
      const [x, y] = this.centre(row);
      const r = Math.max(this.shape[row * 4], this.shape[row * 4 + 1]) / 2;
      x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r);
      x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r);
    }
    const left = this.leftInset();
    const s = Math.max(this.fitScale() * 0.5, Math.min(maxScale, // may zoom out past the fit, as far as zooming allows
      (this.w - left - this.insetRight - right - 80) / (x1 - x0), (this.h - 120) / (y1 - y0)));
    this.flyTo({ x: (x0 + x1) / 2 - (left - this.insetRight - right) / (2 * s), y: (y0 + y1) / 2, s }, 900);
  }

  zoomBy(f: number, sx = this.w / 2, sy = this.h / 2) {
    const [fx, fy] = this.toField(sx, sy);
    const s = Math.min(MAX_SCALE, Math.max(this.fitScale() * 0.5, this.cam.s * f));
    this.anim = null;
    this.cam.x = fx - (sx - this.w / 2) / s;
    this.cam.y = fy - (sy - this.h / 2) / s;
    this.cam.s = s;
    this.invalidate();
  }

  private stepCamera() {
    if (!this.anim) return;
    const { from, to, t0, ms } = this.anim;
    const t = Math.min(1, (performance.now() - t0) / ms);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this.cam.s = Math.exp(Math.log(from.s) + (Math.log(to.s) - Math.log(from.s)) * e);
    this.cam.x = from.x + (to.x - from.x) * e;
    this.cam.y = from.y + (to.y - from.y) * e;
    if (t >= 1) this.anim = null;
    this.invalidate();
  }

  toField(sx: number, sy: number): [number, number] {
    return [this.cam.x + (sx - this.w / 2) / this.cam.s, this.cam.y + (sy - this.h / 2) / this.cam.s];
  }

  /** Where an artwork's tile has settled, including any drift: centre and rotation. */
  private centre(row: number): [number, number, number] {
    const x = this.to[row * 3], y = this.to[row * 3 + 1], rot = this.shape[row * 4 + 2];
    const ox = this.offset[row * 2], oy = this.offset[row * 2 + 1];
    const turn = this.spin[row] * this.drift;
    if (turn === 0) return [x + ox, y + oy, rot];
    const t = this.turnCache;
    if (turn !== t.turn) { t.turn = turn; t.cos = Math.cos(turn); t.sin = Math.sin(turn); }
    const dx = x - this.pivot.x, dy = y - this.pivot.y;
    return [this.pivot.x + dx * t.cos - dy * t.sin + ox, this.pivot.y + dx * t.sin + dy * t.cos + oy, rot + turn];
  }

  /** Is field point (fx, fy) inside this artwork's (possibly rotated) tile? */
  private contains(row: number, fx: number, fy: number) {
    const k = row * 4;
    const [cx, cy, rot] = this.centre(row);
    const [w, h] = [this.shape[k], this.shape[k + 1]];
    const dx = fx - cx, dy = fy - cy;
    const c = Math.cos(-rot), s = Math.sin(-rot);
    return Math.abs(dx * c - dy * s) <= w / 2 && Math.abs(dx * s + dy * c) <= h / 2;
  }

  /** A field point turned back to where tiles rest, for looking up the hash. */
  private atRest(fx: number, fy: number): [number, number] {
    if (this.uniformSpin === null) {
      if (this.drift !== this.hashDrift) this.rehash(); // tiles turn differently: track them
      return [fx, fy];
    }
    const turn = this.uniformSpin * this.drift;
    return turn ? turnAbout(fx, fy, this.pivot, -turn) : [fx, fy];
  }

  /** Works whose centres lie in this field rectangle: from the hash's cells when
   *  that's fewer to look at than every work, else by checking them all. */
  private visible(fx0: number, fy0: number, fx1: number, fy1: number): number[] {
    const out: number[] = [];
    const corners = [[fx0, fy0], [fx1, fy0], [fx0, fy1], [fx1, fy1]].map(([x, y]) => this.atRest(x, y));
    const pad = 1 + this.maxSize / 2 + tune.brushMax / this.cam.s; // tiles nudged off their cell
    const bx0 = Math.floor(Math.min(...corners.map((c) => c[0])) - pad), bx1 = Math.floor(Math.max(...corners.map((c) => c[0])) + pad);
    const by0 = Math.floor(Math.min(...corners.map((c) => c[1])) - pad), by1 = Math.floor(Math.max(...corners.map((c) => c[1])) + pad);
    const inside = (row: number) => {
      const [x, y] = this.centre(row);
      return x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1;
    };
    if ((bx1 - bx0 + 1) * (by1 - by0 + 1) > this.placedRows.length) {
      for (const row of this.placedRows) if (inside(row)) out.push(row);
      return out;
    }
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let by = by0; by <= by1; by++) {
        const bucket = this.hash.get(bx * 100000 + by);
        if (bucket) for (const row of bucket) if (inside(row)) out.push(row);
      }
    }
    return out;
  }

  /** Works at least `minCells` across with centres in this field rectangle: from the
   *  biggest-first list when few are that big, else from the visible area. */
  private bigAndVisible(minCells: number, fx0: number, fy0: number, fx1: number, fy1: number): number[] {
    let lo = 0, hi = this.sizeOf.length; // how many are at least minCells (sizes descend)
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.sizeOf[mid] >= minCells) lo = mid + 1; else hi = mid; }
    if (lo > 20000) return this.visible(fx0, fy0, fx1, fy1).filter((r) => Math.max(this.shape[r * 4], this.shape[r * 4 + 1]) >= minCells);
    const out: number[] = [];
    for (let i = 0; i < lo; i++) {
      const row = this.bySize[i];
      const [x, y] = this.centre(row);
      if (x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1) out.push(row);
    }
    return out;
  }

  rowAt(sx: number, sy: number): number | null {
    const [fx, fy] = this.toField(sx, sy);
    const [rx, ry] = this.atRest(fx, fy);
    const bx = Math.floor(rx), by = Math.floor(ry);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (const row of this.hash.get((bx + dx) * 100000 + (by + dy)) ?? []) {
          if (this.contains(row, fx, fy)) return row;
        }
      }
    }
    return null;
  }

  /** Rebuild the hit-test hash where tiles have drifted to (when they turn
   *  differently, as Orbits' rings do). */
  private rehash() {
    this.hash.clear();
    for (const row of this.placedRows) {
      const [x, y] = this.centre(row);
      const key = Math.floor(x) * 100000 + Math.floor(y);
      const bucket = this.hash.get(key);
      if (bucket) bucket.push(row); else this.hash.set(key, [row]);
    }
    this.hashDrift = this.drift;
  }

  randomRow(): number | null {
    if (!this.layout) return null;
    return this.layout.rows[Math.floor(Math.random() * this.layout.rows.length)];
  }

  // ── high-res tiles ────────────────────────────────────────────────────────

  /** Give tiles on screen that are too big for their sprite a 128px copy of their
   *  thumbnail, nearest the centre first. Slots of works off screen are recycled. */
  private upgrade() {
    if (!this.layout) return;
    const dpr = window.devicePixelRatio || 1;
    const s = this.cam.s;
    if (s * dpr * 3 < SPRITE_MAX) return; // every tile still fits its sprite
    const now = performance.now();
    const [fx0, fy0] = this.toField(-s * 2, -s * 2);
    const [fx1, fy1] = this.toField(this.w + s * 2, this.h + s * 2);
    const want: [number, number][] = [];
    for (const row of this.bigAndVisible(SPRITE_MAX / (s * dpr), fx0, fy0, fx1, fy1)) {
      const [x, y] = this.centre(row);
      const slot = this.slotOfRow[row];
      if (slot >= 0) { this.slotUsed[slot] = now; continue; }
      if (this.loadingRows.has(row)) continue;
      want.push([row, (x - this.cam.x) ** 2 + (y - this.cam.y) ** 2]);
    }
    want.sort((a, b) => a[1] - b[1]);
    for (const [row] of want.slice(0, MAX_LOADING - this.loadingRows.size)) this.loadHi(row);
  }

  /** A free slot, or the one off screen longest (not seen for a couple of seconds). */
  private freeSlot(): number {
    let best = -1, oldest = performance.now() - 2000;
    for (let i = 0; i < this.rowOfSlot.length; i++) {
      if (this.rowOfSlot[i] < 0) return i;
      if (this.slotUsed[i] < oldest) { oldest = this.slotUsed[i]; best = i; }
    }
    return best;
  }

  private loadHi(row: number) {
    this.loadingRows.add(row);
    const img = new Image();
    img.src = this.opts.thumbUrl(row);
    img.decode().then(() => {
      if (this.destroyed) return;
      const slot = this.freeSlot();
      if (slot < 0) return; // every slot is on screen; try again later
      const gl = this.gl;
      const old = this.rowOfSlot[slot];
      if (old >= 0) { this.slotOfRow[old] = -1; this.setHi(old, -1); }
      if (!this.hiReady) this.allocateHi();
      // Centre-square crop, like the sprites, and each smaller size from the last
      // (only this slot's, rather than regenerating mipmaps for the whole array).
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const [x, y, layer] = slotPos(slot);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.hiTex);
      let src: CanvasImageSource = img, sx = (img.naturalWidth - side) / 2, sy = (img.naturalHeight - side) / 2, sw = side;
      this.slotCanvases.forEach((canvas, level) => {
        const size = SLOT >> level;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!; // CPU-backed: quick to upload
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(src, sx, sy, sw, sw, 0, 0, size, size);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, level, x >> level, y >> level, layer, size, size, 1, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        src = canvas; sx = 0; sy = 0; sw = size;
      });
      gl.activeTexture(gl.TEXTURE0);
      this.rowOfSlot[slot] = row;
      this.slotOfRow[row] = slot;
      this.slotUsed[slot] = performance.now();
      this.setHi(row, slot);
      this.invalidate();
    }).catch(() => {}).finally(() => this.loadingRows.delete(row));
  }

  /** Point a work at its high-res slot, or back at its sprite (slot -1). */
  private setHi(row: number, slot: number) {
    const gl = this.gl;
    const [x, y, layer] = slot >= 0 ? slotPos(slot) : [0, 0, -1];
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.hi);
    gl.bufferSubData(gl.ARRAY_BUFFER, row * 12, new Float32Array([x / SLOT_SHEET, y / SLOT_SHEET, layer]));
  }

  // ── loading and drift ─────────────────────────────────────────────────────

  /** Copy decoded sheet pixels to the GPU, a strip at a time, for up to a few
   *  milliseconds; when all of a sheet's sizes are in, start its images fading in. */
  private uploadStrip(now: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTex);
    while (this.uploads.length && performance.now() - now < UPLOAD_BUDGET) {
      const job = this.uploads[0];
      const rows = Math.min(Math.floor(UPLOAD_PIXELS / job.width), job.height - job.row);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, job.level, 0, job.row, job.sheet, job.width, rows, 1, gl.RGBA,
                       gl.UNSIGNED_BYTE, job.data.subarray(job.row * job.width * 4, (job.row + rows) * job.width * 4));
      job.row += rows;
      if (job.row < job.height) continue;
      this.uploads.shift();
      if (--this.sheetLeft[job.sheet] > 0) continue;
      if (!this.mipsShipped) gl.generateMipmap(gl.TEXTURE_2D_ARRAY); // older data: no level files
      this.sheetAt[job.sheet] = now;
      this.invalidate();
    }
  }

  /** Allocate the high-res tile cache, the first time a tile needs it. */
  private allocateHi() {
    const gl = this.gl;
    gl.deleteTexture(this.hiTex);
    this.hiTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.hiTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, HI_LEVELS, gl.RGBA8, SLOT_SHEET, SLOT_SHEET, SLOT_LAYERS);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, HI_LEVELS - 1);
    gl.activeTexture(gl.TEXTURE0);
    this.hiReady = true;
  }

  /** Advance the loading clock; true while it or a sheet fade still needs frames. */
  private loadingVisible(now: number) {
    const arrived = this.sheetAt.filter((t) => t <= now).length / this.sheetAt.length;
    const c = this.clock;
    c.shown += (arrived - c.shown) * 0.12;
    if (arrived === 1 && c.shown > 0.995 && !c.gone) { c.shown = 1; c.gone = now; }
    const fading = this.sheetAt.some((t) => now - t < FADE);
    return fading || !c.gone || now - c.gone < 600;
  }

  /** Ease the rings' drift in after a few idle seconds, and out at the first touch. */
  private stepDrift(now: number) {
    const dt = Math.min(100, now - (this.lastFrame || now));
    this.lastFrame = now;
    const idle = this.disc && !this.anim && !reducedMotion() && now - this.lastInput > IDLE
      && now - this.start > this.stagger + DURATION;
    const target = idle ? Math.min(1, 6 / this.cam.s) : 0; // gentler close up, where it'd race past
    this.driftRate += (target - this.driftRate) * Math.min(1, dt / (target > this.driftRate ? 1500 : 250));
    if (this.driftRate < 0.002 && !target) { this.driftRate = 0; return; }
    this.drift += ((this.driftRate * dt) / 1000) * (this.rotate ? tune.turnSpeed : 1);
    this.dirty = true;
  }

  // ── drawing ───────────────────────────────────────────────────────────────

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.w = r.width;
    this.h = r.height;
    for (const c of [this.canvas, this.top]) {
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
    }
    this.overlay.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.anim && this.layout) this.cam.s = Math.max(this.cam.s, this.fitScale() * 0.5);
  }

  private draw() {
    this.drawTiles();
    this.drawOverlay();
  }

  private drawTiles() {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.u_view, this.w, this.h);
    gl.uniform3f(this.u.u_cam, this.cam.x, this.cam.y, this.cam.s);
    gl.uniform1f(this.u.u_time, performance.now() - this.start);
    const shaped = this.layout?.w !== undefined; // shaped layouts space their own tiles
    gl.uniform1f(this.u.u_gap, !shaped && this.cam.s >= 12 ? Math.max(1, Math.min(2, this.cam.s * 0.008)) : 0);
    gl.uniform1f(this.u.u_tintAmt, tintAmount(this.cam.s));
    gl.uniform1f(this.u.u_drift, this.drift);
    gl.uniform2f(this.u.u_pivot, this.pivot.x, this.pivot.y);
    const now = performance.now();
    const fade = new Float32Array(16);
    this.sheetAt.forEach((t, s) => { fade[s] = Math.min(1, Math.max(0, (now - t) / FADE)); });
    gl.uniform1fv(this.u.u_sheetFade, fade);
    gl.uniform1f(this.u.u_clock, (now - this.born) / 1000);
    gl.uniform1f(this.u.u_twinkle, this.twinkle && !reducedMotion() ? tune.twinkle : 0);
    gl.uniform4f(this.u.u_wave, tune.waveSpeed, tune.driftOut, tune.driftBack, driftPeak());
    gl.uniform4f(this.u.u_look, tune.spotRadius, tune.spotDim, this.dimTo(), 0);
    gl.uniform2f(this.u.u_depth, tune.depthFar, tune.depthDelay);
    gl.uniform3f(this.u.u_mouse, this.mouse.x, this.mouse.y, this.mouse.spot);
    const focus = new Int32Array(16).fill(-1);
    focus.set(this.focusRows);
    gl.uniform1iv(this.u.u_focus, focus);
    gl.uniform1i(this.u.u_focusCount, this.focusRows.length);
    gl.uniform1f(this.u.u_focusAmt, this.focusAmt);
    const waves = new Float32Array(64), dirs = new Float32Array(64);
    this.waves.forEach((w, k) => { waves.set([w.x, w.y, w.t0, w.amp], k * 4); dirs.set([w.dx, w.dy, w.reach, 0], k * 4); });
    gl.uniform4fv(this.u.u_waves, waves);
    gl.uniform4fv(this.u.u_waveDirs, dirs);
    gl.uniform1i(this.u.u_waveCount, this.waves.length);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
  }

  /** Set up the overlay context for a tile: centred, rotated, with its outline as the path. */
  private tilePath(row: number, inset = 0) {
    const ctx = this.overlay, s = this.cam.s, k = row * 4;
    const w = Math.max(0.5, this.shape[k] * s - inset), h = Math.max(0.5, this.shape[k + 1] * s - inset);
    const [x, y, rot] = this.centre(row);
    ctx.translate(...this.stirred(row, ...this.screen(x, y)));
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, this.shape[k + 3] * Math.min(w, h));
    return [w, h] as const;
  }

  private drawOverlay() {
    const ctx = this.overlay;
    ctx.clearRect(0, 0, this.w, this.h);
    const now = performance.now();
    const settled = now - this.start > this.stagger + DURATION;
    const s = this.cam.s;
    const { shown, gone } = this.clock;
    const clockAlpha = shown > 0 ? 1 - Math.min(1, gone ? (now - gone) / 600 : 0) : 0;
    if (this.disc) {
      const d = this.disc;
      const dx = (d.x - this.cam.x) * s + this.w / 2, dy = (d.y - this.cam.y) * s + this.h / 2;
      if (d.rgb) {
        ctx.fillStyle = `rgb(${d.rgb.map((c) => Math.round(c * 255)).join(",")})`;
        ctx.globalAlpha = 1 - (1 - this.dimTo()) * this.focusAmt; // dims with the works around a selection
        ctx.beginPath();
        ctx.arc(dx, dy, d.r * s, 0, 2 * Math.PI);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      // Loading clock: a hairline sweeping round inside the sun's rim as sheets arrive.
      if (clockAlpha > 0) {
        ctx.strokeStyle = `rgba(244, 236, 222, ${0.8 * clockAlpha})`;
        ctx.lineWidth = Math.max(2, d.r * s * 0.025);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.arc(dx, dy, Math.max(18, d.r * s * 0.9), -Math.PI / 2, -Math.PI / 2 + shown * 2 * Math.PI);
        ctx.stroke();
      }
    } else if (this.gradient && clockAlpha > 0) {
      // Loading bar: the colour map itself, filling in beneath the shape.
      const x0 = (this.bounds.x0 - this.cam.x) * s + this.w / 2, x1 = (this.bounds.x1 - this.cam.x) * s + this.w / 2;
      const y = Math.min(this.h - 12, (this.bounds.y1 - this.cam.y) * s + this.h / 2 + 18);
      const g = ctx.createLinearGradient(x0, 0, x1, 0);
      this.gradient.forEach((c, i, all) => g.addColorStop(i / (all.length - 1), c));
      ctx.save();
      ctx.globalAlpha = clockAlpha;
      ctx.strokeStyle = g;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath(); // a faint track, so dark ends of a map still show
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.strokeStyle = "rgba(244, 236, 222, 0.12)";
      ctx.stroke();
      ctx.strokeStyle = g;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + (x1 - x0) * shown, y);
      ctx.stroke();
      ctx.restore();
    }
    const dpr = window.devicePixelRatio || 1;
    if (settled && s * dpr * this.maxSize >= OVERLAY_FROM && this.layout) {
      const [fx0, fy0] = this.toField(-s * 2, -s * 2);
      const [fx1, fy1] = this.toField(this.w + s * 2, this.h + s * 2);
      const shaped = this.layout.w !== undefined;
      const gap = shaped ? 0 : Math.max(1, Math.min(2, s * 0.008));
      for (const row of this.bigAndVisible(OVERLAY_FROM / (s * dpr), fx0, fy0, fx1, fy1)) {
        const img = this.thumbs.get(this.opts.thumbUrl(row));
        if (!img) continue;
        ctx.save();
        const [w, h] = this.tilePath(row, gap);
        ctx.clip();
        // Cover-crop the thumbnail to the tile.
        const scale = Math.max(w / img.width, h / img.height);
        ctx.drawImage(img, -img.width * scale / 2, -img.height * scale / 2, img.width * scale, img.height * scale);
        // Darken it as the tile beneath is (spotlight, selection), or it'd glow above them.
        const light = this.lightOf(row);
        if (light < 0.995) { ctx.fillStyle = `rgba(0, 0, 0, ${1 - light})`; ctx.fillRect(-w / 2, -h / 2, w, h); }
        ctx.restore();
      }
    }
    if (settled && this.selected !== null && this.linked.length) this.drawLinked(this.selected);
    for (const [row, colour, width] of [[this.hovered, "#fff", 1.5], [this.selected, "#ef6a4c", 3]] as const) {
      if (row === null || !settled) continue;
      ctx.save();
      const [w, h] = this.tilePath(row, 1);
      if (Math.min(w, h) < 10) { // too small to outline: ring it instead (if this layout uses rings)
        if (!this.linkRings) { ctx.restore(); continue; }
        ctx.beginPath();
        ctx.arc(0, 0, 8, 0, 2 * Math.PI);
      } else if (s < 6 && row === this.hovered) { ctx.restore(); continue; }
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.stroke();
      ctx.restore();
    }
    this.drawLinks();
    this.drawLabels();
  }

  /** Field position to screen. */
  private screen(x: number, y: number): [number, number] {
    return [(x - this.cam.x) * this.cam.s + this.w / 2, (y - this.cam.y) * this.cam.s + this.h / 2];
  }

  /** How lit overlay marks are (names, lines): dimmed while a work is selected, and
   *  away from the pointer's spotlight (at sx, sy, if given), like the tiles. */
  private dim(sx?: number, sy?: number) {
    const near = sx === undefined ? 0.6 : Math.exp(-((sx - this.mouse.x) ** 2 + (sy! - this.mouse.y) ** 2) / tune.spotRadius ** 2);
    const spot = tune.spotDim + (1 - tune.spotDim) * near;
    return (1 + this.mouse.spot * (spot - 1)) * (1 - (1 - this.dimTo()) * this.focusAmt);
  }

  /** Works whose centres lie within r cells of (fx, fy), nearest first. */
  private near(fx: number, fy: number, r: number): [number, number][] {
    const [rx, ry] = this.atRest(fx, fy);
    const out: [number, number][] = [];
    const pad = r + tune.brushMax / this.cam.s; // tiles nudged off their cell
    for (let bx = Math.floor(rx - pad); bx <= Math.floor(rx + pad); bx++) {
      for (let by = Math.floor(ry - pad); by <= Math.floor(ry + pad); by++) {
        for (const row of this.hash.get(bx * 100000 + by) ?? []) {
          const [x, y] = this.centre(row);
          const d = Math.hypot(x - fx, y - fy);
          if (d <= r) out.push([row, d]);
        }
      }
    }
    return out.sort((a, b) => a[1] - b[1]);
  }

  /** Spring every moved work back to rest (a slight overshoot, settled in ~1s);
   *  returns the works whose offsets changed. */
  private stepKnocks(dt: number): number[] {
    const o = this.offset, v = this.velocity, s = this.cam.s;
    const t = Math.min(0.05, dt / 1000);
    const changed: number[] = [];
    for (const row of this.moving) {
      const i = row * 2;
      for (const k of [i, i + 1]) {
        v[k] += (-(tune.springStiffness ** 2) * o[k] - 2 * tune.springDamping * tune.springStiffness * v[k]) * t;
        o[k] += v[k] * t;
      }
      if (Math.hypot(o[i], o[i + 1]) * s < 0.05 && Math.hypot(v[i], v[i + 1]) * s < 0.5) {
        o[i] = o[i + 1] = v[i] = v[i + 1] = 0;
        this.moving.delete(row);
      }
      changed.push(row);
    }
    return changed;
  }

  /** Upload the offsets of these works (or all of them, if many changed). */
  private uploadOffsets(rows: number[]) {
    if (!rows.length) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.offset);
    if (rows.length > 1500) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.offset);
    else for (const row of rows) gl.bufferSubData(gl.ARRAY_BUFFER, row * 8, this.offset, row * 2, 2);
    this.dirty = true;
  }

  /** The moving pointer gently pushes the stars it touches: each is nudged out of its
   *  way (ahead of it, or aside, by where it was touched) by a fraction of how far the
   *  pointer moved, so it slides through them rather than clearing a space, then they
   *  spring back once it's passed. A resting pointer pushes nothing, so the work under
   *  it settles back to be clicked. */
  private brush(): number[] {
    const p = this.pointer;
    if (!p.inside || this.dragging || p.speed < 0.05 || reducedMotion()) return [];
    const s = this.cam.s, o = this.offset, v = this.velocity;
    const [fx, fy] = this.toField(p.x, p.y);
    const reach = tune.brushReach / s;
    const pushed: number[] = [];
    for (const [row, d] of this.near(fx, fy, reach + this.maxSize / 2)) {
      if (this.focusSet.has(row)) continue;
      const size = Math.max(this.shape[row * 4], this.shape[row * 4 + 1]) / 2;
      const overlap = reach + size - d;
      if (overlap <= 0) continue;
      const [x, y] = this.centre(row);
      const ux = d > 1e-6 ? (x - fx) / d : p.dx, uy = d > 1e-6 ? (y - fy) / d : p.dy;
      const i = row * 2;
      const nudge = Math.min(overlap, (p.speed * 16) / s) * tune.brushGive; // a share of this frame's movement
      o[i] += ux * nudge;
      o[i + 1] += uy * nudge;
      const cap = Math.min(reach + size, tune.brushMax / s); // never shoved far
      const far = Math.hypot(o[i], o[i + 1]);
      if (far > cap) { o[i] *= cap / far; o[i + 1] *= cap / far; }
      // Carry some of the pointer's speed along the push.
      const along = Math.max(0, p.dx * ux + p.dy * uy) * p.speed * 1000 / s;
      v[i] = ux * along * tune.brushCarry;
      v[i + 1] = uy * along * tune.brushCarry;
      this.moving.add(row);
      pushed.push(row);
      if (pushed.length >= 2000) break;
    }
    return pushed;
  }

  /** Start a disturbance at field point (x, y): tiles drift up to `amp` px, outward
   *  and along (dx, dy), by less over `reach` px. The pointer's make way for a
   *  selection's when there are too many. */
  private stir(x: number, y: number, amp: number, dx: number, dy: number, reach: number, big = false) {
    const t0 = (performance.now() - this.born) / 1000;
    const life = (3 * reach) / tune.waveSpeed + 5 * tune.driftBack;
    this.waves.push({ x, y, t0, amp, dx, dy, reach, life, big });
    while (this.waves.length > 16) {
      const i = this.waves.findIndex((w) => !w.big);
      this.waves.splice(i < 0 ? 0 : i, 1);
    }
  }

  /** Where a tile's centre (screen px) is drawn once disturbances have moved it: the
   *  same sums as the vertex shader, for the overlay's thumbnails, outlines and lines. */
  private stirred(row: number, sx: number, sy: number): [number, number] {
    if (!this.waves.length || this.focusSet.has(row)) return [sx, sy];
    const [j1, j2] = jitter(row);
    const depth = tune.depthFar + (1 - tune.depthFar) * j1;
    const peak = driftPeak();
    const clock = (performance.now() - this.born) / 1000;
    let x = sx, y = sy;
    for (const w of this.waves) {
      const [wx, wy] = this.screen(w.x, w.y);
      const rx = x - wx, ry = y - wy, r = Math.hypot(rx, ry);
      const since = (clock - w.t0) * 1000 - r / tune.waveSpeed - (1 - depth) * tune.depthDelay - (j2 - 0.5) * 60;
      if (since <= 0) continue;
      const amp = w.amp * Math.exp(-r / w.reach) * depth
        * (1 - Math.exp(-since / tune.driftOut)) * Math.exp(-since / tune.driftBack) / peak;
      let dx = (r > 0.001 ? rx / r : 0) * 0.7 + w.dx * 0.3, dy = (r > 0.001 ? ry / r : 0) * 0.7 + w.dy * 0.3;
      const l = Math.max(Math.hypot(dx, dy), 0.001);
      x += (dx / l) * amp;
      y += (dy / l) * amp;
    }
    return [x, y];
  }

  /** Ease the spotlight and the selection dimming, brush and spring the knocked
   *  works; ask for frames while any of it is changing. */
  private stepLively(now: number) {
    if (!this.lively) return;
    const dt = Math.max(0, Math.min(100, now - (this.livelyAt || now))); // never backwards
    this.livelyAt = now;
    const m = this.mouse, p = this.pointer;
    const ease = (v: number, to: number, ms: number) => v + (to - v) * Math.min(1, dt / ms);
    const before = [m.x, m.y, m.spot];
    m.x = ease(m.x, p.x, 50);
    m.y = ease(m.y, p.y, 50);
    if (Math.abs(m.x - p.x) > 400 || Math.abs(m.y - p.y) > 400) { m.x = p.x; m.y = p.y; } // no sweeping in from afar
    p.speed *= Math.exp(-dt / 120); // settles once the pointer rests
    m.spot = ease(m.spot, p.inside && !this.dragging ? 1 : 0, 300);
    const sprung = this.stepKnocks(dt);
    this.uploadOffsets(sprung.concat(this.brush()));
    // The moving pointer stirs the space around it as it goes.
    if (p.inside && !this.dragging && p.speed > 0.05 && !reducedMotion() && now - this.waveAt > tune.stirEvery) {
      this.waveAt = now;
      this.stir(...this.toField(p.x, p.y), tune.stirStrength * Math.min(1, Math.max(0.2, p.speed * 1.33)), p.dx, p.dy, tune.stirReach);
    }
    const clock = (now - this.born) / 1000;
    this.waves = this.waves.filter((w) => (clock - w.t0) * 1000 < w.life);
    if (this.waves.length) this.dirty = true;
    const after = [m.x, m.y, m.spot];
    if (after.some((v, i) => Math.abs(v - before[i]) > 0.002)) this.dirty = true;
  }

  /** How lit a work is (0–1), as the vertex shader computes it: dimmed around a
   *  selection unless it's part of it, and away from the pointer's spotlight. */
  private lightOf(row: number) {
    if (this.focusSet.has(row)) return 1;
    const [x, y] = this.screen(...(this.centre(row).slice(0, 2) as [number, number]));
    const lit = Math.exp(-((x - this.mouse.x) ** 2 + (y - this.mouse.y) ** 2) / tune.spotRadius ** 2);
    const spot = 1 + this.mouse.spot * (tune.spotDim + (1 - tune.spotDim) * lit - 1);
    return spot * (1 - (1 - this.dimTo()) * this.focusAmt);
  }

  /** How bright everything but a selected work and its links becomes. */
  private dimTo() { return this.focusDim ?? tune.focusDim; }

  /** Ease the dimming around a selected work in and out. */
  private stepFocus(now: number) {
    const dt = Math.max(0, Math.min(100, now - (this.focusAt || now)));
    this.focusAt = now;
    if (!this.focusOn) { this.focusAmt = 0; return; }
    const to = this.focusRows.length ? 1 : 0;
    if (this.focusAmt === to) return;
    this.focusAmt += (to - this.focusAmt) * Math.min(1, dt / 250);
    if (Math.abs(this.focusAmt - to) < 0.002) this.focusAmt = to;
    this.dirty = true;
  }

  /** Constellation lines between linked points, with a ring at each end, drawn in
   *  after the entrance and fading out as you zoom in among the stars. */
  private drawLinks() {
    const ctx = this.overlay;
    if (!this.links.length) return;
    const zoom = this.cam.s / this.fitScale();
    const fade = Math.max(0, Math.min(1, (24 - zoom) / 16));
    if (fade <= 0) return;
    const appear = Math.min(1, Math.max(0, (performance.now() - this.start - this.stagger * 0.6) / 1200));
    ctx.save();
    ctx.lineWidth = 1;
    const ends = new Map<string, [number, number]>();
    for (const [x1, y1, x2, y2, k] of this.links) {
      const [a, b] = this.screen(...this.turned(x1, y1)), [c, d] = this.screen(...this.turned(x2, y2));
      ctx.strokeStyle = `rgba(244, 236, 222, ${(0.22 + 0.35 * Math.max(0, (k - 0.8) / 0.15)) * fade * appear * this.dim()})`;
      ctx.beginPath();
      ctx.moveTo(a, b);
      ctx.lineTo(a + (c - a) * appear, b + (d - b) * appear); // lines draw themselves in
      ctx.stroke();
      ends.set(`${x1},${y1}`, [a, b]).set(`${x2},${y2}`, [c, d]);
    }
    ctx.strokeStyle = `rgba(244, 236, 222, ${0.7 * fade * appear * this.dim()})`;
    ctx.lineWidth = 1.5;
    for (const [sx, sy] of ends.values()) {
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(5, 1.9 * this.cam.s) + 3, 0, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** A field point as the whole layout has turned while idle (names and links). */
  private turned(x: number, y: number): [number, number] {
    return this.rotate ? turnAbout(x, y, this.pivot, this.rotate * this.drift) : [x, y];
  }

  /** Lines from the selected work to the works it's linked to (its look-alikes). */
  private drawLinked(from: number) {
    const ctx = this.overlay, s = this.cam.s;
    const [fx, fy] = this.stirred(from, ...this.screen(...(this.centre(from).slice(0, 2) as [number, number])));
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = this.linkColour;
    ctx.lineWidth = this.linkWidth;
    const dot = (x: number, y: number) => { ctx.beginPath(); ctx.arc(x, y, 1.5, 0, 2 * Math.PI); ctx.fill(); };
    if (!this.linkRings && this.linked.length) dot(fx, fy);
    for (const row of this.linked) {
      const [x, y] = this.centre(row);
      const [sx, sy] = this.stirred(row, ...this.screen(x, y));
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(sx, sy);
      ctx.stroke();
      if (!this.linkRings) { dot(sx, sy); continue; }
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(6, (Math.max(this.shape[row * 4], this.shape[row * 4 + 1]) * s) / 2 + 3), 0, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Names over the tiles: systems from afar, the regions within them closer in,
   *  bigger first, wherever there's room (never overlapping). */
  private drawLabels() {
    if (!this.labels.length) return;
    const ctx = this.overlay;
    const zoom = this.cam.s / this.fitScale();
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    const appear = clamp((performance.now() - this.start - this.stagger) / 800);
    const placed: [number, number, number, number][] = [];
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (const l of this.labels) {
      const level = l.level ?? 0;
      const alpha = appear * (level === 0 ? clamp((10 - zoom) / 6) : Math.min(clamp((zoom - 2) / 2), clamp((40 - zoom) / 20)));
      if (alpha <= 0.02) continue;
      const [x, y] = this.screen(...this.turned(l.x, l.y));
      const lit = this.dim(x, y);
      if (x < -300 || y < -60 || x > this.w + 300 || y > this.h + 60) continue;
      // Systems in light Google Sans (bigger ones still win where names would crowd);
      // the regions within them in small caps.
      const size = level === 0 ? 12 : 11;
      const text = level === 0 ? l.text : l.text.toUpperCase();
      ctx.font = `${level === 0 ? 300 : 600} ${size}px "Google Sans", system-ui, sans-serif`;
      ctx.letterSpacing = level === 0 ? "0px" : "1.2px";
      const ty = level === 0 ? y - Math.max(14, 1.7 * this.cam.s + 12) : y; // a system's name sits above its brightest star
      const key = `${ctx.font}|${ctx.letterSpacing}|${text}`;
      let width = this.textWidths.get(key);
      if (width === undefined) { width = ctx.measureText(text).width; this.textWidths.set(key, width); }
      const half = width / 2;
      // Names keep a little air around them, so where they'd crowd, the bigger one shows.
      const [padX, padY] = level === 0 ? [12, 6] : [8, 5];
      const box: [number, number, number, number] = [x - half - padX, ty - size / 2 - padY, x + half + padX, ty + size / 2 + padY];
      if (placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) continue;
      placed.push(box);
      ctx.globalAlpha = alpha * lit;
      ctx.lineWidth = 3; // a soft dark edge keeps names legible over bright stars
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.strokeText(text, x, ty);
      ctx.fillStyle = "#fff";
      ctx.fillText(text, x, ty);
    }
    ctx.restore();
  }

  /** Join the selected work to these works with lines (e.g. its look-alikes in view). */
  linkTo(rows: number[]) {
    this.linked = rows.filter((r) => this.placed.has(r));
    const sel = this.selected;
    this.focusRows = sel !== null ? [sel, ...this.linked].slice(0, 16) : []; // the selection stays lit even with no links in view
    this.focusSet = new Set(this.focusRows);
    if (this.lively && sel !== null && this.linked.length && !reducedMotion()) {
      const [x, y] = this.centre(sel);
      this.stir(x, y, tune.selectStrength, 0, 0, tune.selectReach, true);
    }
    this.invalidate();
  }

  // ── input ─────────────────────────────────────────────────────────────────

  private bindInput() {
    const c = this.top;
    let drag: { x: number; y: number; moved: boolean } | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: number | null = null;
    const local = (e: { clientX: number; clientY: number }) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      c.addEventListener(type, fn as EventListener, o);
      this.cleanup.push(() => c.removeEventListener(type, fn as EventListener));
    };
    const touch = () => { this.lastInput = performance.now(); };
    for (const type of ["pointerdown", "pointermove", "wheel", "dblclick"] as const) on(type, touch);
    // Pointer position and speed, for the push and spotlight.
    on("pointermove", (e) => {
      const [x, y] = local(e);
      const now = performance.now(), p = this.pointer;
      const ms = Math.max(1, now - (p.movedAt || now));
      const step = Math.hypot(x - p.x, y - p.y);
      if (p.inside) {
        p.speed = 0.6 * p.speed + 0.4 * (step / ms);
        if (step > 0.5) { p.dx = (x - p.x) / step; p.dy = (y - p.y) / step; }
      }
      p.x = x; p.y = y; p.inside = true; p.movedAt = now;
      this.invalidate();
    });
    on("pointerdown", () => { this.dragging = true; });
    on("pointerup", () => { this.dragging = false; });
    on("pointerleave", () => { this.pointer.inside = false; this.dragging = false; });
    on("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
        drag = null;
      } else {
        drag = { x: e.clientX, y: e.clientY, moved: false };
        this.anim = null;
      }
    });
    on("pointermove", (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch !== null && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const [mx, my] = local({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
        this.zoomBy(d / pinch, mx, my);
        pinch = d;
        return;
      }
      const [sx, sy] = local(e);
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        this.cam.x -= dx / this.cam.s;
        this.cam.y -= dy / this.cam.s;
        drag.x = e.clientX;
        drag.y = e.clientY;
        this.invalidate();
        return;
      }
      const row = this.cam.s >= 4 ? this.rowAt(sx, sy) : null;
      if (row !== this.hovered) { this.hovered = row; this.invalidate(); }
      this.opts.onHover(row, sx, sy);
    });
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag && !drag.moved) {
        const [sx, sy] = local(e);
        this.selected = this.rowAt(sx, sy);
        this.invalidate();
        this.opts.onSelect(this.selected);
      }
      drag = null;
    };
    on("pointerup", end);
    on("pointercancel", end);
    on("pointerleave", () => { this.hovered = null; this.opts.onHover(null, 0, 0); this.invalidate(); });
    on("dblclick", (e) => {
      const [sx, sy] = local(e);
      const [fx, fy] = this.toField(sx, sy);
      this.flyTo({ x: fx, y: fy, s: this.cam.s * 3 }, 500);
    });
    on("wheel", (e) => {
      e.preventDefault();
      const [sx, sy] = local(e);
      if (e.ctrlKey || e.metaKey) this.zoomBy(Math.exp(-e.deltaY * 0.012), sx, sy);
      else if (e.deltaMode === 1 || (Math.abs(e.deltaY) >= 50 && e.deltaX === 0 && Number.isInteger(e.deltaY))) {
        this.zoomBy(Math.exp(-Math.sign(e.deltaY) * 0.25), sx, sy);
      } else {
        this.anim = null;
        this.cam.x += e.deltaX / this.cam.s;
        this.cam.y += e.deltaY / this.cam.s;
        this.invalidate();
      }
    }, { passive: false });
  }
}
