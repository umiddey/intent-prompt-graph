import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Config } from "../config";
import type { Action, Trigger, Turn } from "../model";
import type { Harness, Reader, SessionRef } from "./harness";

const HARNESS_TEXT_MAX = 400;
const TEXT_MAX = 20_000;
const SUMMARY_MAX = 120;
const CHUNK = 1 << 20;
/** A session id is a UUID; it is also the file name, so nothing else may pass. */
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Claude Code cuts a project directory name at this length and appends a hash. */
const PROJECT_NAME_MAX = 200;
/**
 * Text Claude Code wrote into the user channel itself: it starts with a lowercase tag such as
 * <command-name>, <local-command-stdout>, <system-reminder>, <bash-input> or <task-notification>.
 * Same test as Claude Code's own "is this a real prompt" check.
 */
const WRAPPER_RE = /^\s*<[a-z][\w-]*[\s>]/;
/** Marker Claude Code writes when the owner pressed Esc. */
const INTERRUPT_RE = /^\[Request interrupted by user[^\]]*\]/;

/** Claude Code's config directory: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function projectsDir(): string {
  return join(claudeDir(), "projects");
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseObj(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function newest(files: string[]): string | undefined {
  let best: { file: string; mtime: number } | undefined;
  for (const file of files) {
    const mtime = statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  return best?.file;
}

/** Session files matching a glob under the projects dir (one level: subagent files lie deeper). */
function sessionFiles(pattern: string): string[] {
  if (!existsSync(projectsDir())) return [];
  return [...new Bun.Glob(pattern).scanSync({ cwd: projectsDir(), absolute: true })];
}

/** Calls fn with every complete line of the file, read in 1 MiB chunks. */
function eachLine(file: string, fn: (line: Buffer) => void): void {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry: Buffer | undefined;
    for (let n = readSync(fd, buf, 0, CHUNK, null); n > 0; n = readSync(fd, buf, 0, CHUNK, null)) {
      const view = buf.subarray(0, n);
      let start = 0;
      for (let nl = view.indexOf(0x0a); nl !== -1; nl = view.indexOf(0x0a, start)) {
        const part = view.subarray(start, nl);
        fn(carry ? Buffer.concat([carry, part]) : part);
        carry = undefined;
        start = nl + 1;
      }
      // `buf` is reused by the next read, so the unfinished line is copied out.
      if (start < n) carry = Buffer.concat(carry ? [carry, view.subarray(start)] : [view.subarray(start)]);
    }
  } finally {
    closeSync(fd);
  }
}

interface Head {
  sessionId?: string;
  cwd?: string;
  title?: string;
}

/**
 * Reads the working directory from the first record that carries one, and the title from the
 * title records. Claude Code appends its title records again after later writes, so the whole
 * file is scanned, but only lines that can hold a title are parsed.
 */
function headOf(file: string): Head {
  const head: Head = {};
  let custom: string | undefined;
  let ai: string | undefined;
  let summary: string | undefined;
  eachLine(file, (line) => {
    const needCwd = head.cwd === undefined;
    if (!needCwd && !line.includes('-title"') && !line.includes('"type":"summary"')) return;
    const obj = parseObj(line.toString("utf8"));
    if (!obj) return;
    if (needCwd && typeof obj.cwd === "string") {
      head.cwd = obj.cwd;
      if (typeof obj.sessionId === "string") head.sessionId = obj.sessionId;
    }
    if (obj.type === "custom-title" && typeof obj.customTitle === "string") custom = obj.customTitle;
    else if (obj.type === "ai-title" && typeof obj.aiTitle === "string") ai = obj.aiTitle;
    else if (obj.type === "summary" && typeof obj.summary === "string") summary = obj.summary;
  });
  // The owner's own title wins over the generated one, as in Claude Code's session list.
  head.title = custom || ai || summary || undefined;
  return head;
}

function refOf(file: string): SessionRef {
  const head = headOf(file);
  const name = basename(file, ".jsonl");
  // The file name is the session id; a renamed copy still carries the id in its records.
  const key = KEY_RE.test(name) ? name : head.sessionId;
  if (!head.cwd || !key || !KEY_RE.test(key)) throw new Error(`no Claude Code session records in ${file}`);
  return { harness: "claude", key, file, cwd: head.cwd, title: head.title };
}

/** Parent pid: field 4 of /proc/<pid>/stat on Linux, `ps -o ppid=` where there is no /proc. */
function parentPid(pid: number): number | undefined {
  let field: string | undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 2 (the command name) may hold spaces and parentheses; the rest follows its last ")".
    field = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1];
  } catch {
    try {
      field = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]).stdout.toString().trim();
    } catch {
      return undefined;
    }
  }
  const ppid = Number(field);
  return field && Number.isInteger(ppid) ? ppid : undefined;
}

/** The pids above this process, nearest first, up to but not including pid 1. */
function ancestorPids(): number[] {
  const pids: number[] = [];
  for (let pid: number | undefined = process.ppid; pid !== undefined && pid > 1 && pids.length < 64; pid = parentPid(pid)) {
    pids.push(pid);
  }
  return pids;
}

/** Project directory name of a working directory, as a glob (long names end in a hash). */
function projectGlob(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return name.length <= PROJECT_NAME_MAX ? name : `${name.slice(0, PROJECT_NAME_MAX)}-*`;
}

async function locate(opts: { sessionFile?: string; tty?: string; cwd: string }): Promise<SessionRef> {
  if (opts.sessionFile) return refOf(opts.sessionFile);
  const looked: string[] = [];
  // Claude Code runs commands as its own children, so the session that started us is an ancestor.
  // Each running Claude Code process registers its session id under sessions/<pid>.json.
  const sessions = join(claudeDir(), "sessions");
  const pids = ancestorPids();
  looked.push(`${join(sessions, "<pid>.json")} for ancestor pids ${pids.join(", ")}`);
  for (const pid of pids) {
    const registered = join(sessions, `${pid}.json`);
    if (!existsSync(registered)) continue;
    const id = parseObj(readFileSync(registered, "utf8"))?.sessionId;
    if (typeof id !== "string" || !KEY_RE.test(id)) continue;
    const file = newest(sessionFiles(`*/${id}.jsonl`));
    if (file) return refOf(file);
    // Falling back to another session of this directory would show the wrong conversation.
    throw new Error(
      `Claude Code session ${id} (pid ${pid}) has no transcript yet (send a first message); looked for ${join(projectsDir(), "*", `${id}.jsonl`)}`,
    );
  }
  const glob = projectGlob(opts.cwd);
  looked.push(`newest session under ${join(projectsDir(), glob)}`);
  const file = newest(sessionFiles(`${glob}/*.jsonl`));
  if (file) return refOf(file);
  throw new Error(`no Claude Code session found; looked at: ${looked.join("; ")}`);
}

async function resolve(key: string): Promise<SessionRef> {
  if (!KEY_RE.test(key)) throw new Error(`invalid Claude Code session key: ${key}`);
  const file = newest(sessionFiles(`*/${key}.jsonl`));
  if (!file) throw new Error(`no Claude Code session with key ${key} under ${projectsDir()}`);
  return refOf(file);
}

/** Text of each block of user content: a string is one block; images show as [image]. */
function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .map((b: unknown) => {
      if (!isObj(b)) return "";
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean);
}

/** Summary preference: input.description, then the first string input value. */
function actionOf(name: string, input: unknown): Action {
  const a = isObj(input) ? input : {};
  let summary = Object.values(a).find((v): v is string => typeof v === "string") ?? "";
  if (typeof a.description === "string") summary = a.description;
  return { tool: name, summary: summary.slice(0, SUMMARY_MAX) };
}

function snap(t: Turn): Turn {
  return { ...t, actions: [...t.actions] };
}

function claudeReader(opts: { config: Config }): Reader {
  let open: Turn | null = null;
  let pending: Trigger | undefined;
  let last: Turn | null = null;
  /** API message id of the newest assistant record in `last`; one message spans several records. */
  let lastMessageId: string | undefined;

  return {
    push(record: unknown): Turn[] {
      const changed: Turn[] = [];
      // Bookkeeping records (mode, last-prompt, api-request, cost-state …) carry no uuid.
      if (!isObj(record) || typeof record.uuid !== "string" || record.isSidechain === true) return changed;
      const id = record.uuid;
      const at = Date.parse(String(record.timestamp)) || 0;

      const closeOpen = () => {
        if (!open) return;
        open.open = false;
        changed.push(snap(open));
        open = null;
      };

      /**
       * Folds text from the user channel: the owner's own words, or text the harness put there.
       * `typed` marks a prompt the owner submitted as text, as opposed to a command or its output.
       */
      const userText = (content: unknown, origin: unknown, typed: boolean) => {
        const blocks = textBlocks(content);
        const raw = blocks.join("\n");
        if (INTERRUPT_RE.test(raw)) return closeOpen();
        // A leading wrapper tag marks harness text, unless the whole typed prompt merely starts with a tag.
        const own = blocks.filter((b) => !WRAPPER_RE.test(b));
        const text = (typed && own.length === 0 ? blocks : own).join("\n");
        const kind = isObj(origin) ? origin.kind : undefined;
        const injected = (kind !== undefined && kind !== "human") || opts.config.harnessText.some((re) => re.test(text));
        if (!text || injected) {
          // Mid-turn injections are ignored; idle ones become the next agent turn's trigger.
          if (raw && !open) pending = { from: "owner", text: raw.slice(0, HARNESS_TEXT_MAX) };
          return;
        }
        closeOpen();
        pending = undefined;
        const t: Turn = { id, author: "owner", at, text, actions: [], open: false };
        last = t;
        changed.push(snap(t));
      };

      if (record.type === "user" && isObj(record.message)) {
        const m = record.message;
        // Tool output comes back in the user channel; it is never an owner turn.
        if (Array.isArray(m.content) && m.content.some((b: unknown) => isObj(b) && b.type === "tool_result")) {
          return changed;
        }
        // Written for the model or the transcript only; the owner neither typed nor saw them as prompts.
        if (record.isMeta === true || record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true) {
          return changed;
        }
        // Typed, queued and SDK prompts name their source; slash commands and `!` shell lines do not.
        const source = record.promptSource;
        userText(m.content, record.origin, typeof source === "string" && source !== "system");
        return changed;
      }

      if (record.type === "assistant" && isObj(record.message)) {
        const m = record.message;
        // Error notices and other replies Claude Code wrote itself end the turn without adding text.
        if (m.model === "<synthetic>" || record.isApiErrorMessage === true) {
          closeOpen();
          return changed;
        }
        const messageId = typeof m.id === "string" ? m.id : undefined;
        let cur = open;
        // A later block of a message whose earlier block already ended the turn.
        if (!cur && last?.author === "agent" && messageId !== undefined && messageId === lastMessageId) cur = last;
        if (!cur) {
          cur = { id, author: "agent", at, text: "", actions: [], open: true };
          if (last?.author === "owner") cur.openedBy = last.id;
          if (pending) cur.trigger = pending;
          pending = undefined;
          open = cur;
          last = cur;
        }
        lastMessageId = messageId;
        const content = Array.isArray(m.content) ? m.content : [];
        let visible = false;
        for (const b of content) {
          if (!isObj(b)) continue;
          if (b.type === "text" && typeof b.text === "string" && b.text) {
            cur.text = (cur.text ? `${cur.text}\n${b.text}` : b.text).slice(-TEXT_MAX);
            visible = true;
          } else if (b.type === "tool_use" && typeof b.name === "string") {
            cur.actions.push(actionOf(b.name, b.input));
            visible = true;
          }
        }
        // tool_use and pause_turn continue the same turn; every other stop reason ends it. Each
        // record of a message repeats the stop reason and thinking comes first, so a record with
        // only thinking never ends the turn: the text record after it does.
        const ends =
          typeof m.stop_reason === "string" && m.stop_reason !== "tool_use" && m.stop_reason !== "pause_turn";
        if (visible && ends && cur === open) {
          cur.open = false;
          open = null;
        }
        changed.push(snap(cur));
        return changed;
      }

      // A message the owner sent while the agent was working arrives as an attachment.
      if (record.type === "attachment" && isObj(record.attachment) && record.attachment.type === "queued_command") {
        const a = record.attachment;
        if (a.isMeta !== true) userText(a.prompt, a.origin, isObj(a.origin) && a.origin.kind === "human");
        return changed;
      }

      // Written when the whole agent loop has finished.
      if (record.type === "system" && record.subtype === "turn_duration") closeOpen();
      return changed;
    },
  };
}

export const claude: Harness = {
  id: "claude",
  locate,
  resolve,
  reader(_ref: SessionRef, opts: { config: Config }): Reader {
    return claudeReader(opts);
  },
};
