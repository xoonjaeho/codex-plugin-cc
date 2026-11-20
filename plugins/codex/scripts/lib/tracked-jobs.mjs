import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    // Root-thread assistant text only ("Subagent <x> message" titles are excluded):
    // stream it into the job file so a launcher that dies mid-run leaves a usable
    // last message behind. Never stored in `result` or the state index -- that would
    // make storedJobHasOutput true and suppress the fuller rollout recovery.
    const hasPartialOutput =
      normalized.logTitle === "Assistant message" && Boolean(normalized.logBody?.trim());

    if (!changed && !hasPartialOutput) {
      return;
    }

    if (changed) {
      upsertJob(workspaceRoot, patch);
    }

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch,
      ...(hasPartialOutput
        ? { partialOutput: { text: normalized.logBody, capturedAt: nowIso() } }
        : {})
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

const LAUNCHER_SIGNALS = ["SIGTERM", "SIGINT"];

// One listener set per process, writing to the log of the job it is running now.
let launcherLogFile = null;
let launcherExitLoggingInstalled = false;

function describeThrown(value) {
  try {
    return value instanceof Error ? String(value.message) : String(value);
  } catch {
    return "(value cannot be converted to a string)";
  }
}

// Never throws: these run inside exit, signal and uncaught-exception paths, where a throw
// would change how the launcher exits.
function logLauncherEvent(event, detail) {
  try {
    if (!launcherLogFile) {
      return;
    }
    const text = describeThrown(detail).replace(/\s*[\r\n]+\s*/g, " ").trim();
    // No O_CREAT: a deleted log means the job was pruned or cleaned up, so ENOENT skips it.
    const fd = fs.openSync(launcherLogFile, fs.constants.O_APPEND | fs.constants.O_WRONLY);
    try {
      fs.writeSync(fd, `[${nowIso()}] Launcher pid ${process.pid} ${event}: ${text}.\n`, null, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Logging must never change how the launcher exits.
  }
}

// Logs why the launcher (the pid stored on the job) went away, so an orphaned job's log
// names the cause. Observe only: a signal is re-raised once our listener is gone so the
// default termination still happens, and the exception monitor does not handle the error.
// Limitation: no signal listeners on Windows, so Ctrl+C there goes unlogged. Re-raising via
// process.kill would end it with exit code 1 instead of the default status, and a SIGTERM
// from another process is a hard kill that never reaches JS anyway.
function installLauncherExitLogging(logFile) {
  launcherLogFile = logFile;
  if (!logFile || launcherExitLoggingInstalled) {
    return;
  }
  launcherExitLoggingInstalled = true;
  if (process.platform !== "win32") {
    const onSignal = (signal) => {
      logLauncherEvent(signal, "signal received");
      for (const name of LAUNCHER_SIGNALS) {
        process.removeListener(name, onSignal);
      }
      if (process.listenerCount(signal) === 0) {
        process.kill(process.pid, signal);
      }
    };
    for (const name of LAUNCHER_SIGNALS) {
      process.on(name, onSignal);
    }
  }
  process.once("beforeExit", (code) => logLauncherEvent("beforeExit", `code ${code}`));
  process.once("exit", (code) => logLauncherEvent("exit", `code ${code}`));
  process.on("uncaughtExceptionMonitor", (error, origin) => logLauncherEvent(origin, error));
}

export async function runTrackedJob(job, runner, options = {}) {
  installLauncherExitLogging(options.logFile ?? job.logFile ?? null);
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    throw error;
  }
}
