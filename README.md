# intent-prompt-graph

A local tool that shows the intent graph of a coding-agent session: which topics
the conversation moved through, and which turns belong to each topic. It runs a
loopback-only daemon and serves the graph in the browser.

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
- `labeler`: the model that assigns intents and captions. `apiKeyEnv` names an environment variable that holds the key. The key itself never goes in the config file.

## Labeler and privacy

The labeler sends the conversation to the endpoint you configure. It sends:

- owner messages, truncated to 800 characters;
- agent messages, truncated to 1200 characters;
- tool use as counts per tool name, not tool output;
- guest messages replaced by the placeholder `[guest message withheld]`.

Choose an endpoint you trust with those contents. Nothing is sent anywhere else.
