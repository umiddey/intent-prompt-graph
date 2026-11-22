import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  harnessText: RegExp[];
}

export function configFile(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "intent-prompt-graph", "config.json");
}

/** Missing file → defaults. Invalid JSON, non-array, non-string entries, or bad regex throw. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let raw: string;
  try {
    raw = readFileSync(configFile(env), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { harnessText: [] };
    throw err;
  }
  const json: unknown = JSON.parse(raw);
  const obj = json as { harnessText?: unknown };
  const list = obj.harnessText ?? [];
  if (!Array.isArray(list) || list.some((p) => typeof p !== "string")) {
    throw new Error("config.harnessText must be an array of regex strings");
  }
  return { harnessText: list.map((p) => new RegExp(p)) };
}
