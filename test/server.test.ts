import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join, basename } from "node:path";
import { type Config, loadConfig } from "../src/config";
import { APP, type Daemon, startDaemon } from "../src/server";
import { type FakeLabeler, startFakeLabeler } from "./fake-labeler";
import { FIXTURE, FIXTURE_ID, isolate, waitFor } from "./support";

const REPO = join(import.meta.dir, "..");

interface Turn {
  ref: string;
  author: string;
  fixed: boolean;
}

/** The turns in a labeler input. */
function turnsOf(input: unknown): Turn[] {
  if (typeof input !== "object" || input === null || !("turns" in input)) return [];
  const list: unknown = input.turns;
  if (!Array.isArray(list)) return [];
  const out: Turn[] = [];
  for (const t of list) {
    if (typeof t !== "object" || t === null || !("ref" in t) || !("author" in t)) continue;
    if (typeof t.ref !== "string" || typeof t.author !== "string") continue;
    out.push({ ref: t.ref, author: t.author, fixed: "fixedIntent" in t });
  }
  return out;
}

/** Returns a minimal valid Decision & Path Graph JSON covering every turn in the request. */
function extractEverything(input: unknown): string {
  const refs = turnsOf(input).map((t) => t.ref);
  return JSON.stringify({
    title: "Test Session Graph",
    nodes: [
      {
        id: "g1",
        kind: "goal",
        badge: "GOAL",
        title: "Session root",
        desc: "Covered turns",
        rationaleLabel: "Context",
        rationale: "Test graph",
        turnIds: refs,
      },
    ],
    edges: [],
  });
}

interface Stream {
  lines: string[];
  close(): void;
}

/** Reads an SSE response in the background; each complete `data:` frame becomes one entry in lines. */
function openStream(url: string): Stream {
  const lines: string[] = [];
  const ctrl = new AbortController();
  const decoder = new TextDecoder();
  let buf = "";
  void (async () => {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.body) return;
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let cut = buf.indexOf("\n\n");
      while (cut !== -1) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        if (frame.startsWith("data: ")) lines.push(frame.slice("data: ".length));
        cut = buf.indexOf("\n\n");
      }
    }
  })().catch(() => {});
  return { lines, close: () => ctrl.abort() };
}

/** Status code of a GET whose Host header is set explicitly; fetch does not let tests override Host. */
function rawGet(port: number, path: string, host: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  http
    .get({ host: "127.0.0.1", port, path, headers: { Host: host } }, (res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    })
    .on("error", reject);
  return promise;
}

describe("daemon", () => {
  let iso: { root: string; restore(): void };
  let fake: FakeLabeler;
  let daemon: Daemon | undefined;
  let config: Config;
  let file: string;
  const streams: Stream[] = [];

  beforeEach(() => {
    iso = isolate();
    fake = startFakeLabeler();
    fake.respond = extractEverything;
    config = {
      harnessText: [],
      port: 0,
      idleExitMinutes: 15,
      labeler: { baseUrl: fake.url, model: "m" },
    };
    const dir = join(iso.root, "agent", "sessions", "-proj");
    mkdirSync(dir, { recursive: true });
    file = join(dir, basename(FIXTURE));
    copyFileSync(FIXTURE, file);
  });

  afterEach(() => {
    for (const s of streams.splice(0)) s.close();
    daemon?.stop();
    daemon = undefined;
    fake.stop();
    iso.restore();
  });

  test("the session page is served as HTML", async () => {
    daemon = startDaemon({ config, port: 0, onIdle: () => {} });
    const res = await fetch(`http://127.0.0.1:${daemon.port}/s/omp/${FIXTURE_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("/health identifies the app", async () => {
    daemon = startDaemon({ config, port: 0, onIdle: () => {} });
    const res = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    expect(await res.json()).toEqual({ app: APP });
  });

  test("the event stream opens with a snapshot, then delivers a new owner turn and an updated graph", async () => {
    daemon = startDaemon({ config, port: 0, onIdle: () => {} });
    const base = `http://127.0.0.1:${daemon.port}`;
    const stream = openStream(`${base}/api/s/omp/${FIXTURE_ID}/events`);
    streams.push(stream);
    await waitFor(() => stream.lines.length > 0);
    expect(stream.lines[0]).toContain('"type":"snapshot"');

    const owner = {
      type: "message",
      id: "zz000001",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: "new question" }] },
    };
    appendFileSync(file, `${JSON.stringify(owner)}\n`);
    await waitFor(() => stream.lines.some((l) => l.includes('"type":"turn"') && l.includes('"zz000001"')), 1000);
    await waitFor(() => stream.lines.some((l) => l.includes('"type":"graph"') && l.includes('"zz000001"')), 5000);
  });

  test("a request whose Host header is not loopback gets 403", async () => {
    daemon = startDaemon({ config, port: 0, onIdle: () => {} });
    expect(await rawGet(daemon.port, "/health", "evil.example")).toBe(403);
  });

  test("an unknown session key or harness gets 404 on page and stream routes", async () => {
    daemon = startDaemon({ config, port: 0, onIdle: () => {} });
    const base = `http://127.0.0.1:${daemon.port}`;
    expect((await fetch(`${base}/s/omp/no-such-session`)).status).toBe(404);
    expect((await fetch(`${base}/s/bogus/${FIXTURE_ID}`)).status).toBe(404);
    expect((await fetch(`${base}/api/s/omp/no-such-session/events`)).status).toBe(404);
  });

  test("the daemon process exits on its own once the idle window passes with no clients", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port;
    probe.stop(true);
    const cfgDir = join(iso.root, "config", "intent-prompt-graph");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ idleExitMinutes: 0.01 }));
    const proc = Bun.spawn([process.execPath, join(REPO, "src/cli.ts"), "serve", "--port", String(port)], {
      cwd: REPO,
      env: { ...process.env, XDG_CONFIG_HOME: join(iso.root, "config") },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
  });
});

describe("config port and idle window", () => {
  let iso: { root: string; restore(): void };

  beforeEach(() => {
    iso = isolate();
  });

  afterEach(() => {
    iso.restore();
  });

  /** Writes config.json under a fresh XDG_CONFIG_HOME and returns the env that points at it. */
  function envWith(obj: object): NodeJS.ProcessEnv {
    const env = { XDG_CONFIG_HOME: join(iso.root, "cfg") };
    const dir = join(env.XDG_CONFIG_HOME, "intent-prompt-graph");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(obj));
    return env;
  }

  test("defaults are port 4761 and a 15 minute idle window when no file exists", () => {
    const cfg = loadConfig({ XDG_CONFIG_HOME: join(iso.root, "empty") });
    expect(cfg.port).toBe(4761);
    expect(cfg.idleExitMinutes).toBe(15);
  });

  test("a port outside 1 to 65535 is rejected", () => {
    expect(() => loadConfig(envWith({ port: 0 }))).toThrow("config.port must be an integer from 1 to 65535");
    expect(() => loadConfig(envWith({ port: 70000 }))).toThrow("config.port must be an integer from 1 to 65535");
  });

  test("a non-positive idle window is rejected", () => {
    expect(() => loadConfig(envWith({ idleExitMinutes: 0 }))).toThrow("config.idleExitMinutes must be a positive number");
    expect(() => loadConfig(envWith({ idleExitMinutes: "x" }))).toThrow("config.idleExitMinutes must be a positive number");
  });
});
