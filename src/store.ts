import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { KINDS } from "./labeler";
import type { Intent, Kind, Label } from "./model";

export function storeFile(harness: string, key: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "intent-prompt-graph", harness, `${key}.jsonl`);
}

export interface Store {
  readonly file: string;
  /** Intents in creation order. Read-only to callers; grows only through commit(). */
  readonly intents: Intent[];
  /** Labels keyed by turn id. Labels are immutable once stored. */
  readonly labels: Map<string, Label>;
  /** Appends one batch in a single write. Labels for turns already stored are dropped (labels are immutable). */
  commit(intents: Intent[], labels: Label[]): void;
}

type Line = ({ t: "intent" } & Intent) | ({ t: "label" } & Label);

const ALL_KINDS: readonly Kind[] = Object.values(KINDS).flat();

function parseLine(line: string): Line | undefined {
  if (!line.trim()) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    // A corrupt or partially written line is skipped.
    return undefined;
  }
  if (typeof v !== "object" || v === null) return undefined;
  if (
    "t" in v &&
    v.t === "intent" &&
    "id" in v &&
    typeof v.id === "string" &&
    "title" in v &&
    typeof v.title === "string" &&
    "createdAt" in v &&
    typeof v.createdAt === "number"
  ) {
    return { t: "intent", id: v.id, title: v.title, createdAt: v.createdAt };
  }
  if (
    "t" in v &&
    v.t === "label" &&
    "turnId" in v &&
    typeof v.turnId === "string" &&
    "intentId" in v &&
    typeof v.intentId === "string" &&
    "kind" in v &&
    "caption" in v &&
    typeof v.caption === "string"
  ) {
    const raw = v.kind;
    const kind = ALL_KINDS.find((k) => k === raw);
    if (kind === undefined) return undefined;
    return { t: "label", turnId: v.turnId, intentId: v.intentId, kind, caption: v.caption };
  }
  return undefined;
}

export function openStore(harness: string, key: string, env: NodeJS.ProcessEnv = process.env): Store {
  const file = storeFile(harness, key, env);
  const intents: Intent[] = [];
  const labels = new Map<string, Label>();
  let needsNewline = false;

  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const rec = parseLine(line);
      if (!rec) continue;
      if (rec.t === "intent") intents.push({ id: rec.id, title: rec.title, createdAt: rec.createdAt });
      else if (!labels.has(rec.turnId)) {
        labels.set(rec.turnId, { turnId: rec.turnId, intentId: rec.intentId, kind: rec.kind, caption: rec.caption });
      }
    }
    needsNewline = text.length > 0 && !text.endsWith("\n");
  }

  return {
    file,
    intents,
    labels,
    commit(newIntents, newLabels) {
      const fresh: Label[] = [];
      const seen = new Set<string>();
      for (const label of newLabels) {
        if (labels.has(label.turnId) || seen.has(label.turnId)) continue;
        seen.add(label.turnId);
        fresh.push(label);
      }
      if (newIntents.length === 0 && fresh.length === 0) return;

      let out = needsNewline ? "\n" : "";
      for (const intent of newIntents) out += JSON.stringify({ t: "intent", ...intent }) + "\n";
      for (const label of fresh) out += JSON.stringify({ t: "label", ...label }) + "\n";

      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, out);
      needsNewline = false;
      intents.push(...newIntents);
      for (const label of fresh) labels.set(label.turnId, label);
    },
  };
}
