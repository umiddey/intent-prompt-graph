export type Author = "owner" | "agent";

export interface Action {
  tool: string;
  summary: string;
}

export type Trigger = { from: "owner"; text: string } | { from: "agent"; type: string };

export interface Turn {
  id: string;
  author: Author;
  at: number;
  text: string;
  actions: Action[];
  openedBy?: string;
  trigger?: Trigger;
  guest?: true;
  open: boolean;
}

/** Semantic node categories in the Decision & Path Graph. */
export type NodeKind = "goal" | "chosen" | "rejected" | "option" | "decision" | "loop" | "side";

/** Semantic edge categories connecting decision-graph nodes. */
export type EdgeKind = "chosen" | "rejected" | "option" | "decision" | "loop" | "side";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** Short uppercase tag shown in the node header (e.g. "ROOT PROBLEM", "KILLED BY OWNER"). */
  badge: string;
  title: string;
  desc: string;
  /** Heading for the inspector rationale box (e.g. "Why chosen", "Why rejected"). */
  rationaleLabel: string;
  rationale: string;
  /** Source turn IDs that produced this node. */
  turnIds: string[];
  /** Timestamp (ms) of the latest turn contributing to this node. */
  at: number;
  /** Number of collapsed rounds when kind === "loop". */
  rounds?: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
}

export interface SessionGraph {
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** "llm" when produced by the configured LLM extractor; "heuristic" for deterministic fallback. */
  mode: "llm" | "heuristic";
}

export type ServerEvent =
  | { type: "snapshot"; session: string; turns: Turn[]; graph: SessionGraph; labelerError?: string }
  | { type: "turn"; turn: Turn }
  | { type: "graph"; graph: SessionGraph }
  | { type: "labeler"; error?: string }
  | { type: "reset" };
