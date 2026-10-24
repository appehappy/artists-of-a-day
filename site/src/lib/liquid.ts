// A row (or column) of controls drawn as one liquid shape, after Floema's menu: each
// item gets a blob in an SVG behind it, and a "goo" filter (blur, then a hard alpha
// threshold) merges blobs that come within a few pixels, so neighbours join with soft
// waists and colours run into each other at the joins. The gaps between items are
// springs: an item marked apart (the current page, the chosen colour) stretches away
// until its neck pinches off; a hovered one eases a little apart, still joined. A
// faint glow follows the pointer, masked by the same merged shape so it flows over
// the joins. Used by the header nav and the Wall's colour column.

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const SVG = "http://www.w3.org/2000/svg";
const STIFFNESS = 80, DAMPING = 10.5; // a little under critical: a soft overshoot
let instances = 0;

export interface LiquidOptions {
  axis: "x" | "y";
  joined: number; // px between neighbours at rest
  apart: number; // either side of an item marked apart (the goo lets go past ~4.5)
  nudge: number; // either side of a hovered item: stretched, but still joined
  isApart: (el: HTMLElement) => boolean;
  fill: (el: HTMLElement) => string; // a CSS colour for its blob
  outline?: boolean; // a hairline (--line) round the whole shape, for dark fills
  intro?: boolean; // first time: each blob buds out of the one before it
}

interface Gap { at: number; v: number; to: number; delay: number }

/** Make `root` (position: relative, holding `items` in a flex row or column) liquid.
 *  Call `retarget()` after changing what's apart, `refill()` after changing fills. */
export function liquid(root: HTMLElement, items: HTMLElement[], o: LiquidOptions) {
  const id = `liquid-${++instances}`;
  const x = o.axis === "x";
  const svg = document.createElementNS(SVG, "svg");
  svg.classList.add("liquid");
  svg.setAttribute("aria-hidden", "true");
  const edge = o.outline ? `
      <feMorphology in="goo" operator="dilate" radius="1" result="wide" />
      <feFlood class="liquid-edge" />
      <feComposite in2="wide" operator="in" result="edge" />
      <feMerge><feMergeNode in="edge" /><feMergeNode in="goo" /></feMerge>` : "";
  const rects = (fill = "") => items.map(() => `<rect${fill} />`).join("");
  svg.innerHTML = `
    <defs>
      <filter id="${id}-goo" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation="3" />
        <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 16 -7" result="goo" />${edge}
      </filter>
      <radialGradient id="${id}-glow" class="liquid-glow-fill"><stop offset="0" /><stop offset="1" /></radialGradient>
      <mask id="${id}-mask"><g filter="url(#${id}-goo)">${rects(' fill="#fff"')}</g></mask>
    </defs>
    <g class="liquid-blobs" filter="url(#${id}-goo)">${rects()}</g>
    <circle class="liquid-glow" r="48" cx="-99" cy="-99" fill="url(#${id}-glow)" mask="url(#${id}-mask)" />`;
  root.prepend(svg);
  const blobs = [...svg.querySelectorAll<SVGRectElement>(".liquid-blobs rect")];
  const masks = [...svg.querySelectorAll<SVGRectElement>("mask rect")];
  const glow = svg.querySelector<SVGCircleElement>(".liquid-glow")!;

  // gaps[k] sits between items k and k + 1: that item's left (or top) margin.
  const gaps: Gap[] = items.slice(1).map(() => ({ at: o.joined, v: 0, to: o.joined, delay: 0 }));
  let hovered: HTMLElement | null = null;
  const retarget = () => {
    const apart = items.filter(o.isApart);
    gaps.forEach((g, k) => {
      const pair = [items[k], items[k + 1]];
      g.to = pair.some((el) => apart.includes(el)) ? o.apart : hovered && pair.includes(hovered) ? o.nudge : o.joined;
    });
    refill();
    wake();
  };
  const refill = () => items.forEach((el, i) => { blobs[i].style.fill = o.fill(el); });

  if (o.intro && !reducedMotion()) {
    gaps.forEach((g, k) => {
      const size = x ? items[k + 1].offsetWidth : items[k + 1].offsetHeight;
      g.at = -size * 0.85;
      g.delay = 140 + k * 90;
    });
  }

  let frame = 0, last = 0;
  const wake = () => { if (!frame) { last = performance.now(); frame = requestAnimationFrame(step); } };
  function step(now: number) {
    const dt = Math.min(0.032, (now - last) / 1000);
    last = now;
    let moving = false;
    for (const g of gaps) {
      if (reducedMotion()) { g.at = g.to; g.v = 0; continue; }
      if (g.delay > 0) { g.delay -= dt * 1000; moving = true; continue; }
      g.v += (STIFFNESS * (g.to - g.at) - DAMPING * g.v) * dt;
      g.at += g.v * dt;
      if (Math.abs(g.to - g.at) > 0.02 || Math.abs(g.v) > 0.05) moving = true;
      else { g.at = g.to; g.v = 0; }
    }
    draw();
    frame = moving ? requestAnimationFrame(step) : 0;
  }
  function draw() {
    gaps.forEach((g, k) => { items[k + 1].style[x ? "marginLeft" : "marginTop"] = `${g.at.toFixed(2)}px`; });
    items.forEach((el, i) => {
      const h = el.offsetHeight, w = el.offsetWidth;
      for (const rect of [blobs[i], masks[i]]) {
        rect.setAttribute("x", String(el.offsetLeft));
        rect.setAttribute("y", String(el.offsetTop));
        rect.setAttribute("width", String(w));
        rect.setAttribute("height", String(h));
        rect.setAttribute("rx", String(Math.min(w, h) / 2));
      }
    });
  }

  for (const el of items) el.addEventListener("pointerenter", () => { hovered = el; retarget(); });
  root.addEventListener("pointerleave", () => {
    hovered = null;
    retarget();
    glow.classList.remove("on");
  });
  root.addEventListener("pointermove", (e) => {
    const r = root.getBoundingClientRect();
    glow.setAttribute("cx", String(e.clientX - r.left));
    glow.setAttribute("cy", String(e.clientY - r.top));
    glow.classList.add("on");
  });
  const onResize = () => draw();
  addEventListener("resize", onResize);
  draw();
  retarget();
  return { retarget, refill, destroy: () => removeEventListener("resize", onResize) };
}
