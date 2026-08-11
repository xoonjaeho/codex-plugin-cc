---
description: Delegate one bounded investigation or follow-up to the Codex rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Use `/codex:rescue` and `codex:codex-rescue` only for one bounded non-write, non-review task. Long, write, and review runs must use the main-session Bash companion directly, in the foreground or with `run_in_background: true`. Pick the subcommand for the case — always `${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs`, never a relative `scripts/...` path (the target repo does not contain that script):

```bash
# write or multi-minute implementation
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --write --cwd <repo> --prompt-file <path>
# review / adversarial review (focus is a short positional, not a prompt file)
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review --cwd <repo> "<focus>"
# long read-only investigation (no --write)
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --cwd <repo> --prompt-file <path>
```

The Agent path orphans a multi-minute Codex turn whether `run_in_background` is true or false. If a packet is plainly multi-minute, say so and return the Bash companion pointer instead of invoking the Agent.

For a bounded packet, invoke the `codex:codex-rescue` subagent via the `Agent` tool (`subagent_type: "codex:codex-rescue"`), forwarding the raw user request and absolute repo path as the prompt.
`codex:codex-rescue` is a subagent, not a skill — do not call `Skill(codex:codex-rescue)` (no such skill) or `Skill(codex:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must contain the Codex output body verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `codex:codex-rescue` subagent in the background.
- If the request includes `--wait`, run the `codex:codex-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Codex, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --cwd <repo> --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be:
  - `Continue current Codex thread`
  - `Start a new Codex thread`
- If the user is clearly giving a bounded follow-up instruction such as "continue", "keep going", "resume", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- Resolve `<repo>` to an absolute path before launch. Every companion command must include `--cwd <repo>`; never rely on inherited shell cwd.
- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --cwd <repo> ...` and return the Codex output body.
- Return the Codex output body verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/codex:status`, fetch `/codex:result`, call `/codex:cancel`, summarize output, or do follow-up work of its own.
- When the packet asks Codex to run a project's suite or type checker, give the absolute interpreter path, such as `D:/repository/<proj>/.venv/Scripts/python.exe`, not `./.venv/...`. Codex's shell cwd is not guaranteed to be the repo root; a relative path can select different packages and produce a false verdict.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one. If they ask for `spark`, map it to `gpt-5.3-codex-spark`.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
- If the user did not supply a request, ask what Codex should investigate.
