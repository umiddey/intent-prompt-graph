import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LabelerConfig {
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
}

export interface Config {
  harnessText: RegExp[];
  labeler?: LabelerConfig;
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
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return { harnessText: [] };
    throw err;
  }
  const json: unknown = JSON.parse(raw);
  const list = field(json, "harnessText") ?? [];
  if (!Array.isArray(list) || list.some((p) => typeof p !== "string")) {
    throw new Error("config.harnessText must be an array of regex strings");
  }
  const labelerValue = field(json, "labeler");
  const labeler = labelerValue === undefined ? undefined : parseLabeler(labelerValue);
  return { harnessText: list.map((p) => new RegExp(p)), labeler };
}

/** Reads one property of a JSON value; anything that is not an object has no fields. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function parseLabeler(value: unknown): LabelerConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("config.labeler must be an object");
  }
  const out: LabelerConfig = {};
  for (const key of ["baseUrl", "model", "apiKeyEnv"] as const) {
    const v = field(value, key);
    if (v === undefined) continue;
    if (typeof v !== "string") throw new Error(`config.labeler.${key} must be a string`);
    out[key] = v;
  }
  return out;
}
