import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configFile, isLabelerConfigured, type LabelerConfig } from "./config";
import { claudeDir } from "./harness/claude";

/** The Claude Code slash-command files shipped in this package. */
const CLAUDE_COMMANDS = join(import.meta.dir, "../integrations/claude/commands");

/** True when `path` is a symlink that points into this package's command files. */
function isOurLink(path: string, target: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
  } catch {
    return false;
  }
}

/**
 * Links this package's slash commands into Claude Code's commands directory.
 * A file of the same name that is not our link is left alone and reported.
 *
 * Args:
 *     env (NodeJS.ProcessEnv): Environment map; `CLAUDE_CONFIG_DIR` replaces `~/.claude`.
 *
 * Returns:
 *     string[]: One line per command file, saying what was done.
 */
export function setupClaude(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = join(claudeDir(env), "commands");
  mkdirSync(dir, { recursive: true });
  return readdirSync(CLAUDE_COMMANDS)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const target = join(CLAUDE_COMMANDS, f);
      const link = join(dir, f);
      const name = `/${f.slice(0, -3)}`;
      if (isOurLink(link, target)) return `${name}: already set up`;
      let stale = false;
      try {
        stale = lstatSync(link).isSymbolicLink() && !existsSync(link);
      } catch {
        // Nothing at that path yet.
      }
      if (stale) unlinkSync(link);
      else if (existsSync(link)) return `${name}: skipped, ${link} exists and is not ours`;
      symlinkSync(target, link);
      return `${name}: added (${link})`;
    });
}

/**
 * Removes the slash-command links that setupClaude created. Files that are not our links stay.
 *
 * Args:
 *     env (NodeJS.ProcessEnv): Environment map; `CLAUDE_CONFIG_DIR` replaces `~/.claude`.
 *
 * Returns:
 *     string[]: One line per removed link.
 */
export function removeClaude(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = join(claudeDir(env), "commands");
  const out: string[] = [];
  for (const f of readdirSync(CLAUDE_COMMANDS)) {
    const link = join(dir, f);
    if (!isOurLink(link, join(CLAUDE_COMMANDS, f))) continue;
    unlinkSync(link);
    out.push(`removed ${link}`);
  }
  return out;
}

/**
 * Writes the `labeler` section of config.json and keeps every other setting. `undefined` removes
 * the section, which turns the labeler off.
 *
 * Args:
 *     labeler (LabelerConfig | undefined): New labeler settings, or undefined to remove them.
 *     env (NodeJS.ProcessEnv): Environment map for resolving the config file.
 *
 * Returns:
 *     string: Path of the config file that was written.
 */
export function writeLabeler(labeler: LabelerConfig | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (labeler && !isLabelerConfigured(labeler)) {
    throw new Error(
      labeler.model ? "provider openai needs --base-url <url>" : "a labeler needs --model <name>",
    );
  }
  const file = configFile(env);
  let json: Record<string, unknown> = {};
  if (existsSync(file)) {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${file} must hold a JSON object`);
    }
    json = { ...parsed };
  }
  if (labeler) json.labeler = labeler;
  else delete json.labeler;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  return file;
}

/** Directory holding the stored graphs of every session. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "intent-prompt-graph");
}

/**
 * Removes what this tool put on the machine outside its own package: the Claude Code command
 * links, and with `purge` also the config file and every stored graph.
 *
 * Args:
 *     purge (boolean): Also delete the config directory and the stored graphs.
 *     env (NodeJS.ProcessEnv): Environment map for resolving the directories.
 *
 * Returns:
 *     string[]: One line per thing removed.
 */
export function uninstall(purge: boolean, env: NodeJS.ProcessEnv = process.env): string[] {
  const out = removeClaude(env);
  if (purge) {
    for (const dir of [dirname(configFile(env)), stateDir(env)]) {
      if (!existsSync(dir)) continue;
      rmSync(dir, { recursive: true });
      out.push(`removed ${dir}`);
    }
  }
  return out;
}
