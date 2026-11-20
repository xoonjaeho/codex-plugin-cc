import test from "node:test";
import assert from "node:assert/strict";

import {
  renderReviewResult,
  renderStoredJobResult,
  renderTaskResult,
  noFileEditsWarning,
  capacityResumeHint
} from "../plugins/codex/scripts/lib/render.mjs";

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

test("renderStoredJobResult falls back to partialOutput when nothing else was captured", () => {
  const output = renderStoredJobResult(
    { id: "job-1", status: "failed", title: "Codex Task" },
    { partialOutput: { text: "half done", capturedAt: "2026-09-13T00:00:00.000Z" } },
    null
  );

  assert.match(output, /half done/);
  assert.match(output, /PARTIAL/);
  assert.doesNotMatch(output, /No captured result payload was stored/);
});

test("renderStoredJobResult prefers rollout recovery over partialOutput", () => {
  const output = renderStoredJobResult(
    { id: "job-2", status: "failed", title: "Codex Task" },
    { partialOutput: { text: "half done", capturedAt: "2026-09-13T00:00:00.000Z" } },
    { complete: false, text: "recovered rollout text", file: "rollout.json" }
  );

  assert.match(output, /recovered rollout text/);
  assert.doesNotMatch(output, /half done/);
});

const CAPACITY_ERROR = "Selected model is at capacity. Please try a different model.";

test("renderTaskResult ends a capacity failure with a --resume-job hint even when the turn produced output", () => {
  const output = renderTaskResult(
    { rawOutput: "Looking at the repository layout first.", failureMessage: CAPACITY_ERROR, failed: true },
    { jobId: "task-abc123", write: false }
  );
  assert.equal(
    output,
    "Looking at the repository layout first.\nCodex model was at capacity. Resume this task with: task --resume-job task-abc123\n"
  );

  const writeOutput = renderTaskResult(
    { rawOutput: "", failureMessage: CAPACITY_ERROR, failed: true },
    { jobId: "task-abc123", write: true }
  );
  assert.equal(
    writeOutput,
    `${CAPACITY_ERROR}\nCodex model was at capacity. Resume this task with: task --resume-job task-abc123 --write\n`
  );
});

test("renderTaskResult adds no resume hint for other errors or successful turns", () => {
  const otherError = renderTaskResult(
    { rawOutput: "Partial progress.", failureMessage: "stream disconnected before completion", failed: true },
    { jobId: "task-abc123" }
  );
  assert.equal(otherError, "Partial progress.\n");

  // A capacity error Codex retried past still completes the turn: no hint.
  const success = renderTaskResult(
    { rawOutput: "All done.", failureMessage: CAPACITY_ERROR, failed: false },
    { jobId: "task-abc123" }
  );
  assert.equal(success, "All done.\n");
});

test("renderStoredJobResult keeps the capacity resume hint below raw output", () => {
  const hint = "Codex model was at capacity. Resume this task with: task --resume-job task-abc123";
  const output = renderStoredJobResult(
    { id: "task-abc123", status: "failed" },
    { result: { rawOutput: "Partial progress.", resumeHint: hint } }
  );
  assert.equal(output, `Partial progress.\n${hint}\n`);
});

test("capacityResumeHint ignores capacity wording that is not the model-capacity error", () => {
  assert.equal(capacityResumeHint("write failed: disk at capacity", { jobId: "task-abc123" }), null);
  assert.equal(capacityResumeHint("Rate limit: the queue is at capacity", { jobId: "task-abc123" }), null);
  assert.match(capacityResumeHint(CAPACITY_ERROR, { jobId: "task-abc123" }), /task --resume-job task-abc123$/);
});

test("renderStoredJobResult puts the capacity resume hint after the Codex session footer", () => {
  const hint = "Codex model was at capacity. Resume this task with: task --resume-job task-abc123";
  const footer = "Codex session ID: thr_1\nResume in Codex: codex resume thr_1\n";

  const fromRawOutput = renderStoredJobResult(
    { id: "task-abc123", status: "failed" },
    { threadId: "thr_1", result: { rawOutput: "Partial progress.", resumeHint: hint } }
  );
  assert.equal(fromRawOutput, `Partial progress.\n\n${footer}${hint}\n`);

  // No rawOutput: the stored `rendered` text already ends with the hint from renderTaskResult.
  const fromRendered = renderStoredJobResult(
    { id: "task-abc123", status: "failed" },
    { threadId: "thr_1", rendered: `${CAPACITY_ERROR}\n${hint}\n`, result: { rawOutput: "", resumeHint: hint } }
  );
  assert.equal(fromRendered, `${CAPACITY_ERROR}\n\n${footer}${hint}\n`);
});
