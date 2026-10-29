import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { fileURLToPath } from "url";

// ─── Protocol ────────────────────────────────────────────────────────────
// Bump whenever the HTTP contract between wrapper, server and extension
// changes incompatibly. Wrappers refuse to talk to a server with a different
// protocol instead of silently corrupting its state.
export const PROTOCOL_VERSION = 2;

// ─── Paths ───────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
// Both the tsc output (dist/<dir>/file.js) and the esbuild bundles
// (dist/<dir>/file.min.js) live two levels below the package root.
export const PACKAGE_ROOT = path.join(path.dirname(__filename), "..", "..");

// WEB_MCP_HOME lets tests (and power users) run a fully separate instance.
export const WEB_MCP_HOME = process.env.WEB_MCP_HOME || path.join(os.homedir(), ".web-mcp");

export const PATHS = {
  home: WEB_MCP_HOME,
  configFile: path.join(WEB_MCP_HOME, "config.json"),
  pidFile: path.join(WEB_MCP_HOME, "server.pid"),
  tokenFile: path.join(WEB_MCP_HOME, "auth-token"),
  logsDir: path.join(WEB_MCP_HOME, "logs"),
  recordingsDir: path.join(WEB_MCP_HOME, "recordings"),
  extensionCopyDir: path.join(WEB_MCP_HOME, "extension"),
  profileDir: path.join(WEB_MCP_HOME, "chromium-profile-v2"),
  chromeStderrLog: path.join(WEB_MCP_HOME, "chrome-stderr.log"),
  // One file per chrome-devtools-mcp helper we spawned, so stop/troubleshoot
  // only ever kill our own helpers (never other instances' or third parties').
  helpersDir: path.join(WEB_MCP_HOME, "helpers"),
};

/** How often wrappers heartbeat; agents.staleAfterMs must stay well above it. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

export function ensureHome(): void {
  // Owner-only: the folder holds the auth token, logs and the browser profile.
  fs.mkdirSync(WEB_MCP_HOME, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies to new folders; tighten one left by 0.1.x.
  if (process.platform !== "win32") {
    try {
      if ((fs.statSync(WEB_MCP_HOME).mode & 0o077) !== 0) fs.chmodSync(WEB_MCP_HOME, 0o700);
    } catch {
      // not ours to fix (e.g. owned by another user)
    }
  }
}

export function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ─── Config ──────────────────────────────────────────────────────────────

export type LogLevelName = "debug" | "info" | "warn" | "error";

export interface WebMcpConfig {
  server: { port: number; startupTimeout: number };
  chrome: { port: number; executable: string; startupTimeout: number; headless: boolean };
  logging: { level: LogLevelName };
  security: {
    // Expose browser_evaluate (arbitrary JS in the page) to the model.
    allowEvaluate: boolean;
    // URLPattern strings passed to chrome-devtools-mcp --blockedUrlPattern.
    blockedUrlPatterns: string[];
  };
  agents: {
    // An agent with no tool calls for this long is marked idle and its overlay is released.
    idleTimeoutMs: number;
    // An agent whose wrapper stopped heart-beating for this long is removed.
    staleAfterMs: number;
    // Number of per-agent recordings kept in ~/.web-mcp/recordings.
    maxRecordings: number;
  };
}

export const DEFAULT_CONFIG: WebMcpConfig = {
  server: { port: 3026, startupTimeout: 15000 },
  chrome: { port: 9222, executable: "auto-detect", startupTimeout: 20000, headless: false },
  logging: { level: "info" },
  security: { allowEvaluate: true, blockedUrlPatterns: [] },
  agents: { idleTimeoutMs: 90_000, staleAfterMs: 60_000, maxRecordings: 50 },
};

function isPort(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1024 && v <= 65535;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function pick<T>(value: unknown, valid: (v: unknown) => boolean, fallback: T, name: string, warnings: string[]): T {
  if (value === undefined) return fallback;
  if (valid(value)) return value as T;
  warnings.push(`Ignoring invalid config value for ${name}: ${JSON.stringify(value)}`);
  return fallback;
}

/**
 * Loads ~/.web-mcp/config.json, validating every field. Never throws: invalid
 * fields fall back to defaults and are reported in `warnings`. Values that end
 * up in shell commands (ports) are guaranteed to be integers.
 */
export function loadConfig(): { config: WebMcpConfig; warnings: string[] } {
  const warnings: string[] = [];
  let raw: Record<string, any> = {};

  if (fs.existsSync(PATHS.configFile)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(PATHS.configFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, any>;
      } else {
        warnings.push("config.json is not an object; using defaults");
        raw = {};
      }
    } catch (err) {
      warnings.push("Failed to parse config.json, using defaults: " + (err as Error).message);
    }
  } else {
    try {
      ensureHome();
      const tmp = PATHS.configFile + ".tmp." + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(DEFAULT_CONFIG, null, 2));
      fs.renameSync(tmp, PATHS.configFile);
    } catch (err) {
      warnings.push("Could not create config.json: " + (err as Error).message);
    }
  }

  const d = DEFAULT_CONFIG;
  const s = raw.server || {};
  const c = raw.chrome || {};
  const l = raw.logging || {};
  const sec = raw.security || {};
  const a = raw.agents || {};

  const config: WebMcpConfig = {
    server: {
      port: pick(s.port, isPort, d.server.port, "server.port", warnings),
      startupTimeout: pick(s.startupTimeout, isPositiveInt, d.server.startupTimeout, "server.startupTimeout", warnings),
    },
    chrome: {
      port: pick(c.port, isPort, d.chrome.port, "chrome.port", warnings),
      executable: pick(c.executable, (v) => typeof v === "string" && v.length > 0, d.chrome.executable, "chrome.executable", warnings),
      startupTimeout: pick(c.startupTimeout, isPositiveInt, d.chrome.startupTimeout, "chrome.startupTimeout", warnings),
      headless: pick(c.headless, (v) => typeof v === "boolean", d.chrome.headless, "chrome.headless", warnings),
    },
    logging: {
      level: pick(l.level, (v) => v === "debug" || v === "info" || v === "warn" || v === "error", d.logging.level, "logging.level", warnings),
    },
    security: {
      allowEvaluate: pick(sec.allowEvaluate, (v) => typeof v === "boolean", d.security.allowEvaluate, "security.allowEvaluate", warnings),
      blockedUrlPatterns: pick(
        sec.blockedUrlPatterns,
        (v) => Array.isArray(v) && v.every((p) => typeof p === "string"),
        d.security.blockedUrlPatterns,
        "security.blockedUrlPatterns",
        warnings
      ),
    },
    agents: {
      idleTimeoutMs: pick(a.idleTimeoutMs, isPositiveInt, d.agents.idleTimeoutMs, "agents.idleTimeoutMs", warnings),
      staleAfterMs: pick(a.staleAfterMs, isPositiveInt, d.agents.staleAfterMs, "agents.staleAfterMs", warnings),
      maxRecordings: pick(a.maxRecordings, isPositiveInt, d.agents.maxRecordings, "agents.maxRecordings", warnings),
    },
  };

  // Reaping agents faster than they heartbeat would drop (and un-halt) live agents.
  const minStale = HEARTBEAT_INTERVAL_MS * 3;
  if (config.agents.staleAfterMs < minStale) {
    warnings.push(`agents.staleAfterMs must be at least ${minStale} (3× the heartbeat); using ${minStale}`);
    config.agents.staleAfterMs = minStale;
  }

  if (config.server.port === config.chrome.port) {
    warnings.push("server.port and chrome.port are equal; using defaults for both");
    config.server.port = d.server.port;
    config.chrome.port = d.chrome.port;
  }

  return { config, warnings };
}

// ─── Auth token ──────────────────────────────────────────────────────────

/**
 * Shared secret between wrappers, the coordination server and the extension.
 * Created once and kept across restarts so a long-running Chromium (whose
 * extension holds the token in env.js) keeps working when the server restarts.
 */
export function getOrCreateToken(): string {
  ensureHome();
  try {
    const existing = fs.readFileSync(PATHS.tokenFile, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {
    // missing — create below
  }
  // Write to a private temp file and hard-link it into place, so a racing
  // process never reads a half-written token (and then overwrites it).
  const token = crypto.randomBytes(32).toString("hex");
  const tmp = `${PATHS.tokenFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  try {
    fs.linkSync(tmp, PATHS.tokenFile);
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Another process won the race, or an old file is malformed.
    const existing = fs.readFileSync(PATHS.tokenFile, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
    fs.renameSync(tmp, PATHS.tokenFile);
    return token;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// ─── Legacy cleanup ──────────────────────────────────────────────────────

/**
 * Versions <= 0.1.6 wrote the full process environment (including API keys)
 * and debug dumps to ~/.web-mcp on every browser launch, and logged/recorded
 * the first 30 characters of everything the AI typed. Remove all of that
 * (logs and session-* recordings once, guarded by a marker file).
 */
export function removeLegacyDebugFiles(): string[] {
  const removed: string[] = [];
  const remove = (p: string) => {
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        removed.push(p);
      }
    } catch {
      // ignore (e.g. locked on Windows); retried next time
    }
  };
  for (const name of ["debug-env-dump.json", "debug-extension-dir.txt", "chrome-args-debug.log"]) {
    remove(path.join(WEB_MCP_HOME, name));
  }

  const marker = path.join(WEB_MCP_HOME, ".legacy-data-removed");
  if (!fs.existsSync(marker) && fs.existsSync(WEB_MCP_HOME)) {
    try {
      for (const entry of fs.readdirSync(PATHS.recordingsDir)) {
        if (entry.startsWith("session-")) remove(path.join(PATHS.recordingsDir, entry));
      }
    } catch {
      // no recordings dir
    }
    try {
      for (const entry of fs.readdirSync(PATHS.logsDir)) {
        if (/^server\.log(\.\d+)?$/.test(entry)) remove(path.join(PATHS.logsDir, entry));
      }
    } catch {
      // no logs dir
    }
    try {
      fs.writeFileSync(marker, new Date().toISOString());
    } catch {
      // ignore
    }
  }
  return removed;
}

/** Text that is safe to write to disk for a typed value. */
export function redactTyped(prefix: string, value: string): string {
  return `${prefix} (${value.length} chars)`;
}
