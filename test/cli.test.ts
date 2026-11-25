import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionGraph } from "../src/model";
import { storeFile } from "../src/store";
import { FIXTURE, FIXTURE_ID, isolate } from "./support";

const CLI = join(import.meta.dir, "../src/cli.ts");

/**
 * Runs `ipg log` on the fixture session. `env` is passed explicitly: Bun.spawn otherwise gives
 * the child the environment the test process started with, not the one isolate() set.
 */
async function runLog(...extra: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["bun", CLI, "log", "--harness", "omp", "--session-file", FIXTURE, ...extra], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

const STORED: SessionGraph = {
  title: "Stored graph",
  mode: "llm",
  edges: [],
  nodes: [
    {
      id: "goal",
      kind: "goal",
      badge: "GOAL",
      title: "Repair the build",
      desc: "The build fails on a bad import.",
      rationaleLabel: "Why",
      rationale: "Nothing ships until it is green.",
      turnIds: [],
      at: 1,
    },
    {
      id: "rej",
      kind: "rejected",
      badge: "REJECTED",
      title: "Pin the old compiler",
      desc: "Agent proposed a downgrade.",
      rationaleLabel: "Why rejected",
      rationale: "Owner: fix the path,\ndo not downgrade.",
      turnIds: [],
      at: 2,
    },
  ],
};

/** Writes STORED as the persisted LLM graph of the fixture session, as the daemon would. */
function seedStore(): void {
  const file = storeFile("omp", FIXTURE_ID);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ t: "graph", graph: STORED, processedTurnIds: [] })}\n`);
}

describe("cli", () => {
  test("ipg turns | head exits quietly when the reader closes the pipe", async () => {
    const iso = isolate();
    try {
      const proc = Bun.spawn(
        ["bash", "-c", `set -o pipefail; bun ${CLI} turns --harness omp --session-file ${FIXTURE} | head -n 1 > /dev/null`],
        { stdout: "ignore", stderr: "pipe" },
      );
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
    } finally {
      iso.restore();
    }
  });

  test("ipg log prints the heuristic decision log when no graph is stored, and writes no state", async () => {
    const iso = isolate();
    try {
      const { stdout, stderr, code } = await runLog();
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toStartWith("# Fixture session\n\n## Goal\n**Why does the build fail?**");
      expect(stdout).toEndWith("\nSource: heuristic outline (no labeler)\n");
      expect(existsSync(join(iso.root, "state"))).toBe(false);
    } finally {
      iso.restore();
    }
  });

  test("ipg log --rejected prints nothing and exits 0 when nothing was rejected", async () => {
    const iso = isolate();
    try {
      expect(await runLog("--rejected")).toEqual({ stdout: "", stderr: "", code: 0 });
    } finally {
      iso.restore();
    }
  });

  test("ipg log prefers the stored LLM graph; --rejected prints only the paste block", async () => {
    const iso = isolate();
    try {
      seedStore();
      const full = await runLog();
      expect(full.code).toBe(0);
      expect(full.stdout).toStartWith("# Stored graph\n\n## Goal\n**Repair the build** — The build fails on a bad import.");
      expect(full.stdout).toEndWith("\nSource: LLM graph\n");

      expect(await runLog("--rejected")).toEqual({
        stdout:
          "Already rejected in this session; do not propose again:\n" +
          "- **Pin the old compiler** — Owner: fix the path, do not downgrade.\n",
        stderr: "",
        code: 0,
      });
    } finally {
      iso.restore();
    }
  });

  test("ipg log --out writes the log to the file and prints nothing", async () => {
    const iso = isolate();
    try {
      const out = join(iso.root, "log.md");
      expect(await runLog("--out", out)).toEqual({ stdout: "", stderr: "", code: 0 });
      expect(readFileSync(out, "utf8")).toStartWith("# Fixture session\n\n## Goal\n");
    } finally {
      iso.restore();
    }
  });

  test("ipg log --out without a path is a usage error", async () => {
    const iso = isolate();
    try {
      const { stdout, stderr, code } = await runLog("--out");
      expect(stdout).toBe("");
      expect(stderr).toContain("ipg log [--harness omp|claude]");
      expect(code).toBe(2);
    } finally {
      iso.restore();
    }
  });
});
