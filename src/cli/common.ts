/**
 * Report lines plus a success flag. Still a plain string[] for the interactive
 * dashboard; bin/web-mcp.js reads `.ok` to pick the process exit code instead
 * of parsing the text.
 */
export type CommandLines = string[] & { ok: boolean };

export function withOk(lines: string[], ok: boolean): CommandLines {
  return Object.assign(lines, { ok });
}

/** Single source for `web-mcp help` (bin) and the dashboard's help screen. */
export const HELP_LINES = [
  "\x1b[1mWeb MCP - In-Browser Copilot\x1b[0m",
  "",
  "Usage:",
  "  web-mcp                    Open the interactive dashboard",
  "  web-mcp mcp                Run MCP server (used automatically by AI clients)",
  "  web-mcp setup [client]     Configure an AI client (menu, or e.g. `web-mcp setup cursor`)",
  "  web-mcp uninstall [client] Remove web-mcp from a client (menu, or e.g. `web-mcp uninstall cursor`)",
  "  web-mcp uninstall all --yes  Remove from ALL clients and delete local data (incl. browser logins)",
  "  web-mcp browser            Launch the isolated Chromium browser manually",
  "  web-mcp install-browser    Download the Chromium build (Chrome for Testing) web-mcp uses",
  "  web-mcp troubleshoot       Troubleshoot and fix environment issues (keeps logins and settings)",
  "      --reset-profile        Also reset the Web MCP browser profile (signs you out of all sites)",
  "      --reset-config         Also reset ~/.web-mcp/config.json to defaults (a backup is kept)",
  "  web-mcp test               Test Setup & Configurations",
  "  web-mcp status             Check Server & Chromium Status",
  "  web-mcp stop               Stop Server & Chromium",
  "  web-mcp help               Show this help menu",
  "  web-mcp about              About Web MCP",
  "",
  "Clients: opencode, claude-desktop, claude-code, cursor, windsurf, zed, cody, openai-codex,",
  "         antigravity, cline, chatgpt, manual",
];
