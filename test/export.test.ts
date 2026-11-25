import { describe, expect, test } from "bun:test";
import { renderDecisionLog } from "../src/export";
import type { GraphNode, SessionGraph } from "../src/model";

function node(partial: Partial<GraphNode> & Pick<GraphNode, "id" | "kind" | "title">): GraphNode {
  return {
    badge: "BADGE",
    desc: `${partial.title} desc`,
    rationaleLabel: "Why",
    rationale: `${partial.title} rationale`,
    turnIds: [],
    at: 1000,
    ...partial,
  };
}

function graph(nodes: GraphNode[], mode: SessionGraph["mode"] = "llm"): SessionGraph {
  return { title: "Reuse existing code", nodes, edges: [], mode };
}

const EVERY_KIND: GraphNode[] = [
  node({ id: "g", kind: "goal", title: "Stop duplicate code", desc: "Agents rebuild what main already has." }),
  node({ id: "o", kind: "option", title: "Six guards", rationale: "Owner wanted a map first." }),
  node({ id: "d1", kind: "decision", title: "Use an existing map tool", rationale: "No tool of our own to maintain." }),
  node({ id: "r", kind: "rejected", title: "Commit-time check", rationale: "Runs after the tokens are spent." }),
  node({ id: "c1", kind: "chosen", title: "Pre-plan script", rationale: "Runs before planning." }),
  node({ id: "l", kind: "loop", title: "status poll", rounds: 14 }),
  node({ id: "s", kind: "side", title: "What is gross rent?" }),
  node({ id: "d2", kind: "decision", title: "Reuse section is mandatory", rationale: "The template enforces it." }),
  node({ id: "c2", kind: "chosen", title: "Save-time hook", rationale: "Catches a missing section early." }),
];

describe("renderDecisionLog", () => {
  test("renders every section in layout order, nodes in graph order, with the source last", () => {
    expect(renderDecisionLog(graph(EVERY_KIND))).toBe(
      [
        "# Reuse existing code",
        "",
        "## Goal",
        "**Stop duplicate code** — Agents rebuild what main already has.",
        "",
        "## Chosen",
        "- **Pre-plan script** — Runs before planning.",
        "- **Save-time hook** — Catches a missing section early.",
        "",
        "## Rejected",
        "- **Six guards** (not chosen) — Owner wanted a map first.",
        "- **Commit-time check** — Runs after the tokens are spent.",
        "",
        "## Decisions",
        "- **Use an existing map tool** — No tool of our own to maintain.",
        "- **Reuse section is mandatory** — The template enforces it.",
        "",
        "## Loops",
        "- status poll × 14",
        "",
        "Source: LLM graph",
        "",
      ].join("\n"),
    );
  });

  test("leaves side nodes out of the log", () => {
    expect(renderDecisionLog(graph(EVERY_KIND))).not.toContain("gross rent");
  });

  test("omits sections that have no nodes and names the heuristic source", () => {
    const g = graph(
      [
        node({ id: "g", kind: "goal", title: "Fix the build", desc: "The import path is wrong." }),
        node({ id: "c", kind: "chosen", title: "Correct the path", rationale: "Smallest change." }),
      ],
      "heuristic",
    );
    expect(renderDecisionLog(g)).toBe(
      [
        "# Reuse existing code",
        "",
        "## Goal",
        "**Fix the build** — The import path is wrong.",
        "",
        "## Chosen",
        "- **Correct the path** — Smallest change.",
        "",
        "Source: heuristic outline (no labeler)",
        "",
      ].join("\n"),
    );
  });

  test("a graph with no nodes renders only the title and the source", () => {
    expect(renderDecisionLog(graph([], "heuristic"))).toBe(
      "# Reuse existing code\n\nSource: heuristic outline (no labeler)\n",
    );
  });

  test("a loop without a round count has no multiplier", () => {
    const out = renderDecisionLog(graph([node({ id: "l", kind: "loop", title: "review loop" })]));
    expect(out).toContain("## Loops\n- review loop\n");
  });

  test("only: rejected returns the lead line and one bullet per rejected node", () => {
    const g = graph([
      ...EVERY_KIND,
      node({ id: "r2", kind: "rejected", title: "Planner agents", rationale: "Six of eight runs failed." }),
    ]);
    expect(renderDecisionLog(g, { only: "rejected" })).toBe(
      [
        "Already rejected in this session; do not propose again:",
        "- **Commit-time check** — Runs after the tokens are spent.",
        "- **Planner agents** — Six of eight runs failed.",
        "",
      ].join("\n"),
    );
  });

  test("only: rejected returns an empty string when nothing was rejected", () => {
    const withoutRejected = EVERY_KIND.filter((n) => n.kind !== "rejected");
    expect(renderDecisionLog(graph(withoutRejected), { only: "rejected" })).toBe("");
    expect(renderDecisionLog(graph([]), { only: "rejected" })).toBe("");
  });

  test("a multi-line rationale stays one bullet", () => {
    const g = graph([
      node({
        id: "r",
        kind: "rejected",
        title: "Scan only\nchanged files",
        rationale: "Routes depend on other files.\n\n- prefixes\r\n- models\n",
      }),
    ]);
    const bullet = "- **Scan only changed files** — Routes depend on other files. - prefixes - models";
    expect(renderDecisionLog(g, { only: "rejected" }).split("\n")).toEqual([
      "Already rejected in this session; do not propose again:",
      bullet,
      "",
    ]);
    expect(renderDecisionLog(g)).toContain(`## Rejected\n${bullet}\n\nSource:`);
  });

  test("a bullet falls back to the description when the rationale is empty", () => {
    const g = graph([node({ id: "c", kind: "chosen", title: "Ship it", rationale: "", desc: "Merged to main." })]);
    expect(renderDecisionLog(g)).toContain("- **Ship it** — Merged to main.");
  });
});
