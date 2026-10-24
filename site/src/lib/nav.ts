// The header nav, after Floema's: its pills are one liquid shape (lib/liquid.ts), so
// neighbours join with soft waists rather than notches. The current page's pill (in
// the Wall's chosen colour, if any) stands 6px apart: the header persists across page
// changes, so on each one the new pill stretches away until its neck pinches off and
// the old one flows back into the row. Shuffle shuffles its own letters before it
// takes you somewhere.

import { navigate } from "astro:transitions/client";
import { loadSite } from "./client";
import { liquid } from "./liquid";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const isCurrent = (href: string, path: string) =>
  href === "/" ? path === "/" : path.startsWith(href.replace(/\/[^/]*$/, "") || href);

let shape: ReturnType<typeof liquid> | null = null;

export function mountNav(nav: HTMLElement) {
  const items = [...nav.querySelectorAll<HTMLElement>(":scope > a, :scope > button")];
  const links = items.filter((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement);

  // Mark the current page (the header isn't re-rendered on page changes).
  const current = links.find((a) => isCurrent(a.getAttribute("href")!, location.pathname));
  for (const a of links) {
    if (a === current) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (shape) { shape.retarget(); return; }

  shape = liquid(nav, items, {
    axis: "x", joined: -1, apart: 6, nudge: 3, intro: true,
    isApart: (el) => el.getAttribute("aria-current") === "page",
    fill: (el) => (el.getAttribute("aria-current") === "page" ? "var(--pick)" : "var(--line)"),
  });
  // First visit: the labels fade in as their pills bud out.
  if (!reducedMotion()) {
    nav.classList.add("intro");
    setTimeout(() => nav.classList.remove("intro"), 1400);
  }

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
