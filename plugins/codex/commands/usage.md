---
description: Show your codex CLI rate-limit usage (5h + weekly window, % used and reset)
argument-hint: ''
allowed-tools: Bash(python:*), Bash(py:*)
---

Show codex rate-limit usage. Codex has no usage API; the numbers come from the newest
`token_count` snapshot in the local rollout logs under `~/.codex/sessions/`. Purely local.

The reader lives outside this plugin (in `~/.claude/scripts/`) so it survives plugin
updates. Run it (use `py -3` if `python` is missing):

```bash
python "$HOME/.claude/scripts/codex_usage.py" read --json
```

Interpret the JSON:
- `ok: true` → report each window: `primary` (~5h) and `secondary` (weekly) as `used` / `remaining` %, with `reset_at` (epoch) rendered as time-until, plus the `plan`.
  - **Staleness matters:** the figures are a snapshot from codex's last run. If a window has `expired: true`, that window already reset since the snapshot (no codex calls since → it's effectively fresh again), so don't report its old `used` as current. `age_sec` is the snapshot's age; flag it if large.
- `ok: false` → no snapshot found: no recent codex session has run, so there is no usage to read yet. Tell the user to run a codex task and try again; nothing to set up.

Keep the reply to one or two lines. For a plain (non-JSON) rendering run
`python "$HOME/.claude/scripts/codex_usage.py" read` — it already renders expiry and snapshot age.
