import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configFile, loadConfig } from "../src/config";
import { setupClaude, stateDir, uninstall, updatePlan, writeLabeler } from "../src/setup";
import { isolate, type Isolation } from "./support";

let iso: Isolation;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  iso = isolate();
  env = { ...process.env, CLAUDE_CONFIG_DIR: join(iso.root, "claude") };
});
afterEach(() => iso.restore());

describe("ipg setup claude", () => {
  test("adds the three commands, is safe to repeat, and never replaces a file that is not ours", () => {
    const dir = join(iso.root, "claude", "commands");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ipg-log.md"), "the owner's own command");

    const first = setupClaude(env);
    expect(first.filter((l) => l.includes("added"))).toHaveLength(2);
    expect(first.find((l) => l.startsWith("/ipg-log:"))).toContain("skipped");
    expect(readFileSync(join(dir, "ipg-log.md"), "utf8")).toBe("the owner's own command");
    expect(readFileSync(join(dir, "ipg.md"), "utf8")).toContain("ipg open --harness claude");

    expect(setupClaude(env).filter((l) => l.includes("already set up"))).toHaveLength(2);
  });
});

describe("ipg setup labeler", () => {
  test("writes a labeler that loadConfig accepts and keeps the other settings", () => {
    const file = configFile(env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ port: 5000, labeler: { baseUrl: "http://old", model: "old" } }));

    writeLabeler({ provider: "claude-cli", model: "haiku" }, env);
    const config = loadConfig(env);
    expect(config.port).toBe(5000);
    expect(config.labeler).toEqual({ provider: "claude-cli", model: "haiku" });

    writeLabeler(undefined, env);
    expect(loadConfig(env).labeler).toBeUndefined();
    expect(loadConfig(env).port).toBe(5000);
  });

  test("refuses a labeler that could not run", () => {
    expect(() => writeLabeler({ provider: "openai", model: "m" }, env)).toThrow("--base-url");
    expect(() => writeLabeler({ provider: "claude-cli" }, env)).toThrow("--model");
    expect(existsSync(configFile(env))).toBe(false);
  });
});

describe("ipg uninstall", () => {
  test("removes only our command links; --purge also removes config and stored graphs", () => {
    const dir = join(iso.root, "claude", "commands");
    setupClaude(env);
    writeFileSync(join(dir, "mine.md"), "keep me");
    writeLabeler({ provider: "claude-cli", model: "haiku" }, env);
    mkdirSync(join(stateDir(env), "omp"), { recursive: true });

    uninstall(false, env);
    expect(readdirSync(dir)).toEqual(["mine.md"]);
    expect(existsSync(configFile(env))).toBe(true);

    uninstall(true, env);
    expect(existsSync(configFile(env))).toBe(false);
    expect(existsSync(stateDir(env))).toBe(false);
    expect(readdirSync(dir)).toEqual(["mine.md"]);
  });
});

describe("ipg update", () => {
  test("picks the installer that owns the copy, and leaves a checkout or a current copy alone", () => {
    const name = "intent-prompt-graph";
    const bun = `/home/u/.bun/install/global/node_modules/${name}`;
    const npm = `/usr/lib/node_modules/${name}`;
    expect(updatePlan(bun, name, "0.1.5", "0.1.6")).toEqual({ kind: "run", argv: ["bun", "add", "-g", `${name}@0.1.6`] });
    expect(updatePlan(npm, name, "0.1.5", "0.1.6")).toEqual({ kind: "run", argv: ["npm", "install", "-g", `${name}@0.1.6`] });
    expect(updatePlan(bun, name, "0.1.6", "0.1.6")).toEqual({ kind: "current" });
    // A checkout is never overwritten from npm, whatever its version says.
    expect(updatePlan(`/home/u/projects/${name}`, name, "0.1.5", "0.1.6")).toEqual({ kind: "checkout" });
  });
});
