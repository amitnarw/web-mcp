# Changelog

All notable changes to `@amitnarw/web-mcp`.

## 0.2.0

Several AI chats can now share the browser, each in its own tabs, and the local server and browser have been locked down. **Upgrading from 0.1.x:** follow [Upgrading](upgrading.md). It includes rotating API keys that older versions wrote to disk.

### Added

- **Multi-agent tabs.** Every MCP client process (a Claude Code chat, a Cursor window, an OpenCode session, …) is a separate agent with its own tabs, label and color. Agents only see and control the tabs they opened, plus pop-ups and `target="_blank"` tabs their own pages open. Tool results are rewritten so other tabs' URLs and titles never reach the AI. Up to 64 agents at once.
- **Per-tab overlay** in the agent's color, shown only on tabs of an active agent. When the agent is idle or halted, the tab shows a small badge instead.
- **Side panel** listing every agent: client, status, task, tabs (click to focus), recent actions, and Halt/Resume. **Halt all** is in the side panel and the toolbar popup.
- `browser_start` parameter `agentName`, and the `WEB_MCP_AGENT_NAME` environment variable, to name agents.
- `browser_new_tab` parameter `isolated` for a separate cookie jar.
- `browser_navigate` parameter `action` (`back`, `forward`, `reload`).
- New tools `browser_select_option` (by visible option text) and `browser_handle_dialog`. New `browser_click` parameter `dblClick`.
- CLI commands `web-mcp setup <client>` (non-interactive), `web-mcp uninstall <client>` and `web-mcp uninstall all --yes`, and `web-mcp install-browser` (downloads the pinned Chrome for Testing build).
- `web-mcp troubleshoot --reset-config` and `--reset-profile`.
- CLI exit codes: 0 success, 1 failure, 2 usage error. Unknown commands, options and client names are rejected.
- Config settings `chrome.headless`, `security.allowEvaluate`, `security.blockedUrlPatterns`, `agents.idleTimeoutMs`, `agents.staleAfterMs` (minimum 45 s) and `agents.maxRecordings`. All config values are validated, with warnings for invalid ones.
- `WEB_MCP_HOME` environment variable to run a fully separate instance.
- `web-mcp status` lists connected agents, says whether the server proved its identity and whether the browser is installed, and warns about version mismatches and outdated client pins. `web-mcp test` reports outdated, newer or missing pins.
- Per-agent recordings in `~/.web-mcp/recordings/<time>-<agentId>.json`, redacted, with the newest 50 kept.
- Snapshots, text waits and `browser_evaluate` results end with a note that page content is untrusted.
- Tests: `npm test` (server and setup unit tests) and `scripts/e2e-multi-agent.mjs` (17 live checks with two real MCP clients and a headless browser).
- New documentation: Several AIs at once, Configuration, Security, Upgrading, Architecture and Contributing.

### Changed

- `browser_stop` closes the tabs the agent owns and ends only that agent's session. The shared browser and server keep running. It is refused while the agent is halted.
- `browser_done` releases only the calling agent's overlay.
- Halt is per agent and **sticky until Resume** (it used to be global and expired after 10 seconds). A halt survives server restarts and laptop sleep: a reconnecting agent keeps its id, name, color and halt state.
- An agent's first tab opens in the foreground and later tabs in the background. Background-tab throttling is disabled, so agents can work in parallel.
- `browser_start` is now an optional naming tool (it used to be described as internal).
- `browser_hover` keeps the hover state until the agent's next action, so hover menus can be read.
- The overlay shows only the agent's name and the kind of action, sits in the browser's top layer, is re-attached if a page removes it, and also blocks right-clicks, scrolling and touch input. It is hidden in the AI's screenshots, and Enter still submits forms through it.
- The side panel never shows values typed into password-like fields (only their length).
- A browser that was closed is relaunched on the next tool call.
- Dialogs that open while Web MCP runs its own helper scripts, or during `browser_evaluate`, are dismissed.
- `web-mcp setup` pins client configs to `@amitnarw/web-mcp@<installed version>`. Re-running setup updates the pin, but never downgrades a newer one.
- Setup backs up each client config once (`<file>.web-mcp.bak`), writes atomically, keeps the file's formatting, writes through symbolic links, and keeps environment variables: `env`/`environment` of JSON entries, other keys and sub-tables of the Codex table, and Claude Code's env (passed as `-e KEY=VALUE`).
- Claude Code is set up with `claude mcp add --scope user` when the `claude` CLI is available, through `cmd /c` on Windows. Otherwise setup writes `~/.claude.json`.
- For Codex, `model_instructions_file` is inserted as a top-level key, an existing user value is respected, and TOML forms setup can't edit safely are left untouched.
- Zed on macOS is configured in `~/.config/zed/settings.json`.
- ChatGPT Desktop is reported as not supported (it would need the browser exposed to the internet).
- `uninstall all` asks for confirmation, stops Web MCP first and deletes only files Web MCP created.
- `web-mcp troubleshoot` keeps your settings and the browser profile (your logins) unless you pass `--reset-config` (timestamped backup) or `--reset-profile`.
- `web-mcp stop` asks the server to shut down over an authenticated request first, so recordings are written.
- `web-mcp browser` uses the same launcher, flags and ports as the MCP server, and starts the coordination server first.
- The browser is found through `@puppeteer/browsers` in `~/.cache/puppeteer` (pinned build first), then a system Chromium. The `puppeteer` package is no longer loaded at runtime.
- The extension copy in `~/.web-mcp/extension` is refreshed whenever its files change.
- The coordination server API was replaced by protocol 2 (`/agents`, `/tabs`, `/state`, `/events`, `/shutdown`, …). Wrappers refuse a server with a different protocol.
- `chrome-devtools-mcp` runs from Web MCP's own dependencies instead of `npx chrome-devtools-mcp`, with `--no-usage-statistics --no-performance-crux --redactNetworkHeaders --no-file-navigations`. Its startup errors (for example a bad `blockedUrlPatterns` entry) are now shown.
- All dependencies are pinned to exact versions and locked by a published `npm-shrinkwrap.json`. Dropped `better-sse`, `chrome-remote-interface`, `ws` and `@inquirer/prompts`. Fonts and icons moved to dev dependencies. Removed the `postinstall` script.
- Node.js requirement raised to `>=22.12.0` (it was `>=18`).

### Fixed

- One agent calling `browser_done` no longer hides other agents' overlays. Agents' actions no longer show up in every tab.
- Upgrades now load the new extension (0.1.x kept running the old copy).
- Several clients starting at once no longer kill each other's browser (cross-process launch lock).
- Setup no longer overwrites a client config it can't parse, such as JSON with comments. It leaves the file alone and prints the snippet to add by hand.
- Stale overlays are removed when the local server has been unreachable for 15 seconds, and pages re-check their overlay state every 5 seconds.
- For Codex, setup no longer appends `model_instructions_file` at the end of `config.toml`, where it landed inside the last table.

### Security

- The coordination server listens on `127.0.0.1` only (it used to listen on all interfaces), and refuses to start if something else answers on its port.
- Every route except `/.identity` and `/ping` requires a bearer token from `~/.web-mcp/auth-token`.
- The server proves its identity with an HMAC challenge (`/.identity?challenge=`). The MCP servers, the CLI and the extension only send the token to a server that passes it.
- `Host` and `Origin` headers are checked, and no CORS headers are sent (0.1.x sent `Access-Control-Allow-Origin: *`).
- Request bodies must be JSON and are capped at 1 MB. Slow event-stream clients are dropped.
- Content scripts no longer talk to the server. The token is only available to the extension's service worker and pages, and the extension no longer has web-accessible resources.
- Extension permissions were reduced to `sidePanel`, with host access only to `127.0.0.1`.
- Tab claims are bound to the page's origin and consumed by a `document_start` script before page scripts can see them. Wrappers can no longer set tab ids directly.
- In-page overlays only receive the agent's name, color, status and action type. No task names, URLs or typed text.
- Agent tabs can't load the browser's DevTools endpoint (directly or via redirect), and Web MCP's own control ports are refused as navigation targets.
- Typed text is redacted in logs and recordings (`Typing (12 chars)`), and URLs are logged without query strings.
- Web MCP no longer writes `debug-env-dump.json` (your full environment, including API keys), `debug-extension-dir.txt` or `chrome-args-debug.log`, and deletes them if found. 0.1.x logs and session recordings, which could contain typed text, are deleted once. **If you used 0.1.x, rotate the keys that were in your environment.**
- `chrome-devtools-mcp` usage statistics, CrUX lookups and update checks are turned off.
- `browser_navigate` and `browser_new_tab` only open `http(s)`, `data:` and `about:blank` URLs.
- Optional `security.blockedUrlPatterns` and `security.allowEvaluate`.
- `web-mcp stop` and `troubleshoot` only stop processes using the exact Web MCP profile folder, `chrome-devtools-mcp` helpers this instance recorded in `~/.web-mcp/helpers`, and the coordination server after verifying it. They never kill whatever owns port 3026 or 9222.
- Web MCP only drives a browser that has its own extension loaded, identified by the exact unpacked-extension id.
- The `~/.web-mcp` folder (when created), the token, `env.js`, logs and recordings get owner-only permissions on macOS and Linux.
- Agent labels shown by `web-mcp status` are stripped of control characters.

## 0.1.6

- Renamed remaining `browser-pilot` references to `web-mcp`.
- Rewrote README and documentation in plain, beginner-friendly language.
- Added public docs folder at `docs/`.
- Added npm keywords for discoverability.
- Removed tracked `.tgz` build artifacts from the repo.
- Moved source code to the private `private` branch.
- Demo image updated to point to new repo URL.

## 0.1.5

- Updated configuration paths for OpenCode, Cursor, Claude, Windsurf, Zed, Cody, Cline, and OpenAI Codex.
- Improved atomic file writes for AI client config files.
- Removed old code and cleaned up the codebase.

## 0.1.4

- Fixed CDP hit-testing so AI clicks land on the right element.
- Fixed silent `evaluate_script` failures by correctly passing function parameters.
- General stability improvements and bug fixes.

## 0.1.3

- Added stealth mode: replaced `--enable-automation` with `--disable-blink-features=AutomationControlled` to avoid detection.
- Fixed interactive browser launch freeze.
- Added dynamic import of Puppeteer for better compatibility.
- Added OpenAI Codex integration support.

## 0.1.2

- Multi-agent orchestration safety fixes.
- Extension auto-cleanup on shutdown.
- Stale process cleanup and port hijack prevention.
- SSE event stream reliability improvements.

## 0.1.1

- Heartbeat mechanism to prevent zombie Chromium processes when the AI disconnects.
- Sidebar active state and content script fixes for lock overlay.
- Initial concurrency safety work for multiple AI agents.

## 0.1.0

- First public release.
- MCP server with full browser control tools (navigate, click, type, scroll, screenshot, and more).
- Dedicated Chromium profile and extension for isolated browsing.
- Human-AI collision protection with DOM overlay.
- Multi-agent concurrency support.
- Extension side panel with real-time action feed.
- Support for OpenCode, Cursor, Claude Desktop, Claude Code, Windsurf, Zed, Cody, Cline, and Codex.
