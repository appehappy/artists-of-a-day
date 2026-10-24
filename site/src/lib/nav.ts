// The header nav: a row of pills overlapping by a pixel, so they read as one; the
// current page's pill (in the Wall's chosen colour, if any) stands apart from the
// rest, 6px either side. The header persists across page changes, so on each one the
// old pill eases back into the row and the new one springs out of it (the margins
// animate in global.css). Shuffle shuffles its own letters before it takes you
// somewhere.

import { navigate } from "astro:transitions/client";
import { loadSite } from "./client";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const isCurrent = (href: string, path: string) =>
  href === "/" ? path === "/" : path.startsWith(href.replace(/\/[^/]*$/, "") || href);

export function mountNav(nav: HTMLElement) {
  const links = [...nav.querySelectorAll<HTMLAnchorElement>("a")];

  // Mark the current page (the header isn't re-rendered on page changes).
  const current = links.find((a) => isCurrent(a.getAttribute("href")!, location.pathname));
  const changed = current?.getAttribute("aria-current") !== "page";
  for (const a of links) {
    if (a === current) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const first = !nav.dataset.bound;
  if (!first && changed && current && !reducedMotion()) { // a little pop as it separates
    current.classList.remove("pop");
    void current.offsetWidth;
    current.classList.add("pop");
  }
  if (!first) return;
  nav.dataset.bound = "1";

  // First visit: the pills rise in one after another.
  if (!reducedMotion()) {
    nav.classList.add("intro");
    setTimeout(() => nav.classList.remove("intro"), 1200);
  }
  nav.addEventListener("animationend", (e) => (e.target as HTMLElement).classList.remove("pop"));

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
  el.style.minWidth = `${el.offsetWidth}px`; // don't let the track jiggle
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
