import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { harnesses } from "../src/harness/harness";
import { GUEST_PLACEHOLDER } from "../src/labeler";
import type { ServerEvent } from "../src/model";
import { openSession, type Session } from "../src/session";
import { storeFile } from "../src/store";
import { type FakeLabeler, startFakeLabeler } from "./fake-labeler";
import { isolate, waitFor } from "./support";

const AT = Date.UTC(2026, 10, 22, 10, 0, 0);
let clock = 0;
function stamp(): string {
  clock += 1;
  return new Date(AT + clock * 1000).toISOString();
}

function line(obj: object): string {
  return `${JSON.stringify(obj)}\n`;
}

function owner(id: string, text: string): string {
  return line({ type: "message", id, timestamp: stamp(), message: { role: "user", content: [{ type: "text", text }] } });
}

/** A finished agent message: closes the turn. */
function agent(id: string, text: string, tools: string[] = []): string {
  const content = [{ type: "text", text }, ...tools.map((name) => ({ type: "toolCall", name, arguments: { i: "run" } }))];
  return line({
    type: "message",
    id,
    timestamp: stamp(),
    message: { role: "assistant", content, stopReason: "stop" },
  });
}

/** An agent message with no stopReason: the turn stays open. */
function agentOpen(id: string, text: string): string {
  return line({ type: "message", id, timestamp: stamp(), message: { role: "assistant", content: [{ type: "text", text }] } });
}

function guest(id: string, text: string): string {
  return line({
    type: "custom_message",
    id,
    timestamp: stamp(),
    customType: "guest",
    display: true,
    attribution: "user",
    content: text,
  });
}

function agentTrigger(id: string, customType: string, content: string): string {
  return line({
    type: "custom_message",
    id,
    timestamp: stamp(),
    customType,
    display: true,
    attribution: "agent",
    content,
  });
}

interface Seen {
  ref: string;
  author: string;
  fixed: boolean;
}

/** The turns in a labeler input, read back from the recorded request. */
function seen(input: unknown): Seen[] {
  if (typeof input !== "object" || input === null || !("turns" in input)) return [];
  const list: unknown = input.turns;
  if (!Array.isArray(list)) return [];
  const out: Seen[] = [];
  for (const t of list) {
    if (typeof t !== "object" || t === null || !("ref" in t) || !("author" in t)) continue;
    if (typeof t.ref !== "string" || typeof t.author !== "string") continue;
    out.push({ ref: t.ref, author: t.author, fixed: "fixedIntent" in t });
  }
  return out;
}

/** Intent ids offered in a labeler input. */
function offeredIds(input: unknown): string[] {
  if (typeof input !== "object" || input === null || !("intents" in input)) return [];
  const list: unknown = input.intents;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const i of list) {
    if (typeof i === "object" && i !== null && "id" in i && typeof i.id === "string") out.push(i.id);
  }
  return out;
}

/** Answers every turn in the batch, using plan[ref] for the intent of each turn that does not inherit one. */
function answering(plan: Record<string, unknown>): (input: unknown) => string {
  return (input) =>
    JSON.stringify({
      turns: seen(input).map((t) => {
        const turn: { ref: string; kind: string; caption: string; intent?: unknown } = {
          ref: t.ref,
          kind: t.author === "owner" ? "asked" : "did",
          caption: `caption ${t.ref}`,
        };
        if (!t.fixed) turn.intent = plan[t.ref];
        return turn;
      }),
    });
}

function labelOf(s: Session, turnId: string) {
  return s.snapshot().labels.find((l) => l.turnId === turnId);
}

function intentOf(s: Session, turnId: string): string | undefined {
  return labelOf(s, turnId)?.intentId;
}

describe("session", () => {
  let iso: { restore(): void };
  let fake: FakeLabeler;
  let dir: string;
  let file: string;
  let config: Config;
  const sessions: Session[] = [];

  beforeEach(() => {
    iso = isolate();
    fake = startFakeLabeler();
    dir = mkdtempSync(join(tmpdir(), "ipg-sess-"));
    file = join(dir, "sess.jsonl");
    writeFileSync(file, "");
    config = {
      harnessText: [/HARNESS_NOTE/],
      labeler: { baseUrl: fake.url, model: "m" },
      port: 4761,
      idleExitMinutes: 15,
    };
    clock = 0;
  });

  afterEach(() => {
    for (const s of sessions.splice(0)) s.stop();
    fake.stop();
    rmSync(dir, { recursive: true, force: true });
    iso.restore();
  });

  async function open(): Promise<Session> {
    const ref = { harness: harnesses.omp.id, key: "sess", file, cwd: dir };
    const s = await openSession({ harness: harnesses.omp, ref, config });
    sessions.push(s);
    return s;
  }

  /** u1,a1 / u2,a2 / u3,a3 where u2 recurs u1's topic and u3 is a different one. */
  async function runRecurrence(): Promise<Session> {
    fake.respond = answering({ u1: { new: "n1", title: "Login fix" }, u2: "i1", u3: { new: "n1", title: "CSV export" } });
    appendFileSync(
      file,
      owner("u1", "fix the login") +
        agent("a1", "patched login", ["bash"]) +
        owner("u2", "login is broken again") +
        agent("a2", "patched again") +
        owner("u3", "export the users to csv") +
        agent("a3", "csv export added"),
    );
    const s = await open();
    await waitFor(() => labelOf(s, "a3") !== undefined);
    return s;
  }

  test("recurrence reuses an intent; a different topic gets a new id", async () => {
    const s = await runRecurrence();
    expect(intentOf(s, "u1")).toBe("i1");
    expect(intentOf(s, "a1")).toBe("i1");
    expect(intentOf(s, "u2")).toBe("i1");
    expect(intentOf(s, "a2")).toBe("i1");
    expect(intentOf(s, "u3")).toBe("i2");
    expect(intentOf(s, "a3")).toBe("i2");
    expect(s.snapshot().intents.map((i) => i.title)).toEqual(["Login fix", "CSV export"]);
  });

  test("an owner turn and its agent turn can land in different requests; the agent turn carries fixedIntent", async () => {
    await runRecurrence();
    const firstRefs = seen(fake.requests[0]?.input).map((t) => t.ref);
    expect(firstRefs).toEqual(["u1"]);
    const later = fake.requests.slice(1).map((r) => seen(r.input));
    const a1 = later.flat().find((t) => t.ref === "a1");
    expect(a1?.fixed).toBe(true);
    expect(later.flat().some((t) => t.ref === "u1")).toBe(false);
  });

  test("a turn event arrives immediately while the labeler is still busy", async () => {
    // Real latency is the property under test here: the fake labeler must genuinely stall.
    fake.delayMs = 2000;
    fake.respond = answering({ u1: { new: "n1", title: "Slow" } });
    writeFileSync(file, owner("u1", "first question"));
    const s = await open();
    await waitFor(() => fake.requests.length === 1);
    const events: ServerEvent[] = [];
    s.subscribe((ev) => events.push(ev));
    const started = performance.now();
    appendFileSync(file, owner("u9", "second question while labeling"));
    await waitFor(() => events.some((ev) => ev.type === "turn" && ev.turn.id === "u9"), 1000);
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("an invalid kind stores nothing and emits a labeler error", async () => {
    fake.respond = (input) =>
      JSON.stringify({
        turns: seen(input).map((t) => ({ ref: t.ref, kind: "found", caption: "c", intent: { new: "n1", title: "T" } })),
      });
    writeFileSync(file, owner("u1", "hello"));
    const s = await open();
    await waitFor(() => s.snapshot().labelerError !== undefined);
    expect(s.snapshot().labelerError).toMatch(/kind not allowed for owner turn u1/);
    expect(s.snapshot().labels).toEqual([]);
    expect(s.snapshot().intents).toEqual([]);
    expect(existsSync(storeFile(harnesses.omp.id, "sess"))).toBe(false);
  });

  test("an unknown intent id stores nothing", async () => {
    fake.respond = answering({ u1: "i42" });
    writeFileSync(file, owner("u1", "hello"));
    const s = await open();
    await waitFor(() => s.snapshot().labelerError !== undefined);
    expect(s.snapshot().labelerError).toMatch(/unknown intent i42/);
    expect(s.snapshot().labels).toEqual([]);
  });

  test("intents beyond the 40 offered are not reused", async () => {
    const plan: Record<string, unknown> = {};
    let body = "";
    for (let k = 1; k <= 41; k += 1) {
      plan[`o${k}`] = { new: `n${k}`, title: `Topic ${k}` };
      body += owner(`o${k}`, `topic ${k}`);
    }
    fake.respond = answering(plan);
    writeFileSync(file, body);
    const s = await open();
    await waitFor(() => s.snapshot().intents.length === 41);
    expect(s.snapshot().intents.length).toBe(41);

    plan.o42 = "i1";
    appendFileSync(file, owner("o42", "back to the first topic"));
    await waitFor(() => s.snapshot().labelerError !== undefined);
    const lastIntents = offeredIds(fake.requests.at(-1)?.input);
    expect(lastIntents.length).toBeLessThanOrEqual(40);
    expect(lastIntents).not.toContain("i1");
    expect(s.snapshot().labelerError).toMatch(/unknown intent i1/);
    expect(labelOf(s, "o42")).toBeUndefined();
  });

  test("restart labels nothing that is already labeled", async () => {
    const first = await runRecurrence();
    expect(first.snapshot().labels.length).toBe(6);
    first.stop();

    const before = fake.requests.length;
    fake.respond = answering({ u9: { new: "n9", title: "Fresh topic" } });
    const second = await open();
    // Only a new marker turn can produce a request; waiting for its label proves the catch-up ran first.
    appendFileSync(file, owner("u9", "a brand new question"));
    await waitFor(() => labelOf(second, "u9") !== undefined);
    const sentRefs = fake.requests.slice(before).flatMap((r) => seen(r.input).map((t) => t.ref));
    expect(sentRefs).toEqual(["u9"]);
    expect(second.snapshot().labels.length).toBe(7);
  });

  test("a rename-over reset emits reset, re-emits stored labels, and keeps them", async () => {
    const s = await runRecurrence();
    const events: ServerEvent[] = [];
    s.subscribe((ev) => events.push(ev));

    const replacement = join(dir, "sess.next.jsonl");
    writeFileSync(
      replacement,
      owner("u1", "fix the login") + agent("a1", "patched login", ["bash"]) + owner("u5", "one more thing"),
    );
    renameSync(replacement, file);

    await waitFor(() => events.some((ev) => ev.type === "turn" && ev.turn.id === "u5"));
    expect(events.some((ev) => ev.type === "reset")).toBe(true);
    const relabeled = events.flatMap((ev) => (ev.type === "label" ? [ev.label.turnId] : []));
    expect(relabeled).toContain("a3");
    expect(s.snapshot().labels.length).toBe(6);
  });

  test("guest text never reaches a labeler request; the placeholder does", async () => {
    fake.respond = answering({ g1: { new: "n1", title: "Guest topic" } });
    writeFileSync(file, guest("g1", "guest secret words"));
    const s = await open();
    await waitFor(() => labelOf(s, "g1") !== undefined);
    const sent = JSON.stringify(fake.requests.map((r) => r.body));
    expect(sent).not.toContain("guest secret words");
    expect(sent).toContain(GUEST_PLACEHOLDER);
  });

  test("agent-origin trigger text never reaches a request; owner-origin trigger text does", async () => {
    fake.respond = answering({ a1: { new: "n1", title: "Agent start" }, a2: { new: "n2", title: "Owner note" } });
    writeFileSync(
      file,
      agentTrigger("m1", "zzagentzz", "AGENTBODY") +
        agentOpen("a1", "working") +
        agent("a1", "done") +
        owner("u1", "HARNESS_NOTE ownertrigger text") +
        agent("a2", "answering"),
    );
    const s = await open();
    await waitFor(() => labelOf(s, "a2") !== undefined);
    const sent = JSON.stringify(fake.requests.map((r) => r.body));
    expect(sent).not.toContain("zzagentzz");
    expect(sent).not.toContain("AGENTBODY");
    expect(sent).toContain("ownertrigger text");
  });

  test("an agent turn with no openedBy gets its own intent choice", async () => {
    fake.respond = answering({ a1: { new: "n1", title: "Unprompted work" } });
    writeFileSync(file, agent("a1", "I noticed a problem and fixed it"));
    const s = await open();
    await waitFor(() => labelOf(s, "a1") !== undefined);
    expect(intentOf(s, "a1")).toBe("i1");
    expect(s.snapshot().intents.map((i) => i.title)).toEqual(["Unprompted work"]);
  });

  test("a later turn in the same batch reuses an nK and shares its intent id", async () => {
    fake.respond = answering({ u1: { new: "n1", title: "Shared" }, u2: "n1" });
    writeFileSync(file, owner("u1", "first") + owner("u2", "second"));
    const s = await open();
    await waitFor(() => labelOf(s, "u2") !== undefined);
    expect(intentOf(s, "u1")).toBe("i1");
    expect(intentOf(s, "u2")).toBe("i1");
    expect(s.snapshot().intents.length).toBe(1);
    expect(fake.requests.length).toBe(1);
  });
});
