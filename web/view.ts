import type { GraphNode, NodeKind, SessionGraph, Turn } from "../src/model";
import {
  COL_GAP,
  edgePath,
  isSpineKind,
  layoutGraph,
  NODE_H,
  NODE_W,
  pruneGraph,
  timelineRows,
  type GraphSlice,
  type Point,
  type TimelineRow,
} from "./layout";

export type FilterMode = "all" | "chosen" | "decisions";
export type ViewMode = "timeline" | "graph";
export type ColorGroup = "chosen" | "rejected" | "other";

export interface State {
  connected: boolean;
  labelerError?: string;
  turns: Turn[];
  graph: SessionGraph;
  selected?: string;
  filter: FilterMode;
  viewMode: ViewMode;
  follow: boolean;
  seenNodeId?: string;
}

export interface View {
  z: number;
  tx: number;
  ty: number;
}

export interface Els {
  statusDot: HTMLElement;
  sessionTitle: HTMLElement;
  modePill: HTMLElement;
  sidebar: HTMLElement;
  viewport: HTMLElement;
  tlSummary: HTMLElement;
  tlRows: HTMLElement;
  world: HTMLElement;
  edges: SVGSVGElement;
  nodes: HTMLElement;
  labels: HTMLElement;
  keyed: Map<string, HTMLElement>;
  panel: HTMLElement;
  banner: HTMLElement;
  toast: HTMLElement;
  bar: HTMLElement;
  follow: HTMLElement;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.2;
/** Lowest zoom at which card text is still readable; Fit never zooms out further than this. */
export const FIT_FLOOR = 0.6;
/** Free space kept around the graph, in px, and the extra bottom inset that clears the floating #bar. */
const PAD = 40;
const BAR_CLEARANCE = 48;
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

const COLOR_GROUP: Record<NodeKind, ColorGroup> = {
  goal: "chosen",
  chosen: "chosen",
  rejected: "rejected",
  option: "rejected",
  decision: "other",
  loop: "other",
  side: "other",
};

const painted = new WeakMap<Element, string>();

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ENTITIES[ch] ?? ch);
}

/**
 * Escapes transcript text and renders the little markdown agents write: `**bold**`, `` `code` ``,
 * `# headings`, and `<img alt="…">` tags (shown as "[image: …]"). Everything else stays plain text.
 */
export function transcriptHtml(text: string): string {
  return esc(text)
    .replace(/&lt;img\b[^\n]*?&gt;/g, (tag) => {
      const alt = /alt=&quot;(.*?)&quot;/.exec(tag)?.[1];
      return alt ? `[image: ${alt}]` : "[image]";
    })
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/^#{1,6} +(.+)$/gm, "<b>$1</b>");
}

/** Replaces an element's content only when it changed, so scroll position and hover survive repaints. */
function setHtml(el: Element, html: string): void {
  if (painted.get(el) === html) return;
  painted.set(el, html);
  el.innerHTML = html;
}

function clock(at: number): string {
  if (!at) return "";
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Maps a node kind to one of the three colour groups of the palette. A card shows its group as a
 * left bar; an edge takes the group of the node it leads to.
 *
 * Args:
 *     kind (NodeKind): Node kind.
 *
 * Returns:
 *     ColorGroup: "chosen" for goal/chosen, "rejected" for rejected/option, "other" for decision/loop/side.
 */
export function colorGroup(kind: NodeKind): ColorGroup {
  return COLOR_GROUP[kind];
}

/**
 * Determines whether a node is shown under the active filter mode.
 *
 * Args:
 *     node (GraphNode): Node to evaluate.
 *     filter (FilterMode): Active filter mode ("all" | "chosen" | "decisions").
 *
 * Returns:
 *     boolean: True when the node stays in the view.
 */
export function isNodeVisible(node: GraphNode, filter: FilterMode): boolean {
  if (filter === "all") return true;
  if (filter === "chosen") return isSpineKind(node.kind);
  return node.kind === "goal" || node.kind === "decision" || node.kind === "rejected";
}

/**
 * Applies a filter mode to a graph: filtered-out nodes and their edges are removed, and the
 * remaining nodes are bridged across the removed ones so they stay connected.
 *
 * Args:
 *     graph (GraphSlice): Full graph.
 *     filter (FilterMode): Active filter mode.
 *
 * Returns:
 *     GraphSlice: The nodes and edges to show. The input itself when the filter is "all".
 */
export function filterGraph(graph: GraphSlice, filter: FilterMode): GraphSlice {
  if (filter === "all") return graph;
  return pruneGraph(graph.nodes, graph.edges, (n) => isNodeVisible(n, filter));
}

/**
 * Returns the node Follow tracks: the latest spine node (goal, decision, chosen or loop), so a
 * stray side question or an unchosen option never takes the selection. Falls back to the latest
 * node of any kind when the graph has no spine node.
 *
 * Args:
 *     graph (SessionGraph): Current session graph.
 *
 * Returns:
 *     GraphNode | undefined: The follow target, or undefined when the graph is empty.
 */
export function followTarget(graph: SessionGraph): GraphNode | undefined {
  let spine: GraphNode | undefined;
  let any: GraphNode | undefined;
  for (const n of graph.nodes) {
    if (!any || n.at >= any.at) any = n;
    if (isSpineKind(n.kind) && (!spine || n.at >= spine.at)) spine = n;
  }
  return spine ?? any;
}

/**
 * Resolves the currently selected node, falling back to the follow target.
 *
 * Args:
 *     s (State): Current UI state.
 *
 * Returns:
 *     GraphNode | undefined: Selected node if the graph has any nodes.
 */
export function selectedNode(s: State): GraphNode | undefined {
  if (s.selected) {
    const found = s.graph.nodes.find((n) => n.id === s.selected);
    if (found) return found;
  }
  return followTarget(s.graph);
}

/**
 * Picks the node an Up/Down key press moves the selection to. The selection stops at both ends.
 *
 * Args:
 *     ids (readonly string[]): Node ids in display order.
 *     current (string | undefined): Selected node id; may be absent from `ids`.
 *     delta (1 | -1): 1 for Down, -1 for Up.
 *
 * Returns:
 *     string | undefined: Id to select, or undefined when the selection cannot move.
 */
export function stepSelection(ids: readonly string[], current: string | undefined, delta: 1 | -1): string | undefined {
  const at = current === undefined ? -1 : ids.indexOf(current);
  if (at < 0) return delta === 1 ? ids[0] : ids[ids.length - 1];
  return ids[at + delta];
}

export interface GraphSummary {
  /** First goal node. */
  goal?: GraphNode;
  /** Where the session stands: the latest chosen node, else the latest spine node. */
  now?: GraphNode;
  outcomes: GraphNode[];
  rejected: GraphNode[];
  decisionsCount: number;
  loopsCount: number;
}

/**
 * Summarizes the graph for the left sidebar and the summary at the top of the timeline.
 *
 * Args:
 *     graph (SessionGraph): Current session graph.
 *
 * Returns:
 *     GraphSummary: Goal, current position, chosen outcomes, rejected/unchosen paths, and counts.
 */
export function summarizeGraph(graph: SessionGraph): GraphSummary {
  const outcomes = graph.nodes.filter((n) => n.kind === "chosen");
  const rejected = graph.nodes.filter((n) => n.kind === "rejected" || n.kind === "option");
  const decisionsCount = graph.nodes.filter((n) => n.kind === "decision" || n.kind === "rejected").length;
  const loopsCount = graph.nodes.filter((n) => n.kind === "loop").length;
  let now: GraphNode | undefined;
  for (const n of outcomes) {
    if (!now || n.at >= now.at) now = n;
  }
  return {
    goal: graph.nodes.find((n) => n.kind === "goal"),
    now: now ?? followTarget(graph),
    outcomes,
    rejected,
    decisionsCount,
    loopsCount,
  };
}

/** Counts owner rejections and merely unpicked options apart, e.g. "4 rejected, 18 not chosen". */
function notTakenLabel(nodes: readonly GraphNode[]): string {
  const rejected = nodes.filter((n) => n.kind === "rejected").length;
  const options = nodes.length - rejected;
  return [rejected > 0 ? `${rejected} rejected` : "", options > 0 ? `${options} not chosen` : ""].filter(Boolean).join(", ");
}

function turnsLabel(n: GraphNode): string {
  const count = n.turnIds.length;
  const time = clock(n.at);
  if (count === 0) return time;
  const tPart = count === 1 ? "1 turn" : `${count} turns`;
  return time ? `${tPart} · ${time}` : tPart;
}

/**
 * Renders the top bar (status dot, session title, LLM/Heuristic mode pill).
 *
 * Args:
 *     s (State): Current UI state.
 *     els (Els): Cached DOM element references.
 *
 * Returns:
 *     void
 */
export function paintTopbar(s: State, els: Els): void {
  els.statusDot.className = s.connected ? "dot" : "dot offline";
  els.sessionTitle.textContent = s.graph.title || "intent-prompt-graph";
  els.modePill.textContent = s.graph.mode === "llm" ? "LLM graph" : "Heuristic graph";
}

/**
 * Renders the Left Executive Summary sidebar (Session Overview, Chosen Outcomes, Rejected Paths).
 *
 * Args:
 *     s (State): Current UI state.
 *     els (Els): Cached DOM element references.
 *
 * Returns:
 *     void
 */
export function paintSidebar(s: State, els: Els): void {
  const sum = summarizeGraph(s.graph);
  const selId = selectedNode(s)?.id;
  const turnCount = s.turns.length;
  const nodeCount = s.graph.nodes.length;

  const pills = [
    `${turnCount} turns → ${nodeCount} nodes`,
    sum.decisionsCount > 0 ? `${sum.decisionsCount} decisions` : "",
    notTakenLabel(sum.rejected),
    sum.loopsCount > 0 ? `${sum.loopsCount} loops collapsed` : "",
  ]
    .filter(Boolean)
    .map((p) => `<span class="pill">${esc(p)}</span>`)
    .join("");

  const renderList = (items: GraphNode[], group: ColorGroup, empty: string): string => {
    if (items.length === 0) return `<p class="empty-note">${esc(empty)}</p>`;
    return `<ul class="summary-list">${items
      .map(
        (n) =>
          `<li class="summary-item grp-${group}${n.id === selId ? " on" : ""}" data-jump="${esc(n.id)}">` +
          `<div class="st">${esc(n.title)}</div>` +
          `<div class="sd">${esc(n.desc)}</div>` +
          `</li>`,
      )
      .join("")}</ul>`;
  };

  setHtml(
    els.sidebar,
    `<div><div class="sec-title">Session Overview</div><h2 class="session-heading">${esc(s.graph.title || "Waiting for turns")}</h2><div class="session-meta">${pills}</div></div>` +
      `<div><div class="sec-title">Chosen Path &amp; Outcomes</div>${renderList(sum.outcomes, "chosen", "No final outcomes yet.")}</div>` +
      `<div><div class="sec-title">Rejected / Unchosen Paths</div>${renderList(sum.rejected, "rejected", "No paths rejected or skipped yet.")}</div>`,
  );
}

/**
 * Renders the layered DAG into the graph stage: nodes left by the active filter, cubic-Bezier SVG
 * edges, and edge labels in a layer above the cards.
 *
 * Args:
 *     s (State): Current UI state.
 *     els (Els): Cached DOM element references.
 *
 * Returns:
 *     Map<string, Point>: Computed layout positions for all rendered nodes.
 */
export function paintGraph(s: State, els: Els): Map<string, Point> {
  const shown = filterGraph(s.graph, s.filter);
  const positions = layoutGraph(shown.nodes, shown.edges);
  const selId = selectedNode(s)?.id;
  const latestId = followTarget(s.graph)?.id;
  const kindOf = new Map(shown.nodes.map((n) => [n.id, n.kind] as const));

  let paths = "";
  let labels = "";
  for (const e of shown.edges) {
    const a = positions.get(e.from);
    const b = positions.get(e.to);
    const toKind = kindOf.get(e.to);
    if (!a || !b || !toKind || e.from === e.to) continue;
    const geom = edgePath(a, b);
    paths += `<path class="edge grp-${colorGroup(toKind)}" d="${geom.d}"/>`;
    if (!e.label) continue;
    // A label is as wide as the gap it sits in. On a level edge it rides above the line.
    const width = geom.vertical ? NODE_W - 24 : COL_GAP - 12;
    const place = geom.vertical ? " vertical" : a.y === b.y ? " above" : "";
    labels += `<div class="edge-label${place}" style="left:${geom.lx}px;top:${geom.ly}px;max-width:${width}px">${esc(e.label)}</div>`;
  }
  setHtml(els.edges, paths);
  setHtml(els.labels, labels);

  const keep = new Set<string>();
  for (const n of shown.nodes) {
    const p = positions.get(n.id);
    if (!p) continue;
    keep.add(n.id);
    let el = els.keyed.get(n.id);
    if (!el) {
      el = document.createElement("div");
      els.keyed.set(n.id, el);
      els.nodes.append(el);
    }
    const cls = [
      "node",
      `kind-${n.kind}`,
      `grp-${colorGroup(n.kind)}`,
      n.id === selId && "selected",
      n.id === latestId && "latest",
    ]
      .filter(Boolean)
      .join(" ");
    el.className = cls;
    el.dataset.node = n.id;
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    setHtml(
      el,
      `<div class="node-head"><span>${esc(n.badge)}</span><span class="node-turns">${esc(turnsLabel(n))}</span></div>` +
        `<div class="node-title">${esc(n.title)}</div>` +
        `<div class="node-desc">${esc(n.desc)}</div>`,
    );
  }

  for (const [id, el] of els.keyed) {
    if (keep.has(id)) continue;
    el.remove();
    els.keyed.delete(id);
  }

  return positions;
}

function summaryLine(key: string, value: string, jump: GraphNode | undefined): string {
  const target = jump ? ` data-jump="${esc(jump.id)}"` : "";
  return (
    `<div class="tl-sum${jump ? "" : " none"}"${target}>` +
    `<span class="k">${key}</span><span class="v">${esc(value)}</span></div>`
  );
}

function rowHtml(row: TimelineRow, selId: string | undefined, latestId: string | undefined): string {
  const n = row.node;
  const cls = [
    "tl-row",
    `kind-${n.kind}`,
    `grp-${colorGroup(n.kind)}`,
    n.id === selId && "selected",
    n.id === latestId && "latest",
  ]
    .filter(Boolean)
    .join(" ");
  const via = row.edge?.label ? `<div class="tl-via">${esc(row.edge.label)}</div>` : "";
  const rounds =
    n.kind === "loop" && n.rounds !== undefined
      ? `<div class="tl-rounds"><b>${n.rounds}</b><span>rounds</span></div>`
      : "";
  const latest = n.id === latestId ? `<span class="tl-latest">latest</span>` : "";
  const desc = n.desc ? `<div class="tl-desc">${esc(n.desc)}</div>` : "";
  const why =
    n.kind === "rejected" && n.rationale
      ? `<div class="tl-why"><span class="lbl">${esc(n.rationaleLabel || "Why rejected")}</span>${esc(n.rationale)}</div>`
      : "";
  return (
    `<div class="tl-step ${row.depth === 0 ? "spine" : "branch"}">${via}` +
    `<div class="${cls}" data-node="${esc(n.id)}">${rounds}<div class="tl-main">` +
    `<div class="tl-head"><span class="tl-badge">${esc(n.badge)}</span>${latest}<span class="tl-meta">${esc(turnsLabel(n))}</span></div>` +
    `<div class="tl-title">${esc(n.title)}</div>${desc}${why}` +
    `</div></div></div>`
  );
}

/**
 * Renders the timeline view: a three-line summary (Goal, Now, Rejected) and one row per node left
 * by the active filter, spine rows full width and branch rows indented under them.
 *
 * Args:
 *     s (State): Current UI state.
 *     els (Els): Cached DOM element references.
 *
 * Returns:
 *     void
 */
export function paintTimeline(s: State, els: Els): void {
  const sum = summarizeGraph(s.graph);
  const ruledOut = sum.rejected.length;
  setHtml(
    els.tlSummary,
    summaryLine("Goal", sum.goal?.title ?? "No goal identified yet", sum.goal) +
      summaryLine("Now", sum.now?.title ?? "Waiting for turns in this session…", sum.now) +
      summaryLine(
        "Not taken",
        ruledOut === 0 ? "Nothing rejected yet" : `${notTakenLabel(sum.rejected)} · show the first`,
        sum.rejected[0],
      ),
  );

  const shown = filterGraph(s.graph, s.filter);
  const rows = timelineRows(shown.nodes, shown.edges);
  const selId = selectedNode(s)?.id;
  const latestId = followTarget(s.graph)?.id;
  const empty = s.graph.nodes.length === 0 ? "Waiting for turns in this session…" : "No node matches this filter.";
  setHtml(
    els.tlRows,
    rows.length === 0
      ? `<p class="empty-note">${empty}</p>`
      : `<div class="tl-list">${rows.map((r) => rowHtml(r, selId, latestId)).join("")}</div>`,
  );
}

/**
 * Computes a signature for the right inspector panel so it is only re-rendered when its content changes.
 *
 * Args:
 *     s (State): Current UI state.
 *
 * Returns:
 *     string: Stable cache key for the currently inspected node and its source turns.
 */
export function inspectorSignature(s: State): string {
  const n = selectedNode(s);
  if (!n) return "empty";
  const byTurn = new Map(s.turns.map((t) => [t.id, t] as const));
  const turnSig = n.turnIds.map((id) => {
    const t = byTurn.get(id);
    return t ? `${t.id}:${t.text.length}:${t.actions.length}:${t.open ? 1 : 0}` : id;
  });
  return `${n.id}|${n.kind}|${n.title}|${n.rationale}|${turnSig.join(",")}`;
}

/**
 * Renders the Right Inspector panel with rationale and full source transcript excerpts.
 *
 * Args:
 *     s (State): Current UI state.
 *     els (Els): Cached DOM element references.
 *
 * Returns:
 *     void
 */
export function paintInspector(s: State, els: Els): void {
  const n = selectedNode(s);
  if (!n) {
    els.panel.innerHTML = `<p class="empty-note">Waiting for turns in this session…</p>`;
    return;
  }
  const byTurn = new Map(s.turns.map((t) => [t.id, t] as const));
  const turns = n.turnIds.map((id) => byTurn.get(id)).filter((t): t is Turn => t !== undefined);

  const turnsHtml =
    turns.length === 0
      ? `<p class="empty-note">No linked transcript turns.</p>`
      : `<div class="turn-list">${turns
          .map((t) => {
            const whoLabel = t.author === "owner" ? (t.guest ? "GUEST" : "YOU") : "AGENT";
            const actionsHtml =
              t.actions.length > 0
                ? `<ul class="turn-actions">${t.actions
                    .slice(0, 8)
                    .map((a) => `<li><b>${esc(a.tool)}</b> ${esc(a.summary)}</li>`)
                    .join("")}</ul>`
                : "";
            return (
              `<div class="turn-card">` +
              `<div class="turn-who"><span>${whoLabel}</span><span>${esc(clock(t.at))}</span></div>` +
              `<div class="turn-body">${transcriptHtml(t.text || "(tool calls only)")}</div>` +
              actionsHtml +
              `</div>`
            );
          })
          .join("")}</div>`;

  els.panel.innerHTML =
    `<div class="panel-head grp-${colorGroup(n.kind)}">` +
    `<span class="panel-badge">${esc(n.badge)} · ${esc(turnsLabel(n))}</span>` +
    `<h2 class="panel-title">${esc(n.title)}</h2>` +
    `<div class="rationale-box"><div class="lbl">${esc(n.rationaleLabel)}</div><p>${esc(n.rationale)}</p></div>` +
    `</div>` +
    `<div><div class="sec-title">Source Transcript (${turns.length})</div>${turnsHtml}</div>`;
}

/**
 * Updates the chrome around the views: which view is shown, the pressed state of the view and
 * filter buttons, the error/disconnect banner, the new-activity toast, and the Follow button.
 *
 * Args:
 *     s (State): Current UI state.
 *     els (Els): Cached DOM element references.
 *
 * Returns:
 *     void
 */
export function paintChrome(s: State, els: Els): void {
  els.viewport.dataset.view = s.viewMode;
  for (const b of els.bar.querySelectorAll<HTMLElement>("[data-set-view]")) {
    b.classList.toggle("active", b.dataset.setView === s.viewMode);
  }
  for (const b of els.bar.querySelectorAll<HTMLElement>("[data-filter]")) {
    b.classList.toggle("active", b.dataset.filter === s.filter);
  }

  els.banner.hidden = s.connected && !s.labelerError;
  els.banner.textContent = s.connected ? `Labeler error: ${s.labelerError ?? ""}` : "Connection lost. Reconnecting…";
  els.banner.title = els.banner.textContent;

  const latest = followTarget(s.graph);
  const unseen = !s.follow && latest !== undefined && latest.id !== s.seenNodeId;
  els.toast.hidden = !unseen;
  if (latest && unseen) {
    els.toast.textContent = `New update: ${latest.title} — jump`;
    els.toast.dataset.jump = latest.id;
  }

  els.follow.textContent = `Follow: ${s.follow ? "on" : "off"}`;
  els.follow.setAttribute("aria-pressed", String(s.follow));
}

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export function applyView(world: HTMLElement, v: View): void {
  world.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.z})`;
}

/**
 * Translation along one axis: content that fits between the insets is centred there; content that
 * does not is moved so the focus point is centred, without leaving empty space past either end.
 */
function axisOffset(lo: number, hi: number, focus: number, size: number, z: number, padLo: number, padHi: number): number {
  const room = size - padLo - padHi;
  if ((hi - lo) * z <= room) return padLo + (room - (hi - lo) * z) / 2 - lo * z;
  const centred = padLo + room / 2 - focus * z;
  return Math.min(padLo - lo * z, Math.max(size - padHi - hi * z, centred));
}

/**
 * Computes zoom and translation for the Fit and 100% buttons, from the viewport's client size and
 * the real bounds of the cards. Fit shows the whole graph with padding, never enlarged past 100%.
 * When that would need a zoom below FIT_FLOOR, the zoom stays at FIT_FLOOR. On each axis the graph
 * is centred when it fits; otherwise the focus node is centred, stopping at the graph's edges.
 *
 * Args:
 *     positions (ReadonlyMap<string, Point>): Top-left coordinates of all rendered nodes.
 *     vw (number): Viewport client width in px.
 *     vh (number): Viewport client height in px.
 *     focusId (string | undefined): Selected node, kept in view when the graph does not fit whole.
 *         The graph's top-left corner is used when it is absent or not rendered.
 *     zoom (number | undefined): Fixed zoom to use instead of the fitted one.
 *
 * Returns:
 *     View: Target zoom and translation coordinates.
 */
export function fitView(
  positions: ReadonlyMap<string, Point>,
  vw: number,
  vh: number,
  focusId?: string,
  zoom?: number,
): View {
  if (positions.size === 0) return { z: zoom ?? 1, tx: PAD, ty: PAD };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of positions.values()) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + NODE_W);
    y1 = Math.max(y1, p.y + NODE_H);
  }
  const padBottom = PAD + BAR_CLEARANCE;
  const whole = Math.min(1, (vw - 2 * PAD) / (x1 - x0), (vh - PAD - padBottom) / (y1 - y0));
  const z = zoom ?? Math.max(FIT_FLOOR, whole);
  const focus = (focusId !== undefined && positions.get(focusId)) || { x: x0, y: y0 };
  return {
    z,
    tx: axisOffset(x0, x1, focus.x + NODE_W / 2, vw, z, PAD, PAD),
    ty: axisOffset(y0, y1, focus.y + NODE_H / 2, vh, z, PAD, padBottom),
  };
}

/**
 * Pans the view so a node is visible, keeping the zoom. A node already fully inside the viewport
 * leaves the view untouched.
 *
 * Args:
 *     v (View): Current view.
 *     p (Point): Top-left position of the node to reveal.
 *     vw (number): Viewport client width in px.
 *     vh (number): Viewport client height in px.
 *
 * Returns:
 *     View: The same object when nothing has to move, else a view centred on the node.
 */
export function revealView(v: View, p: Point, vw: number, vh: number): View {
  const left = v.tx + p.x * v.z;
  const top = v.ty + p.y * v.z;
  const inside = left >= 0 && top >= 0 && left + NODE_W * v.z <= vw && top + NODE_H * v.z <= vh - BAR_CLEARANCE;
  if (inside) return v;
  return {
    z: v.z,
    tx: vw / 2 - (p.x + NODE_W / 2) * v.z,
    ty: (vh - BAR_CLEARANCE) / 2 - (p.y + NODE_H / 2) * v.z,
  };
}
