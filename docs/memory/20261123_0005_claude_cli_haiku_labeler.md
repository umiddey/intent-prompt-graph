# 20261123_0005_claude_cli_haiku_labeler
**Task**: Add Claude CLI (`claude -p --model haiku`) backend to the Decision & Path Graph labeler and enable it for live `ipg serve` sessions.
**Status**: COMPLETE

## WHAT
- Plan created and Claude CLI environment verified ✓
- Phase 1 (config, labeler CLI backend, session incremental context) ✓
- Phase 2 (unit tests & typecheck) ✓ (`bun test && bunx tsc --noEmit`: 68 pass, 0 fail)
- Phase 3 (live config, daemon restart & real OMP E2E) ✓ (live SSE streamed `mode: "llm"` 19-node, 18-edge graph for `01a20417` via Claude Haiku 4.5)

## HOW
- Verified `/home/ukd/.local/bin/claude` (v2.1.321) supports `-p --model haiku --no-session-persistence --tools "" --system-prompt ... --output-format text` with clean JSON on `stdout` and warnings isolated to `stderr`.
- Added `LabelerProvider` (`"openai" | "claude-cli"`), `command`, and `isLabelerConfigured()` in `src/config.ts`.
- Added `extractViaClaudeCli()` (stdin piping, `--no-session-persistence`, `--tools ""`, 90s timeout kill, stderr error reporting), outermost JSON object extraction fallback, HTTP `max_tokens: 4096`, and tighter `SYSTEM_PROMPT` in `src/labeler.ts`.
- Updated `src/session.ts` to use `isLabelerConfigured()` and pass full node metadata (`badge`, `desc`, `rationaleLabel`, `rationale`, `rounds`) in `existingGraph` across multi-batch updates.
- Added unit tests in `test/labeler.test.ts` covering `isLabelerConfigured`, wrapped JSON extraction, fake CLI subprocess success, and non-zero exit stderr surfacing.
- Wrote `~/.config/intent-prompt-graph/config.json`, restarted `ipg serve` on `127.0.0.1:4761`, and verified live E2E SSE extraction on `01a20417-4c90-7660-8277-d549fb426160`.

## WHY
- Real OMP sessions (`01a20417`, `01a202af`, `01a201fa`) exposed the hard ceiling of regex heuristic mode (verbatim filler titles like `"You're right."`, inverted rejected attribution, noisy polling runs).
- User chose Claude Haiku 4.5 via Claude CLI (`claude -p`) to use their existing Claude subscription without per-token API keys.

## FILES MODIFIED
- `src/config.ts`: added `LabelerProvider`, `command`, and `isLabelerConfigured()`.
- `src/labeler.ts`: added `extractViaClaudeCli()`, outermost JSON extraction fallback, `TIMEOUT_MS = 90_000`, `max_tokens: 4096`, and stricter `SYSTEM_PROMPT`.
- `src/session.ts`: switched to `isLabelerConfigured()` and preserved full node metadata in `existingGraph`.
- `test/labeler.test.ts`: added 4 unit tests for `claude-cli` provider and JSON extraction.
- `~/.config/intent-prompt-graph/config.json`: configured `provider: "claude-cli"`, `model: "haiku"`, `command: "/home/ukd/.local/bin/claude"`.
- `docs/plans/immediate/20261123_0005_claude_cli_haiku_labeler.md`: plan file marked COMPLETE.

## NEXT SESSION
- Optional follow-ups: session switcher (`/`), keyboard search/navigation, one-click Copy Markdown handoff, or markdown + touched files in the right inspector.
- Note: Claude CLI reported OAuth sign-in expires between 2026-11-26 and 2026-11-29 (`claude auth login` or `claude setup-token` will be needed before then).

## REFERENCES
- Plan: `docs/plans/immediate/20261123_0005_claude_cli_haiku_labeler.md`
- Previous overhaul: `docs/plans/immediate/20261122_1800_decision_path_graph.md`
- Verification: `bun test && bunx tsc --noEmit` (68 pass, 0 fail); live SSE `http://127.0.0.1:4761/api/s/omp/01a20417-4c90-7660-8277-d549fb426160/events` (2 batches → 19 nodes, 18 edges, `mode: "llm"`).
