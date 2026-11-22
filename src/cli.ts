#!/usr/bin/env bun
import { loadConfig } from "./config";
import type { Turn } from "./model";
import { harnesses, type HarnessId } from "./harness/harness";
import { tailJsonl } from "./tail";

const USAGE = "usage: ipg turns --harness omp --session-file <file.jsonl>";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** Prints the final turn list, one JSON object per line, in first-appearance order. */
async function turns(args: string[]): Promise<number> {
  const harnessId = flag(args, "--harness");
  const sessionFile = flag(args, "--session-file");
  if (!harnessId || !(harnessId in harnesses) || !sessionFile) {
    console.error(USAGE);
    return 2;
  }
  const harness = harnesses[harnessId as HarnessId];
  const config = loadConfig();
  const ref = await harness.locate({ sessionFile, cwd: process.cwd() });
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
  for (const t of byId.values()) process.stdout.write(`${JSON.stringify(t)}\n`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== "turns") {
    console.error(USAGE);
    return 2;
  }
  try {
    return await turns(rest);
  } catch (err) {
    console.error(`ipg: ${(err as Error).message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
