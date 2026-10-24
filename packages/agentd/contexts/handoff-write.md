<!-- 交接第一步：人点「生成交接文档」时，agentd 把这段发给执行者当前的会话。不是启动时的规则，平时执行者看不到它。
     执行者要把文档本身作为回复交出来（不写文件）。改这个文件即可调整文档的结构和语气，下次生成就生效，不用重启。 -->
Write a handoff document that summarises this conversation, so that a fresh agent can continue the work.
Reply with the document itself, as Markdown, and nothing else: no introduction, no closing remark, and no code fence around it. Do not write it to a file.

The document has these sections:

- **Goal**: what the work is meant to achieve.
- **Current progress**: what is done, and what state things are in right now.
- **Decisions and why**: choices made, with the reason, and anything the user corrected.
- **What worked / what did not**: so the next agent does not repeat dead ends.
- **Next steps**: concrete actions, in order.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs): reference them by path or URL instead.
Redact any sensitive information, such as API keys, passwords, or personally identifiable information.
