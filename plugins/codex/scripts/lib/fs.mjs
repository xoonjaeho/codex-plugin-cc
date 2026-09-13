import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "codex-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const tmpFile = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    fs.writeFileSync(tmpFile, contents, "utf8");
    // Windows: rename over a file another process holds open fails transiently
    // with EPERM/EACCES/EBUSY -- retry a few times before giving up.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmpFile, filePath);
        return;
      } catch (error) {
        const transient =
          error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "EBUSY";
        if (!transient || attempt >= 4) {
          throw error;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  } catch (error) {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return fs.readFileSync(0, "utf8");
}
