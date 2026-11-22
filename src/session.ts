import type { Config } from "./config";
import type { Harness, SessionRef } from "./harness/harness";
import {
  batchTurn,
  label,
  MAX_INTENTS_IN_PROMPT,
  payloadText,
  type IntentRef,
  type LabelInput,
  type OfferedIntent,
  type Parsed,
  type PriorTurn,
} from "./labeler";
import type { Intent, Label, ServerEvent, Turn } from "./model";
import { openStore } from "./store";
import { tailJsonl, type TailEvent } from "./tail";

export const BATCH_TURNS = 8;
export const BATCH_CHARS = 6000;
export const RETRY_MS = 60_000;
const PRIOR_TURNS = 3;
const CAPTIONS_PER_INTENT = 2;

export type SnapshotEvent = Extract<ServerEvent, { type: "snapshot" }>;

export interface Session {
  snapshot(): SnapshotEvent;
  /** Returns an unsubscribe function. */
  subscribe(fn: (ev: ServerEvent) => void): () => void;
  stop(): void;
}

/**
 * One live session: tails the transcript, emits each turn as it changes (I1), and labels closed turns in the background.
 * The labeler never blocks turn events. A failed batch stores nothing and retries on the next turn or after RETRY_MS.
 */
export async function openSession(opts: { harness: Harness; ref: SessionRef; config: Config }): Promise<Session> {
  const { harness, ref, config } = opts;
  const store = openStore(harness.id, ref.key);
  const labelerCfg = config.labeler ?? {};
  const turns = new Map<string, Turn>();
  const subs = new Set<(ev: ServerEvent) => void>();
  let reader = harness.reader(ref, { config });
  let busy = false;
  let stopped = false;
  let ready = false;
  let labelerError: string | undefined;
  let retry: Timer | undefined;

  const emit = (ev: ServerEvent) => {
    for (const fn of subs) fn(ev);
  };

  function setLabelerError(error: string | undefined) {
    if (error === undefined) {
      clearTimeout(retry);
      retry = undefined;
    }
    if (error === labelerError) return;
    labelerError = error;
    emit(error === undefined ? { type: "labeler" } : { type: "labeler", error });
  }

  function scheduleRetry() {
    clearTimeout(retry);
    retry = setTimeout(() => {
      retry = undefined;
      void drain();
    }, RETRY_MS);
    retry.unref();
  }

  /** The intent a turn inherits from its owner's label, if any (agent turns only). */
  function fixedFor(turn: Turn): string | undefined {
    if (turn.author !== "agent" || !turn.openedBy) return undefined;
    return store.labels.get(turn.openedBy)?.intentId;
  }

  /** Closed, unlabeled turns in file order, stopping at the first open turn. Never splits an owner from its agent turn. */
  function nextBatch(): Turn[] {
    const batch: Turn[] = [];
    const ids = new Set<string>();
    let chars = 0;
    for (const turn of turns.values()) {
      if (turn.open) break;
      if (store.labels.has(turn.id)) continue;
      if (turn.author === "agent" && turn.openedBy !== undefined && ids.has(turn.openedBy)) break;
      const size = payloadText(turn).length;
      if (batch.length > 0 && (batch.length >= BATCH_TURNS || chars + size > BATCH_CHARS)) break;
      batch.push(turn);
      ids.add(turn.id);
      chars += size;
    }
    return batch;
  }

  /** Intents ranked by their most recent labeled turn, with their last captions in chronological order. */
  function offerIntents(): OfferedIntent[] {
    const pos = new Map<string, number>();
    let n = 0;
    for (const id of turns.keys()) pos.set(id, n++);
    const groups = new Map<string, { last: number; items: { pos: number; caption: string }[] }>();
    for (const l of store.labels.values()) {
      const p = pos.get(l.turnId) ?? -1;
      let g = groups.get(l.intentId);
      if (g === undefined) {
        g = { last: -1, items: [] };
        groups.set(l.intentId, g);
      }
      g.last = Math.max(g.last, p);
      g.items.push({ pos: p, caption: l.caption });
    }
    const titles = new Map(store.intents.map((i) => [i.id, i.title]));
    return [...groups.entries()]
      .toSorted((a, b) => b[1].last - a[1].last)
      .slice(0, MAX_INTENTS_IN_PROMPT)
      .map(([id, g]) => ({
        id,
        title: titles.get(id) ?? id,
        captions: g.items
          .toSorted((a, b) => a.pos - b.pos)
          .slice(-CAPTIONS_PER_INTENT)
          .map((x) => x.caption),
      }));
  }

  /** The labeled turns just before the batch, oldest first. */
  function priorTurns(first: Turn): PriorTurn[] {
    const ids = [...turns.keys()];
    const out: PriorTurn[] = [];
    for (let k = ids.indexOf(first.id) - 1; k >= 0 && out.length < PRIOR_TURNS; k--) {
      const id = ids[k];
      if (id === undefined) continue;
      const l = store.labels.get(id);
      const t = turns.get(id);
      if (!l || !t) continue;
      out.push({ author: t.author, kind: l.kind, caption: l.caption });
    }
    return out.toReversed();
  }

  function buildInput(batch: Turn[]): LabelInput {
    const first = batch[0];
    return {
      intents: offerIntents(),
      before: first ? priorTurns(first) : [],
      turns: batch.map((turn) => batchTurn(turn, fixedFor(turn))),
    };
  }

  /** Stores a validated batch and emits its new intents and labels. */
  function commit(batch: Turn[], parsed: Parsed): void {
    const answers = new Map(parsed.answers.map((a) => [a.ref, a]));
    const minted = new Map<string, string>();
    const newIntents: Intent[] = [];
    const newLabels: Label[] = [];
    let seq = store.intents.reduce((max, i) => Math.max(max, Number(i.id.slice(1)) || 0), 0);

    for (const turn of batch) {
      const answer = answers.get(turn.id);
      if (answer === undefined) throw new Error(`internal: no answer for turn ${turn.id}`);
      let intentId: string;
      const intent: IntentRef = answer.intent;
      if ("id" in intent) {
        intentId = intent.id;
      } else {
        const existing = minted.get(intent.local);
        if (existing !== undefined) {
          intentId = existing;
        } else {
          const title = parsed.newTitles.get(intent.local);
          if (title === undefined) throw new Error(`internal: no title for intent ${intent.local}`);
          seq += 1;
          intentId = `i${seq}`;
          minted.set(intent.local, intentId);
          newIntents.push({ id: intentId, title, createdAt: turn.at });
        }
      }
      newLabels.push({ turnId: turn.id, intentId, kind: answer.kind, caption: answer.caption });
    }

    store.commit(newIntents, newLabels);
    for (const intent of newIntents) emit({ type: "intent", intent });
    for (const l of newLabels) emit({ type: "label", label: l });
  }

  /** Labels batches until none remain. Recursion, not a loop, so each await stays on its own call. */
  async function labelFrom(batch: Turn[]): Promise<void> {
    if (batch.length === 0 || stopped) return;
    const parsed = await label(labelerCfg, buildInput(batch));
    if (stopped) return;
    commit(batch, parsed);
    setLabelerError(undefined);
    return labelFrom(nextBatch());
  }

  async function drain(): Promise<void> {
    if (busy || stopped) return;
    busy = true;
    try {
      await labelFrom(nextBatch());
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
      // The tail replays the file from byte 0 synchronously. Labeling resumes after that replay, so it does not rescan per record.
      turns.clear();
      reader = harness.reader(ref, { config });
      ready = false;
      setImmediate(() => {
        ready = true;
        void drain();
      });
      emit({ type: "reset" });
      for (const intent of store.intents) emit({ type: "intent", intent });
      for (const l of store.labels.values()) emit({ type: "label", label: l });
      return;
    }
    for (const turn of reader.push(ev.record)) {
      turns.set(turn.id, turn);
      emit({ type: "turn", turn });
    }
    if (ready) void drain();
  };

  const tail = await tailJsonl(ref.file, onTail, { follow: true });
  ready = true;
  void drain();

  return {
    snapshot: () => ({
      type: "snapshot",
      session: ref.key,
      turns: [...turns.values()],
      intents: [...store.intents],
      labels: [...store.labels.values()],
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
