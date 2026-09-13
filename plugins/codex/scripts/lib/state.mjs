import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";
import { writeJsonFile } from "./fs.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

const STATE_LOCK_WAIT_MS = 5000;
const STATE_LOCK_STALE_MS = 30000;
const heldStateLocks = new Map(); // lock path -> { depth, token } for this process

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows: a file another process is creating or deleting fails transiently with these.
function isTransientFsError(error) {
  return error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "EBUSY";
}

// Returns null when the lock file is gone (or stays unreadable through a few retries).
function readLockOwner(lockPath) {
  for (let attempt = 0; ; attempt++) {
    try {
      const raw = fs.readFileSync(lockPath, "utf8");
      const mtimeMs = fs.statSync(lockPath).mtimeMs;
      let owner = {};
      try {
        owner = JSON.parse(raw);
      } catch {
        // Created but not yet filled in by its owner -> unknown pid.
      }
      return { raw, pid: owner?.pid, token: owner?.token, mtimeMs };
    } catch (error) {
      if (error?.code === "ENOENT" || (isTransientFsError(error) && attempt >= 4)) {
        return null;
      }
      if (!isTransientFsError(error)) {
        throw error;
      }
      sleepSync(10);
    }
  }
}

// Serializes every read-modify-write of state.json across processes (foreground
// companion, detached task workers, status polling, hooks). Without it a process
// saving an older snapshot drops jobs another process just added -- and saveState's
// prune then deletes their job files and logs. Re-entrant within one process.
export function withStateLock(cwd, fn, { waitMs = STATE_LOCK_WAIT_MS, staleMs = STATE_LOCK_STALE_MS } = {}) {
  const lockPath = `${resolveStateFile(cwd)}.lock`;
  const held = heldStateLocks.get(lockPath);
  if (held) {
    held.depth += 1;
    try {
      return fn();
    } finally {
      held.depth -= 1;
    }
  }

  ensureStateDir(cwd);
  const token = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const startedAt = Date.now();
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST" && !isTransientFsError(error)) {
        throw error;
      }
      const owner = readLockOwner(lockPath);
      if (owner) {
        const ownerDead = Number.isInteger(owner.pid) && !isProcessAlive(owner.pid);
        if (ownerDead || Date.now() - owner.mtimeMs > staleMs) {
          // Only remove the lock we judged stale, not one a racing process just re-created.
          let removed = true;
          if (readLockOwner(lockPath)?.raw === owner.raw) {
            try {
              removeFileIfExists(lockPath);
            } catch (removeError) {
              if (!isTransientFsError(removeError) && removeError?.code !== "ENOENT") {
                throw removeError;
              }
              removed = removeError?.code === "ENOENT";
            }
          }
          if (removed) {
            continue;
          }
        }
      }
      if (Date.now() - startedAt >= waitMs) {
        throw new Error(
          `Timed out after ${waitMs}ms waiting for the Codex state lock ${lockPath} (held by pid ${owner?.pid ?? "unknown"}).`
        );
      }
      sleepSync(10 + Math.floor(Math.random() * 15));
      continue;
    }
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token }));
    } finally {
      fs.closeSync(fd);
    }
    break;
  }

  heldStateLocks.set(lockPath, { depth: 1, token });
  try {
    return fn();
  } finally {
    heldStateLocks.delete(lockPath);
    const owner = readLockOwner(lockPath);
    if (owner?.token === token) {
      removeFileIfExists(lockPath);
    }
  }
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateLocked(cwd, state));
}

function saveStateLocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeJsonFile(resolveStateFile(cwd), nextState);
  return nextState;
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateLocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return true; // unknown pid -> never treat as dead
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false; // no such process
    }
    return true; // EPERM (process exists, other owner) or anything else -> assume alive
  }
}

// A tracked job's completion is written by the launcher process that owns it
// (see tracked-jobs.mjs::runTrackedJob). If that launcher dies before the turn
// finishes (cancelled background job, ended session, crash, sleep), the job is
// frozen at "running"/"queued" with a stale pid forever. Reconcile such orphans
// to "failed" at read time so /status, /result and /cancel reflect reality.
function reconcileJobLiveness(jobs) {
  const changedIds = [];
  const now = nowIso();
  const reconciled = jobs.map((job) => {
    if (job.status !== "running" && job.status !== "queued") {
      return job;
    }
    if (job.pid == null || isProcessAlive(job.pid)) {
      return job;
    }
    changedIds.push(job.id);
    return {
      ...job,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt: job.completedAt ?? now,
      updatedAt: now,
      errorMessage:
        job.errorMessage ??
        `Codex job orphaned: launcher process (pid ${job.pid}) is no longer running.`
    };
  });
  return { jobs: reconciled, changedIds };
}

function persistReconciledJobFile(cwd, job) {
  const jobFile = resolveJobFile(cwd, job.id);
  if (!fs.existsSync(jobFile)) {
    return;
  }
  let stored;
  try {
    stored = readJobFile(jobFile);
  } catch {
    return;
  }
  writeJobFile(cwd, job.id, {
    ...stored,
    status: job.status,
    phase: job.phase,
    pid: null,
    completedAt: stored.completedAt ?? job.completedAt,
    errorMessage: stored.errorMessage ?? job.errorMessage
  });
}

export function listJobs(cwd) {
  const { jobs, changedIds } = reconcileJobLiveness(loadState(cwd).jobs);
  if (changedIds.length === 0) {
    return jobs;
  }
  // Something needs persisting: redo the read under the lock so the save cannot
  // overwrite jobs another process added since the unlocked read.
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const reconciled = reconcileJobLiveness(state.jobs);
    if (reconciled.changedIds.length > 0) {
      saveStateLocked(cwd, { ...state, jobs: reconciled.jobs });
      for (const job of reconciled.jobs) {
        if (reconciled.changedIds.includes(job.id)) {
          persistReconciledJobFile(cwd, job);
        }
      }
    }
    return reconciled.jobs;
  });
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeJsonFile(jobFile, payload);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
