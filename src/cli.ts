#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { configFile, type Config, type LabelerConfig, loadConfig } from "./config";
import { renderDecisionLog } from "./export";
import { type Harness, harnessById, type SessionRef } from "./harness/harness";
import { buildHeuristicGraph } from "./heuristic";
import type { Turn } from "./model";
import { APP, startDaemon } from "./server";
import { setupClaude, uninstall, writeLabeler } from "./setup";
import { openStore } from "./store";
import { tailJsonl } from "./tail";

const USAGE = [
  "usage: ipg turns --harness omp|claude --session-file <file.jsonl>",
  "       ipg serve [--port N]",
  "       ipg open [--harness omp|claude] [--session-file <file.jsonl>] [--no-browser] [--port N]",
  "       ipg log [--harness omp|claude] [--session-file <file.jsonl>] [--rejected] [--out <file.md>]",
  "       ipg setup claude",
  "       ipg setup labeler --provider claude-cli|openai --model <name> [--base-url <url>] [--api-key-env <VAR>] [--command <path>]",
  "       ipg setup labeler --off",
  "       ipg uninstall [--purge]",
].join("\n");

// The reader closed the pipe (e.g. `| head`): exit quietly, as other Unix tools do.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  console.error(`ipg: ${err.message}`);
  process.exit(1);
});

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function parsePort(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port must be an integer from 1 to 65535`);
  return n;
}

function portOf(args: string[], config: Config): number {
  const value = flag(args, "--port");
  return value === undefined ? config.port : parsePort(value);
}

/** Reads the whole session file once and returns its turns in first-appearance order. */
async function readTurns(harness: Harness, ref: SessionRef, config: Config): Promise<Turn[]> {
  let reader = harness.reader(ref, { config });
  const byId = new Map<string, Turn>();
  await tailJsonl(
    ref.file,
    (ev) => {
      if (ev.type === "reset") {
        reader = harness.reader(ref, { config });
        byId.clear();
        return;
      }
      for (const t of reader.push(ev.record)) byId.set(t.id, t);
    },
    { follow: false },
  );
  return [...byId.values()];
}

/** Finds the session from --session-file, else the way the harness finds its running session. */
async function locateSession(harness: Harness, args: string[]): Promise<SessionRef> {
  return harness.locate({
    sessionFile: flag(args, "--session-file"),
    tty: await ttyName(),
    cwd: process.cwd(),
  });
}

/** Prints the final turn list, one JSON object per line, in first-appearance order. */
async function turns(args: string[]): Promise<number> {
  const harness = harnessById(flag(args, "--harness") ?? "");
  const sessionFile = flag(args, "--session-file");
  if (!harness || !sessionFile) {
    console.error(USAGE);
    return 2;
  }
  const ref = await harness.locate({ sessionFile, cwd: process.cwd() });
  for (const t of await readTurns(harness, ref, loadConfig())) process.stdout.write(`${JSON.stringify(t)}\n`);
  return 0;
}

/**
 * Prints the decision log of a session as markdown, or writes it to --out.
 * Reads the stored LLM graph when there is one, else builds the heuristic outline from the
 * session file. Never starts the daemon and never calls the labeler.
 */
async function log(args: string[]): Promise<number> {
  const harness = harnessById(flag(args, "--harness") ?? "omp");
  const out = flag(args, "--out");
  if (!harness || (args.includes("--out") && !out)) {
    console.error(USAGE);
    return 2;
  }
  const ref = await locateSession(harness, args);
  const stored = openStore(harness.id, ref.key).graph;
  const graph =
    stored && stored.nodes.length > 0
      ? stored
      : buildHeuristicGraph(await readTurns(harness, ref, loadConfig()), ref.title);
  const text = renderDecisionLog(graph, args.includes("--rejected") ? { only: "rejected" } : undefined);
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
  return 0;
}

/** Runs the daemon in the foreground; it exits on its own after the idle window. */
async function serve(args: string[]): Promise<number> {
  const config = loadConfig();
  startDaemon({ config, port: portOf(args, config), onIdle: () => process.exit(0) });
  return 0;
}

/** Ensures a daemon is answering, then prints the session URL. */
async function open(args: string[]): Promise<number> {
  const harness = harnessById(flag(args, "--harness") ?? "omp");
  if (!harness) {
    console.error(USAGE);
    return 2;
  }
  const config = loadConfig();
  const port = portOf(args, config);
  const ref = await locateSession(harness, args);
  await ensureDaemon(port);
  const url = `http://127.0.0.1:${port}/s/${harness.id}/${ref.key}#latest`;
  console.log(url);
  if (!args.includes("--no-browser")) openBrowser(url);
  return 0;
}

/** The terminal this process runs in, or undefined when stdin is not a tty. */
async function ttyName(): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["tty"], { stdin: "inherit", stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

type Health = "ours" | "foreign" | "none";

async function health(port: number): Promise<Health> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
  } catch {
    return "none";
  }
  const body: unknown = await res.json().catch(() => undefined);
  const ours = res.ok && typeof body === "object" && body !== null && "app" in body && body.app === APP;
  return ours ? "ours" : "foreign";
}

function foreignPortError(port: number): Error {
  return new Error(`port ${port} is used by another program; set "port" in ${configFile()} or pass --port`);
}

/** Starts a detached daemon when nothing answers on the port; refuses a foreign listener. */
async function ensureDaemon(port: number): Promise<void> {
  const first = await health(port);
  if (first === "ours") return;
  if (first === "foreign") throw foreignPortError(port);
  Bun.spawn([process.execPath, import.meta.path, "serve", "--port", String(port)], {
    stdio: ["ignore", "ignore", "ignore"],
  }).unref();
  await awaitDaemon(port, Date.now() + 3000);
}

/** Polls /health every 100 ms until the daemon answers or the deadline passes. */
async function awaitDaemon(port: number, deadline: number): Promise<void> {
  await Bun.sleep(100);
  const state = await health(port);
  if (state === "ours") return;
  if (state === "foreign") throw foreignPortError(port);
  if (Date.now() >= deadline) throw new Error(`daemon did not answer on port ${port} within 3 s`);
  return awaitDaemon(port, deadline);
}

function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    Bun.spawn([opener, url], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  } catch {
    console.error(`ipg: could not run ${opener}; open the URL above`);
  }
}

/** One-time setup: slash commands for Claude Code, or the labeler model in config.json. */
function setup(args: string[]): number {
  const [what, ...rest] = args;
  if (what === "claude") {
    console.log(setupClaude().join("\n"));
    console.log("Restart Claude Code to load the commands.");
    return 0;
  }
  if (what === "labeler") {
    let labeler: LabelerConfig | undefined;
    if (!rest.includes("--off")) {
      const provider = flag(rest, "--provider");
      if (provider !== "claude-cli" && provider !== "openai") {
        throw new Error("--provider must be claude-cli or openai (or pass --off)");
      }
      labeler = { provider };
      const model = flag(rest, "--model");
      const baseUrl = flag(rest, "--base-url");
      const apiKeyEnv = flag(rest, "--api-key-env");
      const command = flag(rest, "--command");
      if (model) labeler.model = model;
      if (baseUrl) labeler.baseUrl = baseUrl;
      if (apiKeyEnv) labeler.apiKeyEnv = apiKeyEnv;
      if (command) labeler.command = command;
    }
    const file = writeLabeler(labeler);
    console.log(labeler ? `labeler set to ${labeler.provider} / ${labeler.model} in ${file}` : `labeler turned off in ${file}`);
    console.log("A running page server keeps its old setting until it restarts (it exits after its idle time).");
    return 0;
  }
  console.error(USAGE);
  return 2;
}

/** Removes the Claude Code commands (and with --purge the config and stored graphs), then says what is left. */
function uninstallAll(args: string[]): number {
  const purge = args.includes("--purge");
  const done = uninstall(purge);
  console.log(done.length > 0 ? done.join("\n") : "nothing to remove");
  if (!purge) console.log("Config and stored graphs were kept; pass --purge to delete them too.");
  console.log("Last steps, to remove the program itself:");
  console.log("  omp plugin uninstall intent-prompt-graph   # only if you installed the OMP plugin");
  console.log("  bun remove -g intent-prompt-graph");
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "turns":
        return await turns(rest);
      case "serve":
        return await serve(rest);
      case "open":
        return await open(rest);
      case "log":
        return await log(rest);
      case "setup":
        return setup(rest);
      case "uninstall":
        return uninstallAll(rest);
      default:
        console.error(USAGE);
        return 2;
    }
  } catch (err) {
    console.error(`ipg: ${(err as Error).message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
