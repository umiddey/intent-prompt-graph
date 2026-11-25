import type { GraphEdge, GraphNode, NodeKind } from "../src/model";

export interface Point {
  x: number;
  y: number;
}

export interface EdgeGeometry {
  d: string;
  lx: number;
  ly: number;
}

/** Fixed card footprint used by the layered DAG layout engine. */
export const NODE_W = 248;
export const NODE_H = 128;
export const COL_GAP = 88;
export const ROW_GAP = 42;

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
 * Places the main decision spine left-to-right across topological columns while stacking
 * rejected, unchosen option, and side-question branches cleanly below their parent column.
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

  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const outgoing = new Map<string, GraphEdge[]>();
  const inDegree = new Map<string, number>();
  for (const n of nodes) {
    outgoing.set(n.id, []);
    inDegree.set(n.id, 0);
  }
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue;
    outgoing.get(e.from)?.push(e);
    if (e.kind !== "side") {
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    }
  }

  // Assign topological column (layer) via bounded relaxation so cycles cannot loop forever.
  const layer = new Map<string, number>();
  for (const n of nodes) layer.set(n.id, 0);

  const maxPasses = Math.min(nodes.length, 64);
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    for (const e of edges) {
      if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue;
      const fromL = layer.get(e.from) ?? 0;
      const toL = layer.get(e.to) ?? 0;
      if (e.kind === "side") {
        if (toL < fromL) {
          layer.set(e.to, fromL);
          changed = true;
        }
      } else if (toL < fromL + 1) {
        layer.set(e.to, fromL + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Group nodes into columns and sort each column so the main spine stays on row 0.
  const columns = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    const col = layer.get(n.id) ?? 0;
    const list = columns.get(col) ?? [];
    list.push(n);
    columns.set(col, list);
  }

  const orderIndex = new Map(nodes.map((n, i) => [n.id, i] as const));
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

/**
 * Computes a smooth cubic-Bezier SVG path and midpoint label coordinate between two node positions.
 *
 * Args:
 *     from (Point): Top-left position of the source node.
 *     to (Point): Top-left position of the target node.
 *
 * Returns:
 *     EdgeGeometry: SVG path `d` string and label `(lx, ly)` coordinates.
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
      lx: cx + 10,
      ly: midY,
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
  return {
    d: `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`,
    lx: (x1 + x2) / 2,
    ly: (y1 + y2) / 2 - 8,
  };
}
