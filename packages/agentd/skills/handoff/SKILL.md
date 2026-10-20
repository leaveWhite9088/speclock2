---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save it as `.agentd/HANDOFF.md` in the current working directory (create the folder if needed). If the file already exists, read it first and update it instead of starting over.

The document has these sections:

- **Goal**: what the work is meant to achieve.
- **Current progress**: what is done, and what state things are in right now.
- **Decisions and why**: choices made, with the reason, and anything the user corrected.
- **What worked / what did not**: so the next agent does not repeat dead ends.
- **Next steps**: concrete actions, in order.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

When the file is written, reply with its path and nothing else.
