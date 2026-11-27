import type { GraphChapter, GraphEdge, GraphNode, NodeKind } from "../src/model";

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
/** Vertical gap between two wrapped lines of one chapter, and between two chapter bands. */
export const LINE_GAP = 64;
export const BAND_GAP = 56;
/** Space inside a chapter band around its cards, and the height of the title strip at its top. */
export const BAND_PAD = 36;
export const BAND_HEAD = 96;

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

/** Consecutive timeline rows that share a chapter. `title` is "" when the rows have no chapter. */
export interface ChapterRun {
  title: string;
  rows: TimelineRow[];
}

/**
 * Cuts timeline rows into chapters. A new chapter starts where the chapter title changes from one
 * spine row to the next. A branch row stays with the spine row it hangs under, and a node without a
 * chapter joins the chapter before it.
 *
 * Args:
 *     rows (readonly TimelineRow[]): Rows in display order, as returned by `timelineRows`.
 *     chapters (readonly GraphChapter[] | undefined): Named chapters of the graph, if any.
 *
 * Returns:
 *     ChapterRun[]: Chapters in display order; every row appears in exactly one.
 */
export function chapterRuns(rows: readonly TimelineRow[], chapters: readonly GraphChapter[] | undefined): ChapterRun[] {
  const titleOf = new Map<string, string>();
  for (const c of chapters ?? []) {
    for (const id of c.nodeIds) titleOf.set(id, c.title);
  }
  const runs: ChapterRun[] = [];
  let run: ChapterRun | undefined;
  for (const row of rows) {
    const title = run && row.depth === 1 ? run.title : (titleOf.get(row.node.id) ?? run?.title ?? "");
    if (!run || title !== run.title) {
      run = { title, rows: [] };
      runs.push(run);
    }
    run.rows.push(row);
  }
  return runs;
}

/** One chapter of the graph view: a box that spans the full graph width. */
export interface Band {
  title: string;
  y: number;
  height: number;
  nodeIds: string[];
}

export interface GraphLayout {
  /** Top-left canvas position of every node, in px. */
  positions: Map<string, Point>;
  /** Wrapped line each node sits on, counted from the top of the graph. */
  lines: Map<string, number>;
  /** Top edge of every wrapped line. */
  lineTops: number[];
  bands: Band[];
  /** Index into `bands` for every node. */
  bandOf: Map<string, number>;
  width: number;
  height: number;
}

/**
 * Lays the graph out as chapters stacked top to bottom. Inside a chapter the spine runs left to
 * right in timeline order and wraps onto a new line after `perRow` cards, so the graph is never
 * wider than `perRow` columns. A rejected, option or side node sits below the spine card it
 * branches from. Without chapter titles the graph is one unboxed band starting at (0, 0).
 *
 * Args:
 *     nodes (readonly GraphNode[]): Graph nodes to place.
 *     edges (readonly GraphEdge[]): Directed edges between nodes.
 *     chapters (readonly GraphChapter[] | undefined): Named chapters of the graph, if any.
 *     perRow (number): Spine cards per line; at least 1.
 *
 * Returns:
 *     GraphLayout: Positions, line and band of every node, the bands, and the overall size.
 */
export function layoutGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  chapters: readonly GraphChapter[] | undefined,
  perRow: number,
): GraphLayout {
  const out: GraphLayout = { positions: new Map(), lines: new Map(), lineTops: [], bands: [], bandOf: new Map(), width: 0, height: 0 };
  const runs = chapterRuns(timelineRows(nodes, edges), chapters);
  if (runs.length === 0) return out;
  const boxed = runs.some((r) => r.title !== "");
  const pad = boxed ? BAND_PAD : 0;
  const stepX = NODE_W + COL_GAP;
  const stepY = NODE_H + ROW_GAP;

  let y = 0;
  let maxCols = 1;
  for (const run of runs) {
    const top = y;
    let col = -1;
    let depth = 0;
    const cells = run.rows.map((row) => {
      if (row.depth === 0 || col < 0) {
        col++;
        depth = 0;
      } else {
        depth++;
      }
      return { id: row.node.id, line: Math.floor(col / perRow), col: col % perRow, depth };
    });
    maxCols = Math.max(maxCols, Math.min(col + 1, perRow));

    y += boxed ? BAND_HEAD : 0;
    const lineCount = Math.floor(col / perRow) + 1;
    for (let line = 0; line < lineCount; line++) {
      let deepest = 0;
      for (const c of cells) {
        if (c.line !== line) continue;
        out.positions.set(c.id, { x: pad + c.col * stepX, y: y + c.depth * stepY });
        out.lines.set(c.id, out.lineTops.length);
        out.bandOf.set(c.id, out.bands.length);
        deepest = Math.max(deepest, c.depth);
      }
      out.lineTops.push(y);
      y += deepest * stepY + NODE_H + LINE_GAP;
    }
    y += pad - LINE_GAP;
    out.bands.push({ title: run.title, y: top, height: y - top, nodeIds: cells.map((c) => c.id) });
    y += BAND_GAP;
  }
  out.width = 2 * pad + maxCols * stepX - COL_GAP;
  out.height = y - BAND_GAP;
  return out;
}

/** SVG path through `points` with every corner rounded by at most `radius`. */
function roundedPath(points: readonly Point[], radius: number): string {
  let d = "";
  points.forEach((p, i) => {
    const prev = points[i - 1];
    const next = points[i + 1];
    if (!prev) d = `M ${p.x} ${p.y}`;
    else if (!next) d += ` L ${p.x} ${p.y}`;
    else {
      const before = Math.hypot(p.x - prev.x, p.y - prev.y);
      const after = Math.hypot(next.x - p.x, next.y - p.y);
      const r = Math.min(radius, before / 2, after / 2);
      if (r <= 0) return;
      const ax = p.x - ((p.x - prev.x) / before) * r;
      const ay = p.y - ((p.y - prev.y) / before) * r;
      const bx = p.x + ((next.x - p.x) / after) * r;
      const by = p.y + ((next.y - p.y) / after) * r;
      d += ` L ${ax} ${ay} Q ${p.x} ${p.y} ${bx} ${by}`;
    }
  });
  return d;
}

/** Horizontal distance between a card's side and the vertical run of a wrap connector. */
const WRAP_STUB = 22;

/**
 * Computes the path of an edge in a laid-out graph. Two nodes on the same line get the smooth curve
 * of `edgePath`. Nodes on different lines get a wrap connector that never crosses a card: out of the
 * source's right side, through the column gap to the free strip above the target's line (above its
 * chapter when the chapters differ), along that strip, and into the target's left side.
 *
 * Args:
 *     layout (GraphLayout): Layout that holds both nodes.
 *     from (string): Source node id.
 *     to (string): Target node id.
 *
 * Returns:
 *     (EdgeGeometry & { wrap: boolean }) | undefined: Path and label position; undefined when either node is not laid out.
 */
export function edgeGeometry(layout: GraphLayout, from: string, to: string): (EdgeGeometry & { wrap: boolean }) | undefined {
  const a = layout.positions.get(from);
  const b = layout.positions.get(to);
  const lineB = layout.lines.get(to);
  const band = layout.bands[layout.bandOf.get(to) ?? -1];
  if (!a || !b || lineB === undefined || !band) return undefined;
  if (layout.lines.get(from) === lineB) return { ...edgePath(a, b), wrap: false };

  const sameBand = layout.bandOf.get(from) === layout.bandOf.get(to);
  const strip = sameBand ? (layout.lineTops[lineB] ?? b.y) - LINE_GAP / 2 : band.y - BAND_GAP / 2;
  const y1 = a.y + NODE_H / 2;
  const y2 = b.y + NODE_H / 2;
  const outX = a.x + NODE_W + WRAP_STUB;
  const inX = b.x - WRAP_STUB;
  const d = roundedPath(
    [
      { x: a.x + NODE_W, y: y1 },
      { x: outX, y: y1 },
      { x: outX, y: strip },
      { x: inX, y: strip },
      { x: inX, y: y2 },
      { x: b.x, y: y2 },
    ],
    14,
  );
  return { d, lx: b.x + NODE_W / 2, ly: strip, vertical: false, wrap: true };
}
