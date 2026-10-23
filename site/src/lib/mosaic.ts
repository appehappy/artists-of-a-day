// WebGL2 mosaic: every artwork is an instanced tile drawn from a texture array of
// sprite sheets (scripts/build_colourmaps.py). Layout changes animate on the GPU:
// each tile flies from where it is to where it's going, staggered along the
// gradient; works joining grow in, works leaving shrink out. From far away each tile
// is tinted towards its slot's colour (the zoom tint); close up, a 2D overlay draws
// the real thumbnails.

export interface AtlasInfo { tile: number; sheet: number; perRow: number; perSheet: number; sheets: number; count: number }

export interface MosaicOptions {
  thumbUrl: (row: number) => string;
  onHover: (row: number | null, x: number, y: number) => void;
  onSelect: (row: number | null) => void;
}

export interface Layout {
  rows: Int32Array; // artwork per slot
  x: Int32Array;
  y: Int32Array;
  t: Float32Array; // stagger order
  slotRgb: Float32Array;
}

interface Cam { x: number; y: number; s: number } // centre in cells; CSS px per cell

const DURATION = 1100; // ms per tile flight
const STAGGER = 650; // ms from the start of the gradient to its end
const THUMBS_FROM = 56; // px per cell at which real thumbnails take over
const MAX_SCALE = 360;
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Blend towards the slot colour: 65% when tiles are ~4px, gone by 24px. */
export const tintAmount = (px: number) => 0.65 * Math.min(1, Math.max(0, (24 - px) / 20));

const VERT = `#version 300 es
layout(location=0) in vec3 a_from;   // x, y, alpha
layout(location=1) in vec3 a_to;
layout(location=2) in float a_delay;
layout(location=3) in vec3 a_tint;
layout(location=4) in vec3 a_uv;     // u0, v0, sheet
uniform vec2 u_view;      // canvas size, CSS px
uniform vec3 u_cam;       // centre x, y (cells), px per cell
uniform float u_time;     // ms since the layout change
uniform float u_duration;
uniform float u_gap;      // px between tiles
uniform float u_tileUv;   // tile size in uv units
out vec3 v_uv;
out vec3 v_tint;
out float v_alpha;
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
  vec2 cellPx = vec2(u_cam.z);
  vec2 inset = (1.0 - size) * 0.5 * cellPx + vec2(u_gap * 0.5);
  vec2 px = (p - u_cam.xy) * u_cam.z + u_view * 0.5 + inset + corner * (cellPx * size - vec2(u_gap));
  gl_Position = alpha < 0.01 ? vec4(2.0, 2.0, 0.0, 1.0)
                             : vec4(px / u_view * 2.0 - 1.0, 0.0, 1.0) * vec4(1.0, -1.0, 1.0, 1.0);
  v_uv = vec3(a_uv.xy + corner * u_tileUv, a_uv.z);
  v_tint = a_tint;
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray u_atlas;
uniform float u_tintAmt;
in vec3 v_uv;
in vec3 v_tint;
in float v_alpha;
out vec4 colour;
void main() {
  vec3 c = texture(u_atlas, v_uv).rgb;
  colour = vec4(mix(c, v_tint, u_tintAmt) * v_alpha, v_alpha);
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
  private buf: Record<"from" | "to" | "delay" | "tint", WebGLBuffer>;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private n: number;
  // Per artwork: where its current flight starts and ends.
  private from: Float32Array;
  private to: Float32Array;
  private delay: Float32Array;
  private start = 0;
  private layout: Layout | null = null;
  private grid = new Map<number, number>(); // cell key -> row
  private bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };
  /** Screen px covered by panels on the right, kept clear when fitting the shape. */
  insetRight = 0;
  private w = 0;
  private h = 0;
  private dirty = true;
  private destroyed = false;
  private anim: { from: Cam; to: Cam; t0: number; ms: number } | null = null;
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

  /** Where each artwork is right now (mid-flight if an animation is running). */
  private current(i: number): [number, number, number] {
    const t = Math.min(1, Math.max(0, (performance.now() - this.start - this.delay[i]) / DURATION));
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const f = this.from, o = this.to, k = i * 3;
    return [f[k] + (o[k] - f[k]) * e, f[k + 1] + (o[k + 1] - f[k + 1]) * e, f[k + 2] + (o[k + 2] - f[k + 2]) * e];
  }

  setLayout(layout: Layout) {
    const animate = !reducedMotion() && this.layout !== null;
    const now = performance.now();
    // Centre the new shape on the origin so shapes overlap as they change.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < layout.rows.length; i++) {
      x0 = Math.min(x0, layout.x[i]); y0 = Math.min(y0, layout.y[i]);
      x1 = Math.max(x1, layout.x[i] + 1); y1 = Math.max(y1, layout.y[i] + 1);
    }
    const cx = Math.floor((x0 + x1) / 2), cy = Math.floor((y0 + y1) / 2); // whole cells
    this.bounds = { x0: x0 - cx, y0: y0 - cy, x1: x1 - cx, y1: y1 - cy };

    const nextFrom = new Float32Array(this.n * 3);
    const nextTo = new Float32Array(this.n * 3);
    const nextDelay = new Float32Array(this.n);
    const tint = new Float32Array(this.n * 3);
    const placed = new Uint8Array(this.n);
    this.grid.clear();
    for (let i = 0; i < layout.rows.length; i++) {
      const row = layout.rows[i];
      const x = layout.x[i] - cx, y = layout.y[i] - cy;
      placed[row] = 1;
      this.grid.set(Math.round(x) * 100000 + Math.round(y), row);
      nextTo.set([x, y, 1], row * 3);
      tint.set(layout.slotRgb.subarray(i * 3, i * 3 + 3), row * 3);
      nextDelay[row] = animate ? layout.t[i] * STAGGER + Math.random() * 120 : -DURATION;
    }
    for (let row = 0; row < this.n; row++) {
      const [px, py, pa] = animate ? this.current(row) : [0, 0, 0];
      if (placed[row]) {
        if (pa > 0.01) nextFrom.set([px, py, pa], row * 3); // already showing: fly over
        else {
          // joining: start just off its spot, scattered, and grow in
          const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 18;
          nextFrom.set([nextTo[row * 3] + Math.cos(a) * r, nextTo[row * 3 + 1] + Math.sin(a) * r, 0], row * 3);
        }
      } else {
        // leaving (or never shown): shrink out where it is
        nextFrom.set([px, py, pa], row * 3);
        nextTo.set([px, py, 0], row * 3);
        nextDelay[row] = animate ? Math.random() * 200 : -DURATION;
      }
    }
    this.from = nextFrom;
    this.to = nextTo;
    this.delay = nextDelay;
    this.start = now;
    const gl = this.gl;
    for (const [key, data] of [["from", nextFrom], ["to", nextTo], ["delay", nextDelay], ["tint", tint]] as const) {
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
    return Math.min((this.w - this.insetRight) / (x1 - x0 + 16), this.h / (y1 - y0 + 16));
  }

  /** Fit the whole shape into the area left of any right-hand panel. */
  fit(animate = true) {
    const s = this.fitScale();
    this.flyTo({ x: this.insetRight / (2 * s), y: 0, s }, animate ? 900 : 0);
  }

  flyTo(to: Partial<Cam>, ms = 700) {
    const target = { ...this.cam, ...to };
    target.s = Math.min(MAX_SCALE, Math.max(this.fitScale() * 0.5, target.s));
    if (ms === 0 || reducedMotion()) { Object.assign(this.cam, target); this.invalidate(); return; }
    this.anim = { from: { ...this.cam }, to: target, t0: performance.now(), ms };
  }

  flyToRow(row: number, s = 140) {
    const k = row * 3;
    this.flyTo({ x: this.to[k] + 0.5, y: this.to[k + 1] + 0.5, s });
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

  rowAt(sx: number, sy: number): number | null {
    const [fx, fy] = this.toField(sx, sy);
    return this.grid.get(Math.floor(fx) * 100000 + Math.floor(fy)) ?? null;
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
    gl.uniform1f(this.u.u_gap, this.cam.s >= 12 ? Math.max(1, Math.min(2, this.cam.s * 0.008)) : 0);
    gl.uniform1f(this.u.u_tintAmt, tintAmount(this.cam.s));
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
    this.drawOverlay();
  }

  private drawOverlay() {
    const ctx = this.overlay;
    ctx.clearRect(0, 0, this.w, this.h);
    const settled = performance.now() - this.start > STAGGER + DURATION;
    const s = this.cam.s;
    if (settled && s >= THUMBS_FROM && this.layout) {
      const [fx0, fy0] = this.toField(0, 0);
      const [fx1, fy1] = this.toField(this.w, this.h);
      const gap = Math.max(1, Math.min(2, s * 0.008));
      for (let x = Math.floor(fx0); x <= Math.floor(fx1); x++) {
        for (let y = Math.floor(fy0); y <= Math.floor(fy1); y++) {
          const row = this.grid.get(x * 100000 + y);
          if (row === undefined) continue;
          const img = this.thumbs.get(this.opts.thumbUrl(row));
          if (!img) continue;
          const sx = (x - this.cam.x) * s + this.w / 2, sy = (y - this.cam.y) * s + this.h / 2;
          const side = Math.min(img.width, img.height);
          ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side,
                        sx + gap / 2, sy + gap / 2, s - gap, s - gap);
        }
      }
    }
    for (const [row, colour, width] of [[this.hovered, "#fff", 1.5], [this.selected, "#ef6a4c", 3]] as const) {
      if (row === null || s < 6 || !settled) continue;
      const k = row * 3;
      const sx = (this.to[k] - this.cam.x) * s + this.w / 2, sy = (this.to[k + 1] - this.cam.y) * s + this.h / 2;
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.strokeRect(sx + 0.5, sy + 0.5, s - 1, s - 1);
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
