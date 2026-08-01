import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    env: { PATH: "C:\\Windows\\System32", SHELL: "C:\\Program Files\\Git\\bin\\bash.exe" },
    runCommandImpl(command, args, options) {
      captured = { command, args, options };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"],
    options: {
      cwd: undefined,
      env: {
        PATH: "C:\\Windows\\System32",
        SHELL: "C:\\Program Files\\Git\\bin\\bash.exe",
        MSYS_NO_PATHCONV: "1",
        MSYS2_ARG_CONV_EXCL: "*"
      }
    }
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats exit code 128 as already stopped on a non-English Windows", () => {
  // Korean Windows: taskkill translates "not found", so the English regex cannot match.
  // Only the exit code identifies the case. Without it this call throws.
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "",
        stderr: "오류: 프로세스 \"1234\"을(를) 찾을 수 없습니다.",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.method, "taskkill");
});

// The real message, from a Korean Windows host: taskkill killed the target but could not
// reap one descendant. Keying on the text would reintroduce the locale bug this file
// exists for, so the target's own liveness has to decide it.
test("terminateProcessTree accepts a taskkill failure whose target is nonetheless gone", () => {
  let probedSignal;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 255,
        signal: null,
        stdout: "",
        stderr:
          "오류: PID 27048인 프로세스(PID 1234인 자식 프로세스)를 종료할 수 없습니다.\n오류: 시도한 작업은 지원되지 않습니다.",
        error: null
      };
    },
    killImpl(pid, signal) {
      probedSignal = signal;
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(probedSignal, 0, "the target must be probed, not signalled");
});

test("terminateProcessTree still throws when taskkill fails and the target is alive", () => {
  assert.throws(
    () =>
      terminateProcessTree(1234, {
        platform: "win32",
        runCommandImpl(command, args) {
          return { command, args, status: 1, signal: null, stdout: "", stderr: "Access is denied.", error: null };
        },
        killImpl() {
          return true; // the probe finds it running
        }
      }),
    /Access is denied|taskkill/
  );
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});
