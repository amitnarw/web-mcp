import fs from "fs";
import path from "path";
import { PATHS, loadConfig, removeLegacyDebugFiles } from "../shared/paths.js";
import { findChromePath, killProfileChrome, killStaleChromeDevtoolsMcp } from "../shared/launcher.js";
import { stopCoordinationServer } from "./stop.js";
import { CommandLines, withOk } from "./common.js";

export interface TroubleshootOptions {
  /** Also delete the dedicated Chromium profile (signs the user out of every site in the Web MCP browser). */
  resetProfile?: boolean;
  /** Also reset config.json to defaults (after backing it up to config.json.<timestamp>.bak). */
  resetConfig?: boolean;
}

type Progress = (lines: string[]) => void;

const OK = "\x1b[32m[✓]\x1b[0m";
const SKIP = "\x1b[90m[-]\x1b[0m";
const FAIL = "\x1b[31m[x]\x1b[0m";
const WARN = "\x1b[33m[!]\x1b[0m";

// Profile folders used by older versions (<= 0.1.3) next to the current one.
const LEGACY_PROFILE_DIRS = ["chrome-profile", "chrome-profile-v2"];

/** ok is false if any step failed ([x]). */
export async function runTroubleshooter(options?: TroubleshootOptions | Progress, onProgress?: Progress): Promise<CommandLines> {
  // Backwards compatible with the old runTroubleshooter(onProgress) signature.
  if (typeof options === "function") {
    onProgress = options;
    options = {};
  }
  const resetProfile = !!options?.resetProfile;
  const resetConfig = !!options?.resetConfig;

  const lines: string[] = ["\x1b[36mRunning Web MCP Troubleshooter...\x1b[0m", ""];
  let failed = false;
  const fail = (msg: string) => {
    failed = true;
    lines.push(`${FAIL} ${msg}`);
  };

  const notify = () => { if (onProgress) onProgress([...lines]); };
  notify();

  // Read the config ONCE: its ports decide which processes are ours, for every step below.
  const hadConfig = fs.existsSync(PATHS.configFile);
  const { config, warnings } = loadConfig();

  // Step 1: Config check (settings such as security.allowEvaluate are kept unless --reset-config)
  if (!hadConfig) {
    lines.push(`${SKIP} No config.json found (created defaults)`);
  } else if (warnings.length === 0) {
    lines.push(`${OK} config.json is valid`);
  } else {
    for (const w of warnings) lines.push(`${WARN} ${w}`);
    if (!resetConfig) {
      lines.push(`\x1b[90m    Fix these values in ${PATHS.configFile}, or run: web-mcp troubleshoot --reset-config\x1b[0m`);
    }
  }
  notify();

  // Step 2: Remove debug dumps written by <= 0.1.6 (one contained the full environment, incl. API keys)
  const removed = removeLegacyDebugFiles();
  if (removed.length === 0) {
    lines.push(`${SKIP} No legacy debug files found`);
  } else {
    for (const f of removed) lines.push(`${OK} Removed legacy debug file ${f}`);
    if (removed.some(f => path.basename(f) === "debug-env-dump.json")) {
      lines.push(`\x1b[31m[!] web-mcp 0.1.6 and earlier saved your full environment — including any API keys and tokens —\x1b[0m`);
      lines.push(`\x1b[31m    to debug-env-dump.json. Rotate any API keys/tokens that were set in your environment\x1b[0m`);
      lines.push(`\x1b[31m    (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN, cloud credentials).\x1b[0m`);
    }
  }
  notify();

  // Step 3: Stop our processes (scoped: never by broad command-line wildcards)
  const server = await stopCoordinationServer(config.server.port);
  if (server.status === "failed") fail(server.message);
  else lines.push(`${server.status === "stopped" ? OK : server.status === "skipped" ? WARN : SKIP} ${server.message}`);
  notify();

  try {
    const helpers = killStaleChromeDevtoolsMcp(config.chrome.port);
    killProfileChrome(PATHS.profileDir);
    // Give OS time to release file locks
    await new Promise(r => setTimeout(r, 1500));
    lines.push(`${OK} Stopped the Web MCP Chromium${helpers > 0 ? ` and ${helpers} chrome-devtools-mcp helper${helpers === 1 ? "" : "s"}` : ""}`);
  } catch (e) {
    fail(`Error stopping Chromium processes: ${(e as Error).message}`);
  }
  notify();

  // Step 4: Reset config.json only on request
  let chromeConfig = config;
  if (resetConfig) {
    try {
      if (fs.existsSync(PATHS.configFile)) {
        const bak = `${PATHS.configFile}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
        fs.copyFileSync(PATHS.configFile, bak, fs.constants.COPYFILE_EXCL);
        fs.unlinkSync(PATHS.configFile);
        chromeConfig = loadConfig().config; // recreates the defaults
        lines.push(`${OK} Reset config.json to defaults (previous one saved as ${bak})`);
      } else {
        lines.push(`${SKIP} No config.json to reset`);
      }
    } catch (e) {
      fail(`Failed to reset config.json: ${(e as Error).message}`);
    }
    notify();
  }

  // Step 5: Browser profile — holds the user's logins, so only on explicit request
  if (resetProfile) {
    try {
      let deletedAny = false;
      for (const dir of [PATHS.profileDir, ...LEGACY_PROFILE_DIRS.map(d => path.join(PATHS.home, d))]) {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
          deletedAny = true;
        }
      }
      if (deletedAny) {
        lines.push(`${OK} Deleted the Web MCP browser profile — saved logins in the Web MCP browser were removed`);
      } else {
        lines.push(`${SKIP} No Web MCP browser profile found`);
      }
    } catch (e) {
      fail("Failed to delete the browser profile (a process might still be locking it)");
    }
  } else {
    lines.push(`${SKIP} Kept the Web MCP browser profile (your saved logins)`);
    lines.push("\x1b[90m    If the browser itself is broken, run: web-mcp troubleshoot --reset-profile\x1b[0m");
    lines.push("\x1b[90m    (this signs you out of every site in the Web MCP browser)\x1b[0m");
  }
  notify();

  // Step 6: Delete cached extension (re-copied with a fresh env.js on next launch)
  try {
    if (fs.existsSync(PATHS.extensionCopyDir)) {
      fs.rmSync(PATHS.extensionCopyDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      lines.push(`${OK} Deleted cached extension directory`);
    } else {
      lines.push(`${SKIP} No cached extension directory found`);
    }
  } catch (e) {
    fail("Failed to delete cached extension directory");
  }
  notify();

  // Step 7: Check Chromium detection
  try {
    const exe = await findChromePath(chromeConfig);
    lines.push(`${OK} Chromium executable detected: ${exe}`);
  } catch (e) {
    fail(`Chromium executable NOT found: ${(e as Error).message}`);
    if (!(e as Error).message.includes("install-browser")) {
      lines.push("    Run `web-mcp install-browser` to download it.");
    }
  }
  notify();

  lines.push("");
  if (failed) {
    lines.push("\x1b[31mTroubleshooting finished with errors (see [x] above).\x1b[0m");
  } else {
    lines.push("\x1b[32mTroubleshooting complete.\x1b[0m Your AI clients will restart the server and browser on their next browser tool call.");
  }
  notify();

  return withOk(lines, !failed);
}
