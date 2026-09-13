import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { persistQueuedJobAndSpawn, readStoredJob } from "../plugins/codex/scripts/lib/job-control.mjs";

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