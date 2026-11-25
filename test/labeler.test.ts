import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isLabelerConfigured } from "../src/config";
import {
  AGENT_CHARS,
  extractGraph,
  GUEST_PLACEHOLDER,
  OWNER_CHARS,
  parseGraphOutput,
  redactTurn,
  TITLE_CHARS,
  TRIGGER_CHARS,
  type GraphExtractInput,
} from "../src/labeler";
import type { SessionGraph, Turn } from "../src/model";
import { type FakeLabeler, startFakeLabeler } from "./fake-labeler";

function turn(partial: Partial<Turn> & Pick<Turn, "id" | "author" | "text">): Turn {
  return { at: 1000, actions: [], open: false, ...partial };
}

describe("parseGraphOutput", () => {
  const ts = new Map([
    ["t1", 1000],
    ["t2", 2000],
    ["t3", 3000],
  ]);

  test("accepts valid graph JSON and strips markdown code fences", () => {
    const raw = [
      "```json",
      JSON.stringify({
        title: "Enforce Reuse",
        nodes: [
          {
            id: "g1",
            kind: "goal",
            badge: "ROOT",
            title: "Stop duplicate code",
            desc: "Force reading files before planning",
            rationaleLabel: "Problem",
            rationale: "Agents built parallel systems",
            turnIds: ["t1"],
          },
          {
            id: "g2",
            kind: "rejected",
            badge: "KILLED",
            title: "Commit-time gate",
            desc: "Check at git commit",
            rationaleLabel: "Why rejected",
            rationale: "Wastes tokens",
            turnIds: ["t2", "t3"],
          },
        ],
        edges: [{ from: "g1", to: "g2", kind: "rejected", label: "Wastes tokens" }],
      }),
      "```",
    ].join("\n");

    const g = parseGraphOutput(raw, ts);
    expect(g.mode).toBe("llm");
    expect(g.title).toBe("Enforce Reuse");
    expect(g.nodes).toHaveLength(2);
    expect(g.nodes[1]?.at).toBe(3000);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.label).toBe("Wastes tokens");
  });

  test("rejects invalid node kind and duplicate node ids", () => {
    expect(() =>
      parseGraphOutput(JSON.stringify({ title: "X", nodes: [{ id: "g1", kind: "bogus", title: "A" }], edges: [] }), ts),
    ).toThrow("invalid node kind");

    expect(() =>
      parseGraphOutput(
        JSON.stringify({
          title: "X",
          nodes: [
            { id: "g1", kind: "goal", title: "A" },
            { id: "g1", kind: "chosen", title: "B" },
          ],
          edges: [],
        }),
        ts,
      ),
    ).toThrow("duplicate node id");
  });

  test("drops a bad edge and keeps the rest of the reply", () => {
    const g = parseGraphOutput(
      JSON.stringify({
        title: "X",
        nodes: [
          { id: "g1", kind: "goal", title: "A", turnIds: ["t1"] },
          { id: "c1", kind: "chosen", title: "B", turnIds: ["t2"] },
        ],
        edges: [
          { from: "g1", to: "missing", kind: "chosen" },
          { from: "g1", to: "c1", kind: "bogus" },
          "not an object",
          null,
          { from: "g1" },
          { from: "g1", to: "c1", kind: "chosen", label: "Picked" },
        ],
      }),
      ts,
    );
    expect(g.nodes.map((n) => n.id)).toEqual(["g1", "c1"]);
    expect(g.edges).toEqual([{ id: "e1", from: "g1", to: "c1", kind: "chosen", label: "Picked" }]);
  });

  test("rejects non-JSON and empty nodes array, and truncates long titles", () => {
    expect(() => parseGraphOutput("not json", ts)).toThrow("not valid JSON");
    expect(() => parseGraphOutput(JSON.stringify({ title: "X", nodes: [], edges: [] }), ts)).toThrow("non-empty array");

    const g = parseGraphOutput(
      JSON.stringify({
        title: "A".repeat(200),
        nodes: [{ id: "g1", kind: "goal", title: "B".repeat(200), turnIds: ["t1"] }],
        edges: [],
      }),
      ts,
    );
    expect(g.title.length).toBe(TITLE_CHARS);
    expect(g.nodes[0]?.title.length).toBe(TITLE_CHARS);
  });
});

describe("parseGraphOutput patch merge", () => {
  const ts = new Map([
    ["t1", 1000],
    ["t2", 2000],
    ["t3", 3000],
    ["t4", 4000],
  ]);

  function existingGraph(): SessionGraph {
    return {
      title: "Enforce Reuse",
      mode: "llm",
      nodes: [
        {
          id: "g1",
          kind: "goal",
          badge: "ROOT",
          title: "Stop duplicate code",
          desc: "Force reading files before planning",
          rationaleLabel: "Problem",
          rationale: "Agents built parallel systems",
          turnIds: ["t1"],
          at: 1000,
        },
        {
          id: "l1",
          kind: "loop",
          badge: "REVIEW LOOP",
          title: "Plan review rounds",
          desc: "Owner re-checks the plan",
          rationaleLabel: "Why collapsed",
          rationale: "Same check repeated",
          turnIds: ["t2", "t3"],
          at: 3000,
          rounds: 2,
        },
      ],
      edges: [{ id: "e1", from: "g1", to: "l1", kind: "loop", label: "2 rounds" }],
    };
  }

  test("keeps existing nodes the patch does not list and appends new nodes and edges", () => {
    const existing = existingGraph();
    const g = parseGraphOutput(
      JSON.stringify({
        nodes: [{ id: "c1", kind: "chosen", title: "Save-time hook", turnIds: ["t4"] }],
        edges: [{ from: "l1", to: "c1", kind: "chosen", label: "Approved" }],
      }),
      ts,
      existing,
    );

    expect(g.mode).toBe("llm");
    expect(g.title).toBe("Enforce Reuse");
    expect(g.nodes.map((n) => n.id)).toEqual(["g1", "l1", "c1"]);
    expect(g.nodes[0]).toEqual(existing.nodes[0]);
    expect(g.nodes[1]).toEqual(existing.nodes[1]);
    expect(g.nodes[2]?.at).toBe(4000);
    expect(g.edges).toEqual([
      { id: "e1", from: "g1", to: "l1", kind: "loop", label: "2 rounds" },
      { id: "e2", from: "l1", to: "c1", kind: "chosen", label: "Approved" },
    ]);
    // The graph passed in is not modified.
    expect(existing).toEqual(existingGraph());
  });

  test("a partial update keeps omitted fields, unions turnIds, and never moves `at` backwards", () => {
    const g = parseGraphOutput(
      JSON.stringify({
        title: "Renamed Graph",
        nodes: [{ id: "l1", rounds: 3, turnIds: ["t3", "t4", "unknown-turn"] }],
      }),
      ts,
      existingGraph(),
    );

    expect(g.title).toBe("Renamed Graph");
    expect(g.nodes).toHaveLength(2);
    expect(g.nodes[1]).toEqual({
      ...existingGraph().nodes[1],
      rounds: 3,
      turnIds: ["t2", "t3", "t4", "unknown-turn"],
      at: 4000,
    });

    // Old turns missing from the timestamp map cannot lower `at`; an empty title is treated as omitted.
    const kept = parseGraphOutput(
      JSON.stringify({ nodes: [{ id: "l1", kind: "chosen", title: "  " }] }),
      new Map<string, number>(),
      existingGraph(),
    );
    expect(kept.nodes[1]).toEqual({ ...existingGraph().nodes[1], kind: "chosen" });
  });

  test("node errors in a patch still throw", () => {
    expect(() => parseGraphOutput(JSON.stringify({ nodes: [{ id: "l1", kind: "bogus" }] }), ts, existingGraph())).toThrow(
      "invalid node kind",
    );
    expect(() => parseGraphOutput(JSON.stringify({ nodes: [{ id: "new1", kind: "chosen" }] }), ts, existingGraph())).toThrow(
      'missing or empty string "title"',
    );
    expect(() =>
      parseGraphOutput(JSON.stringify({ nodes: [{ id: "l1", rounds: 3 }, { id: "l1", rounds: 4 }] }), ts, existingGraph()),
    ).toThrow("duplicate node id");
    expect(() => parseGraphOutput(JSON.stringify({ title: "X" }), ts, existingGraph())).toThrow("nodes must be an array");
  });

  test("an empty patch returns the existing graph unchanged", () => {
    expect(parseGraphOutput(JSON.stringify({ nodes: [], edges: [] }), ts, existingGraph())).toEqual(existingGraph());
    expect(parseGraphOutput(JSON.stringify({ title: "", nodes: [] }), ts, existingGraph())).toEqual(existingGraph());
  });

  test("an empty patch may still add edges between existing nodes; bad edges are dropped", () => {
    const g = parseGraphOutput(
      JSON.stringify({
        nodes: [],
        edges: [
          { from: "l1", to: "gone", kind: "chosen" },
          { from: "l1", to: "g1", kind: "nope" },
          { from: "l1", to: "g1", kind: "decision", label: "Back to goal" },
        ],
      }),
      ts,
      existingGraph(),
    );
    expect(g.nodes).toEqual(existingGraph().nodes);
    expect(g.edges).toEqual([
      { id: "e1", from: "g1", to: "l1", kind: "loop", label: "2 rounds" },
      { id: "e2", from: "l1", to: "g1", kind: "decision", label: "Back to goal" },
    ]);
  });

  test("an edge with the same from+to replaces kind and label; new edge ids never collide", () => {
    const existing = existingGraph();
    existing.edges.push({ id: "e3", from: "l1", to: "g1", kind: "side" });
    const g = parseGraphOutput(
      JSON.stringify({
        nodes: [
          { id: "c1", kind: "chosen", title: "Save-time hook", turnIds: ["t4"] },
          { id: "s1", kind: "side", title: "Side question", turnIds: ["t4"] },
        ],
        edges: [
          { from: "g1", to: "l1", kind: "chosen" },
          { from: "l1", to: "c1", kind: "chosen" },
          { from: "l1", to: "s1", kind: "side" },
        ],
      }),
      ts,
      existing,
    );
    expect(g.edges).toEqual([
      { id: "e1", from: "g1", to: "l1", kind: "chosen" },
      { id: "e3", from: "l1", to: "g1", kind: "side" },
      { id: "e4", from: "l1", to: "c1", kind: "chosen" },
      { id: "e5", from: "l1", to: "s1", kind: "side" },
    ]);
  });
});

describe("redactTurn and I5 privacy", () => {
  test("caps owner text at head, agent text at tail, redacts guest text, and omits agent trigger text", () => {
    const owner = redactTurn(turn({ id: "o1", author: "owner", text: "A".repeat(OWNER_CHARS + 50) }));
    expect(owner.text?.length).toBe(OWNER_CHARS);

    const agent = redactTurn(
      turn({
        id: "a1",
        author: "agent",
        text: `${"X".repeat(200)}${"Z".repeat(AGENT_CHARS)}`,
        actions: [
          { tool: "read", summary: "secret-file.ts" },
          { tool: "read", summary: "other.ts" },
        ],
        trigger: { from: "agent", type: "async-result" },
      }),
    );
    expect(agent.text).toBe("Z".repeat(AGENT_CHARS));
    expect(agent.tools).toEqual({ read: 2 });
    expect(JSON.stringify(agent)).not.toContain("secret-file");
    expect(agent.trigger).toBeUndefined();

    const guest = redactTurn(turn({ id: "g1", author: "owner", guest: true, text: "private guest text" }));
    expect(guest.text).toBe(GUEST_PLACEHOLDER);

    const ownerTrig = redactTurn(
      turn({
        id: "a2",
        author: "agent",
        text: "done",
        trigger: { from: "owner", text: "T".repeat(TRIGGER_CHARS + 20) },
      }),
    );
    expect(ownerTrig.trigger?.text.length).toBe(TRIGGER_CHARS);
  });
});

describe("extractGraph()", () => {
  let fake: FakeLabeler;

  beforeEach(() => {
    fake = startFakeLabeler();
  });

  afterEach(() => {
    fake.stop();
  });

  test("POSTs to /chat/completions with Bearer auth and returns validated SessionGraph", async () => {
    fake.respond = () =>
      JSON.stringify({
        title: "Test Graph",
        nodes: [{ id: "g1", kind: "goal", badge: "GOAL", title: "Root", desc: "Desc", turnIds: ["t1"] }],
        edges: [],
      });

    const input: GraphExtractInput = {
      turns: [redactTurn(turn({ id: "t1", author: "owner", text: "hello" }))],
    };
    const g = await extractGraph(
      { baseUrl: fake.url, model: "test-model", apiKeyEnv: "TEST_KEY" },
      input,
      new Map([["t1", 1000]]),
      undefined,
      { TEST_KEY: "secret-123" },
    );

    expect(g.mode).toBe("llm");
    expect(g.nodes[0]?.id).toBe("g1");
    expect(fake.requests[0]?.path).toBe("/v1/chat/completions");
    expect(fake.requests[0]?.auth).toBe("Bearer secret-123");
  });

  test("fails cleanly when unconfigured, missing apiKeyEnv, or non-200 HTTP", async () => {
    const input: GraphExtractInput = { turns: [] };
    await expect(extractGraph({}, input, new Map())).rejects.toThrow("labeler not configured");
    await expect(
      extractGraph({ baseUrl: fake.url, model: "m", apiKeyEnv: "UNSET" }, input, new Map(), undefined, {}),
    ).rejects.toThrow("UNSET");

    fake.status = 502;
    await expect(extractGraph({ baseUrl: fake.url, model: "m" }, input, new Map())).rejects.toThrow("HTTP 502");
  });

  test("merges a patch reply into the existing graph it is given", async () => {
    const existing: SessionGraph = {
      title: "Existing",
      mode: "llm",
      nodes: [
        {
          id: "g1",
          kind: "goal",
          badge: "GOAL",
          title: "Root",
          desc: "Root desc",
          rationaleLabel: "Problem",
          rationale: "Root why",
          turnIds: ["t1"],
          at: 1000,
        },
      ],
      edges: [],
    };
    fake.respond = () =>
      JSON.stringify({
        nodes: [{ id: "c1", kind: "chosen", title: "Picked path", turnIds: ["t2"] }],
        edges: [{ from: "g1", to: "c1", kind: "chosen" }],
      });

    const g = await extractGraph(
      { baseUrl: fake.url, model: "m" },
      { turns: [redactTurn(turn({ id: "t2", author: "owner", text: "go with it" }))] },
      new Map([["t2", 2000]]),
      existing,
    );

    expect(g.title).toBe("Existing");
    expect(g.nodes.map((n) => n.id)).toEqual(["g1", "c1"]);
    expect(g.nodes[0]).toEqual(existing.nodes[0]);
    expect(g.edges).toEqual([{ id: "e1", from: "g1", to: "c1", kind: "chosen" }]);
  });
});

describe("extractGraph via claude-cli provider", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ipg-cli-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("isLabelerConfigured distinguishes openai and claude-cli providers", () => {
    expect(isLabelerConfigured(undefined)).toBe(false);
    expect(isLabelerConfigured({ model: "haiku" })).toBe(false);
    expect(isLabelerConfigured({ baseUrl: "http://x", model: "m" })).toBe(true);
    expect(isLabelerConfigured({ provider: "claude-cli", model: "haiku" })).toBe(true);
    expect(isLabelerConfigured({ provider: "claude-cli" })).toBe(false);
  });

  test("extracts outermost JSON object when model emits surrounding prose", () => {
    const raw = `Here is the decision graph:\n{"title":"Wrapped","nodes":[{"id":"n1","kind":"goal","title":"Start","turnIds":["t1"]}],"edges":[]}\nDone.`;
    const g = parseGraphOutput(raw, new Map([["t1", 1234]]));
    expect(g.title).toBe("Wrapped");
    expect(g.nodes[0]?.at).toBe(1234);
  });

  test("spawns claude CLI with no-session-persistence, empty tools, and pipes redacted JSON", async () => {
    const script = join(dir, "fake-claude.sh");
    writeFileSync(
      script,
      `#!/bin/sh
echo "stderr warning ignored on success" >&2
case " $* " in
  *" -p "*) ;;
  *) echo "missing -p" >&2; exit 2 ;;
esac
case " $* " in
  *" --no-session-persistence "*) ;;
  *) echo "missing --no-session-persistence" >&2; exit 3 ;;
esac
cat >/dev/null
printf '{"title":"CLI Graph","nodes":[{"id":"g1","kind":"goal","badge":"GOAL","title":"From CLI","desc":"Parsed from stdout","rationaleLabel":"Context","rationale":"Test","turnIds":["t1"]}],"edges":[]}\n'
`,
    );
    chmodSync(script, 0o755);

    const input: GraphExtractInput = {
      turns: [redactTurn(turn({ id: "t1", author: "owner", text: "build it" }))],
    };
    const g = await extractGraph(
      { provider: "claude-cli", model: "haiku", command: script },
      input,
      new Map([["t1", 5000]]),
    );

    expect(g.mode).toBe("llm");
    expect(g.title).toBe("CLI Graph");
    expect(g.nodes[0]?.title).toBe("From CLI");
    expect(g.nodes[0]?.at).toBe(5000);
  });

  test("surfaces stderr cleanly when claude-cli exits non-zero", async () => {
    const script = join(dir, "fail-claude.sh");
    writeFileSync(script, "#!/bin/sh\necho 'auth expired' >&2\nexit 1\n");
    chmodSync(script, 0o755);

    await expect(
      extractGraph({ provider: "claude-cli", model: "haiku", command: script }, { turns: [] }, new Map()),
    ).rejects.toThrow("claude-cli exited 1: auth expired");
  });
});

describe("parseGraphOutput mergeInto", () => {
  const ts = new Map([
    ["t1", 1000],
    ["t2", 2000],
    ["t3", 3000],
    ["t4", 4000],
  ]);
  const n = (id: string, kind: SessionGraph["nodes"][number]["kind"], turnIds: string[], at: number) => ({
    id,
    kind,
    badge: "B",
    title: id,
    desc: id,
    rationaleLabel: "Why",
    rationale: id,
    turnIds,
    at,
  });
  const graph = (): SessionGraph => ({
    title: "T",
    mode: "llm",
    nodes: [n("goal", "goal", ["t1"], 1000), n("fix", "chosen", ["t2"], 2000), n("q", "side", ["t3"], 3000), n("note", "side", ["t4"], 4000)],
    edges: [
      { id: "e1", from: "goal", to: "fix", kind: "chosen" },
      { id: "e2", from: "fix", to: "q", kind: "side" },
      { id: "e3", from: "q", to: "note", kind: "side" },
      { id: "e4", from: "goal", to: "note", kind: "side" },
    ],
  });

  test("folds nodes into the survivor: turns and edges move there, nothing is lost or duplicated", () => {
    // note -> q -> fix is a chain; both end up in fix.
    const g = parseGraphOutput(
      JSON.stringify({ nodes: [{ id: "note", mergeInto: "q" }, { id: "q", mergeInto: "fix" }, { id: "fix", title: "Fix and its questions" }] }),
      ts,
      graph(),
    );
    expect(g.nodes.map((x) => x.id)).toEqual(["goal", "fix"]);
    expect(g.nodes[1]).toMatchObject({ title: "Fix and its questions", turnIds: ["t2", "t3", "t4"], at: 4000 });
    // e2 and e3 became self-loops and are gone; e4 now duplicates e1's pair and is dropped.
    expect(g.edges).toEqual([{ id: "e1", from: "goal", to: "fix", kind: "chosen" }]);
  });

  test("ignores a merge that would remove the goal, points at an unknown node, or loops", () => {
    const g = parseGraphOutput(
      JSON.stringify({
        nodes: [{ id: "goal", mergeInto: "fix" }, { id: "q", mergeInto: "nope" }, { id: "note", mergeInto: "note" }, { id: "ghost", mergeInto: "fix" }],
      }),
      ts,
      graph(),
    );
    expect(g).toEqual(graph());
  });
});

describe("claude-cli failure message", () => {
  test("shows the cause claude printed on stdout ahead of stderr noise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ipg-cli-"));
    const script = join(dir, "fail.sh");
    writeFileSync(script, "#!/bin/sh\necho 'Warning: old config' >&2\necho 'more noise' >&2\necho 'Your subscription payment is past due'\nexit 1\n");
    chmodSync(script, 0o755);
    try {
      await expect(
        extractGraph({ provider: "claude-cli", model: "haiku", command: script }, { turns: [] }, new Map()),
      ).rejects.toThrow("claude-cli exited 1: Your subscription payment is past due | Warning: old config more noise");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
