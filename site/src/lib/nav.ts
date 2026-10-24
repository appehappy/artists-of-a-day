// The header nav, after Floema's: the pills are drawn as one liquid shape behind
// the labels (a "goo" filter in Base.astro merges blobs that come close), so
// neighbours join with soft waists rather than notches. The current page's pill (in
// the Wall's chosen colour, if any) stands 6px apart from the rest: on a page change
// it stretches away, its neck thinning until it pinches off, while the old one flows
// back into the row. Hovering a pill eases it a little apart, still joined; a faint
// glow follows the pointer. The gaps are springs, so everything settles rather than
// stops. Shuffle shuffles its own letters before it takes you somewhere.

import { navigate } from "astro:transitions/client";
import { loadSite } from "./client";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const isCurrent = (href: string, path: string) =>
  href === "/" ? path === "/" : path.startsWith(href.replace(/\/[^/]*$/, "") || href);

const JOINED = -1; // px between neighbours at rest: overlapping, so they read as one
const APART = 6; // either side of the current page's pill (the goo lets go past ~4.5)
const NUDGE = 3; // either side of a hovered pill: stretched, but still joined
const STIFFNESS = 80, DAMPING = 10.5; // a little under critical: a soft overshoot

interface Gap { at: number; v: number; to: number; delay: number }

export function mountNav(nav: HTMLElement) {
  const items = [...nav.querySelectorAll<HTMLElement>(":scope > a, :scope > button")];
  const links = items.filter((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement);

  // Mark the current page (the header isn't re-rendered on page changes).
  const current = links.find((a) => isCurrent(a.getAttribute("href")!, location.pathname));
  for (const a of links) {
    if (a === current) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const blobs = [...nav.querySelectorAll<HTMLElement>(".nav-goo > span")];
  blobs.forEach((b, i) => b.classList.toggle("current", items[i] === current));

  if (nav.dataset.bound) { nav.dispatchEvent(new Event("nav:retarget")); return; }
  nav.dataset.bound = "1";

  // gaps[k] sits between items k and k + 1; it's that item's left margin.
  const gaps: Gap[] = items.slice(1).map(() => ({ at: JOINED, v: 0, to: JOINED, delay: 0 }));
  let hovered: HTMLElement | null = null;
  const retarget = () => {
    const now = nav.querySelector<HTMLElement>('[aria-current="page"]');
    gaps.forEach((g, k) => {
      const pair = [items[k], items[k + 1]];
      g.to = now && pair.includes(now) ? APART : hovered && pair.includes(hovered) ? NUDGE : JOINED;
    });
    wake();
  };

  // First visit: each pill buds out of the one before it, left to right.
  if (!reducedMotion()) {
    gaps.forEach((g, k) => { g.at = -items[k + 1].offsetWidth * 0.85; g.delay = 140 + k * 90; });
    nav.classList.add("intro");
    setTimeout(() => nav.classList.remove("intro"), 1400);
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
    gaps.forEach((g, k) => { items[k + 1].style.marginLeft = `${g.at.toFixed(2)}px`; });
    items.forEach((el, i) => {
      blobs[i].style.transform = `translateX(${el.offsetLeft}px)`;
      blobs[i].style.width = `${el.offsetWidth}px`;
    });
  }

  for (const el of items) {
    el.addEventListener("pointerenter", () => { hovered = el; retarget(); });
  }
  nav.addEventListener("pointerleave", () => {
    hovered = null;
    retarget();
    for (const el of items) el.style.removeProperty("--gx");
  });
  // The glow: a soft light under the pointer, inside whichever pills it's over.
  nav.addEventListener("pointermove", (e) => {
    for (const el of items) {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--gx", `${e.clientX - r.left}px`);
      el.style.setProperty("--gy", `${e.clientY - r.top}px`);
    }
  });
  nav.addEventListener("nav:retarget", retarget);
  addEventListener("resize", draw);
  draw();
  retarget();

  const shuffle = nav.querySelector<HTMLButtonElement>("[data-shuffle]")!;
  shuffle.addEventListener("click", async () => {
    const pick = loadSite().then(({ artists }) => artists[Math.floor(Math.random() * artists.length)].slug);
    if (!reducedMotion()) await scramble(shuffle);
    navigate(`/artist/${await pick}`);
  });
}

/** Shuffle a button's letters a few times, then settle back on its label. */
function scramble(el: HTMLElement) {
  const label = el.dataset.label ?? el.textContent!;
  el.dataset.label = label;
  el.style.minWidth = `${el.offsetWidth}px`; // don't let the row jiggle
  const letters = [...label];
  return new Promise<void>((done) => {
    let step = 0;
    const timer = setInterval(() => {
      step++;
      if (step >= 7) {
        clearInterval(timer);
        el.textContent = label;
        el.style.minWidth = "";
        done();
        return;
      }
      // Letters lock into place left to right as the shuffle runs down.
      const settled = Math.floor((step / 7) * letters.length);
      const rest = letters.slice(settled).sort(() => Math.random() - 0.5);
      el.textContent = letters.slice(0, settled).join("") + rest.join("");
    }, 55);
  });
}
