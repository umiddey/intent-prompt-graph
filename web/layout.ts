import type { GraphEdge, GraphNode, NodeKind } from "../src/model";

export interface Point {
  x: number;
  y: number;
}

export interface EdgeGeometry {
  d: string;
  /** Centre of the label: always inside a gap between cards, next to the target node. */
  lx: number;
  ly: number;
  /** True for a same-column edge, whose label sits in the row gap instead of the column gap. */
  vertical: boolean;
}

/** A node list and the edges between those nodes. */
export interface GraphSlice {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
}

export interface TimelineRow {
  node: GraphNode;
  /** 0 for a spine row, 1 for a branch row indented under a spine row. */
  depth: 0 | 1;
  /** Spine node a branch row hangs under; unset for spine rows and for branch rows with no spine ancestor. */
  parentId?: string;
  /** Edge that leads into this node; its label is shown on the row. */
  edge?: GraphEdge;
}

/** Fixed card footprint used by the layered DAG layout engine. */
export const NODE_W = 248;
export const NODE_H = 128;
export const COL_GAP = 120;
export const ROW_GAP = 42;

const SPINE_KIND: Record<NodeKind, boolean> = {
  goal: true,
  decision: true,
  chosen: true,
  loop: true,
  rejected: false,
  option: false,
  side: false,
};

/**
 * Tells whether a node kind belongs to the main spine of the session (as opposed to a branch off it).
 *
 * Args:
 *     kind (NodeKind): Node kind to test.
 *
 * Returns:
 *     boolean: True for goal, decision, chosen and loop; false for rejected, option and side.
 */
export function isSpineKind(kind: NodeKind): boolean {
  return SPINE_KIND[kind];
}

const KIND_PRIORITY: Record<NodeKind, number> = {
  goal: 0,
  chosen: 1,
  decision: 2,
  loop: 3,
  option: 4,
  rejected: 5,
  side: 6,
};

/**
 * Computes collision-free top-left (x, y) coordinates for every node in a Decision & Path Graph.
 * Columns follow time along the spine: a spine node is never placed left of a spine node that
 * happened before it. A node sits one column right of its parent (same column for a side question);
 * a node with no earlier parent starts after the latest spine node instead of restarting at the far
 * left. Rejected, unchosen option, and side-question branches stay beside the node they branch from
 * and stack below the spine in their column.
 *
 * Args:
 *     nodes (readonly GraphNode[]): Graph nodes to place.
 *     edges (readonly GraphEdge[]): Directed edges between nodes.
 *
 * Returns:
 *     Map<string, Point>: Map of node id to top-left canvas position in px.
 */
export function layoutGraph(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Map<string, Point> {
  const pos = new Map<string, Point>();
  if (nodes.length === 0) return pos;

  const orderIndex = new Map(nodes.map((n, i) => [n.id, i] as const));
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    if (!orderIndex.has(e.from) || !orderIndex.has(e.to) || e.from === e.to) continue;
    const list = incoming.get(e.to) ?? [];
    list.push(e);
    incoming.set(e.to, list);
  }

  // Walk the nodes oldest first. Only parents already placed constrain a node, so an edge that
  // points back in time (or closes a cycle) cannot pull anything left.
  const byTime = [...nodes].sort((a, b) => a.at - b.at || (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0));
  const layer = new Map<string, number>();
  let spineMax = 0;
  for (const n of byTime) {
    let col = -1;
    for (const e of incoming.get(n.id) ?? []) {
      const fromL = layer.get(e.from);
      if (fromL === undefined) continue;
      col = Math.max(col, e.kind === "side" ? fromL : fromL + 1);
    }
    const spine = isSpineKind(n.kind);
    if (col < 0) col = layer.size === 0 ? 0 : spine ? spineMax + 1 : spineMax;
    else if (spine) col = Math.max(col, spineMax);
    layer.set(n.id, col);
    if (spine) spineMax = col;
  }

  // Group nodes into columns and sort each column so the main spine stays on row 0.
  const columns = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    const col = layer.get(n.id) ?? 0;
    const list = columns.get(col) ?? [];
    list.push(n);
    columns.set(col, list);
  }

  for (const [col, list] of columns) {
    list.sort((a, b) => {
      const pDiff = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
      if (pDiff !== 0) return pDiff;
      return (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0);
    });
    const x = col * (NODE_W + COL_GAP);
    list.forEach((n, row) => {
      pos.set(n.id, { x, y: row * (NODE_H + ROW_GAP) });
    });
  }

  return pos;
}

function cubic(a: number, b: number, c: number, d: number, t: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

/**
 * Computes a smooth cubic-Bezier SVG path between two node positions and where its label goes.
 * The label is placed in the gap just before the target node, so no card can cover it: the column
 * gap for edges between columns, the row gap for edges inside one column.
 *
 * Args:
 *     from (Point): Top-left position of the source node.
 *     to (Point): Top-left position of the target node.
 *
 * Returns:
 *     EdgeGeometry: SVG path `d` string, label centre `(lx, ly)` and whether the edge is vertical.
 */
export function edgePath(from: Point, to: Point): EdgeGeometry {
  if (Math.abs(from.x - to.x) < 40) {
    const down = from.y <= to.y;
    const sy = down ? from.y + NODE_H : from.y;
    const ey = down ? to.y : to.y + NODE_H;
    const cx = from.x + NODE_W / 2;
    const midY = (sy + ey) / 2;
    return {
      d: `M ${cx} ${sy} C ${cx} ${midY}, ${cx} ${midY}, ${cx} ${ey}`,
      lx: cx,
      ly: down ? ey - ROW_GAP / 2 : ey + ROW_GAP / 2,
      vertical: true,
    };
  }

  const forward = to.x >= from.x;
  const x1 = forward ? from.x + NODE_W : from.x;
  const y1 = from.y + NODE_H / 2;
  const x2 = forward ? to.x : to.x + NODE_W;
  const y2 = to.y + NODE_H / 2;
  const dx = Math.max(48, Math.abs(x2 - x1) * 0.45);
  const c1x = forward ? x1 + dx : x1 - dx;
  const c2x = forward ? x2 - dx : x2 + dx;

  // Adjacent columns: the curve's midpoint is the gap's centre. Longer edges cross other columns,
  // so find the curve point that lies in the middle of the last gap instead.
  let t = 0.5;
  if (Math.abs(x2 - x1) > COL_GAP) {
    const target = forward ? x2 - COL_GAP / 2 : x2 + COL_GAP / 2;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 20; i++) {
      t = (lo + hi) / 2;
      if (cubic(x1, c1x, c2x, x2, t) < target === forward) lo = t;
      else hi = t;
    }
  }
  return {
    d: `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`,
    lx: cubic(x1, c1x, c2x, x2, t),
    ly: cubic(y1, y1, y2, y2, t),
    vertical: false,
  };
}

/**
 * Removes nodes from a graph and keeps the rest connected. Edges between surviving nodes are kept
 * as they are. Where a path ran through removed nodes, one bridging edge joins the surviving node
 * before it to the surviving node after it, carrying the kind and label of the path's last edge.
 *
 * Args:
 *     nodes (readonly GraphNode[]): All graph nodes.
 *     edges (readonly GraphEdge[]): All graph edges.
 *     keep ((node: GraphNode) => boolean): Returns true for nodes that survive.
 *
 * Returns:
 *     GraphSlice: Surviving nodes in their original order, and the kept plus bridging edges.
 */
export function pruneGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  keep: (node: GraphNode) => boolean,
): GraphSlice {
  const kept = nodes.filter(keep);
  const keptIds = new Set(kept.map((n) => n.id));
  const outgoing = new Map<string, GraphEdge[]>(nodes.map((n) => [n.id, []]));
  const linked = new Map<string, Set<string>>(kept.map((n) => [n.id, new Set()]));
  const out: GraphEdge[] = [];

  for (const e of edges) {
    const list = outgoing.get(e.from);
    if (!list || !outgoing.has(e.to) || e.from === e.to) continue;
    list.push(e);
    if (keptIds.has(e.from) && keptIds.has(e.to)) {
      out.push(e);
      linked.get(e.from)?.add(e.to);
    }
  }
  if (kept.length === nodes.length) return { nodes: kept, edges: out };

  for (const src of kept) {
    const targets = linked.get(src.id) ?? new Set<string>();
    const seen = new Set<string>();
    const removed = (outgoing.get(src.id) ?? []).filter((e) => !keptIds.has(e.to)).map((e) => e.to);
    for (let via = removed.pop(); via !== undefined; via = removed.pop()) {
      if (seen.has(via)) continue;
      seen.add(via);
      for (const e of outgoing.get(via) ?? []) {
        if (!keptIds.has(e.to)) {
          removed.push(e.to);
        } else if (e.to !== src.id && !targets.has(e.to)) {
          targets.add(e.to);
          out.push({ ...e, id: `${src.id}~${e.to}`, from: src.id });
        }
      }
    }
  }
  return { nodes: kept, edges: out };
}

/** Topological order of `subset`; ties and cycles are broken by the order of `subset` itself. */
function runOrder(subset: readonly GraphNode[], outgoing: ReadonlyMap<string, GraphEdge[]>): GraphNode[] {
  const waiting = new Map<string, number>(subset.map((n) => [n.id, 0]));
  for (const n of subset) {
    for (const e of outgoing.get(n.id) ?? []) {
      const count = waiting.get(e.to);
      if (count !== undefined) waiting.set(e.to, count + 1);
    }
  }
  const left = [...subset];
  const order: GraphNode[] = [];
  while (left.length > 0) {
    const ready = left.findIndex((n) => waiting.get(n.id) === 0);
    const [next] = left.splice(Math.max(0, ready), 1);
    if (!next) break;
    order.push(next);
    waiting.delete(next.id);
    for (const e of outgoing.get(next.id) ?? []) {
      const count = waiting.get(e.to);
      if (count !== undefined) waiting.set(e.to, count - 1);
    }
  }
  return order;
}

/**
 * Orders a graph as a top-to-bottom timeline. Spine nodes (goal, decision, chosen, loop) come in the
 * order the edges run, starting at the goal; where the edges leave the order open, the order of
 * `nodes` decides. Each rejected, option or side node becomes a branch row directly under the
 * nearest spine node it descends from. Nodes that cannot be reached from a goal are appended after
 * the reachable ones in the same way, and branch nodes with no spine ancestor come last.
 *
 * Args:
 *     nodes (readonly GraphNode[]): Graph nodes; every one appears in the result exactly once.
 *     edges (readonly GraphEdge[]): Directed edges between nodes.
 *
 * Returns:
 *     TimelineRow[]: Rows in display order.
 */
export function timelineRows(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): TimelineRow[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const outgoing = new Map<string, GraphEdge[]>(nodes.map((n) => [n.id, []]));
  const incoming = new Map<string, GraphEdge>();
  for (const e of edges) {
    const list = outgoing.get(e.from);
    if (!list || !byId.has(e.to) || e.from === e.to) continue;
    list.push(e);
    if (!incoming.has(e.to)) incoming.set(e.to, e);
  }

  const reachable = new Set<string>();
  const frontier = nodes.filter((n) => n.kind === "goal").map((n) => n.id);
  for (let id = frontier.pop(); id !== undefined; id = frontier.pop()) {
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const e of outgoing.get(id) ?? []) frontier.push(e.to);
  }
  const order = [
    ...runOrder(nodes.filter((n) => reachable.has(n.id)), outgoing),
    ...runOrder(nodes.filter((n) => !reachable.has(n.id)), outgoing),
  ];

  const spineAncestor = (id: string): string | undefined => {
    const seen = new Set([id]);
    for (let up = incoming.get(id)?.from; up !== undefined && !seen.has(up); up = incoming.get(up)?.from) {
      const parent = byId.get(up);
      if (parent && isSpineKind(parent.kind)) return up;
      seen.add(up);
    }
    return undefined;
  };

  const branches = new Map<string, TimelineRow[]>();
  const loose: TimelineRow[] = [];
  for (const node of order) {
    if (isSpineKind(node.kind)) continue;
    const parentId = spineAncestor(node.id);
    const row: TimelineRow = { node, depth: 1, parentId, edge: incoming.get(node.id) };
    const siblings = parentId === undefined ? loose : branches.get(parentId);
    if (siblings) siblings.push(row);
    else if (parentId !== undefined) branches.set(parentId, [row]);
  }

  const rows: TimelineRow[] = [];
  for (const node of order) {
    if (!isSpineKind(node.kind)) continue;
    rows.push({ node, depth: 0, edge: incoming.get(node.id) }, ...(branches.get(node.id) ?? []));
  }
  rows.push(...loose);
  return rows;
}
