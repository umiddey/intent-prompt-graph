import { describe, expect, test } from "bun:test";
import { buildHeuristicGraph } from "../src/heuristic";
import type { Turn } from "../src/model";

function turn(partial: Partial<Turn> & Pick<Turn, "id" | "author" | "text">): Turn {
  return {
    at: 1000,
    actions: [],
    open: false,
    ...partial,
  };
}

describe("buildHeuristicGraph", () => {
  test("returns an empty heuristic graph when there are no turns", () => {
    const g = buildHeuristicGraph([]);
    expect(g.mode).toBe("heuristic");
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
  });

  test("builds a connected DAG with goal, options, rejection fork, pivot, and side question", () => {
    const turns: Turn[] = [
      turn({ id: "t1", author: "owner", at: 1000, text: "Force agents to read existing files before planning." }),
      turn({
        id: "t2",
        author: "agent",
        at: 2000,
        openedBy: "t1",
        text: "Options:\n1. Proof-of-read in plan\n2. Feed context up front\n3. Save-time hook",
      }),
      turn({ id: "t3", author: "owner", at: 3000, text: "commit time is post token usage, so it is wasting tokens" }),
      turn({
        id: "t4",
        author: "agent",
        at: 4000,
        openedBy: "t3",
        text: "You are right. We will use a pre-plan script and save-time hook instead.",
      }),
      turn({ id: "t5", author: "owner", at: 5000, text: "what is gross rent lease mode?" }),
      turn({ id: "t6", author: "agent", at: 6000, openedBy: "t5", text: "Tenant pays one fixed amount." }),
    ];

    const g = buildHeuristicGraph(turns);
    expect(g.mode).toBe("heuristic");
    expect(g.nodes.some((n) => n.kind === "goal")).toBe(true);
    expect(g.nodes.some((n) => n.kind === "option")).toBe(true);
    expect(g.nodes.some((n) => n.kind === "rejected")).toBe(true);
    expect(g.nodes.some((n) => n.kind === "chosen")).toBe(true);
    expect(g.nodes.some((n) => n.kind === "side")).toBe(true);
    expect(g.edges.length).toBeGreaterThanOrEqual(4);
  });

  test("collapses consecutive check loops (chk agn / chk now) into one node", () => {
    const turns: Turn[] = [
      turn({ id: "t1", author: "owner", at: 1000, text: "Review this remediation plan." }),
      turn({ id: "t2", author: "agent", at: 1500, openedBy: "t1", text: "Found 5 issues." }),
      turn({ id: "t3", author: "owner", at: 2000, text: "chk agn" }),
      turn({ id: "t4", author: "agent", at: 2500, openedBy: "t3", text: "2 issues left." }),
      turn({ id: "t5", author: "owner", at: 3000, text: "chk now" }),
      turn({ id: "t6", author: "agent", at: 3500, openedBy: "t5", text: "Ready to sign off." }),
    ];

    const g = buildHeuristicGraph(turns);
    const collapsed = g.nodes.find((n) => n.rounds === 2);
    expect(collapsed).toBeDefined();
    expect(collapsed?.kind).toBe("chosen");
    expect(collapsed?.turnIds).toEqual(["t3", "t4", "t5", "t6"]);
  });

  test("collapses consecutive polling / guard noise turns into one loop node", () => {
    const turns: Turn[] = [
      turn({ id: "t1", author: "owner", at: 1000, text: "Merge MR !222." }),
      turn({ id: "t2", author: "agent", at: 1500, openedBy: "t1", text: "Pipeline running." }),
      turn({ id: "t3", author: "agent", at: 2000, text: "Still stuck on CI variable." }),
      turn({ id: "t4", author: "agent", at: 2500, text: "Same state: still waiting." }),
      turn({ id: "t5", author: "agent", at: 3000, text: "Nothing has changed." }),
    ];

    const g = buildHeuristicGraph(turns);
    const poll = g.nodes.find((n) => n.kind === "loop");
    expect(poll).toBeDefined();
    expect(poll?.rounds).toBe(3);
    expect(poll?.turnIds).toEqual(["t3", "t4", "t5"]);
  });
});
