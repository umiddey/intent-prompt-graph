import { closeSync, fstatSync, openSync, readSync, watch } from "node:fs";

export type TailEvent = { type: "record"; record: unknown } | { type: "reset" };
export interface Tail {
  stop(): void;
}

const CHUNK = 1 << 20;
const POLL_MS = 1000;

/**
 * Streams a JSONL file from byte 0 and emits one event per complete line.
 * follow=false returns after the first catch-up (used by `ipg turns`); follow=true keeps watching.
 * A changed inode or a shrunken file emits `reset` and re-reads from 0.
 */
export async function tailJsonl(
  file: string,
  emit: (ev: TailEvent) => void,
  opts: { follow: boolean },
): Promise<Tail> {
  let ino = -1;
  let offset = 0;
  let carry: Buffer = Buffer.alloc(0);
  let stopped = false;
  const out = (ev: TailEvent) => {
    if (!stopped) emit(ev);
  };

  const sync = () => {
    const fd = openSync(file, "r");
    try {
      const st = fstatSync(fd);
      if (ino !== -1 && (st.ino !== ino || st.size < offset)) {
        out({ type: "reset" });
        offset = 0;
        carry = Buffer.alloc(0);
      }
      ino = st.ino;
      while (offset < st.size) {
        const buf = Buffer.allocUnsafe(Math.min(CHUNK, st.size - offset));
        const n = readSync(fd, buf, 0, buf.length, offset);
        if (n === 0) break;
        offset += n;
        carry = drainLines(Buffer.concat([carry, buf.subarray(0, n)]), out);
      }
    } finally {
      closeSync(fd);
    }
  };

  sync();
  if (!opts.follow) return { stop() {} };

  // Follow-mode errors (e.g. a file briefly missing during rename) are swallowed: the next tick retries.
  const kick = () => {
    if (stopped) return;
    try {
      sync();
    } catch {}
  };
  const watcher = watch(file, kick);
  // A dead watch must not crash the process; the poll keeps following.
  watcher.on("error", () => {});
  const timer = setInterval(kick, POLL_MS);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      watcher.close();
    },
  };
}

function drainLines(buf: Buffer, out: (ev: TailEvent) => void): Buffer {
  let start = 0;
  for (let nl = buf.indexOf(0x0a, start); nl !== -1; nl = buf.indexOf(0x0a, start)) {
    const text = buf.toString("utf8", start, nl).trim();
    start = nl + 1;
    if (!text) continue;
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      continue;
    }
    out({ type: "record", record });
  }
  return buf.subarray(start);
}
