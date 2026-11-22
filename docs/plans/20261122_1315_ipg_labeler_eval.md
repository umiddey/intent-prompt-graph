# intent-prompt-graph: labeler eval — measure the labeler on real turns and choose the default model

Repo: /home/ukd/projects/intent-prompt-graph (git init done, no commits, no remote)
Branch: master
Summary: P6 of intent-prompt-graph. Measures the P2 labeler on hand-labelled real OMP turns and records the default model. Needs an owner-chosen endpoint. P1–P5 stay in the main plan.
Queue: personal
Planner: IpgPlannerP6b
Read /home/ukd/projects/opus-implementer-method.md first.
Plan file: /home/ukd/projects/intent-prompt-graph/docs/plans/20261122_1315_ipg_labeler_eval.md
Waits on: /home/ukd/projects/intent-prompt-graph/docs/plans/20261122_1229_ipg_intent_prompt_graph.md

## Goal
- Measure the P2 labeler on three real OMP sessions with hand-labelled gold intents and kinds, and pick the cheapest candidate model that passes as the README default. All numbers go to docs/labeler-eval.md.
- The owner chooses the provider and gives the endpoint. Until then this plan is WAITING (see Progress), and nothing here runs.
- Model, invariants, decisions: docs/design.md. P6 steps: docs/phases.md.

## Forbidden
- Never write harness files (`~/.omp/agent/sessions/**`, `~/.claude/**`, `~/.codex/**`). Turns are read with `ipg turns` only.
- No import from neurastream. No runtime npm dependencies.
- Every new file, function, option or dependency needs a one-sentence commit-message reason why existing code cannot do it. Dead code is removed.
- Never `git add -A` or `git add .`; add files by name. No skipped tests, no weakened assertions, no retries as fixes.
- Labeler input follows I5 (docs/design.md:21) and P2 (docs/phases.md:36): owner text ≤800 chars; owner-origin trigger text ≤400 chars (agent-attributed triggers: type only); agent final text ≤1200 chars; a guest turn as `[guest message withheld]`; tool-name counts only, never tool output.
- Never write raw `ipg turns` output into the repo or a commit: it holds full guest text. Only the reduced case and gold files under eval/ are committed.
- Never commit an API key, token or transcript excerpt that contains a secret. The P6 verify grep blocks them.
- Never tune the prompt against the gold labels more than 3 rounds; record each round in docs/labeler-eval.md.
- Owner rule: never push to any remote (none exists).
- Per phase, stop and report within ~100 calls; long agents reread huge contexts.

## Blockers
- no-push
- deny-path /home/ukd/.omp/** /home/ukd/.claude/** /home/ukd/.codex/** /home/ukd/projects/neurastream/**
- deny-command git\s+push\b --no-verify git\s+add\s+(-A|--all|\.)(\s|$) reset\s+--hard clean\s+-[a-z]*f

## Phases
- [ ] P6 Labeler eval and default model; needs an owner endpoint — verify: `set -o pipefail; cd /home/ukd/projects/intent-prompt-graph && ! grep -rEn '(sk-[A-Za-z0-9]{20,}|glpat-|ghp_[A-Za-z0-9]{20,}|xox[bp]-|AKIA[0-9A-Z]{16}|-----BEGIN)' eval/ && ! grep -hE '"guest": ?true' eval/cases/*.jsonl | grep -vF '"text":"[guest message withheld]"' > /dev/null && bun eval/run.ts | tee /tmp/ipg-eval.txt && grep -q 'PASS' /tmp/ipg-eval.txt`
P6 starts only after the main plan's P1–P5 are committed and the owner endpoint is set (see Progress). Per-phase steps: docs/phases.md (P6).

## Done check
`set -o pipefail; cd /home/ukd/projects/intent-prompt-graph && test -s docs/labeler-eval.md && grep -q 'PASS' docs/labeler-eval.md && test -z "$(git status --porcelain -- eval docs/labeler-eval.md)"`

## Applies to
- New `eval/` directory and `docs/labeler-eval.md` in the repo only. No change to `src/`; the labeler itself is P2.

## Background
- Why P6 is split out: the spawn guard refuses any agent on a plan parked WAITING on owner, and only P6 waits. Evidence and decisions: docs/design.md.

## Code read by Main
- /home/ukd/projects/intent-prompt-graph/docs/design.md
- /home/ukd/projects/intent-prompt-graph/docs/phases.md

## Reuse
- The labeler input is fixed by I5 and P2: owner text ≤800 chars, owner-origin trigger ≤400 chars, agent final text ≤1200 chars, guest turns as `[guest message withheld]`, no tool output — checked: /home/ukd/projects/intent-prompt-graph/docs/design.md:21, /home/ukd/projects/intent-prompt-graph/docs/phases.md:36
- Guest text is withheld from the labeler (`[guest message withheld]`) — checked: /home/ukd/projects/intent-prompt-graph/docs/design.md:40
- Secret redaction before the labeler — checked: /home/ukd/projects/intent-prompt-graph/docs/design.md:51
- P6 steps: sessions, gold labels, eval/run.ts, pass bar — checked: /home/ukd/projects/intent-prompt-graph/docs/phases.md:121

## Progress
Status: open
WAITING on owner: a labeler endpoint for P6 (P1–P5 do not need it; tests use a fake). Choose one: (a) an OpenRouter or OpenAI key, exported in the shell OMP runs from, plus a model id; (b) an Anthropic API key for `https://api.anthropic.com/v1/` (OpenAI-compatible) and a Haiku model id; (c) local `qwen-local start` when ≥ 11 GiB RAM is free (privacy and zero cost, but slow on CPU and maybe too weak; P6 will measure it) — blocked: P6 needs a real endpoint and none is configured — why you: only you hold provider keys, and the choice decides where transcript excerpts go — still true if: `! grep -q '"baseUrl"' "${XDG_CONFIG_HOME:-$HOME/.config}/intent-prompt-graph/config.json" 2>/dev/null`
- 2026-11-22 13:25 Main: split out of the main plan so the guard lets agents work on P1-P5; plan file written by IpgPlannerP6 from the draft of IpgPlannerFixHaiku.
