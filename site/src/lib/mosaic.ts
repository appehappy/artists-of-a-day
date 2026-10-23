// WebGL2 mosaic: every artwork is an instanced tile drawn from a texture array of
// sprite sheets (scripts/build_colourmaps.py). Tiles can be grid squares or rotated,
// rounded shapes such as pills (the Colour Field's Orbits). Layout changes animate on the GPU:
// each tile flies from where it is to where it's going, staggered along the
// gradient; works joining grow in, works leaving shrink out. From far away each tile
// is tinted towards its slot's colour (the zoom tint); close up, a 2D overlay draws
// the real thumbnails.

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
}

interface Cam { x: number; y: number; s: number } // centre in cells; CSS px per cell

/** Sprite sheet layout, each tile's texture coordinates, and each work's OKLab colour
 *  (scripts/build_colourmaps.py). Throws if the data hasn't been built. */
export async function loadMosaicData(base = "/fields/maps") {
  const ok = (r: Response) => { if (!r.ok) throw new Error(r.url); return r; };
  const [atlas, lab]: [AtlasInfo, Float32Array] = await Promise.all([
    fetch(`${base}/atlas.json`).then(ok).then((r) => r.json()),
    fetch(`${base}/colour.bin`).then(ok).then((r) => r.arrayBuffer()).then((b) => new Float32Array(b)),
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
const STAGGER = 650; // ms from the start of the gradient to its end
const THUMBS_FROM = 56; // px per cell at which real thumbnails take over
const MAX_SCALE = 360;
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;


const VERT = `#version 300 es
layout(location=0) in vec3 a_from;   // x, y, alpha
layout(location=1) in vec3 a_to;
layout(location=2) in float a_delay;
layout(location=3) in vec3 a_tint;
layout(location=4) in vec3 a_uv;     // u0, v0, sheet
layout(location=5) in vec4 a_shape;  // w, h (cells), rotation, corner radius fraction
uniform vec2 u_view;      // canvas size, CSS px
uniform vec3 u_cam;       // centre x, y (cells), px per cell
uniform float u_time;     // ms since the layout change
uniform float u_duration;
uniform float u_gap;      // px between tiles
uniform float u_tileUv;   // tile size in uv units
out vec3 v_uv;
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
  float alpha = mix(a_from.z, a_to.z, e);
  v_alpha = alpha;
  float size = 0.35 + 0.65 * alpha;   // works joining grow in, leaving shrink out
  vec2 half_ = max(vec2(0.5), (a_shape.xy * u_cam.z * size - vec2(u_gap)) * 0.5);
  vec2 local = (corner * 2.0 - 1.0) * half_;
  float c = cos(a_shape.z), s = sin(a_shape.z);
  vec2 px = (p - u_cam.xy) * u_cam.z + u_view * 0.5 + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  gl_Position = alpha < 0.01 ? vec4(2.0, 2.0, 0.0, 1.0)
                             : vec4(px / u_view * 2.0 - 1.0, 0.0, 1.0) * vec4(1.0, -1.0, 1.0, 1.0);
  // Cover-crop the square tile to the shape's aspect ratio.
  vec2 crop = a_shape.xy / max(a_shape.x, a_shape.y);
  v_uv = vec3(a_uv.xy + (0.5 + (corner - 0.5) * crop) * u_tileUv, a_uv.z);
  v_tint = a_tint;
  v_local = local;
  v_half = half_;
  v_radius = a_shape.w * 2.0 * min(half_.x, half_.y);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray u_atlas;
uniform float u_tintAmt;
in vec3 v_uv;
in vec3 v_tint;
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
  vec3 c = texture(u_atlas, v_uv).rgb;
  colour = vec4(mix(c, v_tint, u_tintAmt) * a, a);
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
  private buf: Record<"from" | "to" | "delay" | "tint" | "shape", WebGLBuffer>;
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
  /** Screen px covered by panels on either side, kept clear when fitting the shape. */
  insetRight = 0;
  insetLeft = 0;
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
    this.thumbs = new ImageCache(400, () => this.invalidate());

    this.prog = this.program();
    for (const name of ["u_view", "u_cam", "u_time", "u_duration", "u_gap", "u_tileUv", "u_tintAmt", "u_atlas"]) {
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
    };
    attrib(4, 3, uvs);

    // Texture array: one layer per sprite sheet, filled in as each loads.
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 4, gl.RGBA8, atlas.sheet, atlas.sheet, atlas.sheets);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, 3); // 24px → 3px tiles
    let loaded = 0;
    for (let s = 0; s < atlas.sheets; s++) {
      const img = new Image();
      img.onload = () => {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, s, atlas.sheet, atlas.sheet, 1, gl.RGBA, gl.UNSIGNED_BYTE, img);
        if (++loaded === atlas.sheets) gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
        this.invalidate();
      };
      img.src = `${base}/atlas-${String(s).padStart(2, "0")}.webp`;
    }
    gl.useProgram(this.prog);
    gl.uniform1f(this.u.u_tileUv, atlas.tile / atlas.sheet);
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
      const animating = performance.now() - this.start < STAGGER + DURATION + 50;
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
      nextTo[k3] = x; nextTo[k3 + 1] = y; nextTo[k3 + 2] = 1;
      tint[k3] = layout.slotRgb[i * 3]; tint[k3 + 1] = layout.slotRgb[i * 3 + 1]; tint[k3 + 2] = layout.slotRgb[i * 3 + 2];
      nextDelay[row] = animate ? layout.t[i] * STAGGER + Math.random() * 120 : -DURATION;
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
      }
      if (placed[row]) {
        if (pa > 0.01) { nextFrom[k3] = px; nextFrom[k3 + 1] = py; nextFrom[k3 + 2] = pa; } // showing: fly over
        else {
          // joining: start just off its spot, scattered, and grow in
          const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 18;
          nextFrom[k3] = nextTo[k3] + Math.cos(a) * r;
          nextFrom[k3 + 1] = nextTo[k3 + 1] + Math.sin(a) * r;
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
    this.placedRows = layout.rows;
    this.start = now;
    const gl = this.gl;
    for (const [key, data] of [["from", nextFrom], ["to", nextTo], ["delay", nextDelay], ["tint", tint],
                               ["shape", shape]] as const) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf[key]);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    }
    const first = this.layout === null;
    this.layout = layout;
    this.selected = null;
    this.fit(!first);
  }

  // ── camera ────────────────────────────────────────────────────────────────

  private fitScale() {
    const { x0, y0, x1, y1 } = this.bounds;
    return Math.min((this.w - this.insetLeft - this.insetRight) / (x1 - x0 + 16), this.h / (y1 - y0 + 16));
  }

  /** Fit the whole shape into the area between any side panels. */
  fit(animate = true) {
    const s = this.fitScale();
    this.flyTo({ x: (this.insetRight - this.insetLeft) / (2 * s), y: 0, s }, animate ? 900 : 0);
  }

  setInsetLeft(px: number) {
    this.insetLeft = px;
    this.fit(false);
  }

  flyTo(to: Partial<Cam>, ms = 700) {
    const target = { ...this.cam, ...to };
    target.s = Math.min(MAX_SCALE, Math.max(this.fitScale() * 0.5, target.s));
    if (ms === 0 || reducedMotion()) { Object.assign(this.cam, target); this.invalidate(); return; }
    this.anim = { from: { ...this.cam }, to: target, t0: performance.now(), ms };
  }

  flyToRow(row: number, s = 140) {
    const k = row * 3;
    this.flyTo({ x: this.to[k], y: this.to[k + 1], s });
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

  /** Is field point (fx, fy) inside this artwork's (possibly rotated) tile? */
  private contains(row: number, fx: number, fy: number) {
    const k = row * 4;
    const [w, h, rot] = [this.shape[k], this.shape[k + 1], this.shape[k + 2]];
    const dx = fx - this.to[row * 3], dy = fy - this.to[row * 3 + 1];
    const c = Math.cos(-rot), s = Math.sin(-rot);
    return Math.abs(dx * c - dy * s) <= w / 2 && Math.abs(dx * s + dy * c) <= h / 2;
  }

  rowAt(sx: number, sy: number): number | null {
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

  randomRow(): number | null {
    if (!this.layout) return null;
    return this.layout.rows[Math.floor(Math.random() * this.layout.rows.length)];
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
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
    this.drawOverlay();
  }

  /** Set up the overlay context for a tile: centred, rotated, with its outline as the path. */
  private tilePath(row: number, inset = 0) {
    const ctx = this.overlay, s = this.cam.s, k = row * 4;
    const w = this.shape[k] * s - inset, h = this.shape[k + 1] * s - inset;
    ctx.translate((this.to[row * 3] - this.cam.x) * s + this.w / 2, (this.to[row * 3 + 1] - this.cam.y) * s + this.h / 2);
    ctx.rotate(this.shape[k + 2]);
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, this.shape[k + 3] * Math.min(w, h));
    return [w, h] as const;
  }

  private drawOverlay() {
    const ctx = this.overlay;
    ctx.clearRect(0, 0, this.w, this.h);
    const settled = performance.now() - this.start > STAGGER + DURATION;
    const s = this.cam.s;
    if (this.disc) {
      const d = this.disc;
      ctx.fillStyle = `rgb(${d.rgb.map((c) => Math.round(c * 255)).join(",")})`;
      ctx.beginPath();
      ctx.arc((d.x - this.cam.x) * s + this.w / 2, (d.y - this.cam.y) * s + this.h / 2, d.r * s, 0, 2 * Math.PI);
      ctx.fill();
    }
    if (settled && s >= THUMBS_FROM && this.layout) {
      const [fx0, fy0] = this.toField(-s * 2, -s * 2);
      const [fx1, fy1] = this.toField(this.w + s * 2, this.h + s * 2);
      const shaped = this.layout.w !== undefined;
      const gap = shaped ? 0 : Math.max(1, Math.min(2, s * 0.008));
      for (const row of this.placedRows) {
        const x = this.to[row * 3], y = this.to[row * 3 + 1];
        if (x < fx0 || x > fx1 || y < fy0 || y > fy1) continue;
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
