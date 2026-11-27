import { describe, expect, test } from "bun:test";
import type { GraphEdge, GraphNode, NodeKind } from "../src/model";
import {
  BAND_HEAD,
  chapterRuns,
  COL_GAP,
  edgeGeometry,
  edgePath,
  layoutGraph,
  NODE_H,
  NODE_W,
  pruneGraph,
  ROW_GAP,
  timelineRows,
} from "../web/layout";

function node(id: string, kind: NodeKind = "decision"): GraphNode {
  return {
    id,
    kind,
    badge: kind.toUpperCase(),
    title: id,
    desc: id,
    rationaleLabel: "Why",
    rationale: "Reason",
    turnIds: [id],
    at: 1000,
  };
}

function overlaps(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) < NODE_W && Math.abs(a.y - b.y) < NODE_H;
}

describe("layered DAG layout", () => {
  test("never overlaps any two nodes across a branching 120-node DAG", () => {
    const nodes: GraphNode[] = [node("n0", "goal")];
    const edges: GraphEdge[] = [];
    for (let i = 1; i < 120; i++) {
      const kind: NodeKind = i % 5 === 0 ? "rejected" : i % 4 === 0 ? "side" : i % 3 === 0 ? "option" : "chosen";
      nodes.push(node(`n${i}`, kind));
      const parent = `n${Math.max(0, i - (i % 3 === 0 ? 2 : 1))}`;
      edges.push({ id: `e${i}`, from: parent, to: `n${i}`, kind });
    }

    const pos = layoutGraph(nodes, edges, undefined, 4).positions;
    expect(pos.size).toBe(120);
    const pts = [...pos.values()];
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        expect(overlaps(pts[i]!, pts[j]!)).toBe(false);
      }
    }
  });

  test("places forward transitions left-to-right and keeps main spine above rejected/option branches", () => {
    const nodes = [node("g1", "goal"), node("opt", "option"), node("rej", "rejected"), node("win", "chosen")];
    const edges: GraphEdge[] = [
      { id: "e1", from: "g1", to: "opt", kind: "option" },
      { id: "e2", from: "g1", to: "rej", kind: "rejected" },
      { id: "e3", from: "g1", to: "win", kind: "chosen" },
    ];
    const pos = layoutGraph(nodes, edges, undefined, 6).positions;
    const pGoal = pos.get("g1")!;
    const pWin = pos.get("win")!;
    const pOpt = pos.get("opt")!;
    const pRej = pos.get("rej")!;

    expect(pWin.x).toBeGreaterThan(pGoal.x);
    expect(pWin.y).toBeLessThan(pOpt.y);
    expect(pOpt.y).toBeLessThan(pRej.y);
  });

  test("places side questions in the same column below their parent and computes vertical edge paths", () => {
    const nodes = [node("d1", "decision"), node("s1", "side")];
    const edges: GraphEdge[] = [{ id: "e1", from: "d1", to: "s1", kind: "side" }];
    const pos = layoutGraph(nodes, edges, undefined, 6).positions;
    const pParent = pos.get("d1")!;
    const pSide = pos.get("s1")!;

    expect(pSide.x).toBe(pParent.x);
    expect(pSide.y).toBeGreaterThan(pParent.y);
    const geom = edgePath(pParent, pSide);
    expect(geom.d).toContain("M ");
    expect(geom.ly).toBeGreaterThan(pParent.y);
  });

  test("handles cyclic edges without infinite loops", () => {
    const nodes = [node("a", "decision"), node("b", "decision")];
    const edges: GraphEdge[] = [
      { id: "e1", from: "a", to: "b", kind: "decision" },
      { id: "e2", from: "b", to: "a", kind: "decision" },
    ];
    const pos = layoutGraph(nodes, edges, undefined, 6).positions;
    expect(pos.size).toBe(2);
  });
});

/** The session shape seen in real LLM graphs: the spine runs through option and rejected nodes. */
function story(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = [
    node("goal", "goal"),
    node("opt", "option"),
    node("dec", "decision"),
    node("try", "option"),
    node("rej", "rejected"),
    node("win", "chosen"),
    node("loop", "loop"),
    node("oops", "rejected"),
    node("fin", "chosen"),
    node("aside", "side"),
  ];
  const edges: GraphEdge[] = [
    { id: "e1", from: "goal", to: "opt", kind: "option", label: "agent proposes" },
    { id: "e2", from: "opt", to: "dec", kind: "decision", label: "owner redirects" },
    { id: "e3", from: "dec", to: "try", kind: "option", label: "agent tries" },
    { id: "e4", from: "try", to: "rej", kind: "rejected", label: "too late" },
    { id: "e5", from: "dec", to: "win", kind: "chosen", label: "move check" },
    { id: "e6", from: "win", to: "loop", kind: "loop", label: "3 rounds" },
    { id: "e7", from: "loop", to: "oops", kind: "rejected", label: "wrong turn" },
    { id: "e8", from: "oops", to: "fin", kind: "chosen", label: "owner corrects" },
    { id: "e9", from: "goal", to: "aside", kind: "side", label: "stray input" },
  ];
  return { nodes, edges };
}

describe("timeline order", () => {
  test("runs the spine goal-first and hangs rejected, option and side rows under the spine node they branch from", () => {
    const { nodes, edges } = story();
    const rows = timelineRows(nodes, edges);

    expect(rows.map((r) => r.node.id)).toEqual([
      "goal",
      "opt",
      "aside",
      "dec",
      "try",
      "rej",
      "win",
      "loop",
      "oops",
      "fin",
    ]);
    expect(rows.filter((r) => r.depth === 0).map((r) => r.node.id)).toEqual(["goal", "dec", "win", "loop", "fin"]);
    const parents = Object.fromEntries(rows.filter((r) => r.depth === 1).map((r) => [r.node.id, r.parentId]));
    // "rej" branches from the option "try", so it lands under that option's spine node.
    expect(parents).toEqual({ opt: "goal", aside: "goal", try: "dec", rej: "dec", oops: "loop" });
    expect(rows.find((r) => r.node.id === "rej")?.edge?.label).toBe("too late");
    expect(rows.find((r) => r.node.id === "dec")?.edge?.label).toBe("owner redirects");
  });

  test("follows the edges, not the order of the node list", () => {
    const { nodes, edges } = story();
    const shuffled = timelineRows([...nodes].reverse(), edges);
    expect(shuffled.filter((r) => r.depth === 0).map((r) => r.node.id)).toEqual(["goal", "dec", "win", "loop", "fin"]);
    expect(shuffled.map((r) => r.node.id).sort()).toEqual(nodes.map((n) => n.id).sort());
  });

  test("appends nodes unreachable from the goal and never drops one", () => {
    const { nodes, edges } = story();
    nodes.push(node("lost", "decision"), node("lost-side", "side"), node("stray", "rejected"));
    edges.push(
      { id: "x1", from: "lost", to: "lost-side", kind: "side" },
      { id: "x2", from: "ghost", to: "stray", kind: "rejected" },
      { id: "x3", from: "fin", to: "goal", kind: "loop" },
    );
    const rows = timelineRows(nodes, edges);

    expect(rows).toHaveLength(nodes.length);
    expect(new Set(rows.map((r) => r.node.id)).size).toBe(nodes.length);
    expect(rows[0]?.node.id).toBe("goal");
    expect(rows.slice(-3).map((r) => [r.node.id, r.depth, r.parentId])).toEqual([
      ["lost", 0, undefined],
      ["lost-side", 1, "lost"],
      ["stray", 1, undefined],
    ]);
  });

  test("orders a graph that has no goal by its edges", () => {
    const nodes = [node("b", "chosen"), node("a", "decision"), node("s", "side")];
    const edges: GraphEdge[] = [
      { id: "e1", from: "a", to: "b", kind: "chosen" },
      { id: "e2", from: "a", to: "s", kind: "side" },
    ];
    expect(timelineRows(nodes, edges).map((r) => r.node.id)).toEqual(["a", "s", "b"]);
  });
});

describe("filtered graph layout", () => {
  test("bridges the spine across removed nodes and lays the rest out without gaps", () => {
    const { nodes, edges } = story();
    const spine: NodeKind[] = ["goal", "decision", "chosen", "loop"];
    const slice = pruneGraph(nodes, edges, (n) => spine.includes(n.kind));

    expect(slice.nodes.map((n) => n.id)).toEqual(["goal", "dec", "win", "loop", "fin"]);
    expect(slice.edges.map((e) => [e.from, e.to, e.kind, e.label])).toEqual([
      ["dec", "win", "chosen", "move check"],
      ["win", "loop", "loop", "3 rounds"],
      ["goal", "dec", "decision", "owner redirects"],
      ["loop", "fin", "chosen", "owner corrects"],
    ]);

    const pos = layoutGraph(slice.nodes, slice.edges, undefined, 6).positions;
    expect(pos.size).toBe(5);
    // One connected row: columns 0 to 4 are each taken once, all on row 0.
    const step = NODE_W + COL_GAP;
    expect(slice.nodes.map((n) => pos.get(n.id)!.x / step)).toEqual([0, 1, 2, 3, 4]);
    expect([...pos.values()].every((p) => p.y === 0)).toBe(true);
  });

  test("keeps every node and edge when nothing is removed", () => {
    const { nodes, edges } = story();
    const slice = pruneGraph(nodes, edges, () => true);
    expect(slice.nodes).toEqual(nodes);
    expect(slice.edges).toEqual(edges);
  });

  test("does not loop on a cycle of removed nodes", () => {
    const nodes = [node("a", "goal"), node("x", "side"), node("y", "side"), node("b", "chosen")];
    const edges: GraphEdge[] = [
      { id: "e1", from: "a", to: "x", kind: "side" },
      { id: "e2", from: "x", to: "y", kind: "side" },
      { id: "e3", from: "y", to: "x", kind: "side" },
      { id: "e4", from: "y", to: "b", kind: "chosen", label: "back on track" },
      { id: "e5", from: "y", to: "a", kind: "side" },
    ];
    const slice = pruneGraph(nodes, edges, (n) => n.kind !== "side");
    expect(slice.edges.map((e) => [e.from, e.to, e.label])).toEqual([["a", "b", "back on track"]]);
  });
});

describe("edge labels", () => {
  test("sit in the gap before the target node, never under a card", () => {
    const { nodes, edges } = story();
    // A long edge that skips columns: its label must still clear the cards it passes.
    edges.push({ id: "long", from: "goal", to: "fin", kind: "chosen", label: "straight there" });
    const pos = layoutGraph(nodes, edges, undefined, 12).positions;
    const cards = [...pos.values()];

    for (const e of edges) {
      const to = pos.get(e.to)!;
      const geom = edgePath(pos.get(e.from)!, to);
      const underCard = cards.some(
        (c) => geom.lx > c.x && geom.lx < c.x + NODE_W && geom.ly > c.y && geom.ly < c.y + NODE_H,
      );
      expect(underCard).toBe(false);
      if (geom.vertical) {
        expect(geom.lx).toBe(to.x + NODE_W / 2);
        expect(geom.ly).toBe(to.y - ROW_GAP / 2);
      } else {
        expect(geom.lx).toBeCloseTo(to.x - COL_GAP / 2, 1);
      }
    }
    expect(edgePath(pos.get("goal")!, pos.get("aside")!).vertical).toBe(true);
  });
});

describe("graph columns follow the timeline", () => {
  test("a topic with no link to earlier cards starts right of them, not at the far left", () => {
    const at = (id: string, kind: NodeKind, t: number): GraphNode => ({ ...node(id, kind), at: t });
    // Two chains that the labeler did not link: a→b→c, then a new topic d→e that starts after b.
    const nodes = [at("a", "goal", 1), at("b", "chosen", 2), at("d", "decision", 3), at("c", "chosen", 4), at("e", "chosen", 5)];
    const edges: GraphEdge[] = [
      { id: "e1", from: "a", to: "b", kind: "chosen" },
      { id: "e2", from: "b", to: "c", kind: "chosen" },
      { id: "e3", from: "d", to: "e", kind: "chosen" },
    ];
    const pos = layoutGraph(nodes, edges, undefined, 6).positions;
    // Same order as the timeline view: one column per card, the unlinked topic after the first chain.
    const order = timelineRows(nodes, edges).map((r) => r.node.id);
    expect(order.slice(0, 2)).toEqual(["a", "b"]);
    const xs = order.map((id) => pos.get(id)!.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
    expect(pos.get("d")!.x).toBeGreaterThan(pos.get("b")!.x);
  });
});

describe("chapters", () => {
  /** A chain a→b→c→d→e→f with one rejected branch under c. */
  function chain(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const nodes = [...ids.map((id, i) => node(id, i === 0 ? "goal" : "chosen")), node("no", "rejected")];
    const edges: GraphEdge[] = ids.slice(1).map((id, i) => ({ id: `e${i}`, from: ids[i]!, to: id, kind: "chosen" }));
    edges.push({ id: "er", from: "c", to: "no", kind: "rejected" });
    return { nodes, edges };
  }
  const chapters = [
    { title: "Plan", nodeIds: ["a", "b", "c"] },
    { title: "Build", nodeIds: ["d", "e", "f"] },
  ];

  test("chapterRuns keeps a branch with its spine row and an unnamed node with the chapter before it", () => {
    const { nodes, edges } = chain();
    const rows = timelineRows(nodes, edges);
    // "no" has no chapter and "e" lost its name: both stay where they are in the story.
    const runs = chapterRuns(rows, [chapters[0]!, { title: "Build", nodeIds: ["d", "f"] }]);
    expect(runs.map((r) => [r.title, r.rows.map((x) => x.node.id)])).toEqual([
      ["Plan", ["a", "b", "c", "no"]],
      ["Build", ["d", "e", "f"]],
    ]);
    expect(chapterRuns(rows, undefined).map((r) => r.title)).toEqual([""]);
  });

  test("layoutGraph wraps a long row onto new lines instead of growing sideways", () => {
    const { nodes, edges } = chain();
    const layout = layoutGraph(nodes, edges, undefined, 2);
    const step = NODE_W + COL_GAP;
    expect(layout.width).toBe(2 * step - COL_GAP);
    expect(layout.lineTops.length).toBe(3);
    expect(["a", "b", "c", "d", "e", "f"].map((id) => layout.positions.get(id)!.x / step)).toEqual([0, 1, 0, 1, 0, 1]);
    expect(["a", "c", "e"].map((id) => layout.lines.get(id))).toEqual([0, 1, 2]);
    // The branch sits under its parent, and the next line starts below the branch.
    expect(layout.positions.get("no")!.x).toBe(layout.positions.get("c")!.x);
    expect(layout.positions.get("e")!.y).toBeGreaterThanOrEqual(layout.positions.get("no")!.y + NODE_H);
    expect(layout.bands.length).toBe(1);
  });

  test("layoutGraph stacks named chapters as bands that hold their own cards", () => {
    const { nodes, edges } = chain();
    const layout = layoutGraph(nodes, edges, chapters, 6);
    expect(layout.bands.map((b) => b.title)).toEqual(["Plan", "Build"]);
    const [plan, build] = layout.bands as [(typeof layout.bands)[0], (typeof layout.bands)[0]];
    expect(build.y).toBeGreaterThan(plan.y + plan.height);
    expect(layout.height).toBe(build.y + build.height);
    for (const [i, band] of layout.bands.entries()) {
      for (const id of band.nodeIds) {
        const p = layout.positions.get(id)!;
        expect(layout.bandOf.get(id)).toBe(i);
        expect(p.y).toBeGreaterThanOrEqual(band.y + BAND_HEAD);
        expect(p.y + NODE_H).toBeLessThan(band.y + band.height);
        expect(p.x).toBeGreaterThan(0);
        expect(p.x + NODE_W).toBeLessThan(layout.width);
      }
    }
  });

  test("edgeGeometry routes an edge to another line through the gap above it, clear of every card", () => {
    const { nodes, edges } = chain();
    const layout = layoutGraph(nodes, edges, chapters, 2);
    const same = edgeGeometry(layout, "a", "b")!;
    expect(same.wrap).toBe(false);
    expect(same.d).toBe(edgePath(layout.positions.get("a")!, layout.positions.get("b")!).d);

    for (const [from, to] of [["b", "c"], ["c", "d"]] as const) {
      const geom = edgeGeometry(layout, from, to)!;
      expect(geom.wrap).toBe(true);
      for (const p of layout.positions.values()) {
        expect(geom.ly > p.y && geom.ly < p.y + NODE_H).toBe(false);
      }
      expect(geom.ly).toBeLessThan(layout.positions.get(to)!.y);
      expect(geom.ly).toBeGreaterThan(layout.positions.get(from)!.y + NODE_H);
    }
    expect(edgeGeometry(layout, "a", "missing")).toBeUndefined();
  });
});
