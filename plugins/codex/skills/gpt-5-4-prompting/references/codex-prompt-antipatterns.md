# Codex Prompt Anti-Patterns

Avoid these when prompting Codex or GPT-5.4.

## Vague task framing

Bad:

```text
Take a look at this and let me know what you think.
```

Better:

```xml
<task>
Review this change for material correctness and regression risks.
</task>
```

## Missing output contract

Bad:

```text
Investigate and report back.
```

Better:

```xml
<structured_output_contract>
Return:
1. root cause
2. evidence
3. smallest safe next step
</structured_output_contract>
```

## No follow-through default

Bad:

```text
Debug this failure.
```

Better:

```xml
<default_follow_through_policy>
Keep going until you have enough evidence to identify the root cause confidently.
</default_follow_through_policy>
```

## Asking for more reasoning instead of a better contract

Bad:

```text
Think harder and be very smart.
```

Better:

```xml
<verification_loop>
Before finalizing, verify that the answer matches the observed evidence and task requirements.
</verification_loop>
```

## Mixing unrelated jobs into one run

Bad:

```text
Review this diff, fix the bug you find, update the docs, and suggest a roadmap.
```

Better:
- Run review first.
- Run a separate fix prompt if needed.
- Use a third run for docs or roadmap work.

## Unsupported certainty

Bad:

```text
Tell me exactly why production failed.
```

Better:

```xml
<grounding_rules>
Ground every claim in the provided context or tool outputs.
If a point is an inference, label it clearly.
</grounding_rules>
```

## Running codex alongside another subagent

Bad:

```text
Launch codex and an ollama subagent at the same time to cross-check.
```

Why it stalls:
Two "stalled" rollouts both ended `turn_aborted / interrupted` at 123 s and 139 s; the identical packet re-run **alone** finished in 274 s.

Better:

```text
Launch codex first and let it finish, then fan out kimi/glm.
```

## Letting graphify or saved workflows auto-trigger

Bad:

```text
Review this change for correctness issues.
```

Why it stalls:
Codex's own copy of the `graphify` skill auto-triggers on the word "review", and banning it by name is not sufficient — codex also re-enters its own prior repo-specific review workflow.

Better:

```text
Inspect this commit and answer N questions.

Do NOT run the graphify workflow / build or read a project graph.
Do not use any saved or prior workflow, skill, or checklist for this repository.
```

## Repo-wide audit questions

Bad:

```text
Audit every X in the repo for Y.
```

Why it stalls:
"Audit every X in the repo" does not complete; questions answerable from 1–3 named files do. Confirmed by a controlled A/B: same engine, same day, same companion — the variable was the packet.

Better:

```text
Name the changed files and ask every question answerable from those files only.
```

## Uncommitted-tree packets

Bad:

```text
Here is my working diff: <inline diff>
```

Why it stalls:
Every documented stall described an uncommitted diff; all 14 clean runs were commit shas.

Better:

```text
Give the commit sha and let codex `git show` it.
Never inline a diff or point at a working tree.
```

## Two concurrent codex subagents

Bad:

```text
Run two codex tasks in parallel.
```

Why it stalls:
Two concurrent codex subagents kill one outright with an unhandled `ENOENT` throw in a notification handler, and the harness still reports "completed / exit 0".

Better:

```text
One codex subagent at a time.
```
