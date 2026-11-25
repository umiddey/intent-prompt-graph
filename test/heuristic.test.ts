import { describe, expect, test } from "bun:test";
import { buildHeuristicGraph, MAX_HEURISTIC_NODES } from "../src/heuristic";
import type { SessionGraph, Turn } from "../src/model";

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

  /** One owner request plus the agent's answer; each pair becomes exactly one spine node. */
  function plainExchanges(count: number): Turn[] {
    const turns: Turn[] = [];
    for (let i = 1; i <= count; i++) {
      turns.push(turn({ id: `o${i}`, author: "owner", at: i * 1000, text: `Implement part ${i} of the importer.` }));
      turns.push(turn({ id: `a${i}`, author: "agent", at: i * 1000 + 500, openedBy: `o${i}`, text: `Part ${i} is implemented.` }));
    }
    return turns;
  }

  /** Asserts ids are unique, edges reference existing nodes, and every non-goal node is reachable from the one goal. */
  function expectConnected(g: SessionGraph): void {
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.size).toBe(g.nodes.length);
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(g.edges.length);
    const goals = g.nodes.filter((n) => n.kind === "goal");
    expect(goals).toHaveLength(1);
    expect(g.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to))).toEqual([]);

    const reached = new Set<string>();
    const queue = goals.map((n) => n.id);
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      if (reached.has(id)) continue;
      reached.add(id);
      for (const e of g.edges) if (e.from === id) queue.push(e.to);
    }
    expect(g.nodes.filter((n) => !reached.has(n.id)).map((n) => n.id)).toEqual([]);
  }

  test("leaves a session at or under the node cap unchanged", () => {
    const short = buildHeuristicGraph(plainExchanges(10));
    expect(short.nodes).toHaveLength(10);
    expect(short.edges).toHaveLength(9);
    expect(short.nodes.some((n) => n.badge.startsWith("EARLIER"))).toBe(false);
    expectConnected(short);

    const atCap = buildHeuristicGraph(plainExchanges(MAX_HEURISTIC_NODES));
    expect(atCap.nodes).toHaveLength(MAX_HEURISTIC_NODES);
    expect(atCap.nodes.map((n) => n.turnIds[0])).toEqual(Array.from({ length: MAX_HEURISTIC_NODES }, (_, i) => `o${i + 1}`));
    expect(atCap.edges).toHaveLength(MAX_HEURISTIC_NODES - 1);
    expect(atCap.nodes.some((n) => n.badge.startsWith("EARLIER"))).toBe(false);
  });

  test("caps a long session at MAX_HEURISTIC_NODES: goal, one summary node, and the latest steps", () => {
    const total = 300;
    const g = buildHeuristicGraph(plainExchanges(total));
    const hidden = total - (MAX_HEURISTIC_NODES - 1);

    expect(g.nodes).toHaveLength(MAX_HEURISTIC_NODES);
    expectConnected(g);

    const [goal, summary, firstKept] = g.nodes;
    expect(goal?.kind).toBe("goal");
    expect(goal?.turnIds).toEqual(["o1", "a1"]);
    expect(summary).toMatchObject({
      kind: "loop",
      badge: `EARLIER · ${hidden} STEPS`,
      title: `${hidden} earlier steps collapsed`,
      rounds: hidden,
      at: (hidden + 1) * 1000 + 500,
    });
    expect(summary?.desc).toContain("no-AI mode");
    expect(summary?.turnIds).toHaveLength(hidden * 2);
    expect(summary?.turnIds[0]).toBe("o2");
    expect(summary?.turnIds.at(-1)).toBe(`a${hidden + 1}`);
    expect(g.nodes.filter((n) => n.badge.startsWith("EARLIER"))).toHaveLength(1);

    // The kept steps are the most recent ones, in order, ending with the latest exchange.
    expect(g.nodes.slice(2).map((n) => n.turnIds[0])).toEqual(
      Array.from({ length: MAX_HEURISTIC_NODES - 2 }, (_, i) => `o${hidden + 2 + i}`),
    );
    expect(g.nodes.at(-1)?.badge).toBe("LATEST OUTCOME");

    // goal -> summary -> first kept step, and nothing else leaves the goal.
    expect(g.edges.filter((e) => e.from === goal?.id).map((e) => e.to)).toEqual([summary?.id ?? ""]);
    expect(g.edges.filter((e) => e.from === summary?.id).map((e) => e.to)).toEqual([firstKept?.id ?? ""]);
    expect(g.edges).toHaveLength(MAX_HEURISTIC_NODES - 1);
  });

  test("a capped session with branches, pivots, loops, and agent-only turns stays connected", () => {
    const turns: Turn[] = [];
    const add = (id: string, author: Turn["author"], text: string, openedBy?: string) => {
      turns.push(turn({ id, author, at: (turns.length + 1) * 1000, text, openedBy }));
    };
    const rounds = 80;
    for (let i = 1; i <= rounds; i++) {
      // Spine step (the very first one is the goal).
      add(`p${i}`, "owner", `Build feature ${i} for the importer.`);
      add(`pa${i}`, "agent", `Feature ${i} is built.`, `p${i}`);
      // Side question.
      add(`q${i}`, "owner", `what is the status of module ${i}?`);
      add(`qa${i}`, "agent", `Module ${i} is idle.`, `q${i}`);
      // Rejection with a pivot (two nodes), then a rejection nobody answered.
      add(`r${i}`, "owner", `That is wrong, use approach ${i} instead.`);
      add(`ra${i}`, "agent", `Switched to approach ${i}.`, `r${i}`);
      add(`n${i}`, "owner", `never touch table ${i}`);
      // Check loop, agent-only update, polling noise.
      add(`k${i}a`, "owner", "chk agn");
      add(`ka${i}a`, "agent", `Round ${i}: 2 issues left.`, `k${i}a`);
      add(`k${i}b`, "owner", "chk now");
      add(`ka${i}b`, "agent", `Round ${i}: 1 issue left.`, `k${i}b`);
      add(`u${i}`, "agent", `Background job ${i} finished.`);
      add(`s${i}a`, "agent", "Still stuck on CI variable.");
      add(`s${i}b`, "agent", "Nothing has changed.");
    }
    const uncapped = rounds * 8;
    const hidden = uncapped - (MAX_HEURISTIC_NODES - 1);

    const g = buildHeuristicGraph(turns, "Importer session");
    expect(g.title).toBe("Importer session");
    expect(g.nodes).toHaveLength(MAX_HEURISTIC_NODES);
    expectConnected(g);
    for (const kind of ["side", "rejected", "decision", "loop"] as const) {
      expect(g.nodes.slice(2).some((n) => n.kind === kind)).toBe(true);
    }

    const summaries = g.nodes.filter((n) => n.badge.startsWith("EARLIER"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toBe(g.nodes[1]);
    expect(summaries[0]?.rounds).toBe(hidden);
    expect(new Set(summaries[0]?.turnIds).size).toBe(summaries[0]?.turnIds.length ?? -1);
    expect(g.edges.filter((e) => e.from === g.nodes[0]?.id).map((e) => e.to)).toEqual([summaries[0]?.id ?? ""]);
    expect(g.nodes.at(-1)?.turnIds).toEqual([`s${rounds}a`, `s${rounds}b`]);
  });
});
