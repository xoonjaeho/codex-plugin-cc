---
description: Show your codex CLI rate-limit usage (5h + weekly window, % used and reset)
argument-hint: ''
allowed-tools: Bash(python:*), Bash(py:*)
---

Show codex rate-limit usage. The numbers are read **live** from
`chatgpt.com/backend-api/codex/usage`, authenticated with the ChatGPT OAuth token codex
already stores in `~/.codex/auth.json` — so there is no separate login or cookie to set up.
If that read fails, the reader falls back to the newest local rollout snapshot under
`~/.codex/sessions/` and marks it stale.

The reader lives outside this plugin (in `~/.claude/scripts/`) so it survives plugin
updates. Run it (use `py -3` if `python` is missing):

```bash
python "$HOME/.claude/scripts/codex_usage.py" read --json
```

Interpret the JSON — `stale` says whether the numbers are current, the exit code says why:
- `ok: true` + `stale: false` (exit 0) → live numbers. Report each window: `primary` (~5h) and `secondary` (weekly) as `used` / `remaining` %, with `reset_at` (epoch) rendered as time-until, plus the `plan`.
- `ok: true` + `stale: true` (exit 5 or 6) → the live read failed; these are codex's last local snapshot, **not current**. Report them as cached, pass on `reason`, and flag `age_sec` if large. A window with `expired: true` already reset since that snapshot, so don't present its `used` as current.
- `ok: false` (exit 5 or 8) → the live read failed and there is no local snapshot to fall back on either. Report `reason`. Note the exit code is 5 here, not 8, when the cause was credentials — read `need_login`, not the code, to decide what to tell the user.
- `need_login: true` (exit 5, with or without `ok`) → the stored codex credentials are missing or expired. Tell the user to run `codex login`; nothing else to set up. **Any other refusal** (HTTP 403 and friends) comes back as exit 6 with the status in `reason` — do not send the user to `codex login` for those.
- exit 2 is argparse rejecting the arguments; no JSON is printed.

Keep the reply to one or two lines. For a plain (non-JSON) rendering run
`python "$HOME/.claude/scripts/codex_usage.py" read` — it already renders resets, staleness and snapshot age.
