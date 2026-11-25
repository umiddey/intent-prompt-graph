import type { ServerEvent, Turn } from "../src/model";
import type { Point } from "./layout";
import {
  applyView,
  clampZoom,
  fitView,
  inspectorSignature,
  latestNode,
  paintChrome,
  paintGraph,
  paintInspector,
  paintSidebar,
  paintTopbar,
  selectedNode,
  type Els,
  type FilterMode,
  type State,
  type View,
} from "./view";

function byId<T extends Element = HTMLElement>(id: string): T {
  const found = document.querySelector<T>(`#${id}`);
  if (!found) throw new Error(`ipg: missing #${id}`);
  return found;
}

const els: Els = {
  statusDot: byId("status-dot"),
  sessionTitle: byId("session-title"),
  modePill: byId("mode-pill"),
  sidebar: byId("sidebar"),
  viewport: byId("viewport"),
  world: byId("world"),
  edges: byId<SVGSVGElement>("edges"),
  nodes: byId("nodes"),
  keyed: new Map(),
  panel: byId("panel"),
  banner: byId("banner"),
  toast: byId("toast"),
  follow: byId("follow"),
};

const state: State = {
  connected: false,
  turns: [],
  graph: { title: "Loading session…", nodes: [], edges: [], mode: "heuristic" },
  filter: "all",
  follow: true,
};

let view: View = { z: 1, tx: 40, ty: 80 };
let lastPositions: Map<string, Point> = new Map();
let lastInspectorSig = "";
let fitted = false;

function glideTo(next: View): void {
  view = next;
  els.world.classList.add("glide");
  applyView(els.world, view);
  window.setTimeout(() => els.world.classList.remove("glide"), 380);
}

function glideFit(): void {
  glideTo(fitView(lastPositions, els.viewport.clientWidth, els.viewport.clientHeight));
}

function syncHash(): void {
  const sel = selectedNode(state)?.id;
  const next = state.follow ? "#latest" : sel ? `#node=${encodeURIComponent(sel)}` : "";
  if (location.hash === next) return;
  history.replaceState(null, "", `${location.pathname}${location.search}${next}`);
}

function render(): void {
  paintTopbar(state, els);
  paintSidebar(state, els);
  lastPositions = paintGraph(state, els);
  const sig = inspectorSignature(state);
  if (sig !== lastInspectorSig) {
    lastInspectorSig = sig;
    paintInspector(state, els);
  }
  paintChrome(state, els);
  syncHash();
}

function refollow(): void {
  if (!state.follow) return;
  const latest = latestNode(state.graph);
  state.selected = latest?.id;
  state.seenNodeId = latest?.id;
}

function selectNode(id: string, disableFollow = true): void {
  if (disableFollow) state.follow = false;
  state.selected = id;
  const latest = latestNode(state.graph);
  if (latest?.id === id) state.seenNodeId = id;
  render();
}

function upsertTurn(t: Turn): void {
  const idx = state.turns.findIndex((x) => x.id === t.id);
  if (idx < 0) state.turns.push(t);
  else state.turns[idx] = t;
}

function onEvent(ev: ServerEvent): void {
  switch (ev.type) {
    case "snapshot": {
      state.turns = ev.turns;
      state.graph = ev.graph;
      state.labelerError = ev.labelerError;
      const hashNode = /^#node=(.+)$/.exec(location.hash);
      if (hashNode && !fitted) {
        state.selected = decodeURIComponent(hashNode[1] ?? "");
        state.follow = false;
      }
      refollow();
      render();
      if (!fitted) {
        fitted = true;
        glideFit();
      }
      return;
    }
    case "reset":
      state.turns = [];
      state.graph = { title: "Reloading session…", nodes: [], edges: [], mode: "heuristic" };
      state.selected = undefined;
      break;
    case "turn":
      upsertTurn(ev.turn);
      break;
    case "graph":
      state.graph = ev.graph;
      refollow();
      break;
    case "labeler":
      state.labelerError = ev.error;
      break;
  }
  render();
}

// Click delegation: nodes, sidebar jump items, toast jump, filter buttons.
let dragged = false;
document.addEventListener("click", (e) => {
  if (dragged) {
    dragged = false;
    return;
  }
  if (!(e.target instanceof Element)) return;

  const filterBtn = e.target.closest<HTMLElement>("[data-filter]");
  if (filterBtn) {
    const mode = filterBtn.dataset.filter as FilterMode;
    state.filter = mode;
    document.querySelectorAll<HTMLElement>("#bar [data-filter]").forEach((b) => {
      b.classList.toggle("active", b === filterBtn);
    });
    render();
    return;
  }

  const jumpEl = e.target.closest<HTMLElement>("[data-jump]");
  if (jumpEl?.dataset.jump) {
    selectNode(jumpEl.dataset.jump, true);
    return;
  }

  const nodeEl = e.target.closest<HTMLElement>("[data-node]");
  if (nodeEl?.dataset.node) {
    selectNode(nodeEl.dataset.node, true);
  }
});

els.follow.addEventListener("click", () => {
  state.follow = !state.follow;
  refollow();
  render();
});
byId("fit").addEventListener("click", () => glideFit());
byId("reset").addEventListener("click", () => glideTo({ z: 1, tx: 40, ty: 80 }));

// Cursor-anchored wheel zoom.
els.viewport.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = els.viewport.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const z = clampZoom(view.z * Math.exp(-e.deltaY * 0.0012));
    view = {
      z,
      tx: mx - ((mx - view.tx) / view.z) * z,
      ty: my - ((my - view.ty) / view.z) * z,
    };
    applyView(els.world, view);
  },
  { passive: false },
);

// Pointer drag pan.
let press: { id: number; x: number; y: number; lastX: number; lastY: number; moving: boolean } | undefined;
els.viewport.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || (e.target instanceof Element && e.target.closest(".node, #bar, #banner, #toast"))) return;
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

render();
