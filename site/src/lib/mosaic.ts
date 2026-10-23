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

export interface AtlasInfo { tile: number; sheet: number; perRow: number; perSheet: number; sheets: number; count: number }

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
  /** A solid disc drawn under the tiles, e.g. the dark sun at the centre of Orbits. */
  disc?: { x: number; y: number; r: number; rgb: [number, number, number] };
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
out float v_fade;
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
  p = u_pivot + vec2(q0.x * tc - q0.y * ts, q0.x * ts + q0.y * tc);
  float alpha = mix(a_from.z, a_to.z, e);
  v_alpha = alpha;
  float size = 0.35 + 0.65 * alpha;   // works joining grow in, leaving shrink out
  vec2 half_ = max(vec2(0.5), (a_shape.xy * u_cam.z * size - vec2(u_gap)) * 0.5);
  vec2 local = (corner * 2.0 - 1.0) * half_;
  float c = cos(a_shape.z + turn), s = sin(a_shape.z + turn);
  vec2 px = (p - u_cam.xy) * u_cam.z + u_view * 0.5 + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
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
  v_radius = a_shape.w * 2.0 * min(half_.x, half_.y);
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
  colour = vec4(mix(c, v_tint, max(u_tintAmt, 1.0 - v_fade)) * a, a);
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
  private buf: Record<"from" | "to" | "delay" | "tint" | "shape" | "hi" | "spin", WebGLBuffer>;
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
  private stagger = STAGGER;
  private gradient: string[] | null = null;
  // High-res tile cache: which slot holds which artwork, and when it was last on screen.
  private hiTex: WebGLTexture;
  private slotOfRow: Int32Array;
  private rowOfSlot = new Int32Array(SLOTS_PER_ROW * SLOTS_PER_ROW * SLOT_LAYERS).fill(-1);
  private slotUsed = new Float64Array(SLOTS_PER_ROW * SLOTS_PER_ROW * SLOT_LAYERS);
  private loadingRows = new Set<number>();
  private slotCanvas = Object.assign(document.createElement("canvas"), { width: SLOT, height: SLOT });
  private pendingHi: [row: number, slot: number][] = []; // uploaded, waiting for mipmaps
  private lastMip = 0;
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
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.overlay = top.getContext("2d")!;
    this.n = atlas.count;
    this.from = new Float32Array(this.n * 3);
    this.to = new Float32Array(this.n * 3);
    this.delay = new Float32Array(this.n);
    this.shape = new Float32Array(this.n * 4);
    this.slotOfRow = new Int32Array(this.n).fill(-1);
    this.spin = new Float32Array(this.n);
    this.lastInput = performance.now();
    this.sheetAt = new Array(atlas.sheets).fill(Infinity);
    this.thumbs = new ImageCache(400, () => this.invalidate());

    this.prog = this.program();
    for (const name of ["u_view", "u_cam", "u_time", "u_duration", "u_gap", "u_tileUv", "u_slotUv", "u_tintAmt", "u_atlas", "u_hi", "u_drift", "u_pivot", "u_sheetFade"]) {
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
    };
    attrib(4, 3, uvs);

    // Texture array: one layer per sprite sheet, filled in as each loads.
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 4, gl.RGBA8, atlas.sheet, atlas.sheet, atlas.sheets);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, 3); // 24px → 3px tiles
    for (let s = 0; s < atlas.sheets; s++) {
      const img = new Image();
      img.onload = () => {
        if (this.destroyed) return;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, s, atlas.sheet, atlas.sheet, 1, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D_ARRAY); // per sheet, so each can fade in at any zoom
        this.sheetAt[s] = performance.now();
        this.invalidate();
      };
      img.src = `${base}/atlas-${String(s).padStart(2, "0")}.webp`;
    }
    this.hiTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.hiTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 5, gl.RGBA8, SLOT_SHEET, SLOT_SHEET, SLOT_LAYERS);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, 4); // 128px → 8px
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
      this.stepCamera();
      const now = performance.now();
      const loading = this.loadingVisible(now);
      const animating = loading || now - this.start < this.stagger + DURATION + 50;
      this.stepDrift(now);
      if (now - this.lastUpgrade > 120) { this.lastUpgrade = now; this.upgrade(); }
      if (this.pendingHi.length && now - this.lastMip > 250) {
        // Rebuild the smaller sizes, then switch the new tiles over (not before, or
        // they'd show stale mip levels).
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE1);
        gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
        gl.activeTexture(gl.TEXTURE0);
        for (const [row, slot] of this.pendingHi) if (this.slotOfRow[row] === slot) this.setHi(row, slot);
        this.pendingHi = [];
        this.lastMip = now;
        this.dirty = true;
      }
      if (this.dirty || animating) { this.draw(); this.dirty = false; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  destroy() {
    this.destroyed = true;
    this.cleanup.forEach((f) => f());
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
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    this.bounds = { x0: x0 - cx, y0: y0 - cy, x1: x1 - cx, y1: y1 - cy };
    this.disc = layout.disc ? { ...layout.disc, x: layout.disc.x - cx, y: layout.disc.y - cy } : null;
    this.gradient = layout.gradient ?? null;
    const stagger = layout.stagger ?? STAGGER;
    const spiral = layout.enter === "spiral" && this.disc !== null;
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
      spin[row] = layout.spin?.[i] ?? 0;
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
    this.pivot = pivot;
    this.drift = 0;
    this.hashDrift = 0;
    this.stagger = stagger;
    this.placedRows = layout.rows;
    this.start = now;
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
    const turn = this.spin[row] * this.drift;
    if (turn === 0) return [x, y, rot];
    const [tx, ty] = turnAbout(x, y, this.pivot, turn);
    return [tx, ty, rot + turn];
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

  rowAt(sx: number, sy: number): number | null {
    if (this.drift !== this.hashDrift) this.rehash();
    const [fx, fy] = this.toField(sx, sy);
    const bx = Math.floor(fx), by = Math.floor(fy);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (const row of this.hash.get((bx + dx) * 100000 + (by + dy)) ?? []) {
          if (this.contains(row, fx, fy)) return row;
        }
      }
    }
    return null;
  }

  /** Rebuild the hit-test hash where tiles have drifted to. */
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
    for (const row of this.placedRows) {
      const [x, y] = this.centre(row);
      if (x < fx0 || x > fx1 || y < fy0 || y > fy1) continue;
      const slot = this.slotOfRow[row];
      if (slot >= 0) { this.slotUsed[slot] = now; continue; }
      if (this.loadingRows.has(row)) continue;
      if (Math.max(this.shape[row * 4], this.shape[row * 4 + 1]) * s * dpr < SPRITE_MAX) continue;
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
      // Centre-square crop, like the sprites.
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const ctx = this.slotCanvas.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, SLOT, SLOT);
      const [x, y, layer] = slotPos(slot);
      gl.activeTexture(gl.TEXTURE1);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, x, y, layer, SLOT, SLOT, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.slotCanvas);
      gl.activeTexture(gl.TEXTURE0);
      this.rowOfSlot[slot] = row;
      this.slotOfRow[row] = slot;
      this.slotUsed[slot] = performance.now();
      this.pendingHi.push([row, slot]);
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
    this.drift += (this.driftRate * dt) / 1000;
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
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
    this.drawOverlay();
  }

  /** Set up the overlay context for a tile: centred, rotated, with its outline as the path. */
  private tilePath(row: number, inset = 0) {
    const ctx = this.overlay, s = this.cam.s, k = row * 4;
    const w = this.shape[k] * s - inset, h = this.shape[k + 1] * s - inset;
    const [x, y, rot] = this.centre(row);
    ctx.translate((x - this.cam.x) * s + this.w / 2, (y - this.cam.y) * s + this.h / 2);
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
      ctx.fillStyle = `rgb(${d.rgb.map((c) => Math.round(c * 255)).join(",")})`;
      ctx.beginPath();
      ctx.arc(dx, dy, d.r * s, 0, 2 * Math.PI);
      ctx.fill();
      // Loading clock: a hairline sweeping round inside the sun's rim as sheets arrive.
      if (clockAlpha > 0) {
        ctx.strokeStyle = `rgba(244, 236, 222, ${0.8 * clockAlpha})`;
        ctx.lineWidth = Math.max(2, d.r * s * 0.025);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.arc(dx, dy, d.r * s * 0.9, -Math.PI / 2, -Math.PI / 2 + shown * 2 * Math.PI);
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
    if (settled && s * dpr * 3 >= OVERLAY_FROM && this.layout) { // no tile is wider than 3 cells
      const [fx0, fy0] = this.toField(-s * 2, -s * 2);
      const [fx1, fy1] = this.toField(this.w + s * 2, this.h + s * 2);
      const shaped = this.layout.w !== undefined;
      const gap = shaped ? 0 : Math.max(1, Math.min(2, s * 0.008));
      for (const row of this.placedRows) {
        const [x, y] = this.centre(row);
        if (x < fx0 || x > fx1 || y < fy0 || y > fy1) continue;
        if (Math.max(this.shape[row * 4], this.shape[row * 4 + 1]) * s * dpr < OVERLAY_FROM) continue;
        const img = this.thumbs.get(this.opts.thumbUrl(row));
        if (!img) continue;
        ctx.save();
        const [w, h] = this.tilePath(row, gap);
        ctx.clip();
        // Cover-crop the thumbnail to the tile.
        const scale = Math.max(w / img.width, h / img.height);
        ctx.drawImage(img, -img.width * scale / 2, -img.height * scale / 2, img.width * scale, img.height * scale);
        ctx.restore();
      }
    }
    for (const [row, colour, width] of [[this.hovered, "#fff", 1.5], [this.selected, "#ef6a4c", 3]] as const) {
      if (row === null || s < 6 || !settled) continue;
      ctx.save();
      this.tilePath(row, 1);
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.stroke();
      ctx.restore();
    }
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
