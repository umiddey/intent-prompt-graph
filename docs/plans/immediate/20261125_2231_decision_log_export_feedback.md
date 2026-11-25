# Plan: Decision log export and feeding rejections back to the agent

**Status**: COMPLETE
**Created**: 2026-11-25

## Thought Process & Context
The graph's lasting value is the record under the picture: what was decided, what was rejected and why. Two uses need it as text:

- **Handoff**: a new session should read the record instead of 300 messages.
- **Feedback**: agents forget an early "no" after a rollover and propose the rejected path again. Putting the rejected list back in front of the agent stops that.

Today the record exists only inside the browser page.

Verified before planning:
- `src/store.ts` `openStore(harness, key)` replays the persisted LLM graph (`store.graph`) without the daemon.
- `src/heuristic.ts` `buildHeuristicGraph(turns, title)` builds a graph from turns with no LLM.
- `src/cli.ts` `turns` command already shows how to read all turns of a session file once (`tailJsonl(..., { follow: false })`).
- The real OMP extension API (`@oh-my-pi/pi-coding-agent` `extensibility/extensions/types.d.ts`) has `ctx.ui.pasteToEditor(text)` and `ctx.ui.setEditorText(text)`. `integrations/omp/types.d.ts` is a hand-kept subset and does not declare them yet.

## Files
Owned by this plan: new `src/export.ts`, `src/cli.ts`, `integrations/omp/intent-graph.ts`, `integrations/omp/types.d.ts`, new `test/export.test.ts`, `test/cli.test.ts`, `README.md` (add sections only).
Do not edit `src/labeler.ts`, `src/session.ts`, `src/heuristic.ts`, `src/store.ts`, `src/model.ts` or anything in `web/` (other work is in flight there). Importing from them is fine.

## Phases

### Phase 1: Markdown renderer (`src/export.ts`)
**Status**: DONE
- Pure function `renderDecisionLog(graph: SessionGraph, opts?: { only?: "rejected" }): string`.
- Full log layout:
  - `# <graph title>`
  - `## Goal` — goal node title and desc.
  - `## Chosen` — one bullet per `chosen` node: `**title** — rationale`.
  - `## Rejected` — one bullet per `rejected` or `option` node: `**title** — rationale`. `option` nodes are marked "(not chosen)".
  - `## Decisions` — `decision` nodes in order.
  - `## Loops` — `loop` nodes with rounds, e.g. `status poll × 14`.
  - A last line stating the source: `LLM graph` or `heuristic outline (no labeler)`.
- Sections with no nodes are omitted. Node order follows `graph.nodes` order.
- `only: "rejected"` returns just a short block meant to be pasted into an agent prompt: a one-line lead ("Already rejected in this session; do not propose again:") and the rejected bullets. When there are none it returns an empty string.
- Text from nodes is collapsed to one line per bullet (no raw newlines breaking the list).

### Phase 2: CLI command `ipg log`
**Status**: DONE
- `ipg log [--harness omp] [--session-file <file.jsonl>] [--rejected] [--out <file.md>]`. Add it to `USAGE`.
- Locate the session like `open` does (`harness.locate`, tty fallback).
- Graph source: `openStore(harness.id, ref.key).graph` when it has nodes; otherwise read all turns once (as the `turns` command does) and call `buildHeuristicGraph`.
- Prints the markdown to stdout, or writes it to `--out`. Does not start the daemon and makes no network or LLM call.
- `--rejected` with nothing rejected prints nothing and exits 0.

### Phase 3: OMP commands
**Status**: DONE
- Extend `integrations/omp/types.d.ts` with `pasteToEditor(text: string): void` on `ExtensionUIContext` (it exists in the real API).
- `/graph-log`: runs `ipg log --harness omp --session-file <file> --out <tmp path>` and notifies the path. Tmp path under `os.tmpdir()`, named after the session key.
- `/graph-rejected`: runs `ipg log … --rejected`; pastes the output into the editor with `ctx.ui.pasteToEditor` so the owner reviews and sends it. When the output is empty, notify "Nothing rejected yet".
- Same error handling as the existing `/graph` command (warning when the session is not saved, error notify on CLI failure). Keep shelling out to `ipg` on PATH; do not import daemon code.

### Phase 4: Tests and docs
**Status**: DONE
- `test/export.test.ts`: full log for a graph with every kind; empty sections omitted; `only: "rejected"` output and its empty case; multi-line rationale stays one bullet.
- `test/cli.test.ts`: `ipg log` on the fixture session under `test/fixtures/omp` prints a log with a Goal section (heuristic path, no store); `--rejected` exits 0.
- `README.md`: add a short "Decision log" section (`ipg log`, `/graph-log`, `/graph-rejected`). Another change is editing README at the same time: re-read the file right before editing and only add the new section.
- `bun test` and `bun run typecheck` pass.

## Verification
- Orchestrator runs `ipg log` on session `01a20417-…` (has a stored LLM graph) and reads the output.
