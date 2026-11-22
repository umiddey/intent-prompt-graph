import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AGENT_CHARS,
  batchTurn,
  CAPTION_CHARS,
  GUEST_PLACEHOLDER,
  label,
  type LabelInput,
  OWNER_CHARS,
  parseOutput,
  payloadText,
  TITLE_CHARS,
  TRIGGER_CHARS,
} from "../src/labeler";
import type { Turn } from "../src/model";
import { type FakeLabeler, startFakeLabeler } from "./fake-labeler";

const AT = 1_700_000_000_000;

function turn(over: Partial<Turn> & Pick<Turn, "id" | "author">): Turn {
  return { at: AT, text: "", actions: [], open: false, ...over };
}

const input: LabelInput = {
  intents: [{ id: "i1", title: "Auth", captions: ["fixed login"] }],
  before: [],
  turns: [
    { ref: "a", author: "owner", text: "fix login" },
    { ref: "b", author: "agent", text: "patched" },
  ],
};

function answer(turns: unknown[]): string {
  return JSON.stringify({ turns });
}

describe("parseOutput", () => {
  test("accepts a valid reply and strips a code fence", () => {
    const raw =
      "```json\n" +
      answer([
        { ref: "a", kind: "asked", caption: "asks about login", intent: "i1" },
        { ref: "b", kind: "did", caption: "patches login", intent: "i1" },
      ]) +
      "\n```";
    const parsed = parseOutput(raw, input);
    expect(parsed.answers).toEqual([
      { ref: "a", intent: { id: "i1" }, kind: "asked", caption: "asks about login" },
      { ref: "b", intent: { id: "i1" }, kind: "did", caption: "patches login" },
    ]);
    expect(parsed.newTitles.size).toBe(0);
  });

  test("rejects a kind the author may not use", () => {
    const raw = answer([
      { ref: "a", kind: "found", caption: "c", intent: "i1" },
      { ref: "b", kind: "did", caption: "c", intent: "i1" },
    ]);
    expect(() => parseOutput(raw, input)).toThrow(/kind not allowed for owner turn a/);
  });

  test("rejects an intent that was never offered", () => {
    const raw = answer([
      { ref: "a", kind: "asked", caption: "c", intent: "i7" },
      { ref: "b", kind: "did", caption: "c", intent: "i1" },
    ]);
    expect(() => parseOutput(raw, input)).toThrow(/unknown intent i7 for turn a/);
  });

  test("rejects a turn that was not answered", () => {
    const raw = answer([{ ref: "a", kind: "asked", caption: "c", intent: "i1" }]);
    expect(() => parseOutput(raw, input)).toThrow(/missing answers for b/);
  });

  test("rejects a ref answered twice", () => {
    const raw = answer([
      { ref: "a", kind: "asked", caption: "c", intent: "i1" },
      { ref: "a", kind: "asked", caption: "c", intent: "i1" },
    ]);
    expect(() => parseOutput(raw, input)).toThrow(/ref a answered twice/);
  });

  test("rejects a ref that is not in the batch", () => {
    const raw = answer([{ ref: "zz", kind: "asked", caption: "c", intent: "i1" }]);
    expect(() => parseOutput(raw, input)).toThrow(/unknown ref zz/);
  });

  test("rejects an empty caption", () => {
    const raw = answer([
      { ref: "a", kind: "asked", caption: "   ", intent: "i1" },
      { ref: "b", kind: "did", caption: "c", intent: "i1" },
    ]);
    expect(() => parseOutput(raw, input)).toThrow(/empty caption for turn a/);
  });

  test("rejects non-JSON and a missing turns array", () => {
    expect(() => parseOutput("not json", input)).toThrow(/not valid JSON/);
    expect(() => parseOutput(JSON.stringify({ items: [] }), input)).toThrow(/no turns array/);
  });

  test("cuts a caption to CAPTION_CHARS", () => {
    const raw = answer([
      { ref: "a", kind: "asked", caption: "x".repeat(300), intent: "i1" },
      { ref: "b", kind: "did", caption: "c", intent: "i1" },
    ]);
    const [first] = parseOutput(raw, input).answers;
    expect(first?.caption.length).toBe(CAPTION_CHARS);
  });

  test("declares a new intent and cuts its title to TITLE_CHARS", () => {
    const raw = answer([
      { ref: "a", kind: "asked", caption: "c", intent: { new: "n1", title: "t".repeat(200) } },
      { ref: "b", kind: "did", caption: "c", intent: "i1" },
    ]);
    const parsed = parseOutput(raw, input);
    expect(parsed.answers[0]?.intent).toEqual({ local: "n1" });
    expect(parsed.newTitles.get("n1")?.length).toBe(TITLE_CHARS);
  });

  test("a later turn may reuse an nK declared earlier in the same batch", () => {
    const raw = answer([
      { ref: "a", kind: "asked", caption: "c", intent: { new: "n1", title: "Export" } },
      { ref: "b", kind: "did", caption: "c", intent: "n1" },
    ]);
    const parsed = parseOutput(raw, input);
    expect(parsed.answers.map((x) => x.intent)).toEqual([{ local: "n1" }, { local: "n1" }]);
  });

  test("rejects redeclaring the same nK", () => {
    const raw = answer([
      { ref: "a", kind: "asked", caption: "c", intent: { new: "n1", title: "A" } },
      { ref: "b", kind: "did", caption: "c", intent: { new: "n1", title: "B" } },
    ]);
    expect(() => parseOutput(raw, input)).toThrow(/intent n1 declared twice/);
  });

  test("a fixed-intent turn takes its fixed id and ignores the model's intent", () => {
    const fixed: LabelInput = {
      intents: [{ id: "i1", title: "Auth", captions: [] }],
      before: [],
      turns: [
        { ref: "a", author: "owner", text: "fix login" },
        { ref: "b", author: "agent", text: "patched", fixedIntent: "i1" },
      ],
    };
    const raw = answer([
      { ref: "a", kind: "asked", caption: "c", intent: "i1" },
      { ref: "b", kind: "did", caption: "c", intent: { new: "n1", title: "Something else" } },
    ]);
    const parsed = parseOutput(raw, fixed);
    expect(parsed.answers[1]?.intent).toEqual({ id: "i1" });
    expect(parsed.newTitles.size).toBe(0);
  });
});

describe("payload and I5 redaction", () => {
  test("owner text is capped at the head, OWNER_CHARS", () => {
    const t = turn({ id: "a", author: "owner", text: "H".repeat(2000) });
    expect(payloadText(t)).toBe("H".repeat(OWNER_CHARS));
    expect(batchTurn(t).text).toBe("H".repeat(OWNER_CHARS));
  });

  test("agent text is capped at the tail, AGENT_CHARS", () => {
    const t = turn({ id: "b", author: "agent", text: "x".repeat(3000) + "END" });
    const text = batchTurn(t).text ?? "";
    expect(text.length).toBe(AGENT_CHARS);
    expect(text.endsWith("END")).toBe(true);
  });

  test("guest text is replaced by the placeholder and never sent", () => {
    const t = turn({ id: "a", author: "owner", text: "top secret", guest: true });
    const out = batchTurn(t);
    expect(out.text).toBe(GUEST_PLACEHOLDER);
    expect(out.guest).toBe(true);
    expect(JSON.stringify(out)).not.toContain("top secret");
  });

  test("agent turns send tool counts only, not summaries", () => {
    const t = turn({
      id: "b",
      author: "agent",
      text: "ok",
      actions: [
        { tool: "bash", summary: "rm -rf secret-dir" },
        { tool: "bash", summary: "cat secret.env" },
        { tool: "read", summary: "/etc/secret" },
      ],
    });
    const out = batchTurn(t);
    expect(out.tools).toEqual({ bash: 2, read: 1 });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  test("an agent-origin trigger is omitted entirely", () => {
    const t = turn({ id: "b", author: "agent", text: "ok", trigger: { from: "agent", type: "subagent-result" } });
    const out = batchTurn(t);
    expect(out.trigger).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("subagent-result");
  });

  test("an owner-origin trigger is sent, capped at TRIGGER_CHARS", () => {
    const t = turn({ id: "b", author: "agent", text: "ok", trigger: { from: "owner", text: "Q".repeat(1000) } });
    expect(batchTurn(t).trigger).toEqual({ from: "owner", text: "Q".repeat(TRIGGER_CHARS) });
    expect(payloadText(t).length).toBe("ok".length + TRIGGER_CHARS);
  });

  test("fixedIntent is passed only to agent turns", () => {
    const agent = turn({ id: "b", author: "agent", text: "ok" });
    const owner = turn({ id: "a", author: "owner", text: "hi" });
    expect(batchTurn(agent, "i3").fixedIntent).toBe("i3");
    expect(batchTurn(owner, "i3").fixedIntent).toBeUndefined();
  });
});

describe("label()", () => {
  let fake: FakeLabeler;

  beforeEach(() => {
    fake = startFakeLabeler();
    fake.respond = () =>
      answer([
        { ref: "a", kind: "asked", caption: "asks about login", intent: "i1" },
        { ref: "b", kind: "did", caption: "patches login", intent: "i1" },
      ]);
  });

  afterEach(() => {
    fake.stop();
  });

  test("POSTs to /chat/completions with the input as the user message", async () => {
    const parsed = await label({ baseUrl: fake.url, model: "m1" }, input, {});
    expect(parsed.answers.length).toBe(2);
    const req = fake.requests[0];
    expect(req?.path).toBe("/v1/chat/completions");
    expect(req?.auth).toBeNull();
    expect(req?.input).toEqual(input);
    expect(req?.body).toMatchObject({ model: "m1", temperature: 0, response_format: { type: "json_object" } });
  });

  test("sends the key from apiKeyEnv as a Bearer token", async () => {
    await label({ baseUrl: fake.url, model: "m1", apiKeyEnv: "MY_KEY" }, input, { MY_KEY: "sek" });
    expect(fake.requests[0]?.auth).toBe("Bearer sek");
  });

  test("a set apiKeyEnv naming an unset variable fails before any request", async () => {
    await expect(label({ baseUrl: fake.url, model: "m1", apiKeyEnv: "MISSING" }, input, {})).rejects.toThrow(
      /MISSING, which is not set/,
    );
    expect(fake.requests.length).toBe(0);
  });

  test("an unconfigured labeler fails before any request", async () => {
    await expect(label({}, input, {})).rejects.toThrow(/labeler not configured/);
    expect(fake.requests.length).toBe(0);
  });

  test("an HTTP error surfaces the status", async () => {
    fake.status = 500;
    await expect(label({ baseUrl: fake.url, model: "m1" }, input, {})).rejects.toThrow(/labeler HTTP 500/);
  });

  test("a reply that fails validation throws and is not partially used", async () => {
    fake.respond = () => answer([{ ref: "a", kind: "found", caption: "c", intent: "i1" }]);
    await expect(label({ baseUrl: fake.url, model: "m1" }, input, {})).rejects.toThrow(/labeler output/);
  });
});
