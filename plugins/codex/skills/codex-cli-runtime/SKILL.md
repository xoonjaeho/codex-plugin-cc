---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --cwd <repo> --prompt-file <path>` — write the prompt to a temp file and pass `--prompt-file`; never pass the prompt as a positional argument (argv limits and shell substitution).

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return the Codex output body.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `codex:codex-rescue`.
- Use `task` for every accepted bounded rescue request, including diagnosis, planning, and research.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Map `spark` to `--model gpt-5.3-codex-spark`.
- Handle only one bounded non-write, non-review task. Long, write, and review runs belong in the main-session Bash companion.
- Always include `--cwd <repo>` on every companion launch. Never rely on inherited shell cwd.
- The companion takes its writable workspace root from `--cwd`, falling back to the shell cwd. A stray earlier `cd` in persistent Bash can make the target repo read-only; the run then exits 0 with an empty `git diff` after writing nothing.

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
- `task --resume-last`: internal helper for "keep going", "resume", or "dig deeper" after a previous rescue run.

Safety rules:
- Reject plainly long, write, or review work and point the caller to the main-session Bash companion.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the Codex output body. Never replace it with a forwarding stub; if necessary, return `job.summary` plus parsed findings.
- If the Bash call fails or Codex cannot be invoked, return nothing.

## Invocation gotchas

These look like crashes but are permanent operating conditions of the CLI or harness:

- **Argv too long:** `task "$(cat bigpacket)"` fails outright. **Backticks in double-quoted argv** get command-substituted by bash. Feed the prompt on stdin or `--prompt-file`; both are safe.
- **Never hardcode the version-pinned cache path** — it is deleted the moment the plugin auto-updates, mid-session, and the harness reports exit 0. Use the unpinned marketplace copy under `~/.claude/plugins/marketplaces/openai-codex/`.
- **Restart the app-server after any codex upgrade** (the broker's 30-min idle exit only mitigates it). Kill narrowly — match the exact `codex…app-server` cmdline; a broad match once killed the Codex desktop app.
- **Upstream 503 `biscuit_baker_service_me_circuit_open`** is a server-side circuit breaker. It fails fast and loudly, unlike stalls. One retry, then fall back to ollama.
- **Do not ask a codex subagent to verify its own pytest run on this host** — its shell is denied a `tmp_path` root, so tests die at setup. Node/`npm test` is fine with `--write`. Budget for the parent re-running scoped tests.
- **A `--write` subagent's sandbox can be denied the signal/probe needed to clean up its own processes**, so check for survivors yourself.

## Caller-side result extraction

`codex-companion.mjs result <job-id> --cwd <repo> --json` returns `{job, storedJob, recovered}`; none of those top-level keys is the body. `storedJob` is already a parsed dict. Do not `json.loads` it. Always pass `--cwd <repo>` — job state is per-workspace, so without it the result resolves against the wrong workspace when the caller's shell is not already in the target repo.

The stored body shape depends on the job class (`job.jobClass`):
- **review / adversarial-review jobs** (`jobClass == "review"`): findings are in `storedJob.result.codex.stdout`, a JSON string containing `{verdict, summary, findings[], next_steps[]}` — pass it to `json.loads`. `job.summary` is the one-line verdict.
- **task jobs** (`jobClass == "task"`, including `task --write`): the body is plain text in `storedJob.result.rawOutput`; there is no `codex` key and it is not structured JSON. If the body looks wrong, also read `storedJob.result.parseError`.

```bash
# review job: parse structured findings
node ".../codex-companion.mjs" result <job-id> --cwd <repo> --json | python -c "import sys,json; d=json.loads(sys.stdin.read()); print(json.loads(d['storedJob']['result']['codex']['stdout'])['findings'])"
# task job: print the raw body text
node ".../codex-companion.mjs" result <job-id> --cwd <repo> --json | python -c "import sys,json; d=json.loads(sys.stdin.read()); print(d['storedJob']['result'].get('rawOutput',''))"
```

## Caller-side verification

Never accept a Codex verification line. Re-run the suite yourself after every Codex round in one Bash call. Give the packet the absolute interpreter path, not a relative one, and state the expected baseline counts so a divergent skip count is a warning, not an environmental caveat. "N failed, but environmental" is unverified until run in the real environment.

## Exit-0 recovery

`task --write` can exit 0 after only reading. Exit 0 with an empty diff is not success. Recover with `task --resume-last --write --cwd <repo>` and a prompt whose first line is `Stop analysing. Your first action must be an edit`. Resume carries the dead run's reads, so it is cheaper than a new dispatch.
