import fs from "node:fs";
import path from "node:path";

import { resolveCodexHome } from "./codex.mjs";

// When a turn ends without writing a result back to the job record -- the companion
// returned first, the app-server turn was interrupted, the process died -- `result`
// has nothing to hand back. The assistant messages it *did* produce are already on
// disk though: codex writes every turn to its own rollout transcript under
// $CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<threadId>.jsonl.
// Reading the last assistant message there turns an unrecoverable job into a
// partial answer. This is a read-only recovery path; it never writes to the job.

function findRolloutFile(sessionsDir, threadId) {
  const suffix = `-${threadId}.jsonl`;
  const stack = [sessionsDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // sessions dir absent, or a directory we cannot read: not fatal
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) {
        return full;
      }
    }
  }

  return null;
}

function messageText(payload) {
  if (typeof payload?.content === "string") {
    return payload.content;
  }
  if (!Array.isArray(payload?.content)) {
    return "";
  }
  return payload.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

function readLastAssistantText(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  let latest = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue; // a killed turn can leave a half-written final line
    }
    const payload = record?.payload;
    if (payload?.type !== "message" || payload?.role !== "assistant") {
      continue;
    }
    const text = messageText(payload);
    if (text.trim()) {
      latest = text;
    }
  }

  return latest;
}

/**
 * Last assistant message codex recorded for `threadId`, or null when there is no
 * transcript or it holds no assistant text.
 *
 * @param {string} threadId
 * @param {{ sessionsDir?: string, codexHome?: string }} [options]
 * @returns {{ text: string, file: string } | null}
 */
export function readLastAssistantMessage(threadId, options = {}) {
  if (typeof threadId !== "string" || threadId.length === 0) {
    return null;
  }

  const sessionsDir =
    options.sessionsDir ?? path.join(options.codexHome ?? resolveCodexHome(), "sessions");
  const file = findRolloutFile(sessionsDir, threadId);
  if (!file) {
    return null;
  }

  const text = readLastAssistantText(file);
  if (!text) {
    return null;
  }

  return { text, file };
}
