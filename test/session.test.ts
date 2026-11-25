import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/config";
import { omp } from "../src/harness/omp";
import type { ServerEvent } from "../src/model";
import { openSession, type Session } from "../src/session";
import { type FakeLabeler, startFakeLabeler } from "./fake-labeler";
import { isolate, waitFor } from "./support";

function userRec(id: string, text: string, at: string) {
  return JSON.stringify({ type: "message", id, timestamp: at, message: { role: "user", content: [{ type: "text", text }] } });
}

function assistantRec(id: string, text: string, at: string) {
  return JSON.stringify({
    type: "message",
    id,
    timestamp: at,
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
  });
}

function headerRec(id: string) {
  return JSON.stringify({ type: "session", id, cwd: "/tmp/proj", timestamp: "2026-11-22T10:00:00.000Z" });
}

describe("session pipeline", () => {
  let iso: { root: string; restore(): void };
  let fake: FakeLabeler;
  let session: Session | undefined;
  let file: string;

  beforeEach(() => {
    iso = isolate();
    fake = startFakeLabeler();
    file = join(iso.root, "session.jsonl");
    writeFileSync(
      file,
      [
        headerRec("sess-1"),
        userRec("t1", "Force agents to read files before planning", "2026-11-22T10:00:01.000Z"),
        assistantRec("t2", "Use a pre-plan script and save hook.", "2026-11-22T10:00:05.000Z"),
      ].join("\n") + "\n",
    );
  });

  afterEach(() => {
    session?.stop();
    session = undefined;
    fake.stop();
    iso.restore();
  });

  test("serves an immediate heuristic graph with no labeler configured and zero errors", async () => {
    const config: Config = { harnessText: [], port: 4761, idleExitMinutes: 15 };
    const ref = await omp.locate({ sessionFile: file, cwd: "/tmp/proj" });
    session = await openSession({ harness: omp, ref, config });

    const snap = session.snapshot();
    expect(snap.turns).toHaveLength(2);
    expect(snap.graph.mode).toBe("heuristic");
    expect(snap.graph.nodes.length).toBeGreaterThan(0);
    expect(snap.labelerError).toBeUndefined();
  });

  test("emits turns immediately while slow LLM extractor runs, then upgrades to LLM graph and persists across restart", async () => {
    fake.delayMs = 80;
    fake.respond = () =>
      JSON.stringify({
        title: "LLM Decision Graph",
        nodes: [
          {
            id: "g1",
            kind: "goal",
            badge: "GOAL",
            title: "Enforce file reads",
            desc: "Force reading before plan",
            rationaleLabel: "Problem",
            rationale: "Avoid duplicates",
            turnIds: ["t1", "t2"],
          },
        ],
        edges: [],
      });

    const config: Config = {
      harnessText: [],
      port: 4761,
      idleExitMinutes: 15,
      labeler: { baseUrl: fake.url, model: "m" },
    };
    const ref = await omp.locate({ sessionFile: file, cwd: "/tmp/proj" });
    session = await openSession({ harness: omp, ref, config });

    const events: ServerEvent[] = [];
    session.subscribe((ev) => events.push(ev));

    // Append a new turn and verify it arrives before the slow LLM responds (I1).
    const start = Date.now();
    appendFileSync(file, `${userRec("t3", "commit time wastes tokens", "2026-11-22T10:01:00.000Z")}\n`);
    await waitFor(() => events.some((e) => e.type === "turn" && e.turn.id === "t3"), 500);
    expect(Date.now() - start).toBeLessThan(500);

    // Wait for both the initial batch (t1, t2) and the appended turn (t3) to be committed by the LLM extractor.
    await waitFor(
      () =>
        events.filter((e) => e.type === "graph" && e.graph.mode === "llm").length >= 1 &&
        fake.requests.some((r) => JSON.stringify(r.input).includes('"t3"')),
      2000,
    );
    // Wait for the in-flight request containing t3 to finish committing before restart.
    const expectedCalls = fake.requests.length;
    await waitFor(
      () => events.filter((e) => e.type === "graph" && e.graph.mode === "llm").length >= expectedCalls,
      2000,
    );
    expect(session.snapshot().graph.mode).toBe("llm");
    expect(session.snapshot().graph.title).toBe("LLM Decision Graph");

    // Restart on the same store: zero new LLM calls needed for already-processed turns.
    const callsBefore = fake.requests.length;
    session.stop();
    session = await openSession({ harness: omp, ref, config });
    await Bun.sleep(60);
    expect(session.snapshot().graph.mode).toBe("llm");
    expect(fake.requests.length).toBe(callsBefore);
  });

  test("emits labeler error on invalid LLM output while keeping heuristic graph usable", async () => {
    fake.respond = () => "not valid json";
    const config: Config = {
      harnessText: [],
      port: 4761,
      idleExitMinutes: 15,
      labeler: { baseUrl: fake.url, model: "m" },
    };
    const ref = await omp.locate({ sessionFile: file, cwd: "/tmp/proj" });
    session = await openSession({ harness: omp, ref, config });

    await waitFor(() => session?.snapshot().labelerError !== undefined, 1000);
    expect(session.snapshot().labelerError).toContain("not valid JSON");
    expect(session.snapshot().graph.mode).toBe("heuristic");
    expect(session.snapshot().graph.nodes.length).toBeGreaterThan(0);
  });

  test("atomic rename triggers reset and replays turns cleanly", async () => {
    const config: Config = { harnessText: [], port: 4761, idleExitMinutes: 15 };
    const ref = await omp.locate({ sessionFile: file, cwd: "/tmp/proj" });
    session = await openSession({ harness: omp, ref, config });

    const events: ServerEvent[] = [];
    session.subscribe((ev) => events.push(ev));

    const tmp = join(iso.root, "rewrite.jsonl");
    writeFileSync(tmp, `${headerRec("sess-1")}\n${userRec("t9", "Fresh start", "2026-11-22T11:00:00.000Z")}\n`);
    renameSync(tmp, file);

    await waitFor(() => events.some((e) => e.type === "reset"), 1500);
    await waitFor(() => session?.snapshot().turns.some((t) => t.id === "t9") === true, 1500);
  });
});
