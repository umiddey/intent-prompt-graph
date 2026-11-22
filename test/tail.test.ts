import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, closeSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Tail, type TailEvent, tailJsonl } from "../src/tail";
import { waitFor } from "./support";

const dirs: string[] = [];
const tails: Tail[] = [];

afterEach(() => {
  for (const t of tails.splice(0)) t.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fileIn(): string {
  const d = mkdtempSync(join(tmpdir(), "ipg-tail-"));
  dirs.push(d);
  return join(d, "s.jsonl");
}

/** A 256-byte title line (255 chars + newline), as OMP writes it. */
const slot = (title: string) => `${JSON.stringify({ type: "title", v: 1, title }).padEnd(255, " ")}\n`;

/** Starts a tail and returns the live array its events are pushed into. */
async function start(file: string, follow: boolean): Promise<TailEvent[]> {
  const events: TailEvent[] = [];
  tails.push(await tailJsonl(file, (e) => events.push(e), { follow }));
  return events;
}

const recs = (evs: TailEvent[]) => evs.flatMap((e) => (e.type === "record" ? [e.record] : []));

describe("tailJsonl", () => {
  test("emits a line once its newline arrives", async () => {
    const f = fileIn();
    writeFileSync(f, '{"n":1}\n{"n":2');
    const evs = await start(f, true);
    expect(recs(evs)).toEqual([{ n: 1 }]);
    appendFileSync(f, "}\n");
    await waitFor(() => recs(evs).length === 2);
    expect(recs(evs)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("skips blank and non-JSON lines", async () => {
    const f = fileIn();
    writeFileSync(f, '{"n":1}\nnot json\n\n{"n":2}\n');
    const evs = await start(f, false);
    expect(recs(evs)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("atomic rename emits reset, then re-reads the new file", async () => {
    const f = fileIn();
    writeFileSync(f, '{"n":1}\n{"n":2}\n');
    const evs = await start(f, true);
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, '{"n":3}\n{"n":4}\n{"n":5}\n');
    renameSync(tmp, f);
    await waitFor(() => recs(evs).length === 5);
    expect(evs.slice(2)).toEqual([
      { type: "reset" },
      { type: "record", record: { n: 3 } },
      { type: "record", record: { n: 4 } },
      { type: "record", record: { n: 5 } },
    ]);
  });

  test("truncation emits reset, then re-reads from byte 0", async () => {
    const f = fileIn();
    writeFileSync(f, '{"n":1}\n{"n":2}\n{"n":3}\n');
    const evs = await start(f, true);
    writeFileSync(f, '{"n":9}\n');
    await waitFor(() => recs(evs).length === 4);
    expect(evs.slice(3)).toEqual([{ type: "reset" }, { type: "record", record: { n: 9 } }]);
  });

  test("a 256-byte title slot rewritten in place emits nothing", async () => {
    const f = fileIn();
    writeFileSync(f, `${slot("first")}{"n":2}\n`);
    const evs = await start(f, true);
    expect(evs.length).toBe(2);
    const fd = openSync(f, "r+");
    writeSync(fd, Buffer.from(slot("second")), 0, 256, 0);
    closeSync(fd);
    // Sentinel: events are emitted in file order, so anything the rewrite caused would land before it.
    appendFileSync(f, '{"n":3}\n');
    await waitFor(() => recs(evs).length === 3);
    expect(evs.map((e) => e.type)).toEqual(["record", "record", "record"]);
    expect(recs(evs).slice(2)).toEqual([{ n: 3 }]);
  });

  test("non-follow on a missing file rejects", async () => {
    const f = fileIn();
    await expect(tailJsonl(f, () => {}, { follow: false })).rejects.toThrow();
  });
});
