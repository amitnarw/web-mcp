import * as fs from "fs";
import { spawnSync } from "child_process";
import { PATHS, loadConfig, getOrCreateToken } from "../shared/paths.js";
import { getServerIdentity, killProfileChrome, killStaleChromeDevtoolsMcp } from "../shared/launcher.js";
import { CommandLines, withOk } from "./common.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readPidFile(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(PATHS.pidFile, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function removePidFile(): void {
  try { fs.unlinkSync(PATHS.pidFile); } catch {}
}

/** The auth token if one exists (never creates one). */
export function readExistingToken(): string | undefined {
  if (!fs.existsSync(PATHS.tokenFile)) return undefined;
  try {
    return getOrCreateToken();
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
}

async function waitForServerGone(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await getServerIdentity(port)).identity) return true;
    await sleep(150);
  }
  return !(await getServerIdentity(port)).identity;
}

/** POST /shutdown with the token: the server answers 202, writes recordings and exits. */
async function requestShutdown(port: number, token: string): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(3000),
    });
    return resp.status === 202 || resp.ok;
  } catch {
    return false;
  }
}

// ─── Process ownership checks (0.1.x servers prove nothing about themselves) ───

/** True if a command line looks like a web-mcp coordination server (pure; exported for tests). */
export function isLegacyServerCommandLine(cmd: string): boolean {
  const c = cmd.replace(/\\/g, "/").toLowerCase();
  return (c.includes("server") && c.includes("web-mcp")) || (c.includes("dist") && c.includes("server.min.js"));
}

function parsePids(text: string): number[] {
  return [...new Set(text.split(/\s+/).map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n > 0))];
}

function listeningPids(port: number): number[] {
  if (!Number.isInteger(port)) return [];
  if (process.platform === "win32") {
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`],
      { encoding: "utf8", timeout: 15000, windowsHide: true }
    );
    return parsePids(r.stdout || "");
  }
  const lsof = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", timeout: 10000 });
  if (!lsof.error) return parsePids(lsof.stdout || "");
  // No lsof (minimal Linux): ss prints users:(("node",pid=123,fd=19))
  const ss = spawnSync("ss", ["-Hltnp", `sport = :${port}`], { encoding: "utf8", timeout: 10000 });
  return parsePids([...(ss.stdout || "").matchAll(/pid=(\d+)/g)].map(m => m[1]).join(" "));
}

function commandLineOf(pid: number): string {
  if (process.platform === "win32") {
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: "utf8", timeout: 15000, windowsHide: true }
    );
    return (r.stdout || "").trim();
  }
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
  return (r.stdout || "").trim();
}

/** The PID from our pid file really is the web-mcp server listening on the port (not a reused PID). */
function ownsPortAsServer(pid: number, port: number): boolean {
  return listeningPids(port).includes(pid) && isLegacyServerCommandLine(commandLineOf(pid));
}

export type ServerStopStatus = "stopped" | "not-running" | "stale-pid" | "skipped" | "failed";

/**
 * Stops the coordination server:
 *   1. authenticated POST /shutdown (graceful: recordings are written);
 *   2. otherwise SIGTERM — only the PID in our pid file, and only after
 *      /.identity on our port reports that same PID. A 0.1.x server reports no
 *      PID, and a server that can't prove it knows our token may be an
 *      impostor, so for those the PID must also own the listening port and
 *      look like a web-mcp server. Never kills by command-line wildcards.
 */
export async function stopCoordinationServer(port: number): Promise<{ status: ServerStopStatus; message: string }> {
  const pid = readPidFile();
  const token = readExistingToken();
  const { reachable, identity, verified } = await getServerIdentity(port, token);
  const reportedPid = identity && typeof identity.pid === "number" ? identity.pid : null;
  const legacy = !!identity && typeof identity.protocol !== "number";

  // Only send the token to a server that proved it already knows it.
  if (identity && !legacy && token && verified === true && (await requestShutdown(port, token))) {
    if (await waitForServerGone(port, 3000)) {
      if (pid !== null) removePidFile(); // the server is gone, so the file is stale either way
      return { status: "stopped", message: `Stopped server${reportedPid ? ` (PID: ${reportedPid})` : ""}` };
    }
  }

  if (pid === null) {
    if (identity) {
      return {
        status: "skipped",
        message: `A web-mcp server is running on port ${port}${reportedPid ? ` (PID ${reportedPid})` : ""} but ${PATHS.pidFile} is missing; not stopping it.`,
      };
    }
    return { status: "not-running", message: "Server not running (no PID file)" };
  }

  if (!identity) {
    removePidFile();
    return {
      status: "stale-pid",
      message: reachable
        ? `Port ${port} is used by another program; removed stale PID file (PID ${pid} was not touched)`
        : `Server not running; removed stale PID file (PID ${pid})`,
    };
  }

  if (reportedPid !== null && reportedPid !== pid) {
    removePidFile();
    return {
      status: "stale-pid",
      message: `The server on port ${port} reports PID ${reportedPid}, not ${pid} from the PID file; removed the stale PID file without stopping anything.`,
    };
  }

  if ((legacy || verified === false) && !ownsPortAsServer(pid, port)) {
    return {
      status: "skipped",
      message:
        `Not stopping PID ${pid}: it could not be confirmed as the web-mcp server listening on port ${port}` +
        (legacy ? " (legacy 0.1.x server)" : " (it could not prove it knows this machine's token)") +
        ". Stop that process manually if it is web-mcp.",
    };
  }

  const label = legacy ? " (legacy 0.1.x server)" : "";
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    removePidFile();
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return { status: "not-running", message: `Server process ${pid} not running; removed stale PID file` };
    }
    return { status: "failed", message: `Could not stop server (PID: ${pid}): ${(err as Error).message}` };
  }

  let exited = await waitForExit(pid, 5000);
  if (!exited && process.platform !== "win32") {
    try { process.kill(pid, "SIGKILL"); } catch {}
    exited = await waitForExit(pid, 2000);
  }
  if (!exited) {
    return { status: "failed", message: `Server (PID: ${pid}) did not exit after SIGTERM` };
  }
  // The server removes its PID file on a graceful exit; on Windows SIGTERM is a hard kill.
  if (readPidFile() === pid) removePidFile();
  return { status: "stopped", message: `Stopped server${label} (PID: ${pid})` };
}

async function cdpResponding(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return resp.ok;
  } catch {
    return false;
  }
}

/** ok is false if the server could not be stopped or a kill step failed. */
export async function stopProcesses(): Promise<CommandLines> {
  const lines: string[] = [];

  lines.push("\x1b[1mWeb MCP Stop\x1b[0m");
  lines.push("\x1b[90m=================\x1b[0m");

  const { config, warnings } = loadConfig();
  for (const w of warnings) lines.push(`\x1b[33m! ${w}\x1b[0m`);
  let ok = true;

  // Stop server
  const server = await stopCoordinationServer(config.server.port);
  if (server.status === "failed" || server.status === "skipped") ok = false;
  const color = server.status === "stopped" ? "\x1b[32m" : server.status === "failed" ? "\x1b[31m" : server.status === "skipped" ? "\x1b[33m" : "";
  lines.push(color ? `${color}${server.message}\x1b[0m` : server.message);

  // chrome-devtools-mcp helpers this web-mcp home spawned for our CDP port
  try {
    const n = killStaleChromeDevtoolsMcp(config.chrome.port);
    lines.push(n > 0 ? `Stopped ${n} chrome-devtools-mcp helper${n === 1 ? "" : "s"}` : "No chrome-devtools-mcp helpers to stop");
  } catch (err) {
    ok = false;
    lines.push(`\x1b[31mFailed to stop chrome-devtools-mcp helpers: ${(err as Error).message}\x1b[0m`);
  }

  // Stop Chromium with our profile (only processes using exactly that --user-data-dir)
  const wasUp = await cdpResponding(config.chrome.port);
  try {
    killProfileChrome(PATHS.profileDir);
  } catch (err) {
    lines.push(`\x1b[31mFailed to stop Chromium: ${(err as Error).message}\x1b[0m`);
    return withOk(lines, false);
  }
  if (!wasUp) {
    lines.push(`No Web MCP Chromium responding on port ${config.chrome.port} (cleaned up any leftover profile processes)`);
  } else {
    let stillUp = true;
    for (let i = 0; i < 15 && stillUp; i++) {
      await sleep(200);
      stillUp = await cdpResponding(config.chrome.port);
    }
    lines.push(
      stillUp
        ? `\x1b[33mA browser on port ${config.chrome.port} is still running; it does not use the Web MCP profile, so it was left alone.\x1b[0m`
        : "\x1b[32mStopped Chromium instances with Web MCP profile\x1b[0m"
    );
  }

  return withOk(lines, ok);
}
