---
description: List your codex rate-limit reset credits, or spend one (--yes) to reset the 5h + weekly windows
argument-hint: '[--yes]'
disable-model-invocation: true
allowed-tools: Bash(python:*), Bash(py:*), AskUserQuestion
---

Spending a reset credit is irreversible. The reader is the same script as `/codex:usage`
(`~/.claude/scripts/codex_usage.py`, outside this plugin). It talks HTTP to
`chatgpt.com/backend-api/wham/rate-limit-reset-credits` and, if the HTTP consume is
rejected, retries through `codex app-server` with the same credit and idempotency key.

1. List first, always (use `py -3` if `python` is missing):

```bash
python "$HOME/.claude/scripts/codex_usage.py" reset --json
```

   Report each credit's `title` and `expires_at` (epoch) as time-until, flag any expiring
   within 72 h, and the `applicable` count (credits usable right now).

2. Spend only when `$ARGUMENTS` is exactly `--yes`, or the user picks "Spend" in an
   AskUserQuestion you raise when `applicable` > 0 and `chosen` is set (recommend
   "Don't spend" unless a window is actually exhausted). Then run:

```bash
python "$HOME/.claude/scripts/codex_usage.py" reset --yes --json
```

   With `applicable` 0 there is nothing to ask: the script refuses locally (exit 3) and
   the credit stays unspent.

Interpret the exit code:
- 0 → listed, or `outcome` `reset` / `already_redeemed`; report `via` and the fresh
  windows in `after` (or `after_error` if that re-read failed — the spend still happened).
- 3 → `outcome` `nothing_to_reset` or `no_credit`; nothing was spent.
- 5 → `need_login`; tell the user to run `codex login`.
- 6 → both the HTTP and the app-server consume failed; pass on `reason` verbatim and
  re-run step 1 before any retry, since the credit list shows whether it was spent.
