# intent-prompt-graph

A local tool that turns a coding-agent session into a live **Decision & Path Graph** (DAG): what goal started the session, what options were proposed, what paths were rejected and why, what repetitive loops happened, and what path was chosen. It runs a loopback-only daemon and serves the dark-mode graph in the browser.

Without a `labeler` you get a basic outline, not the real decision graph: node titles are raw message text, and a long session shows only its latest steps (older ones are collapsed into one node). No API key is needed for that. Configure a `labeler` (see [Config](#config)) to get the real decision graph, extracted by an LLM.

## What it is

Two parts in one npm package:

- `ipg`: a standalone CLI and local daemon (needs [Bun](https://bun.sh)). Works from any shell.
- An OMP plugin that adds the `/graph` slash command (a thin wrapper around `ipg open`).

## Install

```sh
bun add -g intent-prompt-graph     # puts `ipg` on PATH
omp plugin install intent-prompt-graph   # adds /graph to OMP
```

From a checkout instead:

```sh
bun install
bun link                           # `ipg` on PATH
omp plugin link "$PWD"             # /graph in OMP
```

## OMP integration

`/graph` runs `ipg open --harness omp --session-file <file>` for the current
session and prints the URL. It calls the `ipg` CLI on PATH and does not import
daemon code. A session that is not saved to disk gets a warning instead of a
graph. The plugin entry is the `omp.extensions` field of `package.json`
(`integrations/omp/intent-graph.ts`).

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
