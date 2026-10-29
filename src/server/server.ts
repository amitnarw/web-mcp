import http from "http";
import net from "net";
import fs from "fs";
import {
  PATHS,
  PROTOCOL_VERSION,
  ensureHome,
  getOrCreateToken,
  loadConfig,
  readPackageVersion,
  removeLegacyDebugFiles,
} from "../shared/paths.js";
import { createApp } from "./app.js";
import { logToFile } from "./logger.js";

// Entry point of the detached coordination server (spawned by the launcher).
// All routes and state live in app.ts; this file only wires up the process.

const PORT_PROBE_TIMEOUT_MS = 500;

function log(msg: string): void {
  logToFile(msg);
}

// ─── Startup ─────────────────────────────────────────────────────────────

ensureHome();
const { config, warnings } = loadConfig();
for (const w of warnings) log("CONFIG WARNING: " + w);
for (const removed of removeLegacyDebugFiles()) log("Removed legacy debug file: " + removed);

const token = getOrCreateToken();
const version = readPackageVersion();
const port = config.server.port;

const { app, close } = createApp({ token, config, version, onShutdown: () => shutdown("POST /shutdown") });
const httpServer = http.createServer(app);

// ─── PID file ────────────────────────────────────────────────────────────
// Written only once we own the port, and removed only if it still holds our
// pid: a second instance that loses the listen race must not clobber it.

let pidFileWritten = false;

function removePidFile(): void {
  if (!pidFileWritten) return;
  try {
    if (fs.readFileSync(PATHS.pidFile, "utf8").trim() === String(process.pid)) fs.unlinkSync(PATHS.pidFile);
  } catch {
    // already gone
  }
  pidFileWritten = false;
}

// ─── Listen ──────────────────────────────────────────────────────────────

/** Exits without touching the pid file: whoever holds the port owns it. */
function exitPortInUse(detail: string): never {
  log(`Port 127.0.0.1:${port} is already in use (${detail}); exiting.`);
  console.error(`web-mcp server: port ${port} is already in use`);
  close();
  process.exit(1);
}

/**
 * True if something already accepts connections on 127.0.0.1:port. On Windows
 * a process bound to 0.0.0.0:port does not make our 127.0.0.1 bind fail, so
 * EADDRINUSE alone can't be trusted to detect a squatter.
 */
function portAnswers(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

httpServer.on("error", (err: NodeJS.ErrnoException) => {
  // Another instance (probably a racing wrapper's) owns the port and the pid file.
  if (err.code === "EADDRINUSE") exitPortInUse("EADDRINUSE");
  log("HTTP server error: " + err.message);
  console.error("web-mcp server: " + err.message);
  close();
  process.exit(1);
});

portAnswers().then((answered) => {
  if (answered) exitPortInUse("another process answers on it");
  // Loopback only: the server must never be reachable from the LAN.
  httpServer.listen(port, "127.0.0.1", () => {
    try {
      fs.writeFileSync(PATHS.pidFile, String(process.pid));
      pidFileWritten = true;
    } catch (err) {
      log("Could not write pid file: " + (err as Error).message);
    }
    log(`web-mcp server v${version} (protocol ${PROTOCOL_VERSION}) listening on 127.0.0.1:${port}, PID ${process.pid}`);
  });
});

// ─── Shutdown ────────────────────────────────────────────────────────────

function shutdown(reason: string): void {
  log(`Shutting down (${reason})...`);
  close(); // writes recordings for the remaining agents
  removePidFile();
  httpServer.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", removePidFile);

process.on("uncaughtException", (err) => {
  log("FATAL uncaught exception: " + (err.stack || err.message));
  close();
  removePidFile();
  process.exit(1);
});
