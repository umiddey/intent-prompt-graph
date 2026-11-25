import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config";
import type { Action, Trigger, Turn } from "../model";
import type { Harness, Reader, SessionRef } from "./harness";

const HARNESS_TEXT_MAX = 400;
const TEXT_MAX = 20_000;
const SUMMARY_MAX = 120;
const KEY_RE = /^[0-9a-zA-Z-]+$/;

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
}

function sessionsDir(): string {
  return join(agentDir(), "sessions");
}

function globFiles(dir: string, pattern: string): string[] {
  if (!existsSync(dir)) return [];
  return [...new Bun.Glob(pattern).scanSync({ cwd: dir, absolute: true })];
}

interface Head {
  id?: string;
  cwd?: string;
  title?: string;
}

/** Reads the title slot (line 1) and the session header (line 2) from the first 4 KiB. */
function headOf(file: string): Head {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head: Head = {};
    for (const line of buf.toString("utf8", 0, n).split("\n")) {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      // OMP prefixes titles with a private-use icon character that only its own terminal font can draw.
      if (obj.type === "title" && typeof obj.title === "string") head.title = obj.title.replace(/\p{Co}/gu, "").trim();
      if (obj.type === "session") {
        head.id = obj.id as string;
        head.cwd = obj.cwd as string;
      }
    }
    return head;
  } finally {
    closeSync(fd);
  }
}

function refOf(file: string): SessionRef {
  const head = headOf(file);
  if (!head.id || !head.cwd) throw new Error(`no OMP session header in ${file}`);
  return { harness: "omp", key: head.id, file, cwd: head.cwd, title: head.title };
}

async function locate(opts: { sessionFile?: string; tty?: string; cwd: string }): Promise<SessionRef> {
  if (opts.sessionFile) return refOf(opts.sessionFile);
  const looked: string[] = [];
  if (opts.tty) {
    // Breadcrumb name: /dev/pts/9 → pts-9
    const crumb = join(agentDir(), "terminal-sessions", opts.tty.replace(/^\/dev\//, "").replace(/\//g, "-"));
    looked.push(crumb);
    if (existsSync(crumb)) {
      const target = readFileSync(crumb, "utf8").split("\n")[1]?.trim();
      if (target && existsSync(target)) return refOf(target);
    }
  }
  looked.push(`newest sessions with cwd ${opts.cwd} under ${sessionsDir()}`);
  let best: { file: string; mtime: number } | undefined;
  for (const file of globFiles(sessionsDir(), "*/*.jsonl")) {
    if (headOf(file).cwd !== opts.cwd) continue;
    const mtime = statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  if (best) return refOf(best.file);
  throw new Error(`no OMP session found; looked at: ${looked.join("; ")}`);
}

async function resolve(key: string): Promise<SessionRef> {
  if (!KEY_RE.test(key)) throw new Error(`invalid OMP session key: ${key}`);
  const [file] = globFiles(sessionsDir(), `*/*_${key}.jsonl`);
  if (!file) throw new Error(`no OMP session with key ${key} under ${sessionsDir()}`);
  return refOf(file);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Owner user content: a string, or text blocks joined with newlines (images shown as [image]). */
function ownerText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: unknown) => {
      if (!isObj(b)) return "";
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Summary preference: arguments.i, then arguments.description, then the first string argument. */
function actionOf(name: string, args: unknown): Action {
  const a = isObj(args) ? args : {};
  let summary = Object.values(a).find((v): v is string => typeof v === "string") ?? "";
  if (typeof a.description === "string") summary = a.description;
  if (typeof a.i === "string") summary = a.i;
  return { tool: name, summary: summary.slice(0, SUMMARY_MAX) };
}

function snap(t: Turn): Turn {
  return { ...t, actions: [...t.actions] };
}

function ompReader(opts: { config: Config }): Reader {
  let open: Turn | null = null;
  let pending: Trigger | undefined;
  let last: Turn | null = null;

  return {
    push(record: unknown): Turn[] {
      const changed: Turn[] = [];
      if (!isObj(record)) return changed;
      if (record.type === "title" || record.type === "session") return changed;
      if (typeof record.id !== "string") return changed;
      const id = record.id;
      const at = Date.parse(String(record.timestamp)) || 0;

      const closeOpen = () => {
        if (!open) return;
        open.open = false;
        changed.push(snap(open));
        open = null;
      };

      if (record.type === "message" && isObj(record.message)) {
        const m = record.message;
        if (m.role === "user") {
          const text = ownerText(m.content);
          const hit = opts.config.harnessText.some((re) => re.test(text));
          if (hit) {
            // Mid-turn injections are ignored; idle ones become the next agent turn's trigger.
            if (!open) pending = { from: "owner", text: text.slice(0, HARNESS_TEXT_MAX) };
            return changed;
          }
          closeOpen();
          pending = undefined;
          const t: Turn = { id, author: "owner", at, text, actions: [], open: false };
          last = t;
          changed.push(snap(t));
        } else if (m.role === "assistant") {
          if (!open) {
            const t: Turn = { id, author: "agent", at, text: "", actions: [], open: true };
            if (last?.author === "owner") t.openedBy = last.id;
            if (pending) t.trigger = pending;
            pending = undefined;
            open = t;
            last = t;
          }
          const cur = open;
          const content = Array.isArray(m.content) ? m.content : [];
          for (const b of content) {
            if (!isObj(b)) continue;
            if (b.type === "text" && typeof b.text === "string" && b.text) {
              cur.text = (cur.text ? `${cur.text}\n${b.text}` : b.text).slice(-TEXT_MAX);
            } else if (b.type === "toolCall" && typeof b.name === "string") {
              cur.actions.push(actionOf(b.name, b.arguments));
            }
          }
          if (m.stopReason === "stop" || m.stopReason === "aborted" || m.stopReason === "error") {
            cur.open = false;
            open = null;
          }
          changed.push(snap(cur));
        }
        return changed;
      }

      if (record.type === "custom_message") {
        if (record.display !== true) return changed;
        if (record.attribution === "user") {
          closeOpen();
          pending = undefined;
          const t: Turn = {
            id,
            author: "owner",
            at,
            text: ownerText(record.content),
            actions: [],
            open: false,
            guest: true,
          };
          last = t;
          changed.push(snap(t));
        } else if (record.attribution === "agent" && !open) {
          pending = { from: "agent", type: String(record.customType) };
        }
        return changed;
      }

      if (record.type === "custom" && record.customType === "session_exit") closeOpen();
      return changed;
    },
  };
}

export const omp: Harness = {
  id: "omp",
  locate,
  resolve,
  reader(_ref: SessionRef, opts: { config: Config }): Reader {
    return ompReader(opts);
  },
};
