---
name: 'Delegate Codebase Exploration'
description: 'Prefer delegating codebase exploration to the Explore subagent instead of chaining searches and file reads by hand.'
applyTo: '**'
---

When the `runSubagent` tool is available, use it to delegate codebase exploration to the `Explore` subagent (`agentName: "Explore"`) instead of directly calling `grep_search`, `file_search` or `read_file` in a chain. Keeping the raw search hits and long file bodies inside the subagent leaves your own context for the actual work.

Delegate to `Explore` when:

- You do not already know which files hold the answer.
- The goal is to locate where a symbol, setting, endpoint or behavior is defined.
- The user asks how something works, where it is used, or why it is built this way.
- A call chain, data flow or configuration path must be traced across modules.
- Answering needs context from three or more files.

Do the work yourself when:

- The file path is already known and only that one file needs reading.
- The task is to create, edit or delete files.
- One targeted search or one known command settles it.

When you delegate, state exactly what must be returned — file paths, symbol names, line ranges and the conclusion — plus the thoroughness you want: `quick` for a single lookup, `medium` for a normal search, `thorough` for tracing across modules. The subagent cannot see this conversation, so the prompt must stand on its own. Do not repeat searches a subagent is already running.

If you are already running inside a subagent, do not delegate again — do the exploration directly.
