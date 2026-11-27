import type { ServerEvent, Turn } from "../src/model";
import { layoutGraph, timelineRows, type GraphLayout } from "./layout";
import {
  applyView,
  bandAt,
  chapterView,
  clampZoom,
  filterGraph,
  fitView,
  followTarget,
  inspectorSignature,
  isNodeVisible,
  overviewView,
  paintChrome,
  paintGraph,
  paintMiniView,
  paintInspector,
  paintSidebar,
  paintTimeline,
  paintTopbar,
  revealView,
  selectedNode,
  stepSelection,
  type Els,
  type FilterMode,
  type State,
  type View,
  type ViewMode,
} from "./view";

type Theme = "ink" | "paper";

const VIEW_MODE_KEY = "ipg.viewMode";
/** Also read by the inline script in index.html, which sets the theme before first paint. */
const THEME_KEY = "ipg.theme";
const THEME_NAME: Record<Theme, string> = { ink: "Ink", paper: "Paper" };

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
  tlSummary: byId("tl-summary"),
  bands: byId("bands"),
  tlRows: byId("tl-rows"),
  world: byId("world"),
  edges: byId<SVGSVGElement>("edges"),
  nodes: byId("nodes"),
  labels: byId("labels"),
  minimap: byId("minimap"),
  miniBands: byId("mini-bands"),
  miniView: byId("mini-view"),
  keyed: new Map(),
  panel: byId("panel"),
  banner: byId("banner"),
  toast: byId("toast"),
  bar: byId("bar"),
  follow: byId("follow"),
};
const stage = byId("stage");
const themeButton = byId("theme");

/** The view the reader last chose; the timeline when nothing is stored or storage is unavailable. */
function storedViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === "graph" ? "graph" : "timeline";
  } catch {
    return "timeline";
  }
}

const state: State = {
  connected: false,
  turns: [],
  graph: { title: "Loading session…", nodes: [], edges: [], mode: "heuristic" },
  filter: "all",
  viewMode: storedViewMode(),
  follow: true,
};

let lastLayout: GraphLayout = layoutGraph([], [], undefined, 1);
let view: View = fitView(lastLayout, 0, 0);
let lastInspectorSig = "";
let opened = false;

/** The chapter in sight: the band at the top of the graph stage, or the heading last scrolled past in the timeline. */
function currentChapter(): number {
  if (state.viewMode === "graph") return bandAt(lastLayout, view);
  let at = -1;
  for (const head of els.tlRows.querySelectorAll<HTMLElement>(".tl-chapter")) {
    if (head.offsetTop > els.tlRows.scrollTop + 16) break;
    at++;
  }
  return Math.max(0, at);
}

/** Marks the chapter in sight on every chapter heading and on the mini-map. */
function markChapter(): void {
  const at = String(currentChapter());
  for (const el of document.querySelectorAll<HTMLElement>("[data-chapter]")) {
    el.classList.toggle("on", el.dataset.chapter === at);
  }
}

/** Shows `view` on the graph stage and keeps the mini-map and the chapter marks in step with it. */
function showView(): void {
  applyView(els.world, view);
  paintMiniView(els, lastLayout, view);
  markChapter();
}

function glideTo(next: View): void {
  view = next;
  els.world.classList.add("glide");
  showView();
  window.setTimeout(() => els.world.classList.remove("glide"), 380);
}

/** Fits the graph, or with `zoom` shows the selected node at that zoom. */
function glideFit(zoom?: number): void {
  const focus = selectedNode(state)?.id;
  glideTo(fitView(lastLayout, els.viewport.clientWidth, els.viewport.clientHeight, focus, zoom));
}

/** Brings a chapter into sight: its band in the graph, its heading in the timeline. */
function jumpChapter(index: number): void {
  if (state.viewMode === "graph") {
    const next = chapterView(lastLayout, index, els.viewport.clientWidth, els.viewport.clientHeight);
    if (next) glideTo(next);
    return;
  }
  const head = els.tlRows.querySelector<HTMLElement>(`.tl-chapter[data-chapter="${index}"]`);
  if (head) els.tlRows.scrollTo({ top: head.offsetTop - 8, behavior: "smooth" });
}

/** Brings the selected node into sight: scrolls the timeline to its row, or pans the graph to its card. */
function reveal(): void {
  const id = selectedNode(state)?.id;
  if (id === undefined) return;
  if (state.viewMode === "graph") {
    const p = lastLayout.positions.get(id);
    if (!p) return;
    const next = revealView(view, p, els.viewport.clientWidth, els.viewport.clientHeight);
    if (next !== view) glideTo(next);
    return;
  }
  const row = els.tlRows.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`);
  if (!row) return;
  // Scrolls #tl-rows itself: scrollIntoView would also move every scrollable ancestor.
  const box = els.tlRows;
  const margin = 12;
  const top = row.offsetTop - margin;
  const bottom = row.offsetTop + row.offsetHeight + margin;
  // The floating #bar covers the foot of the list, so only the part above it counts as in sight.
  const sight = els.bar.getBoundingClientRect().top - box.getBoundingClientRect().top;
  if (top < box.scrollTop) box.scrollTo({ top, behavior: "smooth" });
  else if (bottom > box.scrollTop + sight) box.scrollTo({ top: bottom - sight, behavior: "smooth" });
}

function syncHash(): void {
  // Before the first snapshot the hash is still the reader's deep link (#node=…): leave it alone.
  if (!opened) return;
  const sel = selectedNode(state)?.id;
  const next = state.follow ? "#latest" : sel ? `#node=${encodeURIComponent(sel)}` : "";
  if (location.hash === next) return;
  history.replaceState(null, "", `${location.pathname}${location.search}${next}`);
}

function render(): void {
  paintTopbar(state, els);
  paintSidebar(state, els);
  if (state.viewMode === "graph") {
    lastLayout = paintGraph(state, els);
    paintMiniView(els, lastLayout, view);
  } else {
    paintTimeline(state, els);
  }
  const sig = inspectorSignature(state);
  if (sig !== lastInspectorSig) {
    lastInspectorSig = sig;
    paintInspector(state, els);
  }
  paintChrome(state, els);
  markChapter();
  syncHash();
}

/** Renders, then frames the active view: the graph is fitted again, the timeline shows the selected row. */
function renderAndFrame(): void {
  render();
  if (state.viewMode === "graph") glideFit();
  else reveal();
}

function refollow(): void {
  if (!state.follow) return;
  const latest = followTarget(state.graph);
  state.selected = latest?.id;
  state.seenNodeId = latest?.id;
}

function selectNode(id: string): void {
  state.follow = false;
  state.selected = id;
  if (followTarget(state.graph)?.id === id) state.seenNodeId = id;
  // A node the active filter hides cannot be shown as selected, so the filter gives way.
  const node = state.graph.nodes.find((n) => n.id === id);
  if (node && !isNodeVisible(node, state.filter)) state.filter = "all";
  render();
  reveal();
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
      if (hashNode && !opened) {
        state.selected = decodeURIComponent(hashNode[1] ?? "");
        state.follow = false;
      }
      refollow();
      if (opened) {
        render();
      } else {
        opened = true;
        renderAndFrame();
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
    case "graph": {
      const before = state.selected;
      state.graph = ev.graph;
      refollow();
      render();
      if (state.selected !== before) reveal();
      return;
    }
    case "labeler":
      state.labelerError = ev.error;
      break;
  }
  render();
}

// Click delegation: view switch, filter buttons, sidebar/summary/toast jumps, nodes and timeline rows.
let dragged = false;
document.addEventListener("click", (e) => {
  if (dragged) {
    dragged = false;
    return;
  }
  if (!(e.target instanceof Element)) return;

  const viewBtn = e.target.closest<HTMLElement>("[data-set-view]");
  if (viewBtn) {
    state.viewMode = viewBtn.dataset.setView === "graph" ? "graph" : "timeline";
    try {
      localStorage.setItem(VIEW_MODE_KEY, state.viewMode);
    } catch {
      // Storage is unavailable: the choice lasts for this page load only.
    }
    renderAndFrame();
    return;
  }

  const chapter = e.target.closest<HTMLElement>("[data-chapter]");
  if (chapter) {
    jumpChapter(Number(chapter.dataset.chapter));
    return;
  }

  const filterBtn = e.target.closest<HTMLElement>("[data-filter]");
  if (filterBtn) {
    state.filter = filterBtn.dataset.filter as FilterMode;
    renderAndFrame();
    return;
  }

  const target = e.target.closest<HTMLElement>("[data-jump], [data-node]");
  const id = target?.dataset.jump ?? target?.dataset.node;
  if (id) selectNode(id);
});

// Up/Down move the selection through the nodes in timeline order, in both views.
// "[" and "]" step through the chapters, "0" shows the whole graph.
document.addEventListener("keydown", (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === "[" || e.key === "]") {
    jumpChapter(currentChapter() + (e.key === "]" ? 1 : -1));
    return;
  }
  if (e.key === "0" && state.viewMode === "graph") {
    glideTo(overviewView(lastLayout, els.viewport.clientWidth, els.viewport.clientHeight));
    return;
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  if (e.shiftKey) return;
  const shown = filterGraph(state.graph, state.filter);
  const ids = timelineRows(shown.nodes, shown.edges).map((r) => r.node.id);
  const next = stepSelection(ids, selectedNode(state)?.id, e.key === "ArrowDown" ? 1 : -1);
  e.preventDefault();
  if (next !== undefined) selectNode(next);
});

els.follow.addEventListener("click", () => {
  state.follow = !state.follow;
  refollow();
  render();
  reveal();
});
byId("fit").addEventListener("click", () => glideFit());
byId("reset").addEventListener("click", () => glideFit(1));

/** Starts as the theme index.html put on <html> at load; the button flips it. */
let theme: Theme = document.documentElement.dataset.theme === "paper" ? "paper" : "ink";

function showTheme(): void {
  document.documentElement.dataset.theme = theme;
  themeButton.textContent = THEME_NAME[theme];
}

showTheme();
themeButton.addEventListener("click", () => {
  theme = theme === "ink" ? "paper" : "ink";
  showTheme();
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage is unavailable: the choice lasts for this page load only.
  }
});

// Cursor-anchored wheel zoom.
stage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const z = clampZoom(view.z * Math.exp(-e.deltaY * 0.0012));
    view = {
      z,
      tx: mx - ((mx - view.tx) / view.z) * z,
      ty: my - ((my - view.ty) / view.z) * z,
    };
    showView();
  },
  { passive: false },
);

// Pointer drag pan.
let press: { id: number; x: number; y: number; lastX: number; lastY: number; moving: boolean } | undefined;
// A drag released off the stage fires no click, so any new press anywhere clears the flag.
document.addEventListener("pointerdown", () => (dragged = false), true);
stage.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || (e.target instanceof Element && e.target.closest(".node"))) return;
  press = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, moving: false };
});
stage.addEventListener("pointermove", (e) => {
  if (!press) return;
  if (!press.moving) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= 4) return;
    press.moving = true;
    stage.setPointerCapture(press.id);
  }
  view = { ...view, tx: view.tx + e.clientX - press.lastX, ty: view.ty + e.clientY - press.lastY };
  press.lastX = e.clientX;
  press.lastY = e.clientY;
  showView();
});
const endPress = (): void => {
  if (press?.moving) dragged = true;
  press = undefined;
};
stage.addEventListener("pointerup", endPress);
stage.addEventListener("pointercancel", endPress);

// The graph is laid out for the window's width, so a resize lays it out and fits it again (once per frame).
let resizeFrame = 0;
window.addEventListener("resize", () => {
  if (state.viewMode !== "graph" || resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    renderAndFrame();
  });
});
els.tlRows.addEventListener("scroll", markChapter, { passive: true });

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
