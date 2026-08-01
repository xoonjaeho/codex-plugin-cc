import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import {
  BROKER_IDLE_MS_ENV,
  createBrokerSessionDir,
  ensureBrokerSession,
  saveBrokerSession,
  spawnBrokerProcess,
  waitForBrokerEndpoint
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";

const BROKER_SCRIPT = fileURLToPath(
  new URL("../plugins/codex/scripts/app-server-broker.mjs", import.meta.url)
);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

const waitForExit = (pid, timeoutMs) => waitFor(() => !isAlive(pid), timeoutMs);
const waitForFile = (filePath, timeoutMs) => waitFor(() => fs.existsSync(filePath), timeoutMs);

// A broker is spawned detached and outlives its parent, so before the idle timeout the
// only ways it ever exited were a `broker/shutdown` RPC and SIGTERM/SIGINT. Anything
// that lost track of one stranded it, and the codex stack under it, permanently.
test("a broker nobody connects to exits on its own", async () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const sessionDir = createBrokerSessionDir();
  const endpoint = createBrokerEndpoint(sessionDir);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");

  const child = spawnBrokerProcess({
    scriptPath: BROKER_SCRIPT,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: { ...buildEnv(binDir), [BROKER_IDLE_MS_ENV]: "300" }
  });

  // Wait on the pid file, not the endpoint: probing the endpoint would connect and
  // disconnect, which is the other code path. Nothing here ever connects.
  assert.equal(await waitForFile(pidFile, 10000), true, "broker never came up");
  assert.equal(await waitForExit(child.pid, 10000), true, "broker was still alive after idling");
  assert.equal(fs.existsSync(pidFile), false, "the pid file outlived the broker");

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

// Replacing a stale broker deletes its pid, log and state files whether or not the
// process was killed -- so a survivor becomes invisible to every later reaper,
// including the SessionEnd hook, which finds brokers through the state file this path
// clears. Before the fix the sole production caller passed no killProcess at all.
test("replacing a stale broker kills the process it replaces", async () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = { ...buildEnv(binDir), [BROKER_IDLE_MS_ENV]: "300" };

  const sessionDir = createBrokerSessionDir();
  const stale = spawnBrokerProcess({
    scriptPath: BROKER_SCRIPT,
    cwd,
    endpoint: createBrokerEndpoint(sessionDir),
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    env: { ...env, [BROKER_IDLE_MS_ENV]: "600000" }
  });
  assert.equal(await waitForFile(path.join(sessionDir, "broker.pid"), 10000), true);

  // Record it against an endpoint nothing is listening on: that is what a broker whose
  // endpoint went unreachable looks like to `ensureBrokerSession`.
  saveBrokerSession(cwd, {
    endpoint: createBrokerEndpoint(createBrokerSessionDir()),
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
    pid: stale.pid
  });

  await ensureBrokerSession(cwd, { scriptPath: BROKER_SCRIPT, env });

  assert.equal(await waitForExit(stale.pid, 10000), true, "the replaced broker is still running");
});

// The timeout must not fire under a connected client: a turn holds its socket open for
// its whole duration, so killing a broker with a live socket would kill a running job.
test("a connected client holds the broker open, and releases it on disconnect", async () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const sessionDir = createBrokerSessionDir();
  const endpoint = createBrokerEndpoint(sessionDir);

  const child = spawnBrokerProcess({
    scriptPath: BROKER_SCRIPT,
    cwd,
    endpoint,
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    env: { ...buildEnv(binDir), [BROKER_IDLE_MS_ENV]: "300" }
  });

  assert.equal(await waitForBrokerEndpoint(endpoint, 10000), true, "broker never came up");

  const socket = await new Promise((resolve, reject) => {
    const s = net.connect(parseBrokerEndpoint(endpoint).path);
    s.on("connect", () => resolve(s));
    s.on("error", reject);
  });

  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(isAlive(child.pid), true, "broker exited while a client was connected");

  socket.end();
  assert.equal(await waitForExit(child.pid, 10000), true, "broker survived its client");

  fs.rmSync(sessionDir, { recursive: true, force: true });
});
