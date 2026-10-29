import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import {
  PATHS,
  PACKAGE_ROOT,
  PROTOCOL_VERSION,
  WebMcpConfig,
  ensureHome,
  getOrCreateToken,
  readPackageVersion,
  tokensEqual,
} from "./paths.js";
import { IdentityPayload, SERVER_IDENTITY } from "./protocol.js";

type Log = (msg: string) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, timeoutMs = 2000): Promise<unknown> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return resp.json();
}

// ─── Coordination server ─────────────────────────────────────────────────

/**
 * Asks whoever listens on the port who it is. With a token, also sends a
 * random challenge: only a server that knows the token can answer it, so
 * another local user squatting the port can't impersonate web-mcp and
 * collect the token or typed text (`verified` is false then).
 */
export async function getServerIdentity(
  port: number,
  token?: string
): Promise<{ reachable: boolean; identity?: IdentityPayload; verified?: boolean }> {
  const challenge = crypto.randomBytes(32).toString("hex");
  try {
    const url = `http://127.0.0.1:${port}/.identity` + (token ? `?challenge=${challenge}` : "");
    const data = (await fetchJson(url, 1500)) as Partial<IdentityPayload>;
    if (data && data.identity === SERVER_IDENTITY) {
      let verified: boolean | undefined;
      if (token) {
        const expected = crypto.createHmac("sha256", token).update(challenge).digest("hex");
        verified = typeof data.proof === "string" && tokensEqual(data.proof, expected);
      }
      return { reachable: true, identity: data as IdentityPayload, verified };
    }
    return { reachable: true };
  } catch (err) {
    // A JSON parse error means *something* answered HTTP on that port.
    const name = (err as Error).name;
    return { reachable: name === "SyntaxError" };
  }
}

function serverScriptPath(): string {
  const min = path.join(PACKAGE_ROOT, "dist", "server", "server.min.js");
  return fs.existsSync(min) ? min : path.join(PACKAGE_ROOT, "dist", "server", "server.js");
}

/**
 * Makes sure a compatible coordination server is listening. Never kills
 * whatever else might own the port: 0.1.x force-killed any process listening
 * on 3026, which could take down an unrelated app.
 */
export async function ensureServer(config: WebMcpConfig, log: Log): Promise<{ ok: boolean; error?: string }> {
  const port = config.server.port;
  ensureHome();
  const token = getOrCreateToken(); // the server reads it on startup
  const current = await getServerIdentity(port, token);

  if (current.identity) {
    if (current.identity.protocol !== PROTOCOL_VERSION) {
      const which = current.identity.protocol === undefined ? "An older web-mcp (0.1.x)" : `A different web-mcp version (v${current.identity.version})`;
      return {
        ok: false,
        error:
          `${which} is already running on port ${port}, probably started by another AI client. ` +
          `Update that client's web-mcp or run \`web-mcp stop\`, then retry.`,
      };
    }
    if (!current.verified) {
      return {
        ok: false,
        error: `The program on port ${port} claims to be web-mcp but cannot prove it knows this machine's web-mcp token, so no data was sent to it. Another user or program may be using the port; set "server.port" in ${PATHS.configFile}.`,
      };
    }
    return { ok: true };
  }
  if (current.reachable) {
    return { ok: false, error: `Port ${port} is in use by another program. Set "server.port" in ${PATHS.configFile} to a free port.` };
  }

  const script = serverScriptPath();
  if (!fs.existsSync(script)) {
    return { ok: false, error: "Coordination server script not found: " + script };
  }

  log("Starting coordination server...");
  const proc = spawn(process.execPath, [script], {
    cwd: path.dirname(script),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, WEB_MCP_HOME: PATHS.home },
  });
  proc.on("error", (err) => log("Coordination server spawn failed: " + (err && err.message)));
  proc.unref();

  // Two wrappers may race here; the loser's server exits with EADDRINUSE and
  // both end up talking to the winner.
  const deadline = Date.now() + config.server.startupTimeout;
  while (Date.now() < deadline) {
    const id = await getServerIdentity(port, token);
    if (id.identity) {
      if (id.identity.protocol !== PROTOCOL_VERSION || !id.verified) {
        return { ok: false, error: `Port ${port} was taken by another program (or an incompatible web-mcp server) while starting.` };
      }
      log("  → Server healthy ✓");
      return { ok: true };
    }
    await sleep(200);
  }
  return { ok: false, error: `Coordination server did not start within ${config.server.startupTimeout / 1000}s. See ${path.join(PATHS.logsDir, "server.log")}.` };
}

// ─── Chromium ────────────────────────────────────────────────────────────

// Chrome for Testing lives in puppeteer's default cache. We deliberately do NOT
// import the `puppeteer` package to find it: puppeteer loads .puppeteerrc.*
// and package.json config from the current directory upwards, and the wrapper
// runs in whatever project the AI client opened — a malicious repo could run
// code in web-mcp or point it at any executable.
// PUPPETEER_CACHE_DIR (set by the user, unlike repo config files) is honoured
// so a Chrome downloaded at install time with a custom cache is found.
const CFT_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), ".cache", "puppeteer");

async function pinnedChromeBuild(): Promise<string> {
  const { PUPPETEER_REVISIONS } = await import("puppeteer-core/internal/revisions.js");
  return PUPPETEER_REVISIONS.chrome;
}

async function findChromeForTesting(): Promise<string | null> {
  try {
    const browsers = await import("@puppeteer/browsers");
    const pinned = browsers.computeExecutablePath({ browser: browsers.Browser.CHROME, buildId: await pinnedChromeBuild(), cacheDir: CFT_CACHE_DIR });
    if (fs.existsSync(pinned)) return pinned;
    // Otherwise the newest Chrome for Testing already in the cache.
    const installed = (await browsers.getInstalledBrowsers({ cacheDir: CFT_CACHE_DIR }))
      .filter((b) => b.browser === browsers.Browser.CHROME && fs.existsSync(b.executablePath))
      .sort((a, b) => b.buildId.localeCompare(a.buildId, undefined, { numeric: true }));
    return installed[0]?.executablePath ?? null;
  } catch {
    return null;
  }
}

/** Downloads the Chrome for Testing build pinned by our puppeteer version (`web-mcp install-browser`). */
export async function installChromeForTesting(log: Log): Promise<{ ok: boolean; executablePath?: string; error?: string }> {
  try {
    const browsers = await import("@puppeteer/browsers");
    const buildId = await pinnedChromeBuild();
    log(`Downloading Chrome for Testing ${buildId} to ${CFT_CACHE_DIR} ...`);
    let lastPct = -1;
    const installed = await browsers.install({
      browser: browsers.Browser.CHROME,
      buildId,
      cacheDir: CFT_CACHE_DIR,
      downloadProgressCallback: (done: number, total: number) => {
        const pct = total ? Math.floor((done / total) * 10) * 10 : 0;
        if (pct !== lastPct) {
          lastPct = pct;
          log(`  ${pct}%`);
        }
      },
    });
    return { ok: true, executablePath: installed.executablePath };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function findChromePath(config: WebMcpConfig): Promise<string> {
  if (config.chrome.executable !== "auto-detect") {
    if (fs.existsSync(config.chrome.executable)) return config.chrome.executable;
    throw new Error("Configured chrome.executable does not exist: " + config.chrome.executable);
  }

  const cft = await findChromeForTesting();
  if (cft) return cft;

  const candidates =
    process.platform === "win32"
      ? [path.join(process.env.LOCALAPPDATA || "", "Chromium", "Application", "chrome.exe")]
      : process.platform === "darwin"
        ? ["/Applications/Chromium.app/Contents/MacOS/Chromium"]
        : ["/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  throw new Error("Chromium not found. Run `web-mcp install-browser` (or `npx -y @amitnarw/web-mcp install-browser`), or set chrome.executable in " + PATHS.configFile);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Kills only processes started with exactly this --user-data-dir. */
export function killProfileChrome(profileDir: string): void {
  if (process.platform === "win32") {
    // The path travels in an environment variable so no quote character in it
    // (PowerShell also treats ‘ ’ ‚ ‛ as quotes) can break the script.
    const script =
      `$p = $env:WEB_MCP_KILL_PROFILE; ` +
      `Get-CimInstance Win32_Process | Where-Object { $c = $_.CommandLine; $c -and ` +
      `($c.Contains("--user-data-dir=$p ") -or $c.Contains("--user-data-dir=$p" + [char]34) -or $c.EndsWith("--user-data-dir=$p")) } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: "ignore",
      timeout: 20000,
      windowsHide: true,
      env: { ...process.env, WEB_MCP_KILL_PROFILE: profileDir },
    });
  } else {
    spawnSync("pkill", ["-f", "--", `--user-data-dir=${escapeRegex(profileDir)}( |$)`], { stdio: "ignore", timeout: 10000 });
  }
}

// ─── chrome-devtools-mcp helper registry ─────────────────────────────────
// Wrappers record each helper they spawn. Killing by command-line pattern
// would also hit other web-mcp homes' helpers and third-party tools that
// happen to use the same CDP port.

interface HelperRecord {
  pid: number;
  wrapperPid: number;
  chromePort: number;
}

export function registerHelper(pid: number, chromePort: number): void {
  try {
    fs.mkdirSync(PATHS.helpersDir, { recursive: true, mode: 0o700 });
    const rec: HelperRecord = { pid, wrapperPid: process.pid, chromePort };
    fs.writeFileSync(path.join(PATHS.helpersDir, `${pid}.json`), JSON.stringify(rec), { mode: 0o600 });
  } catch {
    // best effort
  }
}

export function unregisterHelper(pid: number): void {
  try {
    fs.rmSync(path.join(PATHS.helpersDir, `${pid}.json`), { force: true });
  } catch {
    // ignore
  }
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

/**
 * Kills the chrome-devtools-mcp helpers this web-mcp home spawned for the given
 * CDP port (used by stop/troubleshoot only). Each recorded PID is re-checked
 * against its command line so a reused PID is never killed.
 */
export function killStaleChromeDevtoolsMcp(chromePort: number): number {
  let killed = 0;
  let files: string[] = [];
  try {
    files = fs.readdirSync(PATHS.helpersDir).filter((f) => f.endsWith(".json"));
  } catch {
    return 0;
  }
  for (const file of files) {
    const full = path.join(PATHS.helpersDir, file);
    try {
      const rec = JSON.parse(fs.readFileSync(full, "utf8")) as HelperRecord;
      if (!Number.isInteger(rec.pid) || rec.chromePort !== chromePort) continue;
      if (isAlive(rec.pid)) {
        const cmd = commandLineOf(rec.pid);
        if (cmd.includes("chrome-devtools-mcp") && new RegExp(`--browserUrl=http://127\\.0\\.0\\.1:${chromePort}(?!\\d)`).test(cmd)) {
          process.kill(rec.pid);
          killed++;
        }
      }
      fs.rmSync(full, { force: true });
    } catch {
      // unreadable record: leave it for the next run
    }
  }
  return killed;
}

async function cdpHealthy(port: number): Promise<boolean> {
  try {
    const data = (await fetchJson(`http://127.0.0.1:${port}/json/version`, 2000)) as Record<string, unknown>;
    return !!data.webSocketDebuggerUrl;
  } catch {
    return false;
  }
}

/**
 * The id Chromium gives an unpacked extension: SHA-256 of its absolute path
 * (UTF-16LE with an upper-case drive letter on Windows, UTF-8 elsewhere),
 * first 32 hex digits mapped 0-f → a-p. Lets us recognise *our* extension
 * instead of any extension that happens to have a service_worker.js.
 */
function unpackedExtensionIds(dir: string): Set<string> {
  const ids = new Set<string>();
  const variants = new Set([path.resolve(dir)]);
  try {
    variants.add(fs.realpathSync.native(dir));
  } catch {
    // not created yet
  }
  for (let p of variants) {
    let bytes: Buffer;
    if (process.platform === "win32") {
      if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
      bytes = Buffer.from(p, "utf16le");
    } else {
      bytes = Buffer.from(p, "utf8");
    }
    const hex = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    ids.add([...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join(""));
  }
  return ids;
}

async function hasExtensionWorker(port: number): Promise<boolean> {
  const ours = unpackedExtensionIds(PATHS.extensionCopyDir);
  try {
    const targets = (await fetchJson(`http://127.0.0.1:${port}/json/list`, 2000)) as Array<Record<string, unknown>>;
    return targets.some((t) => {
      const m = t.type === "service_worker" && typeof t.url === "string" ? /^chrome-extension:\/\/([a-p]{32})\/service_worker\.js$/.exec(t.url) : null;
      return !!m && ours.has(m[1]);
    });
  } catch {
    return false;
  }
}

function sourceExtensionDir(): string {
  const built = path.join(PACKAGE_ROOT, "extension");
  if (fs.existsSync(path.join(built, "manifest.json"))) return built;
  return path.join(PACKAGE_ROOT, "src", "extension");
}

/** Version plus the name, size and mtime of every source file (env.js excluded). */
function extensionSignature(dir: string): string {
  const hash = crypto.createHash("sha256").update(readPackageVersion());
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relPath = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(relPath);
      else if (entry.name !== "env.js") {
        const st = fs.statSync(path.join(dir, relPath));
        hash.update(`${relPath}:${st.size}:${Math.floor(st.mtimeMs)}\n`);
      }
    }
  };
  walk("");
  return hash.digest("hex");
}

/**
 * Copies the extension into ~/.web-mcp/extension (user-owned, so a root-owned
 * global install still works) and writes env.js with the port and token.
 * 0.1.x only copied when the folder was missing, so upgrades kept running the
 * old extension; the copy is now refreshed whenever the source changes.
 */
function prepareExtension(config: WebMcpConfig, token: string): string {
  const dest = PATHS.extensionCopyDir;
  const source = sourceExtensionDir();
  const marker = path.join(dest, ".web-mcp-source");
  const signature = extensionSignature(source);
  const upToDate = fs.existsSync(path.join(dest, "manifest.json")) && fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === signature;

  if (!upToDate) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(source, dest, { recursive: true });
    fs.writeFileSync(marker, signature);
  }

  const envFile = path.join(dest, "env.js");
  const tmp = envFile + ".tmp." + process.pid;
  // Owner-only: this file contains the auth token.
  fs.writeFileSync(tmp, `globalThis.WEB_MCP_PORT = ${config.server.port};\nglobalThis.WEB_MCP_TOKEN = ${JSON.stringify(token)};\n`, { mode: 0o600 });
  fs.renameSync(tmp, envFile);
  return dest;
}

// Chromium requires Developer Mode in Local State for --load-extension unpacked extensions.
function seedDeveloperMode(profileDir: string): void {
  fs.mkdirSync(path.join(profileDir, "Default"), { recursive: true });
  const localStatePath = path.join(profileDir, "Local State");
  let localState: Record<string, any> = {};
  try {
    localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
  } catch {
    // missing or corrupt
  }
  if (!localState.extensions || typeof localState.extensions !== "object") localState.extensions = {};
  if (!localState.extensions.ui || typeof localState.extensions.ui !== "object") localState.extensions.ui = {};
  localState.extensions.ui.developer_mode = true;
  const tmp = localStatePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(localState, null, 2));
  fs.renameSync(tmp, localStatePath);
}

// Electron/IDE variables leaking into Chromium break it (seen with OpenCode/VS Code hosts).
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const k = key.toUpperCase();
    if (value === undefined || k.startsWith("ELECTRON_") || k.startsWith("OPENCODE_") || k.startsWith("VSCODE_")) continue;
    env[key] = value;
  }
  return env;
}

function spawnChrome(exe: string, args: string[], log: Log): number | undefined {
  let stderrFd: number | null = null;
  try {
    stderrFd = fs.openSync(PATHS.chromeStderrLog, "w");
  } catch {
    // ignore
  }
  const proc = spawn(exe, args, { detached: true, stdio: ["ignore", "ignore", stderrFd ?? "ignore"], env: cleanEnv() });
  proc.on("error", (err) => log("Chromium spawn failed: " + (err && err.message)));
  if (stderrFd !== null) {
    try {
      fs.closeSync(stderrFd);
    } catch {
      // ignore
    }
  }
  proc.unref();
  return proc.pid;
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cross-process mutex (a lock file in WEB_MCP_HOME). Several AI clients often
 * start at the same moment; without it each wrapper re-copies the extension
 * and kills the Chromium the other one just launched.
 */
async function withLaunchLock<T>(timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const lockFile = path.join(PATHS.home, "chrome-launch.lock");
  const deadline = Date.now() + timeoutMs;
  // Write our pid to a private file, then hard-link it into place: the link
  // either fails (lock held) or appears complete, so nobody reads a half-written lock.
  const mine = `${lockFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(mine, String(process.pid));
  try {
    for (;;) {
      try {
        fs.linkSync(mine, lockFile);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          const owner = Number(fs.readFileSync(lockFile, "utf8"));
          const age = Date.now() - fs.statSync(lockFile).mtimeMs;
          if ((Number.isInteger(owner) && owner > 0 && !isAlive(owner)) || age > timeoutMs) {
            fs.rmSync(lockFile, { force: true }); // stale: owner crashed
            continue;
          }
        } catch {
          continue; // lock vanished between calls
        }
        if (Date.now() > deadline) throw new Error("Timed out waiting for another web-mcp process to finish launching Chromium");
        await sleep(250);
      }
    }
  } finally {
    fs.rmSync(mine, { force: true });
  }
  try {
    return await fn();
  } finally {
    try {
      if (fs.readFileSync(lockFile, "utf8") === String(process.pid)) fs.rmSync(lockFile, { force: true });
    } catch {
      // ignore
    }
  }
}

async function checkRunningChrome(port: number, waitForWorkerMs = 0): Promise<{ ok: boolean; error?: string; launched: boolean } | null> {
  if (!(await cdpHealthy(port))) return null;
  const deadline = Date.now() + waitForWorkerMs;
  for (;;) {
    if (await hasExtensionWorker(port)) return { ok: true, launched: false };
    if (Date.now() >= deadline) break;
    await sleep(250);
  }
  // Refuse to drive a browser we didn't set up (e.g. the user's own Chrome started with --remote-debugging-port).
  return {
    ok: false,
    launched: false,
    error: `A browser is listening on CDP port ${port} but the Web MCP extension is not loaded in it. Close that browser or set "chrome.port" in ${PATHS.configFile}.`,
  };
}

/**
 * Makes sure the dedicated Chromium (with the Web MCP extension) is reachable
 * on the CDP port, launching it if needed.
 */
export async function ensureChrome(
  config: WebMcpConfig,
  log: Log,
  opts: { startUrl?: string } = {}
): Promise<{ ok: boolean; error?: string; launched: boolean }> {
  const running = await checkRunningChrome(config.chrome.port);
  if (running?.ok) return running;

  ensureHome();
  try {
    return await withLaunchLock(config.chrome.startupTimeout + 20000, async () => {
      // Another process may have launched it while we waited for the lock, or
      // may still be waiting for its extension worker to register.
      return (await checkRunningChrome(config.chrome.port, 5000)) ?? (await launchChrome(config, log, opts));
    });
  } catch (err) {
    return { ok: false, launched: false, error: (err as Error).message };
  }
}

async function launchChrome(
  config: WebMcpConfig,
  log: Log,
  opts: { startUrl?: string }
): Promise<{ ok: boolean; error?: string; launched: boolean }> {
  const port = config.chrome.port;

  let exe: string;
  try {
    exe = await findChromePath(config);
  } catch (err) {
    return { ok: false, launched: false, error: (err as Error).message };
  }

  // A hung instance without a debugging port would hold the profile lock and
  // (on Windows) keep files in the extension folder open.
  killProfileChrome(PATHS.profileDir);

  let extensionDir: string;
  try {
    extensionDir = prepareExtension(config, getOrCreateToken());
    seedDeveloperMode(PATHS.profileDir);
  } catch (err) {
    return { ok: false, launched: false, error: "Failed to prepare the browser profile: " + (err as Error).message };
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PATHS.profileDir}`,
    `--load-extension=${extensionDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "--disable-translate",
    "--disable-default-apps",
    "--disable-session-crashed-bubble",
    // Several agents work in background tabs at once; don't throttle them.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];
  if (config.chrome.headless) args.push("--headless=new");
  if (opts.startUrl) args.push(opts.startUrl);

  log("Launching Chromium with the Web MCP extension...");
  let pid = spawnChrome(exe, args, log);

  // If another Chromium on this profile was still shutting down, ours hands
  // off to it and exits immediately; retry once after a short pause.
  await sleep(700);
  if (!isAlive(pid) && !(await cdpHealthy(port))) {
    log("  → Chromium exited immediately; retrying once (see " + PATHS.chromeStderrLog + ")");
    killProfileChrome(PATHS.profileDir);
    await sleep(2000);
    pid = spawnChrome(exe, args, log);
  }

  const deadline = Date.now() + config.chrome.startupTimeout;
  while (Date.now() < deadline && !(await cdpHealthy(port))) await sleep(250);
  if (!(await cdpHealthy(port))) {
    return { ok: false, launched: true, error: `Chromium did not open its debugging port within ${config.chrome.startupTimeout / 1000}s. See ${PATHS.chromeStderrLog}.` };
  }

  for (let i = 0; i < 20; i++) {
    if (await hasExtensionWorker(port)) {
      log("  → Chromium ready, extension loaded ✓ (PID " + pid + ")");
      return { ok: true, launched: true };
    }
    await sleep(250);
  }
  return {
    ok: false,
    launched: true,
    error: "Chromium started but the Web MCP extension did not load. Run `web-mcp troubleshoot` and check " + PATHS.chromeStderrLog,
  };
}
