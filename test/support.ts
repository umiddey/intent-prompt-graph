import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURE_ID = "0000aaaa-0000-7000-8000-000000000001";
export const FIXTURE = join(
  import.meta.dir,
  "fixtures/omp/agent/sessions/-proj/2026-11-22T10-00-00-000Z_0000aaaa-0000-7000-8000-000000000001.jsonl",
);

const KEYS = ["PI_CODING_AGENT_DIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME"] as const;

export interface Isolation {
  root: string;
  restore: () => void;
}

/** Points OMP and XDG locations at a fresh temp dir so tests never touch real ~/.omp or ~/.config. */
export function isolate(): Isolation {
  const root = mkdtempSync(join(tmpdir(), "ipg-test-"));
  const saved = KEYS.map((k) => [k, process.env[k]] as const);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  return {
    root,
    restore() {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Resolves once pred() is true; rejects after ms. */
export function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const started = Date.now();
  const tick = () => {
    if (pred()) return resolve();
    if (Date.now() - started > ms) return reject(new Error("waitFor: timed out"));
    setTimeout(tick, 20);
  };
  tick();
  return promise;
}
