#!/usr/bin/env bash
# P1 verification: fixture tests, typecheck, harness-boundary check, then `ipg turns`
# on the given session file plus the 20 newest real OMP sessions, with a 3 s budget each.
set -euo pipefail

SESSION="${1:?usage: verify-p1.sh <session.jsonl>}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

bun install --frozen-lockfile
bun test test/omp.test.ts test/tail.test.ts
bunx tsc --noEmit

leaks="$(grep -rl "harness/omp" src --include='*.ts' | grep -v '^src/harness/' || true)"
if [ -n "$leaks" ]; then
  echo "FAIL harness boundary: outside src/harness/ importing harness/omp: $leaks" >&2
  exit 1
fi

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
mapfile -t recent < <(ls -t "$HOME"/.omp/agent/sessions/*/*.jsonl 2>/dev/null | head -n 20)

for f in "$SESSION" ${recent[@]+"${recent[@]}"}; do
  start="$(date +%s%3N)"
  if ! timeout 3 bun src/cli.ts turns --harness omp --session-file "$f" > "$OUT/turns.jsonl"; then
    echo "FAIL ipg turns exited non-zero or exceeded 3 s: $f" >&2
    exit 1
  fi
  end="$(date +%s%3N)"
  echo "turns=$(wc -l < "$OUT/turns.jsonl") ms=$((end - start)) $f"
done
echo "P1 verify OK"
