import type { ServerEvent, Turn } from "../src/model";
import { applyView, chrome, clampZoom, derive, type Derived, type Els, fitView, paint, selected, slotsOf, type State, type View } from "./view";

function byId<T extends Element = HTMLElement>(id: string): T {
  const found = document.querySelector<T>(`#${id}`);
  if (!found) throw new Error(`ipg: missing #${id}`);
  return found;
}

const els: Els = {
  viewport: byId("viewport"),
  world: byId("world"),
  edges: byId<SVGSVGElement>("edges"),
  nodes: byId("nodes"),
  keyed: new Map(),
  intents: byId("intents"),
  panel: byId("panel"),
  banner: byId("banner"),
  toast: byId("toast"),
  follow: byId("follow"),
};

const state: State = { connected: false, turns: [], intents: new Map(), labels: new Map(), follow: true };
let view: View = { z: 1, tx: 0, ty: 0 };
let fitted = false;
/** Turn named by `#turn=<id>` on load; applied once the first snapshot arrives. */
let pendingTurn: string | undefined;

const hashTurn = /^#turn=(.+)$/.exec(location.hash);
if (hashTurn) {
  pendingTurn = decodeURIComponent(hashTurn[1] ?? "");
  state.follow = false;
}

function render(): void {
  const d = derive(state);
  paint(state, d, els, Date.now());
  chrome(state, d, els);
  syncHash(d);
}

function syncHash(d: Derived): void {
  const sel = selected(state, d)?.id;
  const next = state.follow ? "#latest" : sel === undefined ? "" : `#turn=${encodeURIComponent(sel)}`;
  if (location.hash === next) return;
  history.replaceState(null, "", `${location.pathname}${location.search}${next}`);
}

function glideTo(next: View): void {
  view = next;
  els.world.classList.add("glide");
  applyView(els.world, view);
  window.setTimeout(() => els.world.classList.remove("glide"), 450);
}

function glideFit(): void {
  const slots = slotsOf(state, derive(state), Date.now());
  glideTo(fitView(slots, els.viewport.clientWidth, els.viewport.clientHeight));
}

/** Follow on: the focus and selection track the newest labelled turn. */
function refollow(): void {
  if (!state.follow) return;
  state.focus = undefined;
  state.selected = undefined;
  state.seen = state.turns.at(-1)?.id;
}

function setFollow(on: boolean): void {
  state.follow = on;
  refollow();
  render();
}

function selectTurn(id: string): void {
  const intent = derive(state).intentOf.get(id);
  state.selected = id;
  if (intent !== undefined) state.focus = intent;
}

function focusIntent(id: string): void {
  const turns = derive(state).byIntent.get(id) ?? [];
  state.focus = id;
  state.selected = turns.at(-1)?.id;
}

function upsertTurn(t: Turn): void {
  const i = state.turns.findIndex((x) => x.id === t.id);
  if (i < 0) state.turns.push(t);
  else state.turns[i] = t;
}

function applySnapshot(ev: Extract<ServerEvent, { type: "snapshot" }>): void {
  state.turns = ev.turns;
  state.intents = new Map(ev.intents.map((i) => [i.id, i] as const));
  state.labels = new Map(ev.labels.map((l) => [l.turnId, l] as const));
  state.labelerError = ev.labelerError;
  state.seen ??= state.turns.at(-1)?.id;
  const want = pendingTurn;
  pendingTurn = undefined;
  if (want !== undefined && state.turns.some((t) => t.id === want)) {
    state.selected = want;
    state.focus = derive(state).intentOf.get(want);
  }
}

function onEvent(ev: ServerEvent): void {
  switch (ev.type) {
    case "snapshot":
      applySnapshot(ev);
      refollow();
      render();
      if (!fitted) {
        fitted = true;
        glideFit();
      }
      return;
    case "reset":
      state.turns = [];
      state.intents = new Map();
      state.labels = new Map();
      state.focus = undefined;
      state.selected = undefined;
      break;
    case "turn":
      upsertTurn(ev.turn);
      refollow();
      break;
    case "intent":
      state.intents.set(ev.intent.id, ev.intent);
      break;
    case "label":
      state.labels.set(ev.label.turnId, ev.label);
      refollow();
      break;
    case "labeler":
      state.labelerError = ev.error;
      break;
  }
  render();
}

// Clicks: the capture phase runs first so any owner click (except Follow itself) turns Follow off,
// and the click that ends a pan is swallowed.
let dragged = false;
document.addEventListener(
  "click",
  (e) => {
    if (dragged) {
      dragged = false;
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (!(e.target instanceof Element) || e.target.closest("#follow")) return;
    if (state.follow) setFollow(false);
  },
  true,
);

document.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;
  const hit = e.target.closest<HTMLElement>("[data-turn],[data-intent],[data-jump]");
  if (!hit) return;
  if (hit.dataset.jump) {
    state.seen = hit.dataset.jump;
    selectTurn(hit.dataset.jump);
  } else if (hit.dataset.turn) {
    selectTurn(hit.dataset.turn);
  } else if (hit.dataset.intent) {
    focusIntent(hit.dataset.intent);
    render();
    glideFit();
    return;
  }
  render();
});

els.follow.addEventListener("click", () => setFollow(!state.follow));
byId("fit").addEventListener("click", () => glideFit());
byId("reset").addEventListener("click", () => glideTo({ z: 1, tx: 0, ty: 0 }));

els.viewport.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = els.viewport.getBoundingClientRect();
    const mx = e.clientX - rect.left - rect.width / 2;
    const my = e.clientY - rect.top - rect.height / 2;
    const z = clampZoom(view.z * Math.exp(-e.deltaY * 0.001));
    const wx = (mx - view.tx) / view.z;
    const wy = (my - view.ty) / view.z;
    view = { z, tx: mx - wx * z, ty: my - wy * z };
    applyView(els.world, view);
  },
  { passive: false },
);

let press: { id: number; x: number; y: number; lastX: number; lastY: number; moving: boolean } | undefined;
els.viewport.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  dragged = false;
  press = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, moving: false };
});
els.viewport.addEventListener("pointermove", (e) => {
  if (!press) return;
  if (!press.moving) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= 4) return;
    press.moving = true;
    els.viewport.setPointerCapture(press.id);
  }
  view = { ...view, tx: view.tx + e.clientX - press.lastX, ty: view.ty + e.clientY - press.lastY };
  press.lastX = e.clientX;
  press.lastY = e.clientY;
  applyView(els.world, view);
});
const endPress = (): void => {
  if (press?.moving) dragged = true;
  press = undefined;
};
els.viewport.addEventListener("pointerup", endPress);
els.viewport.addEventListener("pointercancel", endPress);

const route = /^\/s\/([^/]+)\/([^/]+)$/.exec(location.pathname);
if (!route) throw new Error("ipg: not a session page");
const source = new EventSource(`/api/s/${route[1] ?? ""}/${route[2] ?? ""}/events`);
source.addEventListener("open", () => {
  state.connected = true;
  render();
});
source.addEventListener("error", () => {
  state.connected = false;
  render();
});
source.addEventListener("message", (m) => onEvent(JSON.parse(String(m.data)) as ServerEvent));

window.setInterval(render, 15000);
render();
