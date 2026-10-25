// A row of filter chips that stays on one line (from tablet width up): the chips that
// don't fit move, in order, into a menu behind a "…" chip at the end of the row. They
// keep working there (same buttons, same handlers), and the "…" chip takes the chosen
// colour while one of them is on, so an active filter is never out of sight. On phones
// the row wraps as usual.

const WIDE = "(min-width: 721px)";

export function overflowRow(row: HTMLElement, label: string) {
  const chips = [...row.querySelectorAll<HTMLElement>(":scope > .chip[data-value]")];
  const more = document.createElement("div");
  more.className = "chip-more";
  more.hidden = true;
  more.innerHTML = `<button type="button" class="chip more-btn" aria-haspopup="true" aria-expanded="false"
    aria-label="More ${label}" title="More ${label}">…</button><div class="chip-menu" role="group" aria-label="More ${label}"></div>`;
  row.append(more);
  const btn = more.querySelector<HTMLButtonElement>(".more-btn")!;
  const menu = more.querySelector<HTMLElement>(".chip-menu")!;
  const wide = matchMedia(WIDE);

  function fit() {
    for (const c of chips) row.insertBefore(c, more); // all back in the row, in order
    more.hidden = true;
    if (wide.matches && row.scrollWidth > row.clientWidth + 1) {
      more.hidden = false;
      const right = row.getBoundingClientRect().left + row.clientWidth;
      for (let i = chips.length - 1; i > 0 && more.getBoundingClientRect().right > right + 0.5; i--) {
        menu.prepend(chips[i]);
      }
    }
    if (!menu.childElementCount) close();
    sync();
  }
  function sync() {
    btn.classList.toggle("has-active", !!menu.querySelector('[aria-pressed="true"]'));
  }
  function open() {
    more.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
  }
  function close() {
    more.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
  }

  btn.addEventListener("click", () => (more.classList.contains("open") ? close() : open()));
  const onDocClick = (e: MouseEvent) => { if (!more.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && more.classList.contains("open")) { close(); btn.focus(); }
  };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
  wide.addEventListener("change", fit);
  fit();
  document.fonts?.ready.then(fit); // widths change once Inter arrives

  return {
    fit,
    sync,
    destroy() {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", fit);
    },
  };
}
