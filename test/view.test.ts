import { describe, expect, test } from "bun:test";
import type { GraphNode, SessionGraph } from "../src/model";
import { COL_GAP, NODE_H, NODE_W, type Point } from "../web/layout";
import {
  colorGroup,
  filterGraph,
  FIT_FLOOR,
  fitView,
  followTarget,
  inspectorSignature,
  isNodeVisible,
  revealView,
  stepSelection,
  summarizeGraph,
  type State,
  type View,
} from "../web/view";

function node(id: string, kind: GraphNode["kind"], at: number): GraphNode {
  return {
    id,
    kind,
    badge: kind.toUpperCase(),
    title: `Node ${id}`,
    desc: `Desc ${id}`,
    rationaleLabel: "Why",
    rationale: `Reason ${id}`,
    turnIds: [id],
    at,
  };
}

/** True when the card at `p` lies fully inside a `vw` x `vh` viewport under view `v`. */
function cardInside(v: View, p: Point, vw: number, vh: number): boolean {
  const left = v.tx + p.x * v.z;
  const top = v.ty + p.y * v.z;
  return left >= 0 && top >= 0 && left + NODE_W * v.z <= vw && top + NODE_H * v.z <= vh;
}

describe("Decision Graph view helpers", () => {
  const graph: SessionGraph = {
    title: "Enforce Reuse",
    mode: "heuristic",
    nodes: [
      node("g1", "goal", 1000),
      node("o1", "option", 2000),
      node("r1", "rejected", 3000),
      node("c1", "chosen", 4000),
      node("s1", "side", 3500),
    ],
    edges: [
      { id: "e1", from: "g1", to: "o1", kind: "option" },
      { id: "e2", from: "g1", to: "r1", kind: "rejected" },
      { id: "e3", from: "g1", to: "c1", kind: "chosen" },
    ],
  };

  test("summarizeGraph separates chosen outcomes from rejected/unchosen paths and names goal and current position", () => {
    const sum = summarizeGraph(graph);
    expect(sum.outcomes.map((n) => n.id)).toEqual(["c1"]);
    expect(sum.rejected.map((n) => n.id)).toEqual(["o1", "r1"]);
    expect(sum.decisionsCount).toBe(1);
    expect(sum.goal?.id).toBe("g1");
    expect(sum.now?.id).toBe("c1");
  });

  test("summarizeGraph reports the latest spine node as current position when nothing is chosen yet", () => {
    const sum = summarizeGraph({
      ...graph,
      nodes: [node("g1", "goal", 1000), node("d1", "decision", 2000), node("s1", "side", 3000)],
      edges: [],
    });
    expect(sum.now?.id).toBe("d1");
    expect(summarizeGraph({ ...graph, nodes: [], edges: [] }).now).toBeUndefined();
  });

  test("isNodeVisible respects all, chosen, and decisions filter modes", () => {
    const [g, o, r, c, s] = graph.nodes;
    expect(isNodeVisible(o!, "all")).toBe(true);
    expect(isNodeVisible(c!, "chosen")).toBe(true);
    expect(isNodeVisible(r!, "chosen")).toBe(false);
    expect(isNodeVisible(o!, "chosen")).toBe(false);
    expect(isNodeVisible(s!, "chosen")).toBe(false);
    expect(isNodeVisible(r!, "decisions")).toBe(true);
    expect(isNodeVisible(g!, "decisions")).toBe(true);
    expect(isNodeVisible(c!, "decisions")).toBe(false);
  });

  test("filters remove nodes and their edges instead of dimming them", () => {
    expect(filterGraph(graph, "all")).toBe(graph);

    const chosen = filterGraph(graph, "chosen");
    expect(chosen.nodes.map((n) => n.id)).toEqual(["g1", "c1"]);
    expect(chosen.edges.map((e) => e.id)).toEqual(["e3"]);

    const decisions = filterGraph(graph, "decisions");
    expect(decisions.nodes.map((n) => n.id)).toEqual(["g1", "r1"]);
    expect(decisions.edges.map((e) => e.id)).toEqual(["e2"]);
  });

  test("a filter bridges the spine across the nodes it removes", () => {
    const chained: SessionGraph = {
      ...graph,
      nodes: [node("g1", "goal", 1000), node("o1", "option", 2000), node("d1", "decision", 3000)],
      edges: [
        { id: "e1", from: "g1", to: "o1", kind: "option", label: "agent proposes" },
        { id: "e2", from: "o1", to: "d1", kind: "decision", label: "owner redirects" },
      ],
    };
    const shown = filterGraph(chained, "chosen");
    expect(shown.nodes.map((n) => n.id)).toEqual(["g1", "d1"]);
    expect(shown.edges.map((e) => [e.from, e.to, e.kind, e.label])).toEqual([
      ["g1", "d1", "decision", "owner redirects"],
    ]);
  });

  test("the follow target is the latest spine node and skips side, option and rejected nodes", () => {
    expect(followTarget(graph)?.id).toBe("c1");
    const noisy: SessionGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        node("d2", "decision", 5000),
        node("o2", "option", 6000),
        node("r2", "rejected", 7000),
        node("s2", "side", 8000),
      ],
    };
    expect(followTarget(noisy)?.id).toBe("d2");
  });

  test("the follow target falls back to the latest node only when there is no spine node", () => {
    const branchesOnly: SessionGraph = { ...graph, nodes: [node("o1", "option", 2000), node("s1", "side", 3000)] };
    expect(followTarget(branchesOnly)?.id).toBe("s1");
    expect(followTarget({ ...graph, nodes: [] })).toBeUndefined();
  });

  test("inspectorSignature does not depend on the filter", () => {
    const state: State = {
      connected: true,
      turns: [{ id: "c1", author: "agent", at: 4000, text: "done", actions: [], open: false }],
      graph,
      filter: "all",
      viewMode: "timeline",
      follow: true,
    };
    const sig1 = inspectorSignature(state);
    const sig2 = inspectorSignature({ ...state, filter: "chosen", viewMode: "graph" });
    expect(sig1).toBe(sig2);
  });

  test("the palette has three colour groups", () => {
    expect([colorGroup("goal"), colorGroup("chosen")]).toEqual(["chosen", "chosen"]);
    expect([colorGroup("rejected"), colorGroup("option")]).toEqual(["rejected", "rejected"]);
    expect([colorGroup("decision"), colorGroup("loop"), colorGroup("side")]).toEqual(["other", "other", "other"]);
  });

  test("stepSelection moves through the rows and stops at both ends", () => {
    const ids = ["a", "b", "c"];
    expect(stepSelection(ids, "a", 1)).toBe("b");
    expect(stepSelection(ids, "b", -1)).toBe("a");
    expect(stepSelection(ids, "c", 1)).toBeUndefined();
    expect(stepSelection(ids, "a", -1)).toBeUndefined();
    // A selection the filter hides is not in the list: Down starts at the top, Up at the bottom.
    expect(stepSelection(ids, "hidden", 1)).toBe("a");
    expect(stepSelection(ids, undefined, -1)).toBe("c");
    expect(stepSelection([], "a", 1)).toBeUndefined();
  });
});

describe("graph view framing", () => {
  const VW = 735;
  const VH = 722;
  /** Fifteen columns in one row plus one branch: far wider than the viewport, like a real session. */
  const wide = new Map<string, Point>();
  for (let i = 0; i < 15; i++) wide.set(`n${i}`, { x: i * (NODE_W + COL_GAP), y: 0 });
  wide.set("branch", { x: 0, y: NODE_H + 42 });

  test("fitView fits a small graph whole, never enlarged past 100%", () => {
    const small = new Map<string, Point>([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 600, y: 300 }],
    ]);
    const v = fitView(small, 1000, 700);
    expect(v.z).toBeGreaterThanOrEqual(FIT_FLOOR);
    expect(v.z).toBeLessThanOrEqual(1);
    for (const p of small.values()) expect(cardInside(v, p, 1000, 700)).toBe(true);

    const cramped = fitView(small, 700, 500);
    expect(cramped.z).toBeLessThan(1);
    expect(cramped.z).toBeGreaterThanOrEqual(FIT_FLOOR);
    for (const p of small.values()) expect(cardInside(cramped, p, 700, 500)).toBe(true);
  });

  test("fitView stops at the readable floor and shows the selected node instead of shrinking further", () => {
    for (const id of ["n0", "n7", "n14", "branch"]) {
      const v = fitView(wide, VW, VH, id);
      expect(v.z).toBe(FIT_FLOOR);
      expect(cardInside(v, wide.get(id)!, VW, VH)).toBe(true);
    }
    // A selection in the middle of the row is centred in the viewport.
    const mid = fitView(wide, VW, VH, "n7");
    expect(mid.tx + (wide.get("n7")!.x + NODE_W / 2) * mid.z).toBeCloseTo(VW / 2, 6);
    // With no selection the view starts at the first card rather than in empty space.
    expect(cardInside(fitView(wide, VW, VH), wide.get("n0")!, VW, VH)).toBe(true);
  });

  test("fitView at a fixed zoom (the 100% button) keeps the selected node inside the viewport", () => {
    for (const id of ["n0", "n7", "n14"]) {
      const v = fitView(wide, VW, VH, id, 1);
      expect(v.z).toBe(1);
      expect(cardInside(v, wide.get(id)!, VW, VH)).toBe(true);
    }
    expect(fitView(new Map(), VW, VH).z).toBe(1);
  });

  test("revealView leaves a visible node alone and pans to a hidden one without changing the zoom", () => {
    const v = fitView(wide, VW, VH, "n0");
    expect(revealView(v, wide.get("n0")!, VW, VH)).toBe(v);

    const moved = revealView(v, wide.get("n14")!, VW, VH);
    expect(moved.z).toBe(v.z);
    expect(cardInside(moved, wide.get("n14")!, VW, VH)).toBe(true);
  });
});
