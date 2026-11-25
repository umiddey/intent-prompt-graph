import type { LabelerConfig } from "./config";
import type { Author, EdgeKind, GraphEdge, GraphNode, NodeKind, SessionGraph, Turn } from "./model";

export const OWNER_CHARS = 800;
export const AGENT_CHARS = 1200;
export const TRIGGER_CHARS = 400;
export const TITLE_CHARS = 100;
export const DESC_CHARS = 240;
export const RATIONALE_CHARS = 400;
export const BADGE_CHARS = 32;
export const EDGE_LABEL_CHARS = 40;
export const GUEST_PLACEHOLDER = "[guest message withheld]";
export const TIMEOUT_MS = 90_000;

export const NODE_KINDS: readonly NodeKind[] = ["goal", "chosen", "rejected", "option", "decision", "loop", "side"];
export const EDGE_KINDS: readonly EdgeKind[] = ["chosen", "rejected", "option", "decision", "loop", "side"];

export interface RedactedTurn {
  ref: string;
  author: Author;
  at: number;
  guest?: true;
  text?: string;
  tools?: Record<string, number>;
  openedBy?: string;
  trigger?: { from: "owner"; text: string };
}

export interface GraphExtractInput {
  sessionTitle?: string;
  /** Slim outline of the graph built so far; when present the model replies with a patch, not the full graph. */
  existingGraph?: {
    title: string;
    nodes: { id: string; kind: NodeKind; title: string; rounds?: number }[];
    edges: { from: string; to: string; kind: EdgeKind }[];
  };
  turns: RedactedTurn[];
}

const SYSTEM_PROMPT = `You convert a coding-agent conversation into a Decision & Path Graph (directed acyclic graph).

Your goal is to help the human owner understand the entire session in 5 seconds:
1. What problem/goal started the session ("goal")
2. What options/alternatives were proposed but NOT chosen ("option")
3. What paths or proposals were explicitly rejected or killed and WHY ("rejected")
4. What decisions, pivots, constraints, or course corrections happened ("decision")
5. What final paths, architectures, or fixes were chosen/verified ("chosen")
6. Repetitive check/review/polling loops collapsed into a single node ("loop", with "rounds")
7. Tangential clarifying questions branched off the main spine ("side")

Rules:
- Synthesize crisp, specific titles (<= 8 words). NEVER copy filler openers like "You're right", "Okay", "Not quite", or raw file paths as titles.
- When the owner rejects or pushes back on an agent proposal, mark the AGENT's rejected proposal as "rejected" (with the owner's objection as "rationale") and branch the owner's new direction as "decision" or "chosen".
- Merge repetitive back-and-forth checks (like "chk agn" / "chk now" or repeated CI/blocker status polls) into ONE "loop" node with all their turn refs in "turnIds" and an integer "rounds".
- Keep the graph concise and high-signal (typically 5-18 nodes). Do not create separate nodes for routine acknowledgements.
- Connect nodes with directed edges (from -> to) using kinds: "chosen", "rejected", "option", "decision", "loop", "side", with a short edge "label" (<= 4 words). Every non-goal node should be reachable from the goal.
- Without "existingGraph", return the complete first graph for the given turns.
- If "existingGraph" is provided, it outlines the graph built so far (node id, kind, title, rounds; edge from, to, kind). Reply with a PATCH for the new turns, NOT the whole graph: "nodes" holds ONLY nodes that are new or changed, and "edges" holds ONLY new edges. NEVER repeat an unchanged node. Nodes you leave out are kept exactly as they are; you cannot delete a node.
- To change an existing node, return its "id" plus ONLY the fields that change (e.g. "kind" with a matching "badge" and "rationaleLabel", or "rounds"). "turnIds" on a changed node lists only the newly added turn refs; they are added to the ones it already has.
- New nodes need ids not used in "existingGraph". New edges may connect new and existing node ids. To change the kind or label of an existing edge, return it again with the same "from" and "to".
- An empty "nodes" array is valid when the new turns add nothing to an existing graph.
- Every new node must include: "id", "kind", "badge" (2-3 uppercase words), "title" (<= 10 words), "desc" (1-2 concise sentences), "rationaleLabel" (e.g. "Why chosen" / "Why rejected"), "rationale" (clear concrete reason), "turnIds" (array of turn refs from the input).

Reply with raw JSON only (no markdown fences, no commentary before or after):
{"title":"...","nodes":[...],"edges":[{"from":"...","to":"...","kind":"...","label":"..."}]}`;

/**
 * Returns the system prompt used for LLM Decision & Path Graph extraction.
 *
 * Args:
 *     None
 *
 * Returns:
 *     string: The system prompt text.
 */
export function systemPrompt(): string {
  return SYSTEM_PROMPT;
}

/**
 * Extracts I5-compliant visible text from a turn (redacting guest text and capping lengths).
 *
 * Args:
 *     turn (Turn): Source turn from the transcript.
 *
 * Returns:
 *     string: Redacted and length-capped text safe to send to an external labeler.
 */
function visibleText(turn: Turn): string {
  if (turn.guest) return GUEST_PLACEHOLDER;
  if (turn.author === "owner") return turn.text.slice(0, OWNER_CHARS);
  return turn.text.slice(-AGENT_CHARS);
}

/**
 * Computes the exact text a turn contributes to the labeler payload for batch-size budgeting.
 *
 * Args:
 *     turn (Turn): Source turn.
 *
 * Returns:
 *     string: Concatenated visible text and owner-origin trigger text.
 */
export function payloadText(turn: Turn): string {
  const trigger = turn.trigger?.from === "owner" ? turn.trigger.text.slice(0, TRIGGER_CHARS) : "";
  return visibleText(turn) + trigger;
}

/**
 * Counts tool invocations by tool name without leaking tool arguments or outputs (I5).
 *
 * Args:
 *     turn (Turn): Agent turn containing actions.
 *
 * Returns:
 *     Record<string, number>: Map of tool name to call count.
 */
function countTools(turn: Turn): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const action of turn.actions) counts[action.tool] = (counts[action.tool] ?? 0) + 1;
  return counts;
}

/**
 * Builds an I5-compliant redacted representation of a single turn for the LLM extractor.
 *
 * Args:
 *     turn (Turn): Source turn.
 *
 * Returns:
 *     RedactedTurn: Redacted turn object with capped text, tool counts, and owner trigger only.
 */
export function redactTurn(turn: Turn): RedactedTurn {
  const out: RedactedTurn = { ref: turn.id, author: turn.author, at: turn.at };
  if (turn.guest) out.guest = true;
  const text = visibleText(turn);
  if (text) out.text = text;
  if (turn.author === "agent") {
    out.tools = countTools(turn);
    if (turn.openedBy) out.openedBy = turn.openedBy;
    if (turn.trigger?.from === "owner") out.trigger = { from: "owner", text: turn.trigger.text.slice(0, TRIGGER_CHARS) };
  }
  return out;
}

function bad(message: string): Error {
  return new Error(`labeler output: ${message}`);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Fall through to uniform error below.
      }
    }
    throw bad("not valid JSON");
  }
}

function optionalString(obj: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

function nonEmptyString(obj: Record<string, unknown>, key: string, max: number, fallback?: string): string {
  const v = optionalString(obj, key, max) ?? fallback;
  if (v === undefined) throw bad(`missing or empty string "${key}"`);
  return v;
}

function nodeKind(rec: Record<string, unknown>, id: string): NodeKind {
  const kind = NODE_KINDS.find((k) => k === rec.kind);
  if (!kind) throw bad(`invalid node kind for ${id}`);
  return kind;
}

function replyTurnIds(rec: Record<string, unknown>): string[] {
  const raw: unknown[] = Array.isArray(rec.turnIds) ? rec.turnIds : [];
  return raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

function replyRounds(rec: Record<string, unknown>): number | undefined {
  return typeof rec.rounds === "number" && Number.isInteger(rec.rounds) && rec.rounds > 1 ? rec.rounds : undefined;
}

/** Latest known timestamp among turnIds, never lower than floor. */
function latestAt(turnIds: readonly string[], turnTimestamps: ReadonlyMap<string, number>, floor: number): number {
  let at = floor;
  for (const tid of turnIds) {
    const ts = turnTimestamps.get(tid);
    if (ts !== undefined && ts > at) at = ts;
  }
  return at;
}

/**
 * Builds a node the graph does not have yet; every required field must be present or defaultable.
 *
 * Args:
 *     id (string): Validated node id.
 *     rec (Record<string, unknown>): Raw node object from the reply.
 *     turnTimestamps (ReadonlyMap<string, number>): Known turn timestamps keyed by turn id.
 *
 * Returns:
 *     GraphNode: Validated new node.
 */
function newNode(id: string, rec: Record<string, unknown>, turnTimestamps: ReadonlyMap<string, number>): GraphNode {
  const kind = nodeKind(rec, id);
  const title = nonEmptyString(rec, "title", TITLE_CHARS);
  const desc = nonEmptyString(rec, "desc", DESC_CHARS, title);
  const badge = nonEmptyString(rec, "badge", BADGE_CHARS, kind.toUpperCase());
  const rationaleLabel = nonEmptyString(rec, "rationaleLabel", 48, kind === "rejected" ? "Why rejected" : "Why chosen");
  const rationale = nonEmptyString(rec, "rationale", RATIONALE_CHARS, desc);
  const turnIds = replyTurnIds(rec);
  const node: GraphNode = { id, kind, badge, title, desc, rationaleLabel, rationale, turnIds, at: latestAt(turnIds, turnTimestamps, 0) };
  const rounds = replyRounds(rec);
  if (rounds !== undefined) node.rounds = rounds;
  return node;
}

/**
 * Applies a partial reply node to a node the graph already has. Omitted fields keep the old value,
 * turnIds are unioned (old order first) and `at` never moves backwards.
 *
 * Args:
 *     old (GraphNode): Node from the existing graph (not mutated).
 *     rec (Record<string, unknown>): Raw node object from the reply.
 *     turnTimestamps (ReadonlyMap<string, number>): Known turn timestamps keyed by turn id.
 *
 * Returns:
 *     GraphNode: Updated copy of the node.
 */
function updatedNode(old: GraphNode, rec: Record<string, unknown>, turnTimestamps: ReadonlyMap<string, number>): GraphNode {
  const turnIds = [...new Set([...old.turnIds, ...replyTurnIds(rec)])];
  const node: GraphNode = {
    id: old.id,
    kind: rec.kind === undefined ? old.kind : nodeKind(rec, old.id),
    badge: optionalString(rec, "badge", BADGE_CHARS) ?? old.badge,
    title: optionalString(rec, "title", TITLE_CHARS) ?? old.title,
    desc: optionalString(rec, "desc", DESC_CHARS) ?? old.desc,
    rationaleLabel: optionalString(rec, "rationaleLabel", 48) ?? old.rationaleLabel,
    rationale: optionalString(rec, "rationale", RATIONALE_CHARS) ?? old.rationale,
    turnIds,
    at: latestAt(turnIds, turnTimestamps, old.at),
  };
  const rounds = replyRounds(rec) ?? old.rounds;
  if (rounds !== undefined) node.rounds = rounds;
  return node;
}

/**
 * Validates the LLM's Decision & Path Graph JSON reply and merges it into the existing graph.
 * Without an existing graph the reply is the complete first graph. With one, the reply is a patch:
 * its nodes are added or partially update a node with the same id, its edges are added or replace
 * the kind/label of the existing edge with the same from+to. The reply can never delete anything.
 * Node errors throw so callers never commit corrupt graphs; an unusable edge is dropped on its own.
 *
 * Args:
 *     raw (string): Raw assistant message content (may be wrapped in a markdown code fence).
 *     turnTimestamps (ReadonlyMap<string, number>): Known turn timestamps keyed by turn id.
 *     existing (SessionGraph | undefined): Graph the reply patches (not mutated); omit for a first graph.
 *
 * Returns:
 *     SessionGraph: Validated, merged SessionGraph in "llm" mode.
 */
export function parseGraphOutput(raw: string, turnTimestamps: ReadonlyMap<string, number>, existing?: SessionGraph): SessionGraph {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const json = parseJson(text);
  if (typeof json !== "object" || json === null) throw bad("root is not an object");
  const root = json as Record<string, unknown>;

  if (!Array.isArray(root.nodes)) throw bad(existing ? "nodes must be an array" : "nodes must be a non-empty array");
  if (!existing && root.nodes.length === 0) throw bad("nodes must be a non-empty array");
  const rawEdges: unknown[] = Array.isArray(root.edges) ? root.edges : [];

  const title = optionalString(root, "title", TITLE_CHARS) ?? existing?.title ?? "Session Decision Graph";

  // Insertion-ordered: existing nodes keep their position, new nodes are appended.
  const byId = new Map<string, GraphNode>();
  for (const n of existing?.nodes ?? []) byId.set(n.id, n);
  const seenIds = new Set<string>();

  for (const item of root.nodes) {
    if (typeof item !== "object" || item === null) throw bad("node is not an object");
    const rec = item as Record<string, unknown>;
    const id = nonEmptyString(rec, "id", 48);
    if (seenIds.has(id)) throw bad(`duplicate node id ${id}`);
    seenIds.add(id);
    const old = byId.get(id);
    byId.set(id, old ? updatedNode(old, rec, turnTimestamps) : newNode(id, rec, turnTimestamps));
  }

  const edges: GraphEdge[] = existing ? [...existing.edges] : [];
  const pairKey = (from: string, to: string) => `${from}\u0000${to}`;
  const slotByPair = new Map<string, number>();
  const usedEdgeIds = new Set<string>();
  edges.forEach((e, slot) => {
    const key = pairKey(e.from, e.to);
    if (!slotByPair.has(key)) slotByPair.set(key, slot);
    usedEdgeIds.add(e.id);
  });

  let edgeSeq = edges.length;
  for (const item of rawEdges) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const from = optionalString(rec, "from", 48);
    const to = optionalString(rec, "to", 48);
    if (from === undefined || to === undefined || from === to) continue;
    if (!byId.has(from) || !byId.has(to)) continue;
    const kind = EDGE_KINDS.find((k) => k === rec.kind);
    if (!kind) continue;
    const label = optionalString(rec, "label", EDGE_LABEL_CHARS);

    const key = pairKey(from, to);
    const slot = slotByPair.get(key);
    let id = slot === undefined ? undefined : edges[slot]?.id;
    if (id === undefined) {
      do {
        id = `e${++edgeSeq}`;
      } while (usedEdgeIds.has(id));
      usedEdgeIds.add(id);
    }
    const edge: GraphEdge = { id, from, to, kind };
    if (label !== undefined) edge.label = label;
    if (slot === undefined) {
      slotByPair.set(key, edges.length);
      edges.push(edge);
    } else {
      edges[slot] = edge;
    }
  }

  return { title, nodes: [...byId.values()], edges, mode: "llm" };
}

/**
 * Extracts assistant message content from an OpenAI-compatible chat completion response.
 *
 * Args:
 *     body (unknown): Parsed JSON response body.
 *
 * Returns:
 *     unknown: The content string if present, otherwise undefined.
 */
function messageContent(body: unknown): unknown {
  if (typeof body !== "object" || body === null || !("choices" in body) || !Array.isArray(body.choices)) return undefined;
  const choices: unknown[] = body.choices;
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null || !("message" in first)) return undefined;
  const msg: unknown = first.message;
  if (typeof msg !== "object" || msg === null || !("content" in msg)) return undefined;
  return msg.content;
}

/**
 * Invokes the local Claude Code CLI in non-interactive print mode to extract the Decision & Path Graph.
 * Disables session persistence and built-in tools so no ~/.claude history or side effects occur.
 *
 * Args:
 *     cfg (LabelerConfig): Labeler config with model and optional command override.
 *     input (GraphExtractInput): Redacted turns and optional slim outline of the existing graph.
 *     turnTimestamps (ReadonlyMap<string, number>): Known turn timestamps for node ordering.
 *     existing (SessionGraph | undefined): Graph the reply is merged into; omit for a first graph.
 *     env (NodeJS.ProcessEnv): Environment variables passed to the subprocess.
 *
 * Returns:
 *     Promise<SessionGraph>: Validated, merged LLM-extracted Decision & Path Graph.
 */
async function extractViaClaudeCli(
  cfg: LabelerConfig,
  input: GraphExtractInput,
  turnTimestamps: ReadonlyMap<string, number>,
  existing: SessionGraph | undefined,
  env: NodeJS.ProcessEnv,
): Promise<SessionGraph> {
  if (!cfg.model) {
    throw new Error("labeler not configured: set labeler.model in config.json");
  }
  const cmd = cfg.command || "claude";
  const proc = Bun.spawn(
    [
      cmd,
      "-p",
      "--model",
      cfg.model,
      "--no-session-persistence",
      "--tools",
      "",
      "--system-prompt",
      SYSTEM_PROMPT,
      "--output-format",
      "text",
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    },
  );
  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TIMEOUT_MS);
  timer.unref();

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) throw new Error(`claude-cli timed out after ${TIMEOUT_MS}ms`);
    if (exitCode !== 0) {
      const detail = (stderr.trim() || stdout.trim()).slice(0, 240);
      throw new Error(`claude-cli exited ${exitCode}: ${detail}`);
    }
    if (!stdout.trim()) throw new Error("claude-cli returned empty output");
    return parseGraphOutput(stdout, turnTimestamps, existing);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls the configured labeler backend (OpenAI-compatible HTTP endpoint or local Claude CLI)
 * to extract the first Decision & Path Graph, or a patch that is merged into the existing one.
 *
 * Args:
 *     cfg (LabelerConfig): Provider, endpoint/command, model, and optional apiKeyEnv.
 *     input (GraphExtractInput): Redacted turns and optional slim outline of the existing graph.
 *     turnTimestamps (ReadonlyMap<string, number>): Known turn timestamps for node ordering.
 *     existing (SessionGraph | undefined): Full graph that `input.existingGraph` outlines; the reply
 *         is merged into it. Omit for a first graph.
 *     env (NodeJS.ProcessEnv): Environment map used to resolve apiKeyEnv or subprocess env.
 *
 * Returns:
 *     Promise<SessionGraph>: Validated, merged LLM-extracted Decision & Path Graph.
 */
export async function extractGraph(
  cfg: LabelerConfig,
  input: GraphExtractInput,
  turnTimestamps: ReadonlyMap<string, number>,
  existing?: SessionGraph,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionGraph> {
  if (cfg.provider === "claude-cli") {
    return extractViaClaudeCli(cfg, input, turnTimestamps, existing, env);
  }
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
      max_tokens: 4096,
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
  return parseGraphOutput(content, turnTimestamps, existing);
}
