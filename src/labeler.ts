import type { LabelerConfig } from "./config";
import type { Author, Kind, Turn } from "./model";

export const MAX_INTENTS_IN_PROMPT = 40;
export const OWNER_CHARS = 800;
export const AGENT_CHARS = 1200;
export const TRIGGER_CHARS = 400;
export const CAPTION_CHARS = 120;
export const TITLE_CHARS = 80;
export const GUEST_PLACEHOLDER = "[guest message withheld]";
export const TIMEOUT_MS = 60_000;

export const KINDS: Record<Author, readonly Kind[]> = {
  owner: ["asked", "approved"],
  agent: ["found", "did", "advises", "asked"],
};

export interface OfferedIntent {
  id: string;
  title: string;
  captions: string[];
}

export interface PriorTurn {
  author: Author;
  kind: Kind;
  caption: string;
}

export interface BatchTurn {
  ref: string;
  author: Author;
  guest?: true;
  text?: string;
  tools?: Record<string, number>;
  fixedIntent?: string;
  trigger?: { from: "owner"; text: string };
}

export interface LabelInput {
  intents: OfferedIntent[];
  before: PriorTurn[];
  turns: BatchTurn[];
}

export type IntentRef = { id: string } | { local: string };

export interface Answer {
  ref: string;
  intent: IntentRef;
  kind: Kind;
  caption: string;
}

export interface Parsed {
  answers: Answer[];
  /** Intents this batch declared as new, keyed by the model's local name ("nK"). */
  newTitles: Map<string, string>;
}

const SYSTEM_PROMPT = `You label turns of a conversation between a human owner and a coding agent.

For every turn in "turns" return one answer:
- "ref": the turn's ref, exactly as given.
- "kind": owner turns use "asked" or "approved". Agent turns use "found", "did", "advises" or "asked".
- "caption": a short plain summary of the turn, at most 14 words.
- "intent": the topic the turn belongs to. Turns with a "fixedIntent" field already have their topic, so omit "intent" for them.
  - Reuse an id from "intents" when the turn continues that same topic.
  - Otherwise start a new topic: {"new": "nK", "title": "..."} with a title of at most 6 words. K counts from 1.
  - A later turn in this batch may reuse a topic you declared earlier in the batch by writing its name as the string "nK". Never declare the same "nK" twice.

"before" lists the labeled turns just before this batch, for context only. Answer every turn in "turns" exactly once.

Reply with JSON only, in the form {"turns":[{"ref":"...","kind":"...","caption":"...","intent":...}]}.`;

export function systemPrompt(): string {
  return SYSTEM_PROMPT;
}

function visibleText(turn: Turn): string {
  if (turn.guest) return GUEST_PLACEHOLDER;
  if (turn.author === "owner") return turn.text.slice(0, OWNER_CHARS);
  return turn.text.slice(-AGENT_CHARS);
}

/** Exactly the text this turn contributes to the labeler input. Batch budgets count these characters. */
export function payloadText(turn: Turn): string {
  const trigger = turn.trigger?.from === "owner" ? turn.trigger.text.slice(0, TRIGGER_CHARS) : "";
  return visibleText(turn) + trigger;
}

function countTools(turn: Turn): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const action of turn.actions) counts[action.tool] = (counts[action.tool] ?? 0) + 1;
  return counts;
}

/** Builds the labeler's view of one turn. Only what I5 allows: capped text, tool names and counts, owner trigger text. */
export function batchTurn(turn: Turn, fixedIntent?: string): BatchTurn {
  const out: BatchTurn = { ref: turn.id, author: turn.author };
  if (turn.guest) out.guest = true;
  const text = visibleText(turn);
  if (text) out.text = text;
  if (turn.author === "agent") {
    out.tools = countTools(turn);
    if (fixedIntent !== undefined) out.fixedIntent = fixedIntent;
    if (turn.trigger?.from === "owner") out.trigger = { from: "owner", text: turn.trigger.text.slice(0, TRIGGER_CHARS) };
  }
  return out;
}

function bad(message: string): Error {
  return new Error(`labeler output: ${message}`);
}

/** Model output is untrusted: every field is narrowed at runtime before use. */
function resolveIntent(value: unknown, ref: string, offered: ReadonlySet<string>, newTitles: Map<string, string>): IntentRef {
  if (typeof value === "string") {
    if (newTitles.has(value)) return { local: value };
    if (offered.has(value)) return { id: value };
    throw bad(`unknown intent ${value} for turn ${ref}`);
  }
  if (typeof value === "object" && value !== null && "new" in value && typeof value.new === "string" && /^n\d+$/.test(value.new)) {
    const local = value.new;
    if (newTitles.has(local)) throw bad(`intent ${local} declared twice`);
    const title: unknown = "title" in value ? value.title : undefined;
    if (typeof title !== "string" || !title.trim()) throw bad(`intent ${local} has no title`);
    newTitles.set(local, title.trim().slice(0, TITLE_CHARS));
    return { local };
  }
  throw bad(`invalid intent for turn ${ref}`);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw bad("not valid JSON");
  }
}

/**
 * Validates the labeler's reply against the batch it answers. Any violation throws, and the caller stores nothing.
 * A turn that already inherits an intent (fixedIntent) gets {id: fixedIntent} regardless of what the model wrote.
 */
export function parseOutput(raw: string, input: LabelInput): Parsed {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const json = parseJson(text);
  const list: unknown = typeof json === "object" && json !== null && "turns" in json ? json.turns : undefined;
  if (!Array.isArray(list)) throw bad("no turns array");
  const entries: unknown[] = list;

  const byRef = new Map(input.turns.map((turn) => [turn.ref, turn]));
  const offered = new Set(input.intents.map((intent) => intent.id));
  const newTitles = new Map<string, string>();
  const answered = new Set<string>();
  const answers: Answer[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) throw bad("entry is not an object");
    const ref: unknown = "ref" in entry ? entry.ref : undefined;
    if (typeof ref !== "string") throw bad("entry has no ref");
    const turn = byRef.get(ref);
    if (!turn) throw bad(`unknown ref ${ref}`);
    if (answered.has(ref)) throw bad(`ref ${ref} answered twice`);
    answered.add(ref);

    const kindRaw: unknown = "kind" in entry ? entry.kind : undefined;
    const kind = KINDS[turn.author].find((k) => k === kindRaw);
    if (kind === undefined) throw bad(`kind not allowed for ${turn.author} turn ${ref}`);
    const captionRaw: unknown = "caption" in entry ? entry.caption : undefined;
    if (typeof captionRaw !== "string" || !captionRaw.trim()) throw bad(`empty caption for turn ${ref}`);
    const caption = captionRaw.trim().slice(0, CAPTION_CHARS);

    const intentRaw: unknown = "intent" in entry ? entry.intent : undefined;
    const intent: IntentRef =
      turn.fixedIntent !== undefined ? { id: turn.fixedIntent } : resolveIntent(intentRaw, ref, offered, newTitles);
    answers.push({ ref, intent, kind, caption });
  }

  const missing = input.turns.filter((turn) => !answered.has(turn.ref)).map((turn) => turn.ref);
  if (missing.length) throw bad(`missing answers for ${missing.join(", ")}`);
  return { answers, newTitles };
}

/** The assistant message text inside an OpenAI-style chat completion, or undefined if the shape is absent. */
function messageContent(body: unknown): unknown {
  if (typeof body !== "object" || body === null || !("choices" in body) || !Array.isArray(body.choices)) return undefined;
  const choices: unknown[] = body.choices;
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null || !("message" in first)) return undefined;
  const msg: unknown = first.message;
  if (typeof msg !== "object" || msg === null || !("content" in msg)) return undefined;
  return msg.content;
}

/** Calls the configured OpenAI-compatible endpoint and validates its reply. */
export async function label(cfg: LabelerConfig, input: LabelInput, env: NodeJS.ProcessEnv = process.env): Promise<Parsed> {
  if (!cfg.baseUrl || !cfg.model) {
    throw new Error("labeler not configured: set labeler.baseUrl and labeler.model in config.json");
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKeyEnv) {
    const key = env[cfg.apiKeyEnv];
    if (!key) throw new Error(`labeler.apiKeyEnv names ${cfg.apiKeyEnv}, which is not set`);
    headers.authorization = `Bearer ${key}`;
  }
  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: 1500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(input) },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`labeler HTTP ${res.status}: ${detail}`);
  }
  const content = messageContent(await res.json());
  if (typeof content !== "string") throw new Error("labeler response has no message content");
  return parseOutput(content, input);
}
