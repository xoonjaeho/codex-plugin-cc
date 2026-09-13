import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { listJobs, resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState, upsertJob, withStateLock, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
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

function listTmpFiles(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")) : [];
}

test("writeJobFile writes the payload atomically and leaves no temp file", () => {
  const workspace = makeTempDir();
  const payload = { id: "atomic", status: "running", workspaceRoot: workspace };

  const jobFile = writeJobFile(workspace, "atomic", payload);

  assert.deepEqual(JSON.parse(fs.readFileSync(jobFile, "utf8")), payload);
  assert.equal(fs.readFileSync(jobFile, "utf8").endsWith("}\n"), true);
  assert.deepEqual(listTmpFiles(path.dirname(jobFile)), []);
});

test("saveState leaves no temp file behind", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const first = { id: "first", status: "completed", workspaceRoot: workspace };
  const second = { id: "second", status: "completed", workspaceRoot: workspace };

  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [first] });
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [second] });

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    ["second"]
  );
  assert.deepEqual(listTmpFiles(path.dirname(stateFile)), []);
});

test("saveState keeps the previous state file when the atomic rename fails", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const first = { id: "first", status: "completed", workspaceRoot: workspace };
  const second = { id: "second", status: "completed", workspaceRoot: workspace };
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [first] });

  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  };
  try {
    assert.throws(() => {
      saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [second] });
    });
  } finally {
    fs.renameSync = originalRename;
  }

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    ["first"]
  );
  assert.deepEqual(listTmpFiles(path.dirname(stateFile)), []);
});

test("saveState retries a transient rename failure and applies the new state", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const first = { id: "first", status: "completed", workspaceRoot: workspace };
  const second = { id: "second", status: "completed", workspaceRoot: workspace };
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [first] });

  const originalRename = fs.renameSync;
  let thrownOnce = false;
  fs.renameSync = (...args) => {
    if (!thrownOnce) {
      thrownOnce = true;
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    }
    return originalRename(...args);
  };
  try {
    saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [second] });
  } finally {
    fs.renameSync = originalRename;
  }

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    ["second"]
  );
  assert.deepEqual(listTmpFiles(path.dirname(stateFile)), []);
});

test("a state lock left behind by a dead process does not block upsertJob", () => {
  const workspace = makeTempDir();
  const lockPath = `${resolveStateFile(workspace)}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, token: "crashed" }), "utf8");

  upsertJob(workspace, { id: "after-crash", status: "queued", workspaceRoot: workspace });

  const indexedIds = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8")).jobs.map((job) => job.id);
  assert.deepEqual(indexedIds, ["after-crash"]);
  assert.equal(fs.existsSync(lockPath), false);
});

test("a state lock held by a live process past the wait budget throws and is left in place", () => {
  const workspace = makeTempDir();
  const lockPath = `${resolveStateFile(workspace)}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const heldLock = JSON.stringify({ pid: process.pid, token: "someone-else" });
  fs.writeFileSync(lockPath, heldLock, "utf8");

  let ran = false;
  assert.throws(
    () =>
      withStateLock(
        workspace,
        () => {
          ran = true;
        },
        { waitMs: 200 }
      ),
    /Timed out after 200ms waiting for the Codex state lock .*held by pid \d+/
  );
  assert.equal(ran, false);
  assert.equal(fs.readFileSync(lockPath, "utf8"), heldLock);
});

test("state lock is re-entrant within one process and released afterwards", () => {
  const workspace = makeTempDir();
  const lockPath = `${resolveStateFile(workspace)}.lock`;

  withStateLock(workspace, () => {
    assert.equal(fs.existsSync(lockPath), true);
    upsertJob(workspace, { id: "nested", status: "queued", workspaceRoot: workspace });
  });

  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(listJobs(workspace).map((job) => job.id), ["nested"]);
});

test("concurrent upsertJob calls from separate processes keep every job and its file", async () => {
  // Without a cross-process lock, one process saves a stale snapshot over another's new
  // job, and saveState's prune then deletes that job's file as "no longer indexed".
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const goFile = path.join(pluginDataDir, "go");
  const stateModuleUrl = pathToFileURL(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/codex/scripts/lib/state.mjs")
  ).href;
  const workers = 2;
  const jobsPerWorker = 12;

  const runWorker = (worker) =>
    new Promise((resolve, reject) => {
      const code = `
        import fs from "node:fs";
        const { upsertJob, writeJobFile } = await import(${JSON.stringify(stateModuleUrl)});
        const workspace = ${JSON.stringify(workspace)};
        while (!fs.existsSync(${JSON.stringify(goFile)})) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        for (let index = 0; index < ${jobsPerWorker}; index++) {
          const id = "w${worker}-" + index;
          writeJobFile(workspace, id, { id, status: "completed", workspaceRoot: workspace });
          upsertJob(workspace, { id, status: "completed", workspaceRoot: workspace });
        }
      `;
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
        env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataDir },
        stdio: ["ignore", "ignore", "pipe"]
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("exit", (exitCode) => resolve({ exitCode, stderr }));
    });

  const pending = Array.from({ length: workers }, (_, worker) => runWorker(worker));
  fs.writeFileSync(goFile, "", "utf8");
  const results = await Promise.all(pending);
  for (const result of results) {
    assert.equal(result.exitCode, 0, result.stderr);
  }

  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const expectedIds = Array.from({ length: workers }, (_, worker) =>
      Array.from({ length: jobsPerWorker }, (_, index) => `w${worker}-${index}`)
    ).flat();
    const indexedIds = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8")).jobs.map((job) => job.id);
    assert.deepEqual([...indexedIds].sort(), [...expectedIds].sort());
    const missingJobFiles = expectedIds.filter((id) => !fs.existsSync(resolveJobFile(workspace, id)));
    assert.deepEqual(missingJobFiles, []);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});
