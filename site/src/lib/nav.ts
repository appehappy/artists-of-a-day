// The header nav: a track of pills with the current page's pill lifted out of it
// (in the Wall's chosen colour, if any). The header persists across page changes, so
// the pill glides to the new page — its leading edge first, the trailing edge
// catching up — and a faint ghost pill follows the pointer along the track. Shuffle
// shuffles its own letters before it takes you somewhere.

import { navigate } from "astro:transitions/client";
import { loadSite } from "./client";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const isCurrent = (href: string, path: string) =>
  href === "/" ? path === "/" : path.startsWith(href.replace(/\/[^/]*$/, "") || href);

/** Put a pill (absolutely positioned in the track) over an item. Moving right, its
 *  right edge leads; moving left, its left edge does. */
function cover(pill: HTMLElement, item: HTMLElement, glide: boolean) {
  const track = pill.parentElement!;
  const left = item.offsetLeft, right = track.clientWidth - item.offsetLeft - item.offsetWidth;
  const was = Number(pill.dataset.left ?? left);
  const lead = "0s", lag = "0.09s";
  pill.style.transitionDelay = !glide ? "0s"
    : left > was ? `${lag}, ${lead}, 0s, 0s` : `${lead}, ${lag}, 0s, 0s`; // left, right, colour, opacity
  pill.classList.toggle("instant", !glide);
  pill.style.left = `${left}px`;
  pill.style.right = `${right}px`;
  pill.dataset.left = String(left);
}

export function mountNav(nav: HTMLElement) {
  const pill = nav.querySelector<HTMLElement>(".nav-pill")!;
  const ghost = nav.querySelector<HTMLElement>(".nav-ghost")!;
  const items = [...nav.querySelectorAll<HTMLElement>("a, button")];
  const links = items.filter((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement);

  // Mark the current page (the header isn't re-rendered on page changes).
  const current = links.find((a) => isCurrent(a.getAttribute("href")!, location.pathname));
  for (const a of links) {
    if (a === current) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const first = !nav.dataset.bound, shown = !pill.hidden;
  pill.hidden = !current;
  if (current) cover(pill, current, !first && shown && !reducedMotion()); // from a page with no pill: just appear
  if (!first) return;
  nav.dataset.bound = "1";

  // First visit: the pills rise in one after another.
  if (!reducedMotion()) nav.classList.add("intro");
  nav.addEventListener("animationend", () => nav.classList.remove("intro"), { once: true });

  // The ghost pill follows the pointer from item to item.
  for (const item of items) {
    item.addEventListener("pointerenter", () => {
      cover(ghost, item, ghost.classList.contains("on") && !reducedMotion());
      ghost.classList.add("on");
    });
  }
  nav.addEventListener("pointerleave", () => ghost.classList.remove("on"));
  addEventListener("resize", () => {
    const now = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (now) cover(pill, now, false);
  });

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
