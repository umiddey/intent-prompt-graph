import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Config, loadConfig } from "../src/config";
import type { SessionRef } from "../src/harness/harness";
import { omp } from "../src/harness/omp";
import type { Turn } from "../src/model";
import { tailJsonl } from "../src/tail";
import { FIXTURE, FIXTURE_ID, type Isolation, isolate } from "./support";

const REF: SessionRef = { harness: "omp", key: FIXTURE_ID, file: FIXTURE, cwd: "/proj" };

const cfg = (...patterns: string[]): Config => ({ harnessText: patterns.map((p) => new RegExp(p)) });

/** Feeds records through the OMP reader; the last version of each turn wins, in first-seen order. */
function fold(records: unknown[], config: Config = cfg()): Turn[] {
  const reader = omp.reader(REF, { config });
  const byId = new Map<string, Turn>();
  for (const r of records) for (const t of reader.push(r)) byId.set(t.id, t);
  return [...byId.values()];
}

const stamp = "2026-11-22T10:00:00.000Z";
const user = (id: string, content: unknown) => ({
  type: "message",
  id,
  timestamp: stamp,
  message: { role: "user", content },
});

type ToolSpec = { name: string; arguments: Record<string, unknown> };
function asst(id: string, o: { text?: string; tools?: ToolSpec[]; stop?: string } = {}) {
  const content = [
    ...(o.text ? [{ type: "text", text: o.text }] : []),
    ...(o.tools ?? []).map((t) => ({ type: "toolCall", id: `${id}-${t.name}`, name: t.name, arguments: t.arguments })),
  ];
  return {
    type: "message",
    id,
    timestamp: stamp,
    message: { role: "assistant", content, stopReason: o.stop ?? "stop" },
  };
}

function customMsg(
  id: string,
  fields: { customType: string; display: boolean; attribution?: string; content?: unknown },
) {
  return { type: "custom_message", id, timestamp: stamp, ...fields };
}

/** Copies the fixture into the isolated OMP sessions dir (cwd /proj) and returns the copy's path. */
function installFixture(root: string): string {
  const dir = join(root, "agent", "sessions", "-proj");
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, basename(FIXTURE));
  copyFileSync(FIXTURE, copy);
  return copy;
}

/** Writes a terminal breadcrumb: line 1 cwd, line 2 the session file. */
function breadcrumb(root: string, name: string, target: string) {
  const dir = join(root, "agent", "terminal-sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `/proj\n${target}\n`);
}

/** Writes the user config file under the isolated XDG config dir. */
function writeConfig(root: string, text: string) {
  const dir = join(root, "intent-prompt-graph");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), text);
}

let iso: Isolation;
beforeEach(() => {
  iso = isolate();
});
afterEach(() => iso.restore());

describe("omp reader", () => {
  test("skips title and session records", () => {
    expect(fold([{ type: "title", id: "t", title: "x" }, { type: "session", id: "s", cwd: "/" }])).toEqual([]);
  });

  test("plain exchange: owner turn, then the agent turn it opened", () => {
    expect(fold([user("e1", "Q"), asst("e2", { text: "A" })])).toEqual([
      { id: "e1", author: "owner", at: Date.parse(stamp), text: "Q", actions: [], open: false },
      { id: "e2", author: "agent", at: Date.parse(stamp), text: "A", actions: [], open: false, openedBy: "e1" },
    ]);
  });

  test("steering splits the agent turn: the steer opens the next one", () => {
    const turns = fold([
      user("e1", "Go"),
      asst("e2", { text: "Working", stop: "toolUse" }),
      user("e3", "Also do X"),
      asst("e4", { text: "Ok" }),
    ]);
    expect(turns.map((t) => [t.id, t.author, t.open, t.openedBy])).toEqual([
      ["e1", "owner", false, undefined],
      ["e2", "agent", false, "e1"],
      ["e3", "owner", false, undefined],
      ["e4", "agent", false, "e3"],
    ]);
  });

  test("idle async-result becomes the next trigger; its text never appears as a turn", () => {
    const turns = fold(
      [asst("e1", { text: "Done" }), user("e2", "<async-result>job 1 finished</async-result>"), asst("e3", { text: "Thanks" })],
      cfg("^<async-result"),
    );
    expect(turns.map((t) => t.id)).toEqual(["e1", "e3"]);
    expect(turns[1]?.trigger).toEqual({ from: "owner", text: "<async-result>job 1 finished</async-result>" });
    expect(turns.some((t) => t.text.includes("job 1 finished"))).toBe(false);
  });

  test("async-result mid-turn is ignored, not a split", () => {
    const turns = fold(
      [
        user("e1", "Start"),
        asst("e2", { text: "Starting", stop: "toolUse" }),
        user("e3", "<async-result>x</async-result>"),
        asst("e4", { text: "more" }),
      ],
      cfg("^<async-result"),
    );
    expect(turns.map((t) => t.id)).toEqual(["e1", "e2"]);
    expect(turns[1]?.text).toBe("Starting\nmore");
    expect(turns[1]?.trigger).toBeUndefined();
  });

  test("idle harnessText trigger is capped at 400 chars", () => {
    const full = `<async-result>${"x".repeat(1000)}`;
    const turns = fold([user("e1", full), asst("e2", { text: "ok" })], cfg("^<async-result"));
    expect(turns[0]?.trigger).toEqual({ from: "owner", text: full.slice(0, 400) });
  });

  test("an owner turn clears a pending trigger", () => {
    const turns = fold(
      [user("e1", "<async-result>a</async-result>"), user("e2", "hello"), asst("e3", { text: "hi" })],
      cfg("^<async-result"),
    );
    expect(turns.map((t) => t.id)).toEqual(["e2", "e3"]);
    expect(turns[1]?.openedBy).toBe("e2");
    expect(turns[1]?.trigger).toBeUndefined();
  });

  test("display:false custom messages are ignored", () => {
    const turns = fold([
      customMsg("c1", { customType: "x", display: false, attribution: "agent", content: "hidden" }),
      customMsg("c2", { customType: "y", display: false, attribution: "user", content: "hidden2" }),
      asst("e3", { text: "A" }),
    ]);
    expect(turns.map((t) => t.id)).toEqual(["e3"]);
    expect(turns[0]?.trigger).toBeUndefined();
    expect(turns[0]?.openedBy).toBeUndefined();
  });

  test("collab-prompt from the user attribution becomes a guest owner turn", () => {
    const turns = fold([
      customMsg("c1", { customType: "collab-prompt", display: true, attribution: "user", content: "Please review" }),
      asst("e2", { text: "Reviewing" }),
    ]);
    expect(turns.map((t) => [t.id, t.author, t.guest, t.text])).toEqual([
      ["c1", "owner", true, "Please review"],
      ["e2", "agent", undefined, "Reviewing"],
    ]);
    expect(turns[1]?.openedBy).toBe("c1");
  });

  test("agent-attributed custom message becomes the next trigger", () => {
    const turns = fold([
      customMsg("c1", { customType: "async-done", display: true, attribution: "agent", content: "x" }),
      asst("e2", { text: "ok" }),
    ]);
    expect(turns[0]?.trigger).toEqual({ from: "agent", type: "async-done" });
    expect(turns[0]?.openedBy).toBeUndefined();
  });

  test("aborted stop reason closes the agent turn", () => {
    const turns = fold([asst("e1", { text: "x", stop: "aborted" }), asst("e2", { text: "y" })]);
    expect(turns.map((t) => [t.id, t.open])).toEqual([
      ["e1", false],
      ["e2", false],
    ]);
  });

  test("session_exit closes the open agent turn", () => {
    const turns = fold([
      asst("e1", { text: "x", stop: "toolUse" }),
      { type: "custom", id: "c1", customType: "session_exit", timestamp: stamp },
    ]);
    expect(turns.map((t) => [t.id, t.open])).toEqual([["e1", false]]);
  });

  test("owner text blocks join with newlines; images show as [image]", () => {
    const turns = fold([user("e1", [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])]);
    expect(turns[0]?.text).toBe("a\n[image]\nb");
  });

  test("tool summary: arguments.i, then description, then first string arg, capped at 120", () => {
    const turns = fold([
      asst("e1", {
        tools: [
          { name: "bash", arguments: { i: "Run it", description: "d", command: "c" } },
          { name: "read", arguments: { description: "Read file", path: "/x" } },
          { name: "edit", arguments: { path: "/p", content: "z" } },
          { name: "grep", arguments: { i: "x".repeat(200) } },
        ],
      }),
    ]);
    expect(turns[0]?.actions).toEqual([
      { tool: "bash", summary: "Run it" },
      { tool: "read", summary: "Read file" },
      { tool: "edit", summary: "/p" },
      { tool: "grep", summary: "x".repeat(120) },
    ]);
  });

  test("replays the fixture: 4 turns, tool output never shown", async () => {
    const recs: unknown[] = [];
    await tailJsonl(
      FIXTURE,
      (e) => {
        if (e.type === "record") recs.push(e.record);
      },
      { follow: false },
    );
    const turns = fold(recs);
    expect(turns.map((t) => [t.id, t.author])).toEqual([
      ["e0000001", "owner"],
      ["e0000002", "agent"],
      ["e0000005", "owner"],
      ["e0000006", "agent"],
    ]);
    expect(turns[1]?.openedBy).toBe("e0000001");
    expect(turns[3]?.openedBy).toBe("e0000005");
    expect(turns[1]?.text).toBe("Let me check.\nThe import path is wrong.");
    expect(turns[1]?.actions).toEqual([{ tool: "bash", summary: "Run the build" }]);
    expect(JSON.stringify(turns)).not.toContain("fixture tool output");
  });
});

describe("omp locate and resolve", () => {
  test("locate: an explicit session file wins", async () => {
    const ref = await omp.locate({ sessionFile: FIXTURE, cwd: "/elsewhere" });
    expect(ref.key).toBe(FIXTURE_ID);
    expect(ref.file).toBe(FIXTURE);
  });

  test("locate: a breadcrumb target wins over the cwd match", async () => {
    const copy = installFixture(iso.root);
    breadcrumb(iso.root, "pts-9", copy);
    const ref = await omp.locate({ tty: "/dev/pts/9", cwd: "/elsewhere" });
    expect(ref.file).toBe(copy);
    expect(ref.key).toBe(FIXTURE_ID);
  });

  test("locate: a breadcrumb to a missing file falls back to the cwd match", async () => {
    const copy = installFixture(iso.root);
    breadcrumb(iso.root, "pts-9", join(iso.root, "gone.jsonl"));
    const ref = await omp.locate({ tty: "/dev/pts/9", cwd: "/proj" });
    expect(ref.file).toBe(copy);
  });

  test("locate: the error names every place it looked", async () => {
    installFixture(iso.root);
    await expect(omp.locate({ tty: "/dev/pts/9", cwd: "/nope" })).rejects.toThrow(/pts-9[\s\S]*cwd \/nope/);
  });

  test("resolve: finds the session file by key", async () => {
    const copy = installFixture(iso.root);
    const ref = await omp.resolve(FIXTURE_ID);
    expect(ref.file).toBe(copy);
  });

  test("resolve: rejects keys with path characters", async () => {
    await expect(omp.resolve("../x")).rejects.toThrow(/invalid OMP session key/);
  });

  test("resolve: unknown key names the sessions dir", async () => {
    installFixture(iso.root);
    await expect(omp.resolve("0000bbbb-0000-7000-8000-000000000002")).rejects.toThrow(/no OMP session with key/);
  });
});

describe("loadConfig", () => {
  test("missing file means no harnessText rules", () => {
    expect(loadConfig({ XDG_CONFIG_HOME: iso.root }).harnessText).toEqual([]);
  });

  test("compiles harnessText regex strings", () => {
    writeConfig(iso.root, '{"harnessText":["^<async-result"]}');
    expect(loadConfig({ XDG_CONFIG_HOME: iso.root }).harnessText[0]?.test("<async-result>x")).toBe(true);
  });

  test("rejects non-string entries", () => {
    writeConfig(iso.root, '{"harnessText":[1]}');
    expect(() => loadConfig({ XDG_CONFIG_HOME: iso.root })).toThrow(/must be an array of regex strings/);
  });

  test("rejects an invalid regex", () => {
    writeConfig(iso.root, '{"harnessText":["("]}');
    expect(() => loadConfig({ XDG_CONFIG_HOME: iso.root })).toThrow();
  });
});
