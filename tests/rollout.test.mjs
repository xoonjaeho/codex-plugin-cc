import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { readLastAssistantMessage } from "../plugins/codex/scripts/lib/rollout.mjs";
import { renderStoredJobResult, storedJobHasOutput } from "../plugins/codex/scripts/lib/render.mjs";

const THREAD_ID = "019fbad1-b569-7d93-97be-1efbff2b73b2";
const TURN_ID = "019fbad1-c711-7051-b5bd-5665f2da3919";
const LATER_TURN_ID = "019fbb1d-a711-7051-b5bd-5665f2da3919";

function assistantRecord(text) {
  return {
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] }
  };
}

// The turn markers codex actually writes: only these carry `turn_id`, and the
// assistant records between them carry none.
function turnStart(turnId) {
  return { type: "event_msg", payload: { type: "task_started", turn_id: turnId } };
}

function turnEnd(turnId) {
  return { type: "event_msg", payload: { type: "task_complete", turn_id: turnId } };
}

// Mirrors a real transcript: nested <sessions>/<YYYY>/<MM>/<DD>/rollout-<ts>-<threadId>.jsonl
// with reasoning and tool records interleaved between the assistant turns.
function writeRollout(sessionsDir, threadId, records) {
  const dir = path.join(sessionsDir, "2026", "08", "01");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-08-01T09-55-38-${threadId}.jsonl`);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return file;
}

test("readLastAssistantMessage returns the last assistant message of the turn, not the first", () => {
  const sessionsDir = makeTempDir();
  writeRollout(sessionsDir, THREAD_ID, [
    { type: "session_meta", payload: { id: THREAD_ID } },
    turnStart(TURN_ID),
    assistantRecord("first pass, still investigating"),
    { type: "response_item", payload: { type: "reasoning", content: [{ text: "thinking" }] } },
    { type: "response_item", payload: { type: "custom_tool_call", payload: {} } },
    assistantRecord("VERDICT: the lease is never released on cancellation"),
    { type: "event_msg", payload: { type: "token_count" } }
  ]);

  const recovered = readLastAssistantMessage(THREAD_ID, { turnId: TURN_ID, sessionsDir });

  assert.equal(recovered.text, "VERDICT: the lease is never released on cancellation");
  assert.equal(path.basename(recovered.file).endsWith(`-${THREAD_ID}.jsonl`), true);
});

// `--resume-last` reuses a thread, so a newer job appends its turn to the same
// transcript. Recovering the older job must not hand back the newer job's answer.
test("readLastAssistantMessage ignores turns belonging to another job on the same thread", () => {
  const sessionsDir = makeTempDir();
  writeRollout(sessionsDir, THREAD_ID, [
    { type: "session_meta", payload: { id: THREAD_ID } },
    turnStart(TURN_ID),
    assistantRecord("the answer this job produced"),
    turnEnd(TURN_ID),
    turnStart(LATER_TURN_ID),
    assistantRecord("a later job's answer"),
    turnEnd(LATER_TURN_ID)
  ]);

  assert.equal(
    readLastAssistantMessage(THREAD_ID, { turnId: TURN_ID, sessionsDir }).text,
    "the answer this job produced"
  );
  assert.equal(
    readLastAssistantMessage(THREAD_ID, { turnId: LATER_TURN_ID, sessionsDir }).text,
    "a later job's answer"
  );
});

test("readLastAssistantMessage survives the half-written final line a killed turn leaves", () => {
  const sessionsDir = makeTempDir();
  const file = writeRollout(sessionsDir, THREAD_ID, [
    turnStart(TURN_ID),
    assistantRecord("the recoverable answer")
  ]);
  fs.appendFileSync(file, '{"type":"response_item","payload":{"type":"mess', "utf8");

  assert.equal(
    readLastAssistantMessage(THREAD_ID, { turnId: TURN_ID, sessionsDir }).text,
    "the recoverable answer"
  );
});

test("readLastAssistantMessage returns null without a matching thread id or turn id", () => {
  const sessionsDir = makeTempDir();
  writeRollout(sessionsDir, "some-other-thread", [turnStart(TURN_ID), assistantRecord("not this one")]);

  assert.equal(readLastAssistantMessage(THREAD_ID, { turnId: TURN_ID, sessionsDir }), null);
  assert.equal(readLastAssistantMessage("", { turnId: TURN_ID, sessionsDir }), null);
  assert.equal(readLastAssistantMessage(null, { turnId: TURN_ID, sessionsDir }), null);
  // No turn id: the job's turn cannot be identified, so nothing is safe to return.
  assert.equal(readLastAssistantMessage("some-other-thread", { sessionsDir }), null);
  assert.equal(readLastAssistantMessage("some-other-thread", { turnId: null, sessionsDir }), null);
});

test("readLastAssistantMessage returns null when the transcript holds no assistant text", () => {
  const sessionsDir = makeTempDir();
  writeRollout(sessionsDir, THREAD_ID, [
    { type: "session_meta", payload: { id: THREAD_ID } },
    turnStart(TURN_ID),
    { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "go" }] } },
    assistantRecord("   ")
  ]);

  assert.equal(readLastAssistantMessage(THREAD_ID, { turnId: TURN_ID, sessionsDir }), null);
});

test("storedJobHasOutput distinguishes a stored result from an empty one", () => {
  assert.equal(storedJobHasOutput({ result: { rawOutput: "done" } }), true);
  assert.equal(storedJobHasOutput({ result: { codex: { stdout: "done" } } }), true);
  assert.equal(storedJobHasOutput({ rendered: "# Report" }), true);
  assert.equal(storedJobHasOutput({ result: { rawOutput: "" } }), false);
  assert.equal(storedJobHasOutput(null), false);
});

test("renderStoredJobResult surfaces a recovered message instead of the empty-payload notice", () => {
  const job = { id: "job-1", status: "failed", threadId: THREAD_ID };
  const recovered = { text: "VERDICT: the lease is never released", file: "C:/rollout.jsonl" };

  const rendered = renderStoredJobResult(job, null, recovered);

  assert.match(rendered, /Recovered from the Codex transcript \(PARTIAL\)/);
  assert.match(rendered, /VERDICT: the lease is never released/);
  assert.match(rendered, /C:\/rollout\.jsonl/);
  assert.doesNotMatch(rendered, /No captured result payload was stored/);
});

test("renderStoredJobResult keeps the empty-payload notice when nothing was recovered", () => {
  const rendered = renderStoredJobResult({ id: "job-1", status: "failed" }, null, null);

  assert.match(rendered, /No captured result payload was stored/);
  assert.doesNotMatch(rendered, /PARTIAL/);
});
