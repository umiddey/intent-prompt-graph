import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "./types";

// Type-only import: Bun erases it, so the file loads with no runtime dependency on types.d.ts.
// The extension shells out to the `ipg` CLI on PATH instead of importing the daemon code.

/** Runs `ipg <command> --harness omp --session-file <file> …extra` and resolves with its stdout. */
function runIpg(command: string, sessionFile: string, extra: string[] = []): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile("ipg", [command, "--harness", "omp", "--session-file", sessionFile, ...extra], (err, stdout, stderr) => {
    if (err) reject(new Error(stderr.trim() || err.message));
    else resolve(stdout);
  });
  return promise;
}

/**
 * Wraps a command body with the handling every command shares: a warning when the session is
 * not saved to disk, and an error notification when the `ipg` call fails.
 */
function command(
  label: string,
  body: (sessionFile: string, ctx: ExtensionCommandContext) => Promise<void>,
): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  return async (_args, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile === undefined) {
      ctx.ui.notify("This session is not saved to disk", "warning");
      return;
    }
    try {
      await body(sessionFile, ctx);
    } catch (err) {
      ctx.ui.notify(`${label} failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("ipg", {
    description: "Open the intent graph of this session in the browser",
    handler: command("ipg open", async (sessionFile, ctx) => {
      const lines = (await runIpg("open", sessionFile)).trim().split("\n");
      ctx.ui.notify(lines[lines.length - 1] ?? "", "info");
    }),
  });
  pi.registerCommand("ipg-log", {
    description: "Write the decision log of this session to a markdown file",
    handler: command("ipg log", async (sessionFile, ctx) => {
      ctx.ui.notify((await runIpg("log", sessionFile, ["--save"])).trim(), "info");
    }),
  });
  pi.registerCommand("ipg-rejected", {
    description: "Paste the paths rejected in this session into the editor",
    handler: command("ipg log", async (sessionFile, ctx) => {
      const block = (await runIpg("log", sessionFile, ["--rejected"])).trim();
      if (block) ctx.ui.pasteToEditor(block);
      else ctx.ui.notify("Nothing rejected yet", "info");
    }),
  });
}
