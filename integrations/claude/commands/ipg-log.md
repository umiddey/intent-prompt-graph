---
description: Write the decision log of this session to a markdown file
allowed-tools: Bash(ipg log:*)
---

!`ipg log --harness claude --out /tmp/ipg-log-${CLAUDE_SESSION_ID}.md`

The decision log of this session was written to `/tmp/ipg-log-${CLAUDE_SESSION_ID}.md`.

Reply with only that path, on a line of its own. If an error is printed above instead, show the error as it is.
