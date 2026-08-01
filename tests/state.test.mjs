import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { listJobs, resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

const DEAD_PID = 2147480000; // implausibly high -> process.kill(pid, 0) raises ESRCH

test("listJobs reconciles a running job whose launcher pid is dead", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "orphan", status: "running", pid: DEAD_PID, workspaceRoot: workspace });
  writeJobFile(workspace, "orphan", { id: "orphan", status: "running", pid: DEAD_PID, workspaceRoot: workspace });

  const jobs = listJobs(workspace);
  const orphan = jobs.find((job) => job.id === "orphan");

  assert.equal(orphan.status, "failed");
  assert.equal(orphan.phase, "failed");
  assert.equal(orphan.pid, null);
  assert.equal(typeof orphan.completedAt, "string");
  assert.match(orphan.errorMessage, /orphaned/);

  // Reconciliation is persisted to both the index and the per-job file.
  const indexJob = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8")).jobs.find((job) => job.id === "orphan");
  assert.equal(indexJob.status, "failed");
  const fileJob = JSON.parse(fs.readFileSync(resolveJobFile(workspace, "orphan"), "utf8"));
  assert.equal(fileJob.status, "failed");
});

test("listJobs reconciles a queued job with a dead pid", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "queued-orphan", status: "queued", pid: DEAD_PID, workspaceRoot: workspace });

  const jobs = listJobs(workspace);
  assert.equal(jobs.find((job) => job.id === "queued-orphan").status, "failed");
});

test("listJobs leaves a running job with a live pid untouched", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "live", status: "running", pid: process.pid, workspaceRoot: workspace });

  const jobs = listJobs(workspace);
  assert.equal(jobs.find((job) => job.id === "live").status, "running");
});

test("listJobs keeps a running job when the liveness probe fails for a reason other than ESRCH", () => {
  // Only ESRCH proves the process is gone. EPERM means it exists under another owner,
  // and an unexpected errno proves nothing -- both must leave the job alone. Defaulting
  // to "dead" here would mark a still-working job as failed, which is far worse than
  // leaving a zombie: codex turns routinely sit silent for many minutes.
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "eperm", status: "running", pid: DEAD_PID, workspaceRoot: workspace });

  const originalKill = process.kill;
  process.kill = () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  };
  let jobs;
  try {
    jobs = listJobs(workspace);
  } finally {
    process.kill = originalKill;
  }

  assert.equal(jobs.find((job) => job.id === "eperm").status, "running");
});

test("listJobs does not reconcile jobs without a pid or already-finished jobs", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "no-pid", status: "queued", workspaceRoot: workspace });
  upsertJob(workspace, { id: "done", status: "completed", pid: DEAD_PID, workspaceRoot: workspace });

  const jobs = listJobs(workspace);
  assert.equal(jobs.find((job) => job.id === "no-pid").status, "queued");
  assert.equal(jobs.find((job) => job.id === "done").status, "completed");
});
