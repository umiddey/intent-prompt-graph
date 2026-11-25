import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/config";
import { claude } from "../src/harness/claude";
import type { SessionRef } from "../src/harness/harness";
import type { Turn } from "../src/model";
import { tailJsonl } from "../src/tail";
import { type Isolation, isolate } from "./support";

const FIXTURE_ID = "0000cccc-0000-4000-8000-000000000001";
const OTHER_ID = "0000dddd-0000-4000-8000-000000000002";
const FIXTURE = join(import.meta.dir, "fixtures/claude/projects/-proj", `${FIXTURE_ID}.jsonl`);
const REF: SessionRef = { harness: "claude", key: FIXTURE_ID, file: FIXTURE, cwd: "/proj" };

const cfg = (...patterns: string[]): Config => ({
  harnessText: patterns.map((p) => new RegExp(p)),
  port: 4761,
  idleExitMinutes: 15,
});

/** Feeds records through the Claude Code reader; the last version of each turn wins, in first-seen order. */
function fold(records: unknown[], config: Config = cfg()): Turn[] {
  const reader = claude.reader(REF, { config });
  const byId = new Map<string, Turn>();
  for (const r of records) for (const t of reader.push(r)) byId.set(t.id, t);
  return [...byId.values()];
}

const stamp = "2026-11-22T10:00:00.000Z";

/** A user-channel record; `extra` holds the flags Claude Code adds (origin, promptSource, isMeta ...). */
const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  uuid,
  timestamp: stamp,
  isSidechain: false,
  message: { role: "user", content },
  ...extra,
});

/** A prompt the owner typed, as Claude Code records it. */
const typed = (uuid: string, content: unknown) =>
  user(uuid, content, { origin: { kind: "human" }, promptSource: "typed" });

/** Tool output: it comes back in the user channel. */
const result = (uuid: string, output: string) =>
  user(uuid, [{ type: "tool_result", tool_use_id: "toolu_1", content: output }], { toolUseResult: { stdout: output } });

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
const text = (t: string): Block => ({ type: "text", text: t });
const thinking: Block = { type: "thinking", thinking: "hidden reasoning" };
const tool = (name: string, input: Record<string, unknown>): Block => ({
  type: "tool_use",
  id: `toolu_${name}`,
  name,
  input,
});

/**
 * One assistant record. Claude Code writes one content block per record; the blocks of one reply
 * share the API message id `msg`, and each record repeats the reply's stop reason.
 */
function asst(uuid: string, block: Block, o: { stop?: string; msg?: string } = {}) {
  return {
    type: "assistant",
    uuid,
    timestamp: stamp,
    isSidechain: false,
    message: {
      id: o.msg ?? `msg_${uuid}`,
      role: "assistant",
      model: "claude-test",
      content: [block],
      stop_reason: o.stop ?? "end_turn",
    },
  };
}

/** A message that arrived while the agent was working. */
const queued = (uuid: string, prompt: string, kind: string) => ({
  type: "attachment",
  uuid,
  timestamp: stamp,
  attachment: { type: "queued_command", prompt, commandMode: "prompt", origin: { kind } },
});

const turnDone = (uuid: string) => ({ type: "system", subtype: "turn_duration", uuid, timestamp: stamp });

/** Copies the fixture into the isolated Claude Code projects dir and returns the copy's path. */
function installFixture(root: string, project = "-proj"): string {
  const dir = join(root, "claude", "projects", project);
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, `${FIXTURE_ID}.jsonl`);
  copyFileSync(FIXTURE, copy);
  return copy;
}

/** Writes a second session (OTHER_ID) into a project dir, with its file time set to `mtime`. */
function installOther(root: string, mtime: Date, project = "-proj"): string {
  const dir = join(root, "claude", "projects", project);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${OTHER_ID}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ ...typed("o1", "other"), cwd: "/proj", sessionId: OTHER_ID })}\n`);
  utimesSync(file, mtime, mtime);
  return file;
}

/** Registers a running Claude Code process the way it does itself: sessions/<pid>.json. */
function register(root: string, pid: number, sessionId: string) {
  const dir = join(root, "claude", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: "/proj", kind: "interactive" }));
}

/** Writes records as a session file outside the projects dir and returns its path. */
function sessionFile(root: string, name: string, records: unknown[]): string {
  const file = join(root, name);
  writeFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
  return file;
}

const PAST = new Date("2020-01-01T00:00:00Z");
const FUTURE = new Date("2099-01-01T00:00:00Z");

let iso: Isolation;
let savedDir: string | undefined;
beforeEach(() => {
  iso = isolate();
  savedDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(iso.root, "claude");
});
afterEach(() => {
  if (savedDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedDir;
  iso.restore();
});

describe("claude reader", () => {
  test("skips bookkeeping records and records that are not conversation", () => {
    expect(
      fold([
        { type: "permission-mode", permissionMode: "default", sessionId: FIXTURE_ID },
        { type: "ai-title", aiTitle: "x", sessionId: FIXTURE_ID },
        { type: "file-history-snapshot", messageId: "m", snapshot: {} },
        { type: "attachment", uuid: "a1", timestamp: stamp, attachment: { type: "environment", content: "x" } },
        { type: "system", subtype: "local_command", uuid: "s1", timestamp: stamp, content: "x" },
      ]),
    ).toEqual([]);
  });

  test("plain exchange: owner turn, then the agent turn it opened", () => {
    expect(fold([typed("u1", "Q"), asst("a1", text("A"))])).toEqual([
      { id: "u1", author: "owner", at: Date.parse(stamp), text: "Q", actions: [], open: false },
      { id: "a1", author: "agent", at: Date.parse(stamp), text: "A", actions: [], open: false, openedBy: "u1" },
    ]);
  });

  test("records without origin fields: plain text is an owner turn, a leading wrapper tag is not", () => {
    const turns = fold([user("u1", "hello"), user("u2", "<bash-input>ls</bash-input>")]);
    expect(turns.map((t) => [t.id, t.author, t.text])).toEqual([["u1", "owner", "hello"]]);
  });

  test("one reply split across records and a tool round trip is one agent turn", () => {
    const turns = fold([
      typed("u1", "Why does it fail?"),
      asst("a1", thinking, { msg: "m1", stop: "tool_use" }),
      asst("a2", text("Let me check."), { msg: "m1", stop: "tool_use" }),
      asst("a3", tool("Bash", { command: "bun run build", description: "Run the build" }), {
        msg: "m1",
        stop: "tool_use",
      }),
      result("r1", "secret tool output"),
      asst("a4", text("The import path is wrong.")),
    ]);
    expect(turns.map((t) => [t.id, t.author, t.open])).toEqual([
      ["u1", "owner", false],
      ["a1", "agent", false],
    ]);
    expect(turns[1]?.text).toBe("Let me check.\nThe import path is wrong.");
    expect(turns[1]?.actions).toEqual([{ tool: "Bash", summary: "Run the build" }]);
    expect(turns[1]?.openedBy).toBe("u1");
    expect(JSON.stringify(turns)).not.toContain("secret tool output");
    expect(JSON.stringify(turns)).not.toContain("hidden reasoning");
  });

  test("tool results never become owner turns", () => {
    expect(fold([result("r1", "out")])).toEqual([]);
  });

  test("the agent turn stays open across tool calls and closes at end_turn", () => {
    const working = [
      typed("u1", "Go"),
      asst("a1", tool("Bash", { command: "ls" }), { stop: "tool_use" }),
      result("r1", "out"),
    ];
    expect(fold(working)[1]?.open).toBe(true);
    expect(fold([...working, asst("a2", text("Done"))])[1]?.open).toBe(false);
  });

  test("a thinking record that already carries end_turn does not end the turn; the text record does", () => {
    const records = [typed("u1", "Say OK"), asst("a1", thinking, { msg: "m1" }), asst("a2", text("OK"), { msg: "m1" })];
    expect(fold(records.slice(0, 2)).map((t) => [t.id, t.open, t.text])).toEqual([
      ["u1", false, "Say OK"],
      ["a1", true, ""],
    ]);
    expect(fold(records).map((t) => [t.id, t.open, t.text])).toEqual([
      ["u1", false, "Say OK"],
      ["a1", false, "OK"],
    ]);
  });

  test("a later block of the reply that ended the turn extends that turn", () => {
    const turns = fold([asst("a1", text("one"), { msg: "m1" }), asst("a2", text("two"), { msg: "m1" })]);
    expect(turns.map((t) => [t.id, t.open, t.text])).toEqual([["a1", false, "one\ntwo"]]);
  });

  test("turn_duration closes the open agent turn", () => {
    const turns = fold([asst("a1", text("x"), { stop: "tool_use" }), turnDone("s1"), asst("a2", text("y"))]);
    expect(turns.map((t) => [t.id, t.open])).toEqual([
      ["a1", false],
      ["a2", false],
    ]);
  });

  test("the interrupt marker closes the agent turn and is neither an owner turn nor a trigger", () => {
    const turns = fold([
      typed("u1", "Go"),
      asst("a1", text("Working"), { stop: "tool_use" }),
      user("u2", [{ type: "text", text: "[Request interrupted by user for tool use]" }]),
      asst("a2", text("Stopped")),
    ]);
    expect(turns.map((t) => [t.id, t.author, t.open])).toEqual([
      ["u1", "owner", false],
      ["a1", "agent", false],
      ["a2", "agent", false],
    ]);
    expect(turns[2]?.trigger).toBeUndefined();
  });

  test("an error notice Claude Code wrote itself closes the turn without adding text", () => {
    const notice = asst("a2", text("API Error: overloaded"), { stop: "stop_sequence" });
    const turns = fold([
      typed("u1", "Go"),
      asst("a1", text("Working"), { stop: "tool_use" }),
      { ...notice, isApiErrorMessage: true, message: { ...notice.message, model: "<synthetic>" } },
    ]);
    expect(turns.map((t) => [t.id, t.open, t.text])).toEqual([
      ["u1", false, "Go"],
      ["a1", false, "Working"],
    ]);
  });

  test("meta, compact-summary and transcript-only records are ignored", () => {
    const turns = fold([
      user("m1", "Expanded command prompt", { isMeta: true }),
      user("m2", "Summary of the earlier conversation", { isCompactSummary: true }),
      user("m3", "Shown in the transcript only", { isVisibleInTranscriptOnly: true }),
      asst("a1", text("A")),
    ]);
    expect(turns.map((t) => t.id)).toEqual(["a1"]);
    expect(turns[0]?.trigger).toBeUndefined();
    expect(turns[0]?.openedBy).toBeUndefined();
  });

  test("an idle slash command becomes the next trigger; its wrapper never appears as a turn", () => {
    const command = "<command-message>ipg-log</command-message>\n<command-name>/ipg-log</command-name>";
    const turns = fold([
      asst("a1", text("Done")),
      user("u2", command, { origin: { kind: "human" } }),
      user("m3", "Expanded command prompt", { isMeta: true }),
      asst("a4", text("Wrote it")),
    ]);
    expect(turns.map((t) => t.id)).toEqual(["a1", "a4"]);
    expect(turns[1]?.trigger).toEqual({ from: "owner", text: command });
    expect(turns[1]?.openedBy).toBeUndefined();
    expect(turns.some((t) => t.text.includes("ipg-log"))).toBe(false);
  });

  test("wrapper text mid-turn is ignored, not a split", () => {
    const turns = fold([
      typed("u1", "Start"),
      asst("a1", text("Starting"), { stop: "tool_use" }),
      user("u2", "<system-reminder>x</system-reminder>"),
      asst("a2", text("more")),
    ]);
    expect(turns.map((t) => t.id)).toEqual(["u1", "a1"]);
    expect(turns[1]?.text).toBe("Starting\nmore");
    expect(turns[1]?.trigger).toBeUndefined();
  });

  test("text with a non-human origin is harness text even without a wrapper", () => {
    const turns = fold([
      asst("a1", text("Done")),
      user("u2", "Background job finished", { origin: { kind: "task-notification" } }),
      asst("a3", text("Thanks")),
    ]);
    expect(turns.map((t) => t.id)).toEqual(["a1", "a3"]);
    expect(turns[1]?.trigger).toEqual({ from: "owner", text: "Background job finished" });
  });

  test("a typed prompt that starts with a tag is still an owner turn", () => {
    const turns = fold([typed("u1", "<b>hi</b> what does this do?")]);
    expect(turns.map((t) => [t.author, t.text])).toEqual([["owner", "<b>hi</b> what does this do?"]]);
  });

  test("wrapper blocks beside typed text are dropped from the owner turn", () => {
    const turns = fold([
      typed("u1", [
        { type: "text", text: "<ide_opened_file>a.ts</ide_opened_file>" },
        { type: "text", text: "Fix this" },
      ]),
    ]);
    expect(turns[0]?.text).toBe("Fix this");
  });

  test("an idle trigger is capped at 400 chars", () => {
    const full = `<task-notification>${"x".repeat(1000)}`;
    const turns = fold([user("u1", full), asst("a1", text("ok"))]);
    expect(turns[0]?.trigger).toEqual({ from: "owner", text: full.slice(0, 400) });
  });

  test("an owner turn clears a pending trigger", () => {
    const turns = fold([
      user("u1", "<local-command-stdout>a</local-command-stdout>"),
      typed("u2", "hello"),
      asst("a1", text("hi")),
    ]);
    expect(turns.map((t) => t.id)).toEqual(["u2", "a1"]);
    expect(turns[1]?.openedBy).toBe("u2");
    expect(turns[1]?.trigger).toBeUndefined();
  });

  test("a message queued mid-turn splits the agent turn: the steer opens the next one", () => {
    const turns = fold([
      typed("u1", "Go"),
      asst("a1", tool("Bash", { command: "sleep 9" }), { stop: "tool_use" }),
      result("r1", "out"),
      queued("q1", "Also do X", "human"),
      asst("a2", text("Ok")),
    ]);
    expect(turns.map((t) => [t.id, t.author, t.open, t.openedBy])).toEqual([
      ["u1", "owner", false, undefined],
      ["a1", "agent", false, "u1"],
      ["q1", "owner", false, undefined],
      ["a2", "agent", false, "q1"],
    ]);
    expect(turns[2]?.text).toBe("Also do X");
  });

  test("a queued notification mid-turn is ignored, not a split", () => {
    const turns = fold([
      typed("u1", "Go"),
      asst("a1", text("Working"), { stop: "tool_use" }),
      queued("q1", "<task-notification>done</task-notification>", "task-notification"),
      asst("a2", text("more")),
    ]);
    expect(turns.map((t) => t.id)).toEqual(["u1", "a1"]);
    expect(turns[1]?.text).toBe("Working\nmore");
  });

  test("sidechain records are skipped", () => {
    const turns = fold([
      typed("u1", "Q"),
      { ...user("s1", "subagent prompt"), isSidechain: true },
      { ...asst("s2", text("subagent reply")), isSidechain: true },
      asst("a1", text("A")),
    ]);
    expect(turns.map((t) => t.id)).toEqual(["u1", "a1"]);
    expect(JSON.stringify(turns)).not.toContain("subagent");
  });

  test("config harnessText marks plain user text as harness text", () => {
    const turns = fold(
      [asst("a1", text("Done")), user("u2", "[cron] nightly check"), asst("a3", text("ok"))],
      cfg("^\\[cron\\]"),
    );
    expect(turns.map((t) => t.id)).toEqual(["a1", "a3"]);
    expect(turns[1]?.trigger).toEqual({ from: "owner", text: "[cron] nightly check" });
  });

  test("owner text blocks join with newlines; images show as [image]", () => {
    const turns = fold([typed("u1", [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])]);
    expect(turns[0]?.text).toBe("a\n[image]\nb");
  });

  test("tool summary: input.description, then first string input, capped at 120", () => {
    const more = { msg: "m1", stop: "tool_use" };
    const turns = fold([
      asst("a1", tool("Bash", { command: "c", description: "Run it" }), more),
      asst("a2", tool("Read", { file_path: "/x", limit: 5 }), more),
      asst("a3", tool("Grep", { pattern: "x".repeat(200) }), more),
      asst("a4", tool("TodoWrite", { todos: [] }), more),
    ]);
    expect(turns.map((t) => t.id)).toEqual(["a1"]);
    expect(turns[0]?.actions).toEqual([
      { tool: "Bash", summary: "Run it" },
      { tool: "Read", summary: "/x" },
      { tool: "Grep", summary: "x".repeat(120) },
      { tool: "TodoWrite", summary: "" },
    ]);
  });

  test("replays the fixture: 4 turns; tool output, thinking and sidechain text never shown", async () => {
    const recs: unknown[] = [];
    await tailJsonl(
      FIXTURE,
      (e) => {
        if (e.type === "record") recs.push(e.record);
      },
      { follow: false },
    );
    const turns = fold(recs);
    expect(turns.map((t) => [t.id, t.author, t.open])).toEqual([
      ["c0000001", "owner", false],
      ["c0000002", "agent", false],
      ["c000000c", "owner", false],
      ["c000000d", "agent", false],
    ]);
    expect(turns[1]?.openedBy).toBe("c0000001");
    expect(turns[3]?.openedBy).toBe("c000000c");
    expect(turns[1]?.text).toBe("Let me check.\nThe import path is wrong.");
    expect(turns[1]?.actions).toEqual([{ tool: "Bash", summary: "Run the build" }]);
    expect(turns[3]?.text).toBe("Fixed the import.");
    expect(turns[3]?.actions).toEqual([{ tool: "Edit", summary: "/proj/src/a.ts" }]);
    expect(turns[3]?.trigger).toBeUndefined();
    expect(JSON.stringify(turns)).not.toMatch(/fixture (tool output|thinking|sidechain|caveat)|command-name/);
  });
});

describe("claude locate and resolve", () => {
  test("locate: an explicit session file wins", async () => {
    const ref = await claude.locate({ sessionFile: FIXTURE, cwd: "/elsewhere" });
    expect(ref).toEqual({
      harness: "claude",
      key: FIXTURE_ID,
      file: FIXTURE,
      cwd: "/proj",
      title: "Fix the failing build",
    });
  });

  test("locate: the session of the Claude Code process above us wins over the cwd match", async () => {
    const copy = installFixture(iso.root, "-somewhere-else");
    installOther(iso.root, FUTURE);
    register(iso.root, process.ppid, FIXTURE_ID);
    const ref = await claude.locate({ cwd: "/proj" });
    expect(ref.file).toBe(copy);
    expect(ref.key).toBe(FIXTURE_ID);
  });

  test("locate: a registered session with no transcript is an error, not another session", async () => {
    installFixture(iso.root);
    register(iso.root, process.ppid, OTHER_ID);
    await expect(claude.locate({ cwd: "/proj" })).rejects.toThrow(
      new RegExp(`session ${OTHER_ID} \\(pid ${process.ppid}\\) has no transcript yet`),
    );
  });

  test("locate: without a registered process, the newest session of the cwd", async () => {
    const copy = installFixture(iso.root);
    installOther(iso.root, PAST);
    expect((await claude.locate({ cwd: "/proj" })).file).toBe(copy);
    const other = installOther(iso.root, FUTURE);
    expect((await claude.locate({ cwd: "/proj" })).file).toBe(other);
  });

  test("locate: every character of the cwd that is not a letter or digit maps to a dash", async () => {
    const copy = installFixture(iso.root, "-my-proj-a-b");
    expect((await claude.locate({ cwd: "/my proj/a.b" })).file).toBe(copy);
  });

  test("locate: the error names every place it looked", async () => {
    installFixture(iso.root);
    await expect(claude.locate({ cwd: "/nope" })).rejects.toThrow(/sessions\/<pid>\.json[\s\S]*projects\/-nope/);
  });

  test("locate: a renamed copy takes its key from the records", async () => {
    const copy = join(iso.root, "copy.jsonl");
    copyFileSync(FIXTURE, copy);
    expect((await claude.locate({ sessionFile: copy, cwd: "/" })).key).toBe(FIXTURE_ID);
  });

  test("locate: a file without session records is rejected", async () => {
    const file = sessionFile(iso.root, "empty.jsonl", [{ type: "permission-mode", permissionMode: "default" }]);
    await expect(claude.locate({ sessionFile: file, cwd: "/" })).rejects.toThrow(/no Claude Code session records/);
  });

  test("title: the owner's title wins over the generated one; the last record of a kind wins", async () => {
    const head = { ...typed("u1", "hi"), cwd: "/proj", sessionId: FIXTURE_ID };
    const generated = sessionFile(iso.root, "generated.jsonl", [
      head,
      { type: "ai-title", aiTitle: "First guess", sessionId: FIXTURE_ID },
      { type: "ai-title", aiTitle: "Second guess", sessionId: FIXTURE_ID },
    ]);
    expect((await claude.locate({ sessionFile: generated, cwd: "/" })).title).toBe("Second guess");
    const renamed = sessionFile(iso.root, "renamed.jsonl", [
      head,
      { type: "custom-title", customTitle: "My name", sessionId: FIXTURE_ID },
      { type: "ai-title", aiTitle: "Later guess", sessionId: FIXTURE_ID },
    ]);
    expect((await claude.locate({ sessionFile: renamed, cwd: "/" })).title).toBe("My name");
    const untitled = sessionFile(iso.root, "untitled.jsonl", [head]);
    expect((await claude.locate({ sessionFile: untitled, cwd: "/" })).title).toBeUndefined();
  });

  test("resolve: finds the session file by key", async () => {
    const copy = installFixture(iso.root);
    const ref = await claude.resolve(FIXTURE_ID);
    expect(ref.file).toBe(copy);
    expect(ref.cwd).toBe("/proj");
  });

  test("resolve: rejects keys that are not a session id", async () => {
    await expect(claude.resolve("../x")).rejects.toThrow(/invalid Claude Code session key/);
    await expect(claude.resolve("*")).rejects.toThrow(/invalid Claude Code session key/);
  });

  test("resolve: unknown key names the projects dir", async () => {
    installFixture(iso.root);
    await expect(claude.resolve(OTHER_ID)).rejects.toThrow(
      new RegExp(`no Claude Code session with key ${OTHER_ID} under .*claude/projects`),
    );
  });
});
