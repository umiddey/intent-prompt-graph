import { describe, expect, test } from "bun:test";
import type { GraphNode, SessionGraph } from "../src/model";
import { fitView, inspectorSignature, isNodeDimmed, latestNode, summarizeGraph, type State } from "../web/view";

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

  test("summarizeGraph separates chosen outcomes from rejected/unchosen paths", () => {
    const sum = summarizeGraph(graph);
    expect(sum.outcomes.map((n) => n.id)).toEqual(["c1"]);
    expect(sum.rejected.map((n) => n.id)).toEqual(["o1", "r1"]);
    expect(sum.decisionsCount).toBe(1);
  });

  test("isNodeDimmed respects all, chosen, and decisions filter modes", () => {
    const [g, o, r, c, s] = graph.nodes;
    expect(isNodeDimmed(o!, "all")).toBe(false);
    expect(isNodeDimmed(c!, "chosen")).toBe(false);
    expect(isNodeDimmed(r!, "chosen")).toBe(true);
    expect(isNodeDimmed(o!, "chosen")).toBe(true);
    expect(isNodeDimmed(s!, "chosen")).toBe(true);
    expect(isNodeDimmed(r!, "decisions")).toBe(false);
    expect(isNodeDimmed(g!, "decisions")).toBe(false);
    expect(isNodeDimmed(c!, "decisions")).toBe(true);
  });

  test("latestNode picks the node with the latest timestamp and inspectorSignature is stable", () => {
    expect(latestNode(graph)?.id).toBe("c1");
    const state: State = {
      connected: true,
      turns: [{ id: "c1", author: "agent", at: 4000, text: "done", actions: [], open: false }],
      graph,
      filter: "all",
      follow: true,
    };
    const sig1 = inspectorSignature(state);
    const sig2 = inspectorSignature({ ...state, filter: "chosen" });
    expect(sig1).toBe(sig2);
  });

  test("fitView returns a bounded zoom that fits all nodes in the viewport", () => {
    const v = fitView(
      new Map([
        ["a", { x: 0, y: 0 }],
        ["b", { x: 600, y: 300 }],
      ]),
      1000,
      700,
    );
    expect(v.z).toBeGreaterThanOrEqual(0.25);
    expect(v.z).toBeLessThanOrEqual(1.05);
  });
});
