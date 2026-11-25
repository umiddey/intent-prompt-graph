# intent-prompt-graph

A local tool that turns a coding-agent session into a live **Decision & Path Graph** (DAG): what goal started the session, what options were proposed, what paths were rejected and why, what repetitive loops happened, and what path was chosen. It runs a loopback-only daemon and serves the dark-mode graph in the browser.

Without a `labeler` you get a basic outline, not the real decision graph: node titles are raw message text, and a long session shows only its latest steps (older ones are collapsed into one node). No API key is needed for that. Configure a `labeler` (see [Config](#config)) to get the real decision graph, extracted by an LLM.

## What it is

Three parts in one npm package:

- `ipg`: a standalone CLI and local daemon (needs [Bun](https://bun.sh)). Works from any shell. It reads sessions of two harnesses: OMP (`--harness omp`, the default) and Claude Code (`--harness claude`).
- An OMP plugin that adds the `/ipg` slash command (a thin wrapper around `ipg open`).
- Claude Code slash commands that do the same there (see [Claude Code](#claude-code)).

## Install

```sh
bun add -g intent-prompt-graph           # puts `ipg` on PATH
omp plugin install intent-prompt-graph   # OMP: adds /ipg
ipg setup claude                         # Claude Code: adds /ipg
```

Needs [Bun](https://bun.sh) 1.0 or later. The package has no runtime
dependencies. The labeler is optional and needs either the `claude` command or
an OpenAI-compatible endpoint.

Pick the model that draws the real graph (this writes the `labeler` section of
the [config](#config); run it again any time to change it):

```sh
ipg setup labeler --provider claude-cli --model haiku
ipg setup labeler --provider openai --base-url https://api.example.com/v1 --model example-model --api-key-env IPG_LABELER_KEY
ipg setup labeler --off
```

Changing the labeler stops a running page server, so the next graph you open
uses the new model. `ipg stop` stops it by hand.

Uninstall:

```sh
ipg uninstall            # stops the page server, removes the Claude Code commands; --purge also deletes the config and stored graphs
omp plugin uninstall intent-prompt-graph
bun remove -g intent-prompt-graph
```

From a checkout instead:

```sh
bun install
bun link                           # `ipg` on PATH
omp plugin link "$PWD"             # /ipg in OMP
```

## OMP integration

`/ipg` runs `ipg open --harness omp --session-file <file>` for the current
session and prints the URL. It calls the `ipg` CLI on PATH and does not import
daemon code. A session that is not saved to disk gets a warning instead of a
graph. The plugin entry is the `omp.extensions` field of `package.json`
(`integrations/omp/intent-graph.ts`).

## Claude Code

`ipg` reads Claude Code sessions with `--harness claude`:

```sh
ipg open --harness claude          # the session of this terminal or directory
ipg log --harness claude --session-file ~/.claude/projects/<project>/<session id>.jsonl
```

Without `--session-file` it finds the session in two steps:

1. It walks up its own parent processes. A running Claude Code process records
   its session id in `~/.claude/sessions/<pid>.json`, so when `ipg` is started
   from inside Claude Code (a slash command or the Bash tool) it gets exactly
   that session.
2. Otherwise it takes the newest session of the current directory under
   `~/.claude/projects/`.

`CLAUDE_CONFIG_DIR` replaces `~/.claude` when it is set, as in Claude Code.

A message becomes an owner turn only when the owner wrote it. Tool output,
slash-command and `!` shell wrappers, system reminders, task notifications,
compaction summaries and subagent conversations do not.

The slash commands are the files `integrations/claude/commands/*.md` of this
package. `ipg setup claude` links them into your Claude Code commands
directory (`~/.claude/commands/`, or `$CLAUDE_CONFIG_DIR/commands/`). A file of
the same name that is not its own link is left alone. To use them in one
project only, link the files into that project's `.claude/commands/` yourself.

- `/ipg` runs `ipg open --harness claude` and replies with the URL.
- `/ipg-log` writes the decision log to `/tmp/ipg-log-<session id>.md` and
  replies with the path.
- `/ipg-rejected` puts the rejected paths into the conversation, so the agent
  does not propose them again. When nothing was rejected it says so.

Each command runs `ipg` before the model sees the prompt and then costs one
short model reply. A brand-new session has no file on disk until its first
message is sent, so the commands report an error when they are the very first
thing typed.

## Decision log

`ipg log` prints the record under the graph as markdown: the goal, what was
chosen, what was rejected and why, the decisions and the loops.

```sh
ipg log [--harness omp|claude] [--session-file <file.jsonl>] [--rejected] [--out <file.md>]
```

- It reads the graph the labeler already stored for the session. When there is
  none it builds the basic outline from the session file. The last line of the
  log says which one you got. It does not start the daemon and calls no model.
- Without `--session-file` it finds the session of the current terminal, as
  `ipg open` does.
- `--out` writes the log to a file instead of printing it.
- `--rejected` prints only the rejected paths, as a short block to paste into
  an agent prompt so the agent does not propose them again. Options that were
  laid out but never rejected are left out of this block. It prints nothing
  when nothing was rejected.

In OMP:

- `/ipg-log` writes the log to `ipg-log-<session id>.md` in the system temp
  directory and shows the path. Hand that file to a new session instead of the
  old conversation.
- `/ipg-rejected` pastes the rejected block into the input editor. You review
  it and send it yourself. When nothing was rejected it says so.

In Claude Code the same two commands exist; see [Claude Code](#claude-code).

## Config

Optional file: `$XDG_CONFIG_HOME/intent-prompt-graph/config.json`, or
`~/.config/intent-prompt-graph/config.json` when `XDG_CONFIG_HOME` is unset. A
missing file means defaults.

```json
{
  "port": 4761,
  "idleExitMinutes": 15,
  "harnessText": ["^<system-reminder"],
  "labeler": {
    "baseUrl": "https://api.example.com/v1",
    "model": "example-model",
    "apiKeyEnv": "IPG_LABELER_KEY"
  }
}
```

- `port`: loopback port of the daemon (default 4761).
- `idleExitMinutes`: the daemon exits after this many minutes with no open browser tab (default 15).
- `harnessText`: regular expressions. Matching text is treated as harness-injected, not owner-authored.
- `labeler`: the model that extracts the decision graph. Without it you only get the basic outline. Two providers:
  - `"provider": "openai"` (the default when `provider` is omitted): any OpenAI-compatible endpoint. Fields: `baseUrl`, `model`, and optionally `apiKeyEnv`, which names an environment variable that holds the key. The key itself never goes in the config file.
  - `"provider": "claude-cli"`: runs the local Claude Code CLI instead of calling an HTTP endpoint. Fields: `provider`, `model`, and optionally `command` (binary name or path, default `claude`). `baseUrl` and `apiKeyEnv` are not used.

```json
{
  "labeler": {
    "provider": "claude-cli",
    "model": "haiku",
    "command": "claude"
  }
}
```

## Labeler and privacy

The labeler sends the conversation to the endpoint you configure, or to the local `claude` command when the provider is `claude-cli`. It sends:

- owner messages, truncated to 800 characters;
- agent messages, truncated to 1200 characters;
- tool use as counts per tool name, not tool output;
- guest messages replaced by the placeholder `[guest message withheld]`;
- after the first batch, an outline of the graph so far (node ids, kinds and titles, edge endpoints and kinds), so the model replies with only what changed.

Choose an endpoint or CLI account you trust with those contents. Nothing is sent anywhere else.
