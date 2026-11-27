import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionGraph } from "./model";

/**
 * Computes the per-session append-only JSONL state file path under XDG_STATE_HOME.
 *
 * Args:
 *     harness (string): Harness identifier (e.g. "omp").
 *     key (string): Session key/id.
 *     env (NodeJS.ProcessEnv): Environment map for resolving XDG_STATE_HOME.
 *
 * Returns:
 *     string: Absolute path to the session's state JSONL file.
 */
export function storeFile(harness: string, key: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "intent-prompt-graph", harness, `${key}.jsonl`);
}

export interface Store {
  readonly file: string;
  /** Latest persisted LLM SessionGraph, if any. */
  graph: SessionGraph | undefined;
  /** Turn IDs already processed by the persisted LLM graph. */
  readonly processedTurnIds: Set<string>;
  /** Appends a new validated LLM graph snapshot and its covered turn IDs. */
  saveGraph(graph: SessionGraph, processedIds: Iterable<string>): void;
}

interface GraphRecord {
  t: "graph";
  graph: SessionGraph;
  processedTurnIds: string[];
}

/**
 * Parses one JSONL line from the store file, ignoring corrupt or legacy intent/label lines.
 *
 * Args:
 *     line (string): Single line from the store file.
 *
 * Returns:
 *     GraphRecord | undefined: Parsed graph record or undefined if not a valid graph line.
 */
function parseLine(line: string): GraphRecord | undefined {
  if (!line.trim()) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof v !== "object" || v === null) return undefined;
  const rec = v as Record<string, unknown>;
  if (rec.t !== "graph") return undefined;
  if (typeof rec.graph !== "object" || rec.graph === null) return undefined;
  const g = rec.graph as Record<string, unknown>;
  if (typeof g.title !== "string" || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return undefined;
  const processedTurnIds = Array.isArray(rec.processedTurnIds)
    ? rec.processedTurnIds.filter((x): x is string => typeof x === "string")
    : [];
  return {
    t: "graph",
    graph: rec.graph as SessionGraph,
    processedTurnIds,
  };
}

/**
 * Opens or initializes the per-session append-only graph store.
 *
 * Args:
 *     harness (string): Harness identifier.
 *     key (string): Session key/id.
 *     env (NodeJS.ProcessEnv): Environment map for resolving XDG_STATE_HOME.
 *
 * Returns:
 *     Store: Store handle with replayed graph state and saveGraph() writer.
 */
export function openStore(harness: string, key: string, env: NodeJS.ProcessEnv = process.env): Store {
  const file = storeFile(harness, key, env);
  let graph: SessionGraph | undefined;
  const processedTurnIds = new Set<string>();
  let needsNewline = false;

  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const rec = parseLine(line);
      if (!rec) continue;
      graph = rec.graph;
      for (const id of rec.processedTurnIds) processedTurnIds.add(id);
    }
    needsNewline = text.length > 0 && !text.endsWith("\n");
  }

  return {
    file,
    get graph() {
      return graph;
    },
    set graph(next) {
      graph = next;
    },
    processedTurnIds,
    saveGraph(nextGraph, ids) {
      for (const id of ids) processedTurnIds.add(id);
      graph = nextGraph;
      const record: GraphRecord = {
        t: "graph",
        graph: nextGraph,
        processedTurnIds: [...processedTurnIds],
      };
      const out = `${needsNewline ? "\n" : ""}${JSON.stringify(record)}\n`;
      // Graphs summarize private sessions: only the owner may read them, also when the
      // directory and file were created by a version that left them world-readable.
      const dir = dirname(file);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(file, out, { mode: 0o600 });
      for (const path of [dirname(dir), dir]) chmodSync(path, 0o700);
      chmodSync(file, 0o600);
      needsNewline = false;
    },
  };
}
