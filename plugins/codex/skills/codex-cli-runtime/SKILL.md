---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `codex:codex-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Map `spark` to `--model gpt-5.3-codex-spark`.
- Default to a write-capable Codex run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits. Without `--write`, codex exits 0 with a plausible log and zero files on disk.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task` — `--background` detaches the run, and polling or killing what looks stuck becomes the `interrupted` abort. Do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, normalize `spark` to `gpt-5.3-codex-spark` and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable Codex work in `codex:codex-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Codex cannot be invoked, return nothing.

## Invocation gotchas

These look like crashes but are permanent operating conditions of the CLI or harness:

- **Argv too long:** `task "$(cat bigpacket)"` fails outright. **Backticks in double-quoted argv** get command-substituted by bash. Feed the prompt on stdin or `--prompt-file`; both are safe.
- **Never hardcode the version-pinned cache path** — it is deleted the moment the plugin auto-updates, mid-session, and the harness reports exit 0. Use the unpinned marketplace copy under `~/.claude/plugins/marketplaces/openai-codex/`.
- **Restart the app-server after any codex upgrade** (the broker's 30-min idle exit only mitigates it). Kill narrowly — match the exact `codex…app-server` cmdline; a broad match once killed the Codex desktop app.
- **Upstream 503 `biscuit_baker_service_me_circuit_open`** is a server-side circuit breaker. It fails fast and loudly, unlike stalls. One retry, then fall back to ollama.
- **Do not ask a codex subagent to verify its own pytest run on this host** — its shell is denied a `tmp_path` root, so tests die at setup. Node/`npm test` is fine with `--write`. Budget for the parent re-running scoped tests.
- **A `--write` subagent's sandbox can be denied the signal/probe needed to clean up its own processes**, so check for survivors yourself.
