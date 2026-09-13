import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { persistQueuedJobAndSpawn, readStoredJob } from "../plugins/codex/scripts/lib/job-control.mjs";
import { createJobProgressUpdater } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

function runWithPluginData(callback) {
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    return callback();
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
}

function makeQueuedRecord(workspace) {
  return {
    id: "job-under-test",
    workspaceRoot: workspace,
    status: "queued",
    phase: "queued",
    title: "test job",
    request: { prompt: "do work" }
  };
}

test("persistQueuedJobAndSpawn stores the queued job before spawning the worker", () => {
  runWithPluginData(() => {
    const workspace = makeTempDir();
    const queuedRecord = makeQueuedRecord(workspace);
    let seen = null;

    persistQueuedJobAndSpawn(workspace, queuedRecord, () => {
      seen = readStoredJob(workspace, queuedRecord.id);
      return { pid: 1111 };
    });

    assert.equal(seen?.status, "queued");
    assert.deepEqual(seen?.request, { prompt: "do work" });
  });
});

test("persistQueuedJobAndSpawn does not overwrite a worker that already moved the job past queued", () => {
  runWithPluginData(() => {
    const workspace = makeTempDir();
    const queuedRecord = makeQueuedRecord(workspace);

    persistQueuedJobAndSpawn(workspace, queuedRecord, () => {
      const running = { ...readStoredJob(workspace, queuedRecord.id), status: "running", pid: 999 };
      writeJobFile(workspace, queuedRecord.id, running);
      upsertJob(workspace, running);
      return { pid: 4242 };
    });

    const stored = readStoredJob(workspace, queuedRecord.id);
    assert.equal(stored.status, "running");
    assert.equal(stored.pid, 999);
  });
});

test("persistQueuedJobAndSpawn records the spawned pid when the job is still queued", () => {
  runWithPluginData(() => {
    const workspace = makeTempDir();
    const queuedRecord = makeQueuedRecord(workspace);

    persistQueuedJobAndSpawn(workspace, queuedRecord, () => ({ pid: 4242 }));

    const stored = readStoredJob(workspace, queuedRecord.id);
    assert.equal(stored.status, "queued");
    assert.equal(stored.pid, 4242);
  });
});

test("createJobProgressUpdater streams root assistant text into partialOutput", () => {
  runWithPluginData(() => {
    const workspace = makeTempDir();
    const record = { ...makeQueuedRecord(workspace), id: "job-partial", status: "running" };
    writeJobFile(workspace, record.id, record);
    const updater = createJobProgressUpdater(workspace, record.id);

    updater({ message: "x", logTitle: "Assistant message", logBody: "full answer text" });

    const stored = readStoredJob(workspace, record.id);
    assert.equal(stored.partialOutput?.text, "full answer text");
    assert.ok(stored.partialOutput?.capturedAt);
  });
});

test("createJobProgressUpdater does not let subagent messages overwrite partialOutput", () => {
  runWithPluginData(() => {
    const workspace = makeTempDir();
    const record = { ...makeQueuedRecord(workspace), id: "job-partial-sub", status: "running" };
    writeJobFile(workspace, record.id, record);
    const updater = createJobProgressUpdater(workspace, record.id);

    updater({ message: "x", logTitle: "Assistant message", logBody: "full answer text" });
    updater({ message: "x", logTitle: "Subagent worker message", logBody: "subagent noise" });

    const stored = readStoredJob(workspace, record.id);
    assert.equal(stored.partialOutput?.text, "full answer text");
  });
});