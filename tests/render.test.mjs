import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult, noFileEditsWarning } from "../plugins/codex/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});

test("noFileEditsWarning fires only when a --write turn reported no file edits", () => {
  // The failure it guards: --write exits 0 having edited nothing, which reads as
  // success. Flipping the `write` check or the length check breaks one of these.
  assert.ok(noFileEditsWarning(true, []));
  assert.ok(noFileEditsWarning(true, undefined));
  assert.equal(noFileEditsWarning(true, ["src/a.py"]), null);
  assert.equal(noFileEditsWarning(false, []), null);
  // A FAILED turn also edits nothing; "check git status before re-dispatching" is
  // wrong advice stacked on an error the caller can already see. Dropping the
  // exitStatus term makes this line fail.
  assert.equal(noFileEditsWarning(true, [], 1), null);
  assert.ok(noFileEditsWarning(true, [], 0));
  assert.match(noFileEditsWarning(true, []), /reported no file edits/);
  // the shell-write caveat has to survive rewording, or the warning becomes a lie
  assert.match(noFileEditsWarning(true, []), /shell command/);
});

test("renderStoredJobResult surfaces the no-edits warning above raw output", () => {
  // rawOutput wins over `rendered` in this function, so a warning stored only in
  // the rendered text is invisible through `result <job-id>`. Regression: drop the
  // `result.warning` read and the assertion below fails while everything else passes.
  const output = renderStoredJobResult(
    { id: "task-1", status: "completed", title: "Codex Task", jobClass: "task" },
    {
      result: {
        rawOutput: "I reviewed the file and it already looks correct.",
        warning: "WARNING: codex reported no file edits in this --write turn."
      }
    }
  );

  assert.match(output, /WARNING: codex reported no file edits/);
  assert.ok(
    output.indexOf("WARNING") < output.indexOf("I reviewed the file"),
    "the warning must precede the body, not trail it where it scrolls away"
  );
});
