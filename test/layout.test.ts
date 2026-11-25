import { describe, expect, test } from "bun:test";
import type { GraphEdge, GraphNode, NodeKind } from "../src/model";
import { edgePath, layoutGraph, NODE_H, NODE_W } from "../web/layout";

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

    const pos = layoutGraph(nodes, edges);
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
    const pos = layoutGraph(nodes, edges);
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
    const pos = layoutGraph(nodes, edges);
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
    const pos = layoutGraph(nodes, edges);
    expect(pos.size).toBe(2);
  });
});
