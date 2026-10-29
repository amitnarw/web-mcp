import { loadConfig } from "../shared/paths.js";
import { ensureServer, ensureChrome, installChromeForTesting } from "../shared/launcher.js";
import { CommandLines, withOk } from "./common.js";

/**
 * `web-mcp browser`: starts the coordination server (without it the
 * extension's zombie-prevention closes every window after ~60 s) and then the
 * same dedicated Chromium the MCP wrapper uses, with the same flags and ports.
 */
export async function launchBrowser(onProgress?: (lines: string[]) => void): Promise<CommandLines> {
  const lines: string[] = [];
  const notify = () => { if (onProgress) onProgress([...lines]); };

  lines.push("Launching dedicated Chromium browser with Web MCP extension...");
  lines.push("\x1b[90m(Using a managed Chromium instance because modern Google Chrome blocks automated extension loading)\x1b[0m");
  notify();

  const { config, warnings } = loadConfig();
  for (const w of warnings) lines.push(`\x1b[33m! ${w}\x1b[0m`);

  const log = (msg: string) => {
    lines.push(`\x1b[90m${msg}\x1b[0m`);
    notify();
  };

  let server: { ok: boolean; error?: string };
  try {
    server = await ensureServer(config, log);
  } catch (err) {
    server = { ok: false, error: (err as Error).message };
  }
  if (!server.ok) {
    lines.push("\x1b[31mERROR: " + (server.error || "Coordination server failed to start") + "\x1b[0m");
    notify();
    return withOk(lines, false);
  }
  lines.push(`\x1b[32m✓ Coordination server ready on 127.0.0.1:${config.server.port}\x1b[0m`);
  notify();

  let chrome: { ok: boolean; error?: string; launched: boolean };
  try {
    chrome = await ensureChrome(config, log, { startUrl: "https://example.com" });
  } catch (err) {
    chrome = { ok: false, error: (err as Error).message, launched: false };
  }
  if (!chrome.ok) {
    lines.push("\x1b[31mERROR: " + (chrome.error || "Chromium failed to start") + "\x1b[0m");
  } else if (chrome.launched) {
    lines.push("\x1b[32mChromium launched successfully! You can now close this terminal.\x1b[0m");
  } else {
    lines.push(`\x1b[32mThe Web MCP Chromium is already running (CDP port ${config.chrome.port}).\x1b[0m`);
  }
  notify();
  return withOk(lines, chrome.ok);
}

/** `web-mcp install-browser`: downloads the Chrome for Testing build web-mcp is pinned to. */
export async function installBrowser(onProgress?: (lines: string[]) => void): Promise<CommandLines> {
  const lines: string[] = ["Installing the Chromium build used by Web MCP (Chrome for Testing)..."];
  const notify = () => { if (onProgress) onProgress([...lines]); };
  notify();

  const log = (msg: string) => {
    lines.push(`\x1b[90m${msg}\x1b[0m`);
    notify();
  };

  let result: { ok: boolean; executablePath?: string; error?: string };
  try {
    result = await installChromeForTesting(log);
  } catch (err) {
    result = { ok: false, error: (err as Error).message };
  }
  if (!result.ok) {
    lines.push("\x1b[31mERROR: " + (result.error || "Download failed") + "\x1b[0m");
    notify();
    return withOk(lines, false);
  }
  lines.push(`\x1b[32m✓ Chromium installed: ${result.executablePath}\x1b[0m`);
  const { config } = loadConfig();
  if (config.chrome.executable !== "auto-detect") {
    lines.push(`\x1b[33m! config.json sets chrome.executable to ${config.chrome.executable}; set it to "auto-detect" to use this build.\x1b[0m`);
  }
  notify();
  return withOk(lines, true);
}
