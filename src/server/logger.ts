import fs from "fs";
import path from "path";
import { PATHS } from "../shared/paths.js";

// PATHS honours WEB_MCP_HOME, so tests and side-by-side instances log to
// their own directory.
const LOG_FILE = path.join(PATHS.logsDir, "server.log");
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED_FILES = 7;

// Created lazily on first write instead of at import time.
let logsDirReady = false;

function ensureLogsDir(): void {
  if (logsDirReady) return;
  fs.mkdirSync(PATHS.logsDir, { recursive: true });
  logsDirReady = true;
}

function rotateIfNeeded(): void {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stats = fs.statSync(LOG_FILE);
    if (stats.size < MAX_LOG_SIZE) return;

    // Rotate: server.log -> server.log.1, .1 -> .2, etc.
    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
      const oldFile = `${LOG_FILE}.${i}`;
      const newFile = `${LOG_FILE}.${i + 1}`;
      if (fs.existsSync(oldFile)) {
        if (i + 1 >= MAX_ROTATED_FILES) {
          fs.unlinkSync(oldFile);
        } else {
          fs.renameSync(oldFile, newFile);
        }
      }
    }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // Ignore rotation errors
  }
}

/** Appends one line to logs/server.log. Callers must pass already-redacted text. */
export function logToFile(message: string): void {
  try {
    ensureLogsDir();
    rotateIfNeeded();
    const line = `[${new Date().toISOString()}] ${message}\n`;
    // Logs contain URLs and task names: keep them private to the user.
    fs.appendFileSync(LOG_FILE, line, { mode: 0o600 });
  } catch {
    // Ignore write errors
  }
}
