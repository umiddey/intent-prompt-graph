import type { GraphNode, NodeKind, SessionGraph } from "./model";

export interface DecisionLogOptions {
  /** "rejected" returns only the block meant to be pasted into an agent prompt. */
  only?: "rejected";
}

const REJECTED_LEAD = "Already rejected in this session; do not propose again:";

/** Collapses every whitespace run (newlines included) so the text stays on one markdown line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `**title** — detail`, or just the bold title when there is no detail. */
function entry(title: string, detail: string, mark = ""): string {
  const head = `**${oneLine(title)}**${mark}`;
  const tail = oneLine(detail);
  return tail ? `${head} — ${tail}` : head;
}

function bullet(node: GraphNode, mark = ""): string {
  return `- ${entry(node.title, node.rationale || node.desc, mark)}`;
}

/**
 * Renders a session graph as a markdown decision log: goal, chosen and rejected paths,
 * decisions and loops. Sections follow `graph.nodes` order and are omitted when empty.
 * `side` nodes are not part of the log.
 *
 * Args:
 *     graph (SessionGraph): The LLM or heuristic graph of one session.
 *     opts (DecisionLogOptions | undefined): `only: "rejected"` returns just a lead line plus one
 *         bullet per `rejected` node, to paste into an agent prompt.
 *
 * Returns:
 *     string: Markdown ending in a newline. Empty when `only: "rejected"` finds nothing rejected.
 */
export function renderDecisionLog(graph: SessionGraph, opts: DecisionLogOptions = {}): string {
  const byKind = (...kinds: NodeKind[]) => graph.nodes.filter((n) => kinds.includes(n.kind));

  if (opts.only === "rejected") {
    const rejected = byKind("rejected");
    if (rejected.length === 0) return "";
    return `${[REJECTED_LEAD, ...rejected.map((n) => bullet(n))].join("\n")}\n`;
  }

  const blocks: string[] = [`# ${oneLine(graph.title)}`];
  const section = (heading: string, lines: string[]) => {
    if (lines.length > 0) blocks.push(`## ${heading}\n${lines.join("\n")}`);
  };

  const goals = byKind("goal");
  // A lone goal reads as a sentence; several goals become a list so they stay apart.
  section(
    "Goal",
    goals.map((n) => (goals.length === 1 ? entry(n.title, n.desc) : `- ${entry(n.title, n.desc)}`)),
  );
  section("Chosen", byKind("chosen").map((n) => bullet(n)));
  section(
    "Rejected",
    byKind("rejected", "option").map((n) => bullet(n, n.kind === "option" ? " (not chosen)" : "")),
  );
  section("Decisions", byKind("decision").map((n) => bullet(n)));
  section(
    "Loops",
    byKind("loop").map((n) => `- ${oneLine(n.title)}${n.rounds === undefined ? "" : ` × ${n.rounds}`}`),
  );
  blocks.push(`Source: ${graph.mode === "llm" ? "LLM graph" : "heuristic outline (no labeler)"}`);
  return `${blocks.join("\n\n")}\n`;
}
