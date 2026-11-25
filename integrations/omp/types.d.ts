// Minimal structural subset of the OMP extension API (pi-coding-agent
// src/extensibility/extensions/types.ts). Only the members intent-graph.ts uses
// are declared; the real runtime objects are richer.

export interface ExtensionUIContext {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  /** Pastes text into the input editor; the owner still has to send it. */
  pasteToEditor(text: string): void;
}

export interface ReadonlySessionManager {
  getSessionId(): string;
  getSessionFile(): string | undefined;
}

export interface ExtensionCommandContext {
  ui: ExtensionUIContext;
  sessionManager: ReadonlySessionManager;
}

export interface RegisteredCommandOptions {
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface ExtensionAPI {
  registerCommand(name: string, options: RegisteredCommandOptions): void;
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
