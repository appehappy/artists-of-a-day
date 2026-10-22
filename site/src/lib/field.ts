// Zoomable mosaic of every artwork, drawn on a canvas like a slippy map:
//   far out   one overview image of the whole field (8px per cell)
//   closer    32-cell chunk images at 32px per cell, loaded as they come into view
//   close up  each visible artwork's own thumbnail
// Built by scripts/build_fields.py into /fields/<name>/.

export interface FieldLayout {
  name: string;
  width: number; // cells
  height: number;
  count: number;
  tile: number; // px per cell in chunk images
  overview: number; // px per cell in the overview image
  chunk: number; // cells per chunk side
  chunks: string[]; // "x_y" of the chunk images that exist (empty areas have none)
  labelStyle: "top" | "cloud";
  labels: { text: string; x: number; y: number; size?: number }[];
}

export interface FieldOptions {
  thumbUrl: (row: number) => string;
  onHover: (row: number | null, screenX: number, screenY: number) => void;
  onSelect: (row: number | null) => void;
}

interface Camera { x: number; y: number; s: number } // centre in cells; CSS px per cell

const CHUNK_FROM = 5; // px per cell at which chunk images take over from the overview
const THUMBS_FROM = 80; // px per cell at which individual thumbnails are drawn
const MAX_SCALE = 420;
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export async function loadField(name: string) {
  const base = `/fields/${name}`;
  const ok = (r: Response) => {
    if (!r.ok) throw new Error(`${r.url}: ${r.status}`);
    return r;
  };
  const [layout, cellsBuf] = await Promise.all([
    fetch(`${base}/layout.json`).then(ok).then((r) => r.json() as Promise<FieldLayout>),
    fetch(`${base}/cells.bin`).then(ok).then((r) => r.arrayBuffer()),
  ]);
  const overview = new Image();
  overview.src = `${base}/overview.webp`;
  await overview.decode();
  return { base, layout, cells: new Int32Array(cellsBuf), overview };
}

/** Least-recently-used image cache. */
class ImageCache {
  private map = new Map<string, HTMLImageElement | "loading" | "missing">();
  constructor(private limit: number, private onLoad: () => void) {}

  get(url: string): HTMLImageElement | null {
    const v = this.map.get(url);
    if (v instanceof HTMLImageElement) {
      this.map.delete(url);
      this.map.set(url, v); // mark as recently used
      return v;
    }
    if (v === undefined) {
      this.map.set(url, "loading");
      const img = new Image();
      img.decoding = "async";
      img.onload = () => { this.map.set(url, img); this.trim(); this.onLoad(); };
      img.onerror = () => this.map.set(url, "missing");
      img.src = url;
    }
    return null;
  }

  private trim() {
    for (const [k, v] of this.map) {
      if (this.map.size <= this.limit) break;
      if (v instanceof HTMLImageElement) this.map.delete(k);
    }
  }
}

export class FieldView {
  readonly cam: Camera = { x: 0, y: 0, s: 1 };
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dirty = true;
  private anim: { from: Camera; to: Camera; mid: number; start: number; ms: number } | null = null;
  private chunks: ImageCache;
  private thumbs: ImageCache;
  private rowCell: Int32Array;
  private chunkSet: Set<string>;
  hovered: number | null = null;
  selected: number | null = null;
  private colours: { bg: string; ink: string; muted: string; accent: string };
  private cleanup: (() => void)[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private base: string,
    readonly layout: FieldLayout,
    private cells: Int32Array,
    private overview: HTMLImageElement,
    private opts: FieldOptions,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.chunks = new ImageCache(160, () => this.invalidate());
    this.thumbs = new ImageCache(500, () => this.invalidate());
    this.chunkSet = new Set(layout.chunks);
    this.rowCell = new Int32Array(layout.count).fill(-1);
    cells.forEach((row, i) => { if (row >= 0) this.rowCell[row] = i; });
    const css = getComputedStyle(document.documentElement);
    this.colours = {
      bg: css.getPropertyValue("--bg").trim(), ink: css.getPropertyValue("--ink").trim(),
      muted: css.getPropertyValue("--muted").trim(), accent: css.getPropertyValue("--accent").trim(),
    };
    this.resize();
    this.fit(false);
    this.bindInput();
    const ro = new ResizeObserver(() => { this.resize(); this.invalidate(); });
    ro.observe(canvas);
    this.cleanup.push(() => ro.disconnect());
    const loop = () => {
      if (this.destroyed) return;
      this.step();
      if (this.dirty) { this.draw(); this.dirty = false; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private destroyed = false;
  destroy() { this.destroyed = true; this.cleanup.forEach((f) => f()); }
  invalidate() { this.dirty = true; }

  // ── camera ────────────────────────────────────────────────────────────────
  private fitScale() {
    const { width, height, labelStyle } = this.layout;
    const top = labelStyle === "top" ? 2 : 0; // room for the hue labels above the field
    return Math.min(this.w / (width + 2), this.h / (height + 2 + top));
  }

  fit(animate = true) {
    const { width, height, labelStyle } = this.layout;
    const to = { x: width / 2, y: height / 2 - (labelStyle === "top" ? 1 : 0), s: this.fitScale() };
    animate ? this.flyTo(to) : Object.assign(this.cam, to);
    this.invalidate();
  }

  /** Smoothly move the camera, zooming out mid-flight for long hops. */
  flyTo(to: Partial<Camera>, ms?: number) {
    const target = { ...this.cam, ...to };
    target.s = Math.min(MAX_SCALE, Math.max(this.fitScale() * 0.8, target.s));
    if (reducedMotion()) { Object.assign(this.cam, target); this.invalidate(); return; }
    const dist = Math.hypot(target.x - this.cam.x, target.y - this.cam.y);
    // Zoom out far enough that both ends are on screen at the midpoint.
    const span = Math.min(this.cam.s, target.s, Math.max(this.fitScale(), Math.min(this.w, this.h) / (dist * 1.3 + 1)));
    this.anim = { from: { ...this.cam }, to: target, mid: Math.log(span), start: performance.now(),
                  ms: ms ?? Math.min(1600, 500 + dist * 4) };
  }

  flyToRow(row: number, s = 160) {
    const cell = this.rowCell[row];
    if (cell < 0) return false;
    this.flyTo({ x: (cell % this.layout.width) + 0.5, y: Math.floor(cell / this.layout.width) + 0.5, s });
    return true;
  }

  zoomBy(factor: number, sx = this.w / 2, sy = this.h / 2) {
    const [fx, fy] = this.toField(sx, sy);
    const s = Math.min(MAX_SCALE, Math.max(this.fitScale() * 0.6, this.cam.s * factor));
    this.anim = null;
    this.cam.x = fx - (sx - this.w / 2) / s;
    this.cam.y = fy - (sy - this.h / 2) / s;
    this.cam.s = s;
    this.invalidate();
  }

  private step() {
    if (!this.anim) return;
    const { from, to, mid, start, ms } = this.anim;
    const t = Math.min(1, (performance.now() - start) / ms);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
    const a = Math.log(from.s), b = Math.log(to.s);
    // Quadratic curve through log-scale: out to `mid`, then in to the target.
    const m = Math.min(mid, a, b);
    this.cam.s = Math.exp((1 - e) * (1 - e) * a + 2 * e * (1 - e) * m + e * e * b);
    this.cam.x = from.x + (to.x - from.x) * e;
    this.cam.y = from.y + (to.y - from.y) * e;
    if (t >= 1) this.anim = null;
    this.invalidate();
  }

  toField(sx: number, sy: number): [number, number] {
    return [this.cam.x + (sx - this.w / 2) / this.cam.s, this.cam.y + (sy - this.h / 2) / this.cam.s];
  }

  private toScreen(fx: number, fy: number): [number, number] {
    return [(fx - this.cam.x) * this.cam.s + this.w / 2, (fy - this.cam.y) * this.cam.s + this.h / 2];
  }

  rowAt(sx: number, sy: number): number | null {
    const [fx, fy] = this.toField(sx, sy);
    const x = Math.floor(fx), y = Math.floor(fy);
    if (x < 0 || y < 0 || x >= this.layout.width || y >= this.layout.height) return null;
    const row = this.cells[y * this.layout.width + x];
    return row >= 0 ? row : null;
  }

  cellScreenRect(row: number) {
    const cell = this.rowCell[row];
    const [x, y] = this.toScreen(cell % this.layout.width, Math.floor(cell / this.layout.width));
    return { x, y, size: this.cam.s };
  }

  // ── drawing ───────────────────────────────────────────────────────────────
  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private draw() {
    const { ctx, cam, layout } = this;
    const { width: W, height: H, chunk, tile } = layout;
    ctx.fillStyle = this.colours.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = cam.s < 8 ? "high" : "medium";

    const [ox, oy] = this.toScreen(0, 0);
    ctx.drawImage(this.overview, ox, oy, W * cam.s, H * cam.s);

    const [fx0, fy0] = this.toField(0, 0);
    const [fx1, fy1] = this.toField(this.w, this.h);
    if (cam.s >= CHUNK_FROM) {
      for (let cy = Math.max(0, Math.floor(fy0 / chunk)); cy <= Math.min(Math.ceil(H / chunk) - 1, Math.floor(fy1 / chunk)); cy++) {
        for (let cx = Math.max(0, Math.floor(fx0 / chunk)); cx <= Math.min(Math.ceil(W / chunk) - 1, Math.floor(fx1 / chunk)); cx++) {
          if (!this.chunkSet.has(`${cx}_${cy}`)) continue;
          const img = this.chunks.get(`${this.base}/chunks/${cx}_${cy}.webp`);
          if (!img) continue;
          const [x, y] = this.toScreen(cx * chunk, cy * chunk);
          ctx.drawImage(img, x, y, (img.width / tile) * cam.s, (img.height / tile) * cam.s);
        }
      }
    }

    if (cam.s >= THUMBS_FROM) {
      const gap = Math.min(10, cam.s * 0.04);
      ctx.fillStyle = this.colours.bg;
      for (let y = Math.max(0, Math.floor(fy0)); y <= Math.min(H - 1, Math.floor(fy1)); y++) {
        for (let x = Math.max(0, Math.floor(fx0)); x <= Math.min(W - 1, Math.floor(fx1)); x++) {
          const row = this.cells[y * W + x];
          if (row < 0) continue;
          const [sx, sy] = this.toScreen(x, y);
          const img = this.thumbs.get(this.opts.thumbUrl(row));
          // Gaps between works appear as you zoom in, like a salon wall.
          ctx.fillRect(sx, sy, cam.s, gap);
          ctx.fillRect(sx, sy, gap, cam.s);
          if (!img) continue;
          const side = Math.min(img.width, img.height);
          ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side,
                        sx + gap, sy + gap, cam.s - gap, cam.s - gap);
        }
      }
    }

    for (const [row, colour, width] of [[this.hovered, this.colours.ink, 1.5], [this.selected, this.colours.accent, 3]] as const) {
      if (row === null || cam.s < 6) continue;
      const r = this.cellScreenRect(row);
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.size - 1, r.size - 1);
    }
    this.drawLabels();
  }

  private drawLabels() {
    const { ctx, cam, layout } = this;
    if (layout.labelStyle === "top") {
      if (cam.s > 40) return;
      ctx.font = `500 12px Inter, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = this.colours.muted;
      const [, y] = this.toScreen(0, 0);
      for (const l of layout.labels) {
        const [x] = this.toScreen(l.x, 0);
        ctx.fillText(l.text.toUpperCase(), x, y - 8);
      }
      return;
    }
    // Cluster names fade out as you zoom in on the works themselves.
    const fade = Math.max(0, Math.min(1, (14 - cam.s) / 8));
    if (fade <= 0) return;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (const l of layout.labels) {
      const [x, y] = this.toScreen(l.x, l.y);
      if (x < -200 || y < -50 || x > this.w + 200 || y > this.h + 50) continue;
      const size = Math.round(Math.min(26, 12 + Math.sqrt(l.size ?? 400) / 7));
      ctx.font = `400 ${size}px "Instrument Serif", Georgia, serif`;
      ctx.globalAlpha = fade;
      ctx.lineWidth = 5;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.strokeText(l.text, x, y);
      ctx.fillStyle = "#fff";
      ctx.fillText(l.text, x, y);
      ctx.globalAlpha = 1;
    }
  }

  // ── input ─────────────────────────────────────────────────────────────────
  private bindInput() {
    const c = this.canvas;
    let drag: { x: number; y: number; moved: boolean; vx: number; vy: number; t: number } | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number } | null = null;

    const local = (e: { clientX: number; clientY: number }) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };

    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      c.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => c.removeEventListener(type, fn as EventListener));
    };

    on("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
        drag = null;
      } else {
        drag = { x: e.clientX, y: e.clientY, moved: false, vx: 0, vy: 0, t: performance.now() };
        this.anim = null;
      }
    });
    on("pointermove", (e) => {
      const [sx, sy] = local(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const [mx, my] = local({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
        this.zoomBy(dist / pinch.dist, mx, my);
        pinch.dist = dist;
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        const now = performance.now();
        drag.vx = dx / Math.max(1, now - drag.t);
        drag.vy = dy / Math.max(1, now - drag.t);
        drag.t = now;
        this.cam.x -= dx / this.cam.s;
        this.cam.y -= dy / this.cam.s;
        drag.x = e.clientX;
        drag.y = e.clientY;
        this.invalidate();
        return;
      }
      const row = this.cam.s >= 4 ? this.rowAt(sx, sy) : null;
      if (row !== this.hovered) {
        this.hovered = row;
        this.invalidate();
      }
      this.opts.onHover(row, sx, sy);
    });
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!drag) return;
      const wasClick = !drag.moved;
      const { vx, vy } = drag;
      drag = null;
      if (wasClick) {
        const [sx, sy] = local(e);
        const row = this.rowAt(sx, sy);
        this.selected = row;
        this.invalidate();
        this.opts.onSelect(row);
      } else if (!reducedMotion() && Math.hypot(vx, vy) > 0.3) {
        // A little momentum after a flick.
        this.flyTo({ x: this.cam.x - (vx * 220) / this.cam.s, y: this.cam.y - (vy * 220) / this.cam.s }, 600);
      }
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
      if (e.ctrlKey || e.metaKey) {
        this.zoomBy(Math.exp(-e.deltaY * 0.012), sx, sy); // trackpad pinch arrives as ctrl+wheel
      } else if (e.deltaMode === 1 || (Math.abs(e.deltaY) >= 50 && e.deltaX === 0 && Number.isInteger(e.deltaY))) {
        this.zoomBy(Math.exp(-Math.sign(e.deltaY) * 0.25), sx, sy); // mouse wheel: zoom
      } else {
        this.anim = null;
        this.cam.x += e.deltaX / this.cam.s; // trackpad two-finger scroll: pan
        this.cam.y += e.deltaY / this.cam.s;
        this.invalidate();
      }
    }, { passive: false });
  }
}
