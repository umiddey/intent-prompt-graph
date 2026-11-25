import type { EdgeKind, GraphEdge, GraphNode, NodeKind, SessionGraph, Turn } from "./model";

const NOISE_OWNER_RE = /^(main-guard:|Previous session file:|machine:\s*(RED|GREEN))/i;
const NOISE_AGENT_RE = /^(Still stuck|Still no change|Nothing has changed|Nothing new has changed|No change since my last reply|Same state:|Same as before|Nothing runnable|No plan can run now)/i;
const CHECK_LOOP_RE = /^(chk\s*(agn|now|nw|again)?|ch\s*agai|check(\s+again|\s+now)?|yes|ok|okay|go|continue|status\??|done\??|next\??|try again|again)\.?$/i;
const REJECT_RE = /\b(cancel|don't|dont|do not|never|waste|wasting|wrong|against|reject|kill|stop|instead|not yet|no,\s|fuck|ffs)\b/i;
const SIDE_Q_RE = /^(what is|wgat is|whats|what's|why are|why did|how does|can you explain|who is|where is)\b/i;
const APPROVED_RE = /\b(ready to sign off|signed off|approved|looks good|lgtm|done,\s*committed|passes locally|merged|correct\.|clean and ready)\b/i;
const OPTION_LINE_RE = /^\s*(?:\*\*?)?(?:Option\s*)?(\d+)[.)]\s*(?:\*\*?)?([^\n]{6,90})/gm;

interface Exchange {
  owner?: Turn;
  agents: Turn[];
  allTurns: Turn[];
  at: number;
  isNoise: boolean;
  isCheckLoop: boolean;
}

/**
 * Cleans markdown and whitespace into a concise single-line snippet.
 *
 * Args:
 *     text (string): Raw turn text.
 *     max (number): Maximum character length.
 *
 * Returns:
 *     string: Normalized, truncated single-line string.
 */
function snippet(text: string, max: number): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/[#*_`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Extracts a short title from the first meaningful sentence of a turn.
 *
 * Args:
 *     text (string): Source turn text.
 *     fallback (string): Fallback title when text is empty.
 *
 * Returns:
 *     string: Concise node title (up to 72 chars).
 */
function titleFrom(text: string, fallback: string): string {
  const s = snippet(text, 140);
  if (!s) return fallback;
  const firstSentence = s.split(/(?<=[.!?])\s+/)[0] ?? s;
  return firstSentence.length <= 72 ? firstSentence : `${firstSentence.slice(0, 71).trimEnd()}…`;
}

/**
 * Groups raw turns into causal exchanges (an owner turn + the agent turns answering it, or standalone agent turns).
 *
 * Args:
 *     turns (Turn[]): Ordered session turns.
 *
 * Returns:
 *     Exchange[]: Grouped exchanges ready for loop collapsing and graph construction.
 */
function groupExchanges(turns: Turn[]): Exchange[] {
  const exchanges: Exchange[] = [];
  const byOwner = new Map<string, Exchange>();

  for (const t of turns) {
    if (t.author === "owner") {
      const trimmed = t.text.trim();
      const ex: Exchange = {
        owner: t,
        agents: [],
        allTurns: [t],
        at: t.at,
        isNoise: NOISE_OWNER_RE.test(trimmed),
        isCheckLoop: trimmed.length <= 42 && CHECK_LOOP_RE.test(trimmed),
      };
      exchanges.push(ex);
      byOwner.set(t.id, ex);
      continue;
    }

    const parent = t.openedBy ? byOwner.get(t.openedBy) : undefined;
    if (parent) {
      parent.agents.push(t);
      parent.allTurns.push(t);
      parent.at = Math.max(parent.at, t.at);
      continue;
    }

    const trimmed = t.text.trim();
    const isNoise = trimmed.length === 0 || NOISE_AGENT_RE.test(trimmed);
    exchanges.push({
      agents: [t],
      allTurns: [t],
      at: t.at,
      isNoise,
      isCheckLoop: false,
    });
  }
  return exchanges;
}

/**
 * Extracts numbered option headings from an agent message when the agent lays out multiple alternatives.
 *
 * Args:
 *     text (string): Agent response text.
 *
 * Returns:
 *     string[]: Extracted option titles (capped at 3).
 */
function extractOptions(text: string): string[] {
  const found: string[] = [];
  OPTION_LINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null = OPTION_LINE_RE.exec(text);
  while (m !== null && found.length < 4) {
    const label = snippet(m[2] ?? "", 64);
    if (label.length >= 6) found.push(label);
    m = OPTION_LINE_RE.exec(text);
  }
  return found.length >= 2 ? found.slice(0, 3) : [];
}

/**
 * Builds a deterministic Decision & Path Graph DAG directly from raw turns without needing an LLM.
 * Collapses repetitive check/polling loops, branches rejections and side questions off the main spine,
 * and ensures every session is immediately readable out of the box.
 *
 * Args:
 *     turns (Turn[]): Ordered turns from the session transcript.
 *     sessionTitle (string | undefined): Optional session title from the harness header.
 *
 * Returns:
 *     SessionGraph: A connected Decision & Path Graph in "heuristic" mode.
 */
export function buildHeuristicGraph(turns: Turn[], sessionTitle?: string): SessionGraph {
  if (turns.length === 0) {
    return {
      title: sessionTitle || "Waiting for turns",
      nodes: [],
      edges: [],
      mode: "heuristic",
    };
  }

  const exchanges = groupExchanges(turns);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let seq = 0;
  const nextId = (prefix = "h") => `${prefix}${++seq}`;

  const firstReal = exchanges.find((e) => !e.isNoise) ?? exchanges[0];
  const rootTitle =
    sessionTitle?.trim() ||
    (firstReal?.owner ? titleFrom(firstReal.owner.text, "Session start") : titleFrom(firstReal?.agents[0]?.text ?? "", "Session start"));

  let spineId: string | undefined;
  let edgeSeq = 0;
  const addEdge = (from: string, to: string, kind: EdgeKind, label?: string) => {
    edges.push({ id: `e${++edgeSeq}`, from, to, kind, label });
  };

  let i = 0;
  while (i < exchanges.length) {
    const ex = exchanges[i];
    if (!ex) break;

    // 1. Collapse consecutive noise / polling exchanges into one compact loop node (skip if before root).
    if (ex.isNoise) {
      let j = i;
      const turnIds: string[] = [];
      let at = ex.at;
      while (j < exchanges.length && exchanges[j]?.isNoise) {
        const cur = exchanges[j];
        if (cur) {
          turnIds.push(...cur.allTurns.map((t) => t.id));
          at = Math.max(at, cur.at);
        }
        j++;
      }
      const rounds = j - i;
      // Only create a node for multi-turn noise/polling runs once the root exists, so turn 1 handoffs don't become the root.
      if (spineId && (rounds >= 2 || turnIds.length >= 2)) {
        const id = nextId("n");
        nodes.push({
          id,
          kind: "loop",
          badge: `POLL / GUARD · ${rounds}×`,
          title: `Collapsed ${rounds} status/guard turns`,
          desc: snippet(ex.agents.at(-1)?.text || ex.owner?.text || "Repeated status or guard check", 130),
          rationaleLabel: "Why collapsed",
          rationale: `${rounds} repetitive guard or blocker-polling exchanges compressed into one node to keep the decision graph readable.`,
          turnIds,
          at,
          rounds,
        });
        addEdge(spineId, id, "loop", `${rounds}× poll`);
        spineId = id;
      }
      i = j;
      continue;
    }

    // 2. Collapse consecutive short check/approval loops (`chk agn`, `chk now`, `yes`, `go`).
    if (ex.isCheckLoop && spineId) {
      let j = i;
      const turnIds: string[] = [];
      let at = ex.at;
      let lastAgentText = "";
      while (j < exchanges.length && exchanges[j]?.isCheckLoop) {
        const cur = exchanges[j];
        if (cur) {
          turnIds.push(...cur.allTurns.map((t) => t.id));
          at = Math.max(at, cur.at);
          const aText = cur.agents.at(-1)?.text ?? "";
          if (aText) lastAgentText = aText;
        }
        j++;
      }
      const rounds = j - i;
      const approved = APPROVED_RE.test(lastAgentText);
      const id = nextId("l");
      nodes.push({
        id,
        kind: approved ? "chosen" : "loop",
        badge: approved ? `VERIFIED · ${rounds} ROUNDS` : `ITERATION · ${rounds} ROUNDS`,
        title: approved ? `Check loop verified (${rounds} rounds)` : `Review / check loop (${rounds} rounds)`,
        desc: snippet(lastAgentText || ex.owner?.text || "Iterative checks", 140),
        rationaleLabel: "Collapsed iteration",
        rationale: `${rounds} short back-and-forth check rounds collapsed into a single milestone node.`,
        turnIds,
        at,
        rounds,
      });
      addEdge(spineId, id, approved ? "chosen" : "loop", `${rounds} rounds`);
      spineId = id;
      i = j;
      continue;
    }

    const ownerText = ex.owner?.text ?? "";
    const agentText = ex.agents.map((a) => a.text).filter(Boolean).join("\n");
    const turnIds = ex.allTurns.map((t) => t.id);
    const isLast = i === exchanges.length - 1;

    // 3. First real exchange becomes the root Goal node.
    if (!spineId) {
      const id = nextId("g");
      nodes.push({
        id,
        kind: "goal",
        badge: "SESSION GOAL",
        title: titleFrom(ownerText || agentText, rootTitle),
        desc: snippet(agentText || ownerText, 150),
        rationaleLabel: "Starting context",
        rationale: snippet(ownerText || agentText, 280),
        turnIds,
        at: ex.at,
      });
      spineId = id;

      // If the agent laid out numbered options on the opening exchange, attach a compact option branch.
      const opts = extractOptions(agentText);
      if (opts.length >= 2) {
        const optId = nextId("o");
        nodes.push({
          id: optId,
          kind: "option",
          badge: `${opts.length} OPTIONS PROPOSED`,
          title: opts[0] ?? "Proposed alternatives",
          desc: opts.slice(1).join(" · "),
          rationaleLabel: "Alternatives laid out",
          rationale: opts.map((o, idx) => `${idx + 1}. ${o}`).join("\n"),
          turnIds: ex.agents.map((a) => a.id),
          at: ex.at,
        });
        addEdge(id, optId, "option", "Options");
      }
      i++;
      continue;
    }

    // 4. Side clarification question (branches off spine without advancing the spine).
    if (ownerText && ownerText.length < 160 && SIDE_Q_RE.test(ownerText.trim()) && !REJECT_RE.test(ownerText)) {
      const id = nextId("s");
      nodes.push({
        id,
        kind: "side",
        badge: "SIDE QUESTION",
        title: titleFrom(ownerText, "Clarification"),
        desc: snippet(agentText || ownerText, 140),
        rationaleLabel: "Clarification",
        rationale: snippet(agentText || ownerText, 260),
        turnIds,
        at: ex.at,
      });
      addEdge(spineId, id, "side", "Clarification");
      i++;
      continue;
    }

    // 5. Rejection / Pushback fork: owner pushes back or cancels a proposed path.
    if (ownerText && REJECT_RE.test(ownerText)) {
      const rejId = nextId("r");
      nodes.push({
        id: rejId,
        kind: "rejected",
        badge: "PUSHBACK / REJECTED",
        title: titleFrom(ownerText, "Owner rejected path"),
        desc: snippet(ownerText, 140),
        rationaleLabel: "Why rejected / changed",
        rationale: snippet(ownerText, 280),
        turnIds: ex.owner ? [ex.owner.id] : turnIds,
        at: ex.owner?.at ?? ex.at,
      });
      addEdge(spineId, rejId, "rejected", "Rejected");

      if (agentText) {
        const pivotId = nextId("c");
        const pivotKind: NodeKind = isLast || APPROVED_RE.test(agentText) ? "chosen" : "decision";
        nodes.push({
          id: pivotId,
          kind: pivotKind,
          badge: pivotKind === "chosen" ? "CHOSEN PIVOT" : "PIVOT / ADJUSTMENT",
          title: titleFrom(agentText, "Adjusted approach"),
          desc: snippet(agentText, 150),
          rationaleLabel: "New direction",
          rationale: snippet(agentText, 280),
          turnIds,
          at: ex.at,
        });
        addEdge(spineId, pivotId, pivotKind, "Pivot");
        addEdge(rejId, pivotId, "decision", "Replaced by");
        spineId = pivotId;
      }
      i++;
      continue;
    }

    // 6. Standard progression node (Decision or Chosen outcome).
    const approved = APPROVED_RE.test(agentText) || isLast;
    const kind: NodeKind = approved ? "chosen" : "decision";
    const id = nextId(approved ? "c" : "d");
    nodes.push({
      id,
      kind,
      badge: approved ? (isLast ? "LATEST OUTCOME" : "VERIFIED") : ex.owner ? "DECISION / STEP" : "AGENT UPDATE",
      title: titleFrom(ownerText || agentText, "Step"),
      desc: snippet(agentText || ownerText, 150),
      rationaleLabel: approved ? "Outcome" : "Context",
      rationale: snippet(agentText || ownerText, 280),
      turnIds,
      at: ex.at,
    });
    addEdge(spineId, id, kind, ex.owner ? undefined : "Auto");
    spineId = id;
    i++;
  }

  // Promote the final spine decision to "chosen" so trailing side questions don't obscure the session's final outcome.
  if (spineId && !nodes.some((n) => n.kind === "chosen")) {
    const tail = nodes.find((n) => n.id === spineId);
    if (tail && tail.kind === "decision") {
      tail.kind = "chosen";
      tail.badge = "LATEST OUTCOME";
    }
  }

  return {
    title: rootTitle,
    nodes,
    edges,
    mode: "heuristic",
  };
}
