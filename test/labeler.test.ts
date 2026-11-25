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
import type { Turn } from "../src/model";
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

  test("rejects invalid node kind, duplicate node ids, and dangling edges", () => {
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

    expect(() =>
      parseGraphOutput(
        JSON.stringify({
          title: "X",
          nodes: [{ id: "g1", kind: "goal", title: "A" }],
          edges: [{ from: "g1", to: "missing", kind: "chosen" }],
        }),
        ts,
      ),
    ).toThrow("unknown node");
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
    await expect(extractGraph({ baseUrl: fake.url, model: "m", apiKeyEnv: "UNSET" }, input, new Map(), {})).rejects.toThrow(
      "UNSET",
    );

    fake.status = 502;
    await expect(extractGraph({ baseUrl: fake.url, model: "m" }, input, new Map())).rejects.toThrow("HTTP 502");
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
