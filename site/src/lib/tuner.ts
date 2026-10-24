// A temporary panel of sliders for tuning the Constellation's motion and light live
// (open the page with ?tune). Values are kept in this browser between reloads; "Copy
// values" gives the changed ones as JSON, to make permanent in mosaic.ts's `tune`.

import { tune, TUNE_DEFAULTS } from "./mosaic";

type Key = keyof typeof tune;
const GROUPS: [string, [Key, string, number, number, number][]][] = [
  ["Pointer push", [
    ["brushReach", "Reach (px)", 2, 40, 1],
    ["brushGive", "Give (share of pointer movement)", 0, 1, 0.01],
    ["brushMax", "Furthest (px)", 0, 30, 0.5],
    ["brushCarry", "Momentum kept", 0, 0.5, 0.01],
    ["springStiffness", "Spring back (briskness)", 1, 20, 0.5],
    ["springDamping", "Spring damping (≥1: no overshoot)", 0.1, 2, 0.05],
  ]],
  ["Disturbance", [
    ["stirStrength", "From pointer: strength (px)", 0, 15, 0.25],
    ["stirReach", "From pointer: reach (px)", 20, 800, 10],
    ["stirEvery", "From pointer: every (ms)", 40, 600, 10],
    ["selectStrength", "From selection: strength (px)", 0, 40, 0.5],
    ["selectReach", "From selection: reach (px)", 50, 1200, 10],
    ["waveSpeed", "Spreads at (px/ms)", 0.05, 2, 0.01],
    ["driftOut", "Drift out (ms)", 20, 1000, 10],
    ["driftBack", "Glide back (ms)", 100, 6000, 50],
    ["depthFar", "Farthest stars move (share)", 0, 1, 0.01],
    ["depthDelay", "Farthest stars lag (ms)", 0, 600, 10],
  ]],
  ["Light", [
    ["spotRadius", "Spotlight radius (px)", 30, 600, 5],
    ["spotDim", "Outside the spotlight", 0, 1, 0.01],
    ["focusDim", "Around a selection", 0, 1, 0.01],
    ["twinkle", "Twinkle", 0, 1, 0.01],
    ["turnSpeed", "Idle turn (× speed)", 0, 10, 0.1],
  ]],
];
const STORE = "aotd-tune";

export function mountTuner(root: HTMLElement, onChange: () => void) {
  try {
    Object.assign(tune, JSON.parse(localStorage.getItem(STORE) ?? "{}"));
  } catch { /* storage unavailable: start from the defaults */ }
  const save = () => {
    try { localStorage.setItem(STORE, JSON.stringify(changed())); } catch { /* not kept */ }
  };
  const changed = () => Object.fromEntries(
    (Object.keys(tune) as Key[]).filter((k) => tune[k] !== TUNE_DEFAULTS[k]).map((k) => [k, tune[k]]));

  const panel = document.createElement("details");
  panel.className = "panel tuner";
  panel.open = true;
  const summary = document.createElement("summary");
  summary.textContent = "Tune the motion";
  panel.append(summary);
  const inputs = new Map<Key, [HTMLInputElement, HTMLOutputElement]>();
  for (const [title, rows] of GROUPS) {
    const h = document.createElement("h4");
    h.textContent = title;
    panel.append(h);
    for (const [key, label, min, max, step] of rows) {
      const row = document.createElement("label");
      const name = document.createElement("span");
      name.textContent = label;
      const out = document.createElement("output");
      const input = Object.assign(document.createElement("input"), { type: "range", min, max, step });
      input.value = String(tune[key]);
      out.value = String(tune[key]);
      input.addEventListener("input", () => {
        tune[key] = Number(input.value);
        out.value = input.value;
        row.classList.toggle("changed", tune[key] !== TUNE_DEFAULTS[key]);
        save();
        onChange();
      });
      row.classList.toggle("changed", tune[key] !== TUNE_DEFAULTS[key]);
      row.append(name, out, input);
      panel.append(row);
      inputs.set(key, [input, out]);
    }
  }
  const actions = document.createElement("div");
  actions.className = "tuner-actions";
  const copy = Object.assign(document.createElement("button"), { type: "button", textContent: "Copy values" });
  copy.addEventListener("click", async () => {
    const text = JSON.stringify(changed(), null, 2);
    try { await navigator.clipboard.writeText(text); copy.textContent = "Copied"; } catch { copy.textContent = "Copy failed"; }
    setTimeout(() => { copy.textContent = "Copy values"; }, 1500);
  });
  const reset = Object.assign(document.createElement("button"), { type: "button", textContent: "Reset" });
  reset.addEventListener("click", () => {
    Object.assign(tune, TUNE_DEFAULTS);
    for (const [key, [input, out]] of inputs) {
      input.value = out.value = String(tune[key]);
      input.closest("label")!.classList.remove("changed");
    }
    save();
    onChange();
  });
  actions.append(copy, reset);
  panel.append(actions);
  const info = root.querySelector<HTMLElement>(".top-left");
  if (info) panel.style.top = `${info.offsetTop + info.offsetHeight + 12}px`; // just below the info panel
  root.append(panel);
  onChange();
}
