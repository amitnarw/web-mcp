import * as fs from "fs";
import { PATHS, PROTOCOL_VERSION, loadConfig, readPackageVersion } from "../shared/paths.js";
import type { AgentPublic, StatePayload } from "../shared/protocol.js";
import { findChromePath, getServerIdentity } from "../shared/launcher.js";
import { getConfiguredClientDetails } from "./setup.js";
import { readExistingToken, readPidFile } from "./stop.js";
import { CommandLines, withOk } from "./common.js";

const INDENT = "          ";

/** Agent labels/tasks come from MCP clients: strip control characters (ANSI injection) and cap length. */
function clean(value: unknown, max = 60): string {
  const s = typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, "") : "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function colorDot(color: unknown): string {
  const m = typeof color === "string" ? /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color) : null;
  if (!m) return "●";
  return `\x1b[38;2;${parseInt(m[1], 16)};${parseInt(m[2], 16)};${parseInt(m[3], 16)}m●\x1b[0m`;
}

function describeAgent(a: AgentPublic): string {
  const status = a.halted
    ? "\x1b[31mHALTED\x1b[0m"
    : a.status === "active"
      ? "\x1b[32mactive\x1b[0m"
      : "\x1b[90midle\x1b[0m";
  const tabs = Array.isArray(a.tabs) ? a.tabs.length : 0;
  const client = clean(a.clientName, 30) || "unknown client";
  const task = clean(a.taskName) ? ` · task: ${clean(a.taskName)}` : "";
  return `${INDENT}${colorDot(a.color)} ${clean(a.label) || "Agent"} (${client}) — ${status} · ${tabs} tab${tabs === 1 ? "" : "s"}${task}`;
}

async function agentLines(port: number, token: string): Promise<string[]> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (resp.status === 401) {
      return ["Agents:   \x1b[33mUnavailable (auth token rejected — the server was started with a different token)\x1b[0m"];
    }
    if (!resp.ok) return [`Agents:   \x1b[33mUnavailable (HTTP ${resp.status})\x1b[0m`];
    const state = (await resp.json()) as Partial<StatePayload>;
    const agents = Array.isArray(state.agents) ? state.agents : [];
    if (agents.length === 0) return ["Agents:   None connected"];
    return [`Agents:   ${agents.length} connected`, ...agents.map(describeAgent)];
  } catch {
    return ["Agents:   \x1b[33mUnavailable (server did not answer /state)\x1b[0m"];
  }
}

export async function getStatus(): Promise<CommandLines> {
  const lines: string[] = [];

  lines.push("\x1b[1mWeb MCP Status\x1b[0m");
  lines.push("\x1b[90m===================\x1b[0m");

  const { config, warnings } = loadConfig();
  const serverPort = config.server.port;
  const chromePort = config.chrome.port;

  // Check server
  const pidFilePid = readPidFile();
  const token = readExistingToken();
  const { reachable, identity, verified } = await getServerIdentity(serverPort, token);
  if (identity) {
    const reportedPid = typeof identity.pid === "number" ? identity.pid : null;
    const legacy = typeof identity.protocol !== "number";
    const pid = reportedPid ?? pidFilePid;
    lines.push(`Server:   \x1b[32mRunning\x1b[0m${pid ? ` (PID: ${pid})` : ""} on 127.0.0.1:${serverPort}`);
    if (legacy) {
      lines.push(`${INDENT}\x1b[33mLegacy 0.1.x server (protocol 1) — run \`web-mcp stop\` so clients start a compatible one\x1b[0m`);
    } else {
      lines.push(`${INDENT}Version: v${clean(identity.version, 30)} · protocol ${identity.protocol}`);
      if (identity.protocol !== PROTOCOL_VERSION) {
        lines.push(
          `${INDENT}\x1b[33m! Protocol ${identity.protocol} differs from this CLI (v${readPackageVersion()}, protocol ${PROTOCOL_VERSION}). ` +
            "Update the client that started it or run `web-mcp stop`.\x1b[0m"
        );
      }
      if (verified === false) {
        lines.push(`${INDENT}\x1b[33m! It cannot prove it knows this machine's web-mcp token (another program may be using the port)\x1b[0m`);
      }
    }
    if (reportedPid !== null && pidFilePid !== null && reportedPid !== pidFilePid) {
      lines.push(`${INDENT}\x1b[33m! PID file (${pidFilePid}) does not match the running server\x1b[0m`);
    }

    // Agents — the token is only sent to a server that proved it already knows it.
    if (identity.protocol === PROTOCOL_VERSION) {
      if (!token) lines.push("Agents:   \x1b[90mUnavailable (no auth token yet)\x1b[0m");
      else if (verified !== true) lines.push("Agents:   \x1b[90mUnavailable (server identity not verified)\x1b[0m");
      else lines.push(...(await agentLines(serverPort, token)));
    }
  } else if (reachable) {
    lines.push(`Server:   \x1b[31mPort ${serverPort} is used by another program\x1b[0m`);
  } else {
    lines.push("Server:   Not running" + (pidFilePid !== null ? " (stale PID file)" : ""));
  }

  // Check Chromium
  try {
    const resp = await fetch("http://127.0.0.1:" + chromePort + "/json/version", { signal: AbortSignal.timeout(1000) });
    const data = (await resp.json()) as any;
    lines.push("Chromium: Running (port " + chromePort + ")");
    lines.push(`${INDENT}Browser: ` + (clean(data?.Browser || data?.browser, 60) || "Unknown"));
  } catch {
    try {
      const exe = await findChromePath(config);
      lines.push("Chromium: Not running");
      lines.push(`${INDENT}\x1b[90mInstalled: ${exe}\x1b[0m`);
    } catch {
      lines.push("Chromium: \x1b[33mNot installed — run `web-mcp install-browser`\x1b[0m");
    }
  }

  // Check config
  lines.push("Config:   " + (fs.existsSync(PATHS.configFile) ? PATHS.configFile : "Not found"));
  for (const w of warnings) lines.push(`${INDENT}\x1b[33m! ${w}\x1b[0m`);

  // Check Configured Clients
  const configured = getConfiguredClientDetails();
  if (configured.length > 0) {
    lines.push(
      "Clients:  " +
        configured
          .map(c =>
            c.pin === "outdated"
              ? `${c.label} \x1b[33m(outdated pin v${c.version})\x1b[0m`
              : c.pin === "newer"
                ? `${c.label} \x1b[90m(pinned to newer v${c.version})\x1b[0m`
                : c.label
          )
          .join(", ")
    );
    if (configured.some(c => c.pin === "outdated")) {
      lines.push(`${INDENT}\x1b[33mRe-run \`web-mcp setup\` for clients with an outdated pin.\x1b[0m`);
    }
  } else {
    lines.push("Clients:  Not configured (run: web-mcp setup)");
  }

  return withOk(lines, true);
}
