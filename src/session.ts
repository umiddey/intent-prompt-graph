import { isLabelerConfigured, type Config } from "./config";
import type { Harness, SessionRef } from "./harness/harness";
import { buildHeuristicGraph } from "./heuristic";
import { extractGraph, payloadText, redactTurn, type GraphExtractInput } from "./labeler";
import type { ServerEvent, SessionGraph, Turn } from "./model";
import { openStore } from "./store";
import { tailJsonl, type TailEvent } from "./tail";

export const BATCH_TURNS = 16;
export const BATCH_CHARS = 12_000;
export const RETRY_MS = 60_000;
/** A graph is tidied up when it has this many nodes more than its target size. */
export const CONSOLIDATE_SLACK = 6;

/**
 * Node budget for a session: about one node per three turns, never under 12 or over 40.
 *
 * Args:
 *     turnCount (number): Number of turns the graph covers.
 *
 * Returns:
 *     number: Target node count.
 */
export function targetNodes(turnCount: number): number {
  return Math.min(40, Math.max(12, Math.round(turnCount / 3)));
}

export type SnapshotEvent = Extract<ServerEvent, { type: "snapshot" }>;

export interface Session {
  snapshot(): SnapshotEvent;
  /** Returns an unsubscribe function. */
  subscribe(fn: (ev: ServerEvent) => void): () => void;
  stop(): void;
}

/**
 * Opens one live session pipeline: tails the transcript, emits each turn immediately (I1),
 * builds an instant heuristic Decision & Path Graph, and asynchronously upgrades it via the
 * configured LLM extractor when available.
 *
 * Args:
 *     opts ({ harness: Harness; ref: SessionRef; config: Config }): Session dependencies.
 *
 * Returns:
 *     Promise<Session>: Live session handle with snapshot(), subscribe(), and stop().
 */
export async function openSession(opts: { harness: Harness; ref: SessionRef; config: Config }): Promise<Session> {
  const { harness, ref, config } = opts;
  const store = openStore(harness.id, ref.key);
  const labelerCfg = config.labeler ?? {};
  const llmEnabled = isLabelerConfigured(config.labeler);
  const turns = new Map<string, Turn>();
  const subs = new Set<(ev: ServerEvent) => void>();
  let reader = harness.reader(ref, { config });
  let busy = false;
  let stopped = false;
  let ready = false;
  let labelerError: string | undefined;
  let retry: Timer | undefined;
  /** Node count at the last tidy-up attempt; 0 before the first one. */
  let consolidatedAt = 0;
  let heuristicGraph: SessionGraph = buildHeuristicGraph([], ref.title);

  const emit = (ev: ServerEvent) => {
    for (const fn of subs) fn(ev);
  };

  /** Returns the active graph: persisted LLM graph when available, otherwise the live heuristic graph. */
  function currentGraph(): SessionGraph {
    if (store.graph && store.graph.nodes.length > 0) return store.graph;
    return heuristicGraph;
  }

  function refreshHeuristic(shouldEmit: boolean): void {
    heuristicGraph = buildHeuristicGraph([...turns.values()], ref.title);
    if (shouldEmit && !store.graph) {
      emit({ type: "graph", graph: heuristicGraph });
    }
  }

  function setLabelerError(error: string | undefined): void {
    if (error === undefined) {
      clearTimeout(retry);
      retry = undefined;
    }
    if (error === labelerError) return;
    labelerError = error;
    emit(error === undefined ? { type: "labeler" } : { type: "labeler", error });
  }

  function scheduleRetry(): void {
    clearTimeout(retry);
    retry = setTimeout(() => {
      retry = undefined;
      void drain();
    }, RETRY_MS);
    retry.unref();
  }

  /** Collects the next batch of closed, unprocessed turns in file order. */
  function nextBatch(): Turn[] {
    const batch: Turn[] = [];
    let chars = 0;
    for (const turn of turns.values()) {
      if (turn.open) break;
      if (store.processedTurnIds.has(turn.id)) continue;
      const size = payloadText(turn).length;
      if (batch.length > 0 && (batch.length >= BATCH_TURNS || chars + size > BATCH_CHARS)) break;
      batch.push(turn);
      chars += size;
    }
    return batch;
  }

  function buildInput(batch: Turn[]): GraphExtractInput {
    const input: GraphExtractInput = {
      sessionTitle: ref.title,
      turns: batch.map(redactTurn),
    };
    if (store.graph) {
      // Outline only: the reply is a patch that the labeler merges into store.graph locally.
      input.existingGraph = {
        title: store.graph.title,
        nodes: store.graph.nodes.map((n) => ({
          id: n.id,
          kind: n.kind,
          title: n.title,
          ...(n.rounds !== undefined ? { rounds: n.rounds } : {}),
        })),
        edges: store.graph.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
      };
    }
    return input;
  }

  function timestampsMap(): Map<string, number> {
    const map = new Map<string, number>();
    for (const [id, t] of turns) map.set(id, t.at);
    return map;
  }

  async function extractFrom(batch: Turn[]): Promise<void> {
    if (batch.length === 0 || stopped) return;
    const graph = await extractGraph(labelerCfg, buildInput(batch), timestampsMap(), store.graph);
    if (stopped) return;
    store.saveGraph(graph, batch.map((t) => t.id));
    setLabelerError(undefined);
    emit({ type: "graph", graph });
    return extractFrom(nextBatch());
  }

  /**
   * Asks the labeler to fold nodes together when the graph has outgrown its budget. Runs again only
   * after the graph has grown by another CONSOLIDATE_SLACK nodes, so a reply that merges too little
   * is not retried on every turn. A failed tidy-up keeps the graph as it is.
   */
  async function consolidate(): Promise<void> {
    const before = store.graph;
    if (!before || stopped) return;
    const target = targetNodes(store.processedTurnIds.size);
    if (before.nodes.length < Math.max(target, consolidatedAt) + CONSOLIDATE_SLACK) return;
    consolidatedAt = before.nodes.length;
    let graph: SessionGraph;
    try {
      const input: GraphExtractInput = { ...buildInput([]), consolidate: { targetNodes: target } };
      graph = await extractGraph(labelerCfg, input, timestampsMap(), before);
    } catch {
      return;
    }
    if (stopped || graph.nodes.length >= before.nodes.length) return;
    consolidatedAt = graph.nodes.length;
    store.saveGraph(graph, []);
    emit({ type: "graph", graph });
  }

  async function drain(): Promise<void> {
    if (!llmEnabled || busy || stopped) return;
    busy = true;
    try {
      await extractFrom(nextBatch());
      await consolidate();
    } catch (err) {
      if (stopped) return;
      setLabelerError(err instanceof Error ? err.message : String(err));
      scheduleRetry();
    } finally {
      busy = false;
    }
  }

  const onTail = (ev: TailEvent) => {
    if (stopped) return;
    if (ev.type === "reset") {
      turns.clear();
      reader = harness.reader(ref, { config });
      ready = false;
      emit({ type: "reset" });
      setImmediate(() => {
        ready = true;
        refreshHeuristic(true);
        if (store.graph) emit({ type: "graph", graph: store.graph });
        void drain();
      });
      return;
    }
    let changed = false;
    for (const turn of reader.push(ev.record)) {
      turns.set(turn.id, turn);
      emit({ type: "turn", turn });
      changed = true;
    }
    if (ready && changed) {
      refreshHeuristic(true);
      void drain();
    }
  };

  const tail = await tailJsonl(ref.file, onTail, { follow: true });
  ready = true;
  refreshHeuristic(false);
  void drain();

  return {
    snapshot: () => ({
      type: "snapshot",
      session: ref.key,
      turns: [...turns.values()],
      graph: currentGraph(),
      labelerError,
    }),
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    stop() {
      stopped = true;
      tail.stop();
      clearTimeout(retry);
      subs.clear();
    },
  };
}
