---
description: List the paths rejected in this session so they are not proposed again
allowed-tools: Bash(ipg log:*)
---

Paths rejected earlier in this session:

!`ipg log --harness claude --rejected`

Show the block above to the user as it is. Treat every path listed in it as already rejected: do not propose it again in this session. If no rejected paths are listed above, reply with only "Nothing rejected yet". If an error is printed above instead, show the error as it is.
