import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "./types";

// Type-only import: Bun erases it, so the file loads with no runtime dependency on types.d.ts.
// The extension shells out to the `ipg` CLI on PATH instead of importing the daemon code.
function runIpgOpen(sessionFile: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile("ipg", ["open", "--harness", "omp", "--session-file", sessionFile], (err, stdout, stderr) => {
    if (err) {
      reject(new Error(stderr.trim() || err.message));
      return;
    }
    const lines = stdout.trim().split("\n");
    resolve(lines[lines.length - 1] ?? "");
  });
  return promise;
}

async function graph(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile === undefined) {
    ctx.ui.notify("This session is not saved to disk", "warning");
    return;
  }
  try {
    const url = await runIpgOpen(sessionFile);
    ctx.ui.notify(url, "info");
  } catch (err) {
    ctx.ui.notify(`ipg open failed: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("graph", {
    description: "Open the intent graph of this session in the browser",
    handler: graph,
  });
}
