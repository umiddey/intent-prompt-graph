# intent-prompt-graph: design

Companion to the plan `docs/plans/20261122_1229_ipg_intent_prompt_graph.md`. Phase files and steps: `docs/phases.md`.

## Model
- A session is an ordered list of turns T1..Tn. Each turn has an author: `owner` or `agent`.
- An owner turn is one owner message, or one guest message (`collab-prompt`, flagged `guest`; see Decisions). An agent turn is everything the agent says and does from its first reply until it stops (OMP: an assistant message with `stopReason` `stop`, `aborted` or `error`). Any new owner message closes the open agent turn, so steering messages split turns. A harness event (background-job result, IRC message, guard nudge) that wakes an idle agent is the *trigger* of the next agent turn. It is not a node.
- An **intent** is the goal a turn serves. It is a hidden variable. The graph is a set of intents plus, for each turn, the edge turn → intent.
- Causal shortcut: an agent turn opened by an owner turn answers that turn, so it takes that turn's intent, with no inference. Inference is needed only for owner turns and for agent turns a harness event woke up. The share of turns that need inference is unmeasured (P6 measures it). The shortcut is why the answers in the "same question an hour later" example need no clustering of their own.
- Inference is **online and final**: when turn k arrives, the labeler chooses an existing intent or a new one, given the intents so far. The choice is stored and never revised. A graph that is re-clustered on every update would move nodes around while the owner is looking at it. Stability beats global optimality here. Cost: an early mistake stays. A manual move/merge is deferred until the owner asks for it.
- **Kind** is a speech-act tag per turn and is independent of intent. Owner kinds: `asked` (a question or a request) and `approved` (consent or go-ahead to what the agent proposed). Agent kinds: `found` (reports facts), `did` (reports changes it made), `advises` (recommends without doing), `asked` (needs an owner decision). Cards read "YOU ASKED", "AGENT FOUND", and so on, like the reference image.
- **Layout** is a pure function of order and of one count. Turn i of the focused intent sits at Vogel-spiral position (r0 + c·√i, i·137.508°) around the hub (260×120 px). Let n be the focused intent's turn count and Rcl(n) = r0 + c·√n + 119 (card half-diagonal), the cluster's bounding radius. Other intents are chips on an outer spiral: the chip of intent ordinal j (1-based, focused intent skipped) sits at (Rcl(n) + GAP + cChip·√j, j·137.508°). Turn positions depend only on i, so adding turn n+1 never moves turns 1..n (I6). Chips move outward as the focused intent grows and re-place when focus changes; that is a transition, not a re-cluster.
  - **Constants.** Starting values: r0 = 300 px, c = 100 px, cChip = 90 px, GAP = 110 px (GAP's start is above the 103 px chip half-diagonal for 200×48). These are not derived from a density rule. The P4 layout tests (`test/layout.test.ts`; phases.md P4) are the oracle. The implementer raises r0, c, cChip or GAP as needed, with no upper cap, until those tests pass; the tests are never weakened or skipped. After the first passing run, the implementer records the final values on a line here, with the run's command and date.
- **Fade** is a function of global recency rank: opacity = max(0.35, 0.5^(rank/15)), where rank 0 is the newest turn. Hovering a card restores full opacity.
- **Harness boundary**: an adapter is a pure fold, `push(record) → Turn upserts`. The same code serves the backfill read and the live tail. A file rewrite means "new fold, replay from byte 0". Everything after `Turn` is harness-free.

## Invariants
- I1 A turn reaches the browser without waiting for the labeler (≤ 1 s from the line hitting disk).
- I2 A labeled turn's intent and kind never change once stored (persisted per session).
- I3 Only `src/harness/*` knows a harness's paths or record shapes. Nothing outside `src/harness/` imports `src/harness/omp.ts`.
- I4 Read-only towards harness files (see the plan's Forbidden section).
- I5 Privacy: the server binds 127.0.0.1 only and rejects requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (this blocks DNS rebinding). The labeler gets only owner-role text (owner turns capped at 800 chars, owner-role harness triggers capped at 400 chars), the agent's final text capped at 1200 chars, and tool-name counts. It never gets tool outputs, agent-attributed trigger text (the model keeps that as a type only), or guest-message text (`collab-prompt` turns; see Decisions).
- I6 Layout is append-stable (see the model).

## Design decisions (and the alternatives rejected)
- Language: **TypeScript on Bun 1.3.14** (installed). OMP extensions are TS loaded by OMP, so the `/graph` command has to be TS anyway. Bun gives an HTTP server, SSE, file watching, the bundler (HTML imports in `Bun.serve` routes) and a test runner with no dependencies. Server and browser share the protocol types in one file. Rust or Go would still need a separate JS front end.
- Clustering: **LLM assignment over an OpenAI-compatible `/chat/completions` endpoint**, batched (1–8 turns per call). One prompt does intent choice, kind and a caption of ≤14 words (the code also cuts it to 120 chars). Embeddings were rejected because they cannot place "go" / "yes" / "status?" (short owner replies are common: `go` 8, `status?` 23 among 6,641 owner messages) and cannot tag kinds. A single OpenAI-compatible client covers OpenAI, OpenRouter, Anthropic's compat endpoint, Ollama, llama.cpp and LM Studio, with no per-provider code.
- Rejected labeler: `omp -p` as a subprocess. Measured 2026-11-22 12:3x: 9.0 s wall time, and the call failed with `400 prompt is too long: 1182527 tokens` even with `--no-tools --no-extensions --no-skills --no-rules --no-context-files`. Rejected: `ctx.runEphemeralTurn` (absent from `ExtensionContext`; see the source map). It sends the whole conversation to the session's own model and only exists inside OMP.
- Live transport: **Server-Sent Events**. The flow is server → browser only, and EventSource reconnects by itself. WebSocket would add a protocol for nothing.
- One local **daemon** (`ipg serve`, default port 4761; 7787 is taken on this machine) serves all sessions. `ipg open` starts it detached if it is not running. It exits 15 minutes after the last browser disconnects, because a slash command starts it and nobody will remember to stop it.
- Rendering: cards are absolutely positioned HTML divs (text wrapping comes for free), and edges are one SVG layer. Both sit in one container that a CSS transform pans and zooms. No graph library is used: the layout is the spiral under Model (Layout).
- Persistence: labels go in an append-only JSONL per session at `${XDG_STATE_HOME:-~/.local/state}/intent-prompt-graph/<harness>/<sessionId>.jsonl` (`{"t":"intent",…}` and `{"t":"label",…}` lines). Turns are never stored; they are re-read from the harness file. Tests set `XDG_STATE_HOME` to a temp dir.
- Config: `${XDG_CONFIG_HOME:-~/.config}/intent-prompt-graph/config.json` with keys `port`, `labeler.baseUrl`, `labeler.model`, `labeler.apiKeyEnv`, `harnessText`, and `idleExitMinutes`, loaded by `src/config.ts`. `harnessText` is a list of regexes. Owner-role messages that match one are harness triggers, not owner turns. Evidence: the owner's guard writes user-role text that OMP cannot tell apart from typing (see Background evidence). Tests set `XDG_CONFIG_HOME` to a temp dir.
- Labeler down: turns still appear live. Unlabeled turns sit in a "Sorting…" chip with a red banner that shows the labeler error. Pending turns are retried when the next turn arrives and every 60 s. This is honest degraded output, not a fake fallback.

## Decisions added during the rewrite
- Subagent guard dropped (P5). `/graph` is user-invoked, and `ExtensionContext` has no agent-kind field (grep finds none in `extensibility/`, except a comment at `types.ts:338–339`).
- `registerLinkScheme` dropped. It is absent from `src`, so the terminal-link hook is a non-goal.
- Session following: the earlier "sibling file under a lease conflict" claim was unverified and is dropped. The verified fact is the rename-with-rollback at `session-manager.ts:1517–1546`. Following a moved session stays a non-goal.
- `ctx.runEphemeralTurn` exists on `AgentSession` (`agent-session.ts:7785`) and on the IRC host (`agent-session.ts:1027`, `irc-bridge.ts:23`), not on `ExtensionContext`.
- Guest prompts. All 284 `collab-prompt` records under `~/.omp/agent/sessions` (grep, 2026-11-22) have `attribution:"user"` and `details.from:"guest"`, and the sampled texts are human messages ("Status?", "Yes", "unlock 30"). OMP does not record who typed a guest message, and a guest can paste agent output, so guest text is not owner text. The turn stays an owner-role turn with `guest: true`, its text shows on the card, and the labeler gets `[guest message withheld]` (I5). The owner can lift this later.
- Chips on an outer spiral, not a ring (Model, Layout). Golden-angle points on one ring get closer as their count grows, so a ring's radius would have to grow with the chip count; a spiral needs radius ∝ √j, as the turns do.

## Non-goals (and why)
- Clicking a message in the terminal to open the graph: the owner said this comes later. P5's `ctx.ui` is where it would hook in; `registerLinkScheme` is absent from `src` (see the source map).
- Claude Code and Codex adapters: later, by owner order. Each adds one file in `src/harness/` and one entry in `harnesses`, and reuses `tail.ts`. Observed shapes: Claude Code `~/.claude/projects/<dir>/<uuid>.jsonl` (types `user`, `assistant`, `attachment`, `queue-operation`, …); Codex `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`event_msg` `task_started`/`task_complete` mark turns, `response_item` `message`).
- Subagent transcripts as nodes: they are separate files. A `task` call shows as an action on the agent turn.
- Joining rolled-over sessions ("Previous session file: …" handoffs, 61 in 300 sessions): that is the owner's guard convention, not OMP's. Defer until the owner asks. It would be a `predecessor(ref)` adapter method.
- Marking turns on abandoned `/tree` branches: `branch_summary` and `reset_boundary` occur 0 times in 300 recent sessions, so all turns are shown in file order.
- Following an OMP session that moves to a sibling file under a write-lease conflict: rare. The page shows the old file until reopened.
- Manual move or merge of a turn's intent, and re-labeling: there is no evidence yet that online assignment needs it. P6 measures it. Deleting the store file re-labels a session.
- Secret redaction before the labeler: the labeler sees only what I5 allows. The owner chooses the provider.

## Background evidence
- 300 newest OMP sessions (scan 2026-11-22 12:3x):
  - Entries: 229,829 `message` (user 6,641, assistant 107,261, toolResult 114,377, developer 1,197), 115,679 `custom`, 15,611 `custom_message`, 742 `compaction`, 0 `branch_summary`.
  - `custom_message` types: `main-guard.queue` 5,488, `async-result` 5,068, `session-stop-continuation` 2,283, `irc:incoming` 1,050, `collab-prompt` 283. `async-result`/`irc:incoming` are `display:true, attribution:"agent"`; `collab-prompt` is `attribution:"user"`. One sample record each (not a census): `main-guard.queue` is `display:false, attribution:"user"` (session 2026-10-25); `session-stop-continuation` is `display:false, attribution:"agent"` (session 2026-10-12). The reader ignores `display:false`, so a turn woken only by one of them has neither `openedBy` nor `trigger`.
- User-role guard text is identical in shape to typed owner text: same keys (`role, content, attribution:"user", timestamp`, optional `steering`). Prefix counts: `main-guard: don't promise` 191, `Previous session file:` 61, `machine: RED/GREEN` 14, `Owner message from the ph…` 36 (the last one really is the owner, via phone). Hence the `harnessText` config, not hard-coded rules.
- 80 newest sessions: owner messages median 13.5 and max 54; agent stop-ends median 17.5 and max 76; 422 steering messages in total.
- Sizes: up to 142.9 MB (`-Work-gateforge/2026-10-06T05-15-55-164Z_01a10fa3-…jsonl`). A naive Bun stream-parse of it takes 924 ms for 43,300 records, 813 of them user messages.
- File format (OMP docs session.md:65, :506, :556, :559, not on disk; verified in source, see the map):
  - A fixed 256-byte title slot is rewritten in place.
  - Ordinary writes are appends.
  - Full rewrites are atomic renames.
  - Under a lease conflict, the session moves to a sibling file.
- Breadcrumbs (session.md:61): `~/.omp/agent/terminal-sessions/<terminal-id>`. Line 1 is cwd, line 2 is the session file. Observed id: `pts-7`.
- LLM availability on this machine:
  - No `*_API_KEY` or base-URL env vars are set.
  - `qwen-local.service` (Qwen3.5-4B llama.cpp at 127.0.0.1:8089, `~/.omp/agent/models.yml`) is inactive. Its supervisor needs ≥ 11 GiB MemAvailable; `free -g` showed 7 GiB available.
  - Port 1234 is the ai-accountant app, not an LLM.
- Port 7787 is taken (bun on 100.95.84.100), hence the default 4761.
- The reference image shows a central intent card ("I'm looking into this issue: MAP-2086"). Around it are turn cards headed "AGENT FOUND / AGENT ASKED / AGENT DID / AGENT ADVISES / YOU CHECKED / YOU APPROVED / IT CHECKED · Nm ago", with kind-coloured curved edges and faded older cards. There is a metadata sidebar on the left and a thread panel on the right.

## OMP source map
Base: `/home/ukd/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/` (v17.4.1; OMP `docs/` is not on disk).
- `extensibility/extensions/types.ts`: 1198 `ExtensionAPI`; 1349 `registerCommand`; 1178 `RegisteredCommand.handler`; 550 `ExtensionCommandContext`; 1592 `ExtensionFactory`; 455 `ExtensionContext` (ui 457, mode 459, hasUI 467, cwd 469, sessionManager 471, model 477); 256 `ExtensionUIContext`; 279 `notify`; 1359 `registerShortcut` (handler at 1363).
- `session/session-manager.ts`: 359 `ReadonlySessionManager`; 364 and 1950 `getSessionFile`; 1099 header `type: "session"`; 1517–1546 rename with rollback; 743 and 927 `writeTextAtomic`; 2319 `appendCustomMessageEntry` writes `attribution`.
- `session/session-entries.ts`: 8 `SESSION_TITLE_SLOT_BYTES = 256`; 264–266 `display`, `attribution`.
- `session/session-title-slot.ts`: 115–118 pads the title slot.
- `session/exit-diagnostics.ts`: 6 `SESSION_EXIT_CUSTOM_TYPE = "session_exit"`.
- `session/agent-session.ts`: 1027 `runEphemeralTurn` wired to the IRC host; 7785 its definition; 1470 and 2430 `attribution: "agent"`.
- `session/irc-bridge.ts`: 23 `runEphemeralTurn` on the host interface.
- `discovery/builtin.ts`: 58 `getConfigDirs`; 483 `discoverExtensionModulePaths`; 587 `extensionsDir`.
- `extensibility/extensions/loader.ts`: 564, direct files `extensions/*.ts` or `*.js` load.

Absent from `src`: `registerLinkScheme`; `ctx.agent.kind` on `ExtensionContext`; `ctx.runEphemeralTurn` on `ExtensionContext`; `taskDepth|agentKind|isSubagent|OMP_SUBAGENT` in `extensibility/`.
