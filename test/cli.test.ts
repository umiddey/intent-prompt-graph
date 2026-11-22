import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FIXTURE, isolate } from "./support";

const CLI = join(import.meta.dir, "../src/cli.ts");

describe("cli", () => {
  test("ipg turns | head exits quietly when the reader closes the pipe", async () => {
    const iso = isolate();
    try {
      const proc = Bun.spawn(
        ["bash", "-c", `set -o pipefail; bun ${CLI} turns --harness omp --session-file ${FIXTURE} | head -n 1 > /dev/null`],
        { stdout: "ignore", stderr: "pipe" },
      );
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
    } finally {
      iso.restore();
    }
  });
});
