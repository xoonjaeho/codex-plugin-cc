import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("result --json keeps the documented nested JSON types", () => {
  const repo = makeTempDir();
  const invocationCwd = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const codexResult = {
    verdict: "PASS",
    summary: "shape preserved",
    findings: [],
    next_steps: []
  };
  const stdout = JSON.stringify(codexResult);
  const job = {
    id: "shape-job",
    status: "completed",
    jobClass: "review",
    workspaceRoot: repo
  };

  initGitRepo(repo);
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    upsertJob(repo, job);
    writeJobFile(repo, job.id, {
      ...job,
      result: {
        codex: { stdout }
      }
    });

    const result = run(
      "node",
      [SCRIPT, "result", job.id, "--cwd", repo, "--json"],
      {
        cwd: invocationCwd,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_DATA: pluginDataDir
        }
      }
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(payload).sort(), ["job", "recovered", "storedJob"]);
    assert.equal(typeof payload.storedJob, "object");
    assert.equal(Array.isArray(payload.storedJob), false);
    assert.equal(typeof payload.storedJob.result.codex.stdout, "string");
    assert.deepEqual(JSON.parse(payload.storedJob.result.codex.stdout), codexResult);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("rescue launch contract requires explicit cwd and prompt-file forwarding", () => {
  const command = read("commands/rescue.md");
  const agent = read("agents/codex-rescue.md");

  assert.match(command, /Every companion command must include .*--cwd <repo>/);
  assert.match(agent, /Use exactly one .*Bash.* call/);
  assert.match(agent, /single-quoted here-document/i);
  assert.match(
    agent,
    /codex-companion\.mjs" task --cwd <repo> --prompt-file "\$prompt_file"/
  );
  assert.match(agent, /Never pass the prompt as a positional argument/i);
});

test("rescue routing stays bounded and redirects long, write, and review work", () => {
  const command = read("commands/rescue.md");
  const agent = read("agents/codex-rescue.md");

  assert.match(command, /only for one bounded non-write, non-review task/i);
  assert.match(command, /Long, write, and review runs must use the main-session Bash companion directly/i);
  assert.match(
    command,
    /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" task --write --cwd <repo> --prompt-file <path>/
  );
  assert.match(command, /review --cwd <repo> "<focus>"/);
  assert.match(
    command,
    /# long read-only investigation \(no --write\)\s+node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" task --cwd <repo> --prompt-file <path>/
  );
  assert.doesNotMatch(command, /node scripts\/codex-companion\.mjs task/);
  assert.match(agent, /Use this wrapper for one bounded non-write, non-review task only/i);
  assert.match(agent, /plainly multi-minute, write, or review work, do not invoke Codex/i);
  assert.match(
    agent,
    /task --write --cwd <repo> --prompt-file <path>/
  );
  assert.match(agent, /review --cwd <repo> "<focus>"/);
  assert.match(agent, /long read-only investigation: `task --cwd <repo> --prompt-file <path>` \(no `--write`\)/);
  assert.doesNotMatch(agent, /node scripts\/codex-companion\.mjs task/);
});
