import type { GraphEdge, GraphNode, NodeKind, SessionGraph, Turn } from "../src/model";
import { edgePath, layoutGraph, NODE_H, NODE_W, type Point } from "./layout";

export type FilterMode = "all" | "chosen" | "decisions";

export interface State {
  connected: boolean;
  labelerError?: string;
  turns: Turn[];
  graph: SessionGraph;
  selected?: string;
  filter: FilterMode;
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
  world: HTMLElement;
  edges: SVGSVGElement;
  nodes: HTMLElement;
  keyed: Map<string, HTMLElement>;
  panel: HTMLElement;
  banner: HTMLElement;
  toast: HTMLElement;
  follow: HTMLElement;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.2;
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

const KIND_COLOR: Record<NodeKind, string> = {
  goal: "var(--goal)",
  chosen: "var(--chosen)",
  rejected: "var(--rejected)",
  option: "var(--option)",
  decision: "var(--decision)",
  loop: "var(--loop)",
  side: "var(--side)",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ENTITIES[ch] ?? ch);
}

function clock(at: number): string {
  if (!at) return "";
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Determines whether a node should be visually dimmed under the active filter mode.
 *
 * Args:
 *     node (GraphNode): Node to evaluate.
 *     filter (FilterMode): Active filter mode ("all" | "chosen" | "decisions").
 *
 * Returns:
 *     boolean: True when the node should be dimmed.
 */
export function isNodeDimmed(node: GraphNode, filter: FilterMode): boolean {
  if (filter === "all") return false;
  if (filter === "chosen") {
    return !(node.kind === "goal" || node.kind === "chosen" || node.kind === "decision" || node.kind === "loop");
  }
  return !(node.kind === "goal" || node.kind === "decision" || node.kind === "rejected");
}

/**
 * Determines whether an edge should be visually dimmed under the active filter mode.
 *
 * Args:
 *     edge (GraphEdge): Edge to evaluate.
 *     byId (ReadonlyMap<string, GraphNode>): Nodes keyed by id.
 *     filter (FilterMode): Active filter mode.
 *
 * Returns:
 *     boolean: True when either endpoint is dimmed.
 */
export function isEdgeDimmed(edge: GraphEdge, byId: ReadonlyMap<string, GraphNode>, filter: FilterMode): boolean {
  if (filter === "all") return false;
  const a = byId.get(edge.from);
  const b = byId.get(edge.to);
  if (!a || !b) return true;
  return isNodeDimmed(a, filter) || isNodeDimmed(b, filter);
}

/**
 * Returns the latest node in the graph (the node with the highest timestamp, or the last node).
 *
 * Args:
 *     graph (SessionGraph): Current session graph.
 *
 * Returns:
 *     GraphNode | undefined: The latest node, or undefined when the graph is empty.
 */
export function latestNode(graph: SessionGraph): GraphNode | undefined {
  let best: GraphNode | undefined;
  for (const n of graph.nodes) {
    if (!best || n.at >= best.at) best = n;
  }
  return best;
}

/**
 * Resolves the currently selected node, falling back to the latest node in the graph.
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
  return latestNode(s.graph);
}

export interface GraphSummary {
  outcomes: GraphNode[];
  rejected: GraphNode[];
  decisionsCount: number;
  loopsCount: number;
}

/**
 * Summarizes the graph into Executive Summary buckets for the left sidebar.
 *
 * Args:
 *     graph (SessionGraph): Current session graph.
 *
 * Returns:
 *     GraphSummary: Chosen outcomes, rejected/unchosen paths, and counts.
 */
export function summarizeGraph(graph: SessionGraph): GraphSummary {
  const outcomes = graph.nodes.filter((n) => n.kind === "chosen");
  const rejected = graph.nodes.filter((n) => n.kind === "rejected" || n.kind === "option");
  const decisionsCount = graph.nodes.filter((n) => n.kind === "decision" || n.kind === "rejected").length;
  const loopsCount = graph.nodes.filter((n) => n.kind === "loop").length;
  return { outcomes, rejected, decisionsCount, loopsCount };
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
  els.modePill.className = s.graph.mode === "llm" ? "pill llm" : "pill";
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
    sum.rejected.length > 0 ? `${sum.rejected.length} ruled out` : "",
    sum.loopsCount > 0 ? `${sum.loopsCount} loops collapsed` : "",
  ]
    .filter(Boolean)
    .map((p) => `<span class="pill">${esc(p)}</span>`)
    .join("");

  const renderList = (items: GraphNode[], color: string, empty: string): string => {
    if (items.length === 0) return `<p class="empty-note">${esc(empty)}</p>`;
    return `<ul class="summary-list">${items
      .map(
        (n) =>
          `<li class="summary-item${n.id === selId ? " on" : ""}" style="--c:${color}" data-jump="${esc(n.id)}">` +
          `<div class="st">${esc(n.title)}</div>` +
          `<div class="sd">${esc(n.desc)}</div>` +
          `</li>`,
      )
      .join("")}</ul>`;
  };

  els.sidebar.innerHTML =
    `<div><div class="sec-title">Session Overview</div><h2 class="session-heading">${esc(s.graph.title || "Waiting for turns")}</h2><div class="session-meta">${pills}</div></div>` +
    `<div><div class="sec-title">Chosen Path &amp; Outcomes</div>${renderList(sum.outcomes, "var(--chosen)", "No final outcomes yet.")}</div>` +
    `<div><div class="sec-title">Rejected / Unchosen Paths</div>${renderList(sum.rejected, "var(--rejected)", "No paths rejected or skipped yet.")}</div>`;
}

/**
 * Renders the layered DAG nodes and directed cubic-Bezier SVG edges into the viewport world.
 *
 * Args:
 *     s (State): Current UI state.
 *     els (Els): Cached DOM element references.
 *
 * Returns:
 *     Map<string, Point>: Computed layout positions for all rendered nodes.
 */
export function paintGraph(s: State, els: Els): Map<string, Point> {
  const positions = layoutGraph(s.graph.nodes, s.graph.edges);
  const byId = new Map(s.graph.nodes.map((n) => [n.id, n] as const));
  const selId = selectedNode(s)?.id;
  const latestId = latestNode(s.graph)?.id;

  els.edges.innerHTML = s.graph.edges
    .map((e) => {
      const a = positions.get(e.from);
      const b = positions.get(e.to);
      if (!a || !b) return "";
      const geom = edgePath(a, b);
      const dim = isEdgeDimmed(e, byId, s.filter) ? " dimmed" : "";
      const labelSvg = e.label
        ? `<text class="edge-label ${e.kind}${dim}" x="${geom.lx}" y="${geom.ly}" text-anchor="middle">${esc(e.label)}</text>`
        : "";
      return `<path class="edge ${e.kind}${dim}" d="${geom.d}"/>${labelSvg}`;
    })
    .join("");

  const keep = new Set<string>();
  for (const n of s.graph.nodes) {
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
      n.id === selId && "selected",
      n.id === latestId && "latest",
      isNodeDimmed(n, s.filter) && "dimmed",
    ]
      .filter(Boolean)
      .join(" ");
    el.className = cls;
    el.dataset.node = n.id;
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.innerHTML =
      `<div class="node-head"><span>${esc(n.badge)}</span><span class="node-turns">${esc(turnsLabel(n))}</span></div>` +
      `<div class="node-title">${esc(n.title)}</div>` +
      `<div class="node-desc">${esc(n.desc)}</div>`;
  }

  for (const [id, el] of els.keyed) {
    if (keep.has(id)) continue;
    el.remove();
    els.keyed.delete(id);
  }

  return positions;
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
  const col = KIND_COLOR[n.kind];
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
              `<div class="turn-who ${t.author}"><span>${whoLabel}</span><span>${esc(clock(t.at))}</span></div>` +
              `<div class="turn-body">${esc(t.text || "(tool calls only)")}</div>` +
              actionsHtml +
              `</div>`
            );
          })
          .join("")}</div>`;

  els.panel.innerHTML =
    `<span class="panel-badge" style="color:${col}; background:rgba(255,255,255,.05); border:1px solid ${col}">${esc(n.badge)} · ${esc(turnsLabel(n))}</span>` +
    `<h2 class="panel-title">${esc(n.title)}</h2>` +
    `<div class="rationale-box" style="--accent:${col}"><div class="lbl">${esc(n.rationaleLabel)}</div><p>${esc(n.rationale)}</p></div>` +
    `<div><div class="sec-title">Source Transcript (${turns.length})</div>${turnsHtml}</div>`;
}

/**
 * Updates transient chrome elements: error/disconnect banner, new-activity toast, and Follow button.
 *
 * Args:
 *     s (State): Current UI state.
 *     els (Els): Cached DOM element references.
 *
 * Returns:
 *     void
 */
export function paintChrome(s: State, els: Els): void {
  els.banner.hidden = s.connected && !s.labelerError;
  els.banner.textContent = s.connected ? `Labeler error: ${s.labelerError ?? ""}` : "Connection lost. Reconnecting…";

  const latest = latestNode(s.graph);
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
 * Computes zoom and translation to fit all positioned nodes cleanly inside the viewport.
 *
 * Args:
 *     positions (ReadonlyMap<string, Point>): Top-left coordinates of all rendered nodes.
 *     vw (number): Viewport width in px.
 *     vh (number): Viewport height in px.
 *
 * Returns:
 *     View: Target zoom and translation coordinates.
 */
export function fitView(positions: ReadonlyMap<string, Point>, vw: number, vh: number): View {
  if (positions.size === 0 || vw <= 0 || vh <= 0) return { z: 1, tx: 40, ty: 80 };
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
  const pad = 48;
  const w = Math.max(1, x1 - x0 + 2 * pad);
  const h = Math.max(1, y1 - y0 + 2 * pad);
  const z = clampZoom(Math.min(1.05, Math.min(vw / w, vh / h)));
  return {
    z,
    tx: (vw - (x1 - x0) * z) / 2 - x0 * z,
    ty: (vh - (y1 - y0) * z) / 2 - y0 * z,
  };
}
