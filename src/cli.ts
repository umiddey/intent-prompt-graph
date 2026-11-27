#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configFile, type Config, type LabelerConfig, loadConfig } from "./config";
import { renderDecisionLog } from "./export";
import { type Harness, harnessById, type SessionRef } from "./harness/harness";
import { buildHeuristicGraph } from "./heuristic";
import type { Turn } from "./model";
import { APP, STOP_HEADER, startDaemon } from "./server";
import { setupClaude, uninstall, updatePlan, writeLabeler } from "./setup";
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
  "       ipg stop [--port N]",
  "       ipg update",
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

/** Asks our daemon on the port to exit. "old" means it predates `ipg stop` and only exits by idling out. */
async function stopDaemon(port: number): Promise<"stopped" | "none" | "old"> {
  if ((await health(port)) !== "ours") return "none";
  const res = await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { [STOP_HEADER]: "1" } });
  if (res.status === 404) return "old";
  if (!res.ok) throw new Error(`page server on port ${port} refused to stop (${res.status})`);
  const deadline = Date.now() + 3000;
  while ((await health(port)) !== "none") {
    if (Date.now() >= deadline) throw new Error(`page server on port ${port} did not stop within 3 s`);
    await Bun.sleep(100);
  }
  return "stopped";
}

const OLD_DAEMON = "The running page server is an older version and cannot be stopped by command; it exits by itself when idle.";

async function stop(args: string[]): Promise<number> {
  const port = portOf(args, loadConfig());
  const result = await stopDaemon(port);
  if (result === "stopped") console.log(`page server on port ${port} stopped`);
  else if (result === "old") console.log(OLD_DAEMON);
  else console.log(`no page server is running on port ${port}`);
  return 0;
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
async function setup(args: string[]): Promise<number> {
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
    const stopped = await stopDaemon(portOf(rest, loadConfig()));
    if (stopped === "stopped") console.log("Page server stopped; it starts with the new setting the next time you open a graph.");
    else if (stopped === "old") console.log(OLD_DAEMON);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

/** Removes the Claude Code commands (and with --purge the config and stored graphs), then says what is left. */
async function uninstallAll(args: string[]): Promise<number> {
  const purge = args.includes("--purge");
  const stopped = await stopDaemon(portOf(args, loadConfig()));
  const done = uninstall(purge);
  if (stopped === "stopped") done.unshift("stopped the page server");
  console.log(done.length > 0 ? done.join("\n") : "nothing to remove");
  if (!purge) console.log("Config and stored graphs were kept; pass --purge to delete them too.");
  console.log("Last steps, to remove the program itself:");
  console.log("  omp plugin uninstall intent-prompt-graph   # only if you installed the OMP plugin");
  console.log("  bun remove -g intent-prompt-graph");
  return 0;
}

function versionIn(dir: string): string | undefined {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return undefined;
  const pkg: unknown = JSON.parse(readFileSync(file, "utf8"));
  return typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string" ? pkg.version : undefined;
}

/** Installs the latest version from npm, then stops the page server so the next graph uses it. */
async function update(args: string[]): Promise<number> {
  const pkgDir = join(import.meta.dir, "..");
  const current = versionIn(pkgDir) ?? "unknown";
  const res = await fetch(`https://registry.npmjs.org/${APP}/latest`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`npm did not answer (${res.status}); try again later`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || !("version" in body) || typeof body.version !== "string") {
    throw new Error("npm sent no version; try again later");
  }
  const latest = body.version;

  const plan = updatePlan(pkgDir, APP, current, latest);
  if (plan.kind === "checkout") {
    console.log(`ipg ${current} runs from a checkout (${pkgDir}); npm has ${latest}. Update it with: git pull`);
    return 0;
  }
  if (plan.kind === "current") {
    console.log(`ipg ${current} is the latest version.`);
  } else {
    console.log(`updating ipg ${current} → ${latest}: ${plan.argv.join(" ")}`);
    const code = await Bun.spawn(plan.argv, { stdio: ["ignore", "inherit", "inherit"] }).exited;
    if (code !== 0) throw new Error(`${plan.argv.join(" ")} failed (exit ${code})`);
    const stopped = await stopDaemon(portOf(args, loadConfig()));
    if (stopped === "stopped") console.log("Page server stopped; it starts on the new version the next time you open a graph.");
    else if (stopped === "old") console.log(OLD_DAEMON);
    console.log(`ipg is now ${latest}.`);
  }
  // The OMP plugin is a second copy of the package; OMP installs it, so its update is OMP's command.
  const plugin = versionIn(join(homedir(), ".omp", "plugins", "node_modules", APP));
  if (plugin !== undefined && plugin !== latest) {
    console.log(`The OMP plugin is still ${plugin}. Update it with: omp plugin install ${APP}@${latest}`);
  }
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
        return await setup(rest);
      case "stop":
        return await stop(rest);
      case "uninstall":
        return await uninstallAll(rest);
      case "update":
        return await update(rest);
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
