# Web MCP - Development Guide

## 🔴 CRITICAL NOTE
**We exclusively use a managed Chromium build: Chrome for Testing, pinned by our Puppeteer version.** It lives in `~/.cache/puppeteer` (downloaded by Puppeteer's install script or by `web-mcp install-browser`) and is found through `@puppeteer/browsers`. Modern Google Chrome ignores `--load-extension`, so the project relies entirely on this dedicated instance.

This guide is the short version for maintainers. The detailed, up-to-date references are:

- [`docs/architecture.md`](docs/architecture.md): components, lifecycle, tab claiming, HTTP API, extension messages.
- [`docs/contributing.md`](docs/contributing.md): build/test/bundle commands, the e2e test, reloading the extension, project layout, ground rules.
- [`AGENTS.md`](AGENTS.md): rules and context for AI coding agents working on this repo.

## Project Overview

Web MCP is an npm package (`@amitnarw/web-mcp`) that gives AI clients (Claude Code, Cursor, OpenCode, Codex, …) control of a dedicated, visible Chromium through MCP. Since 0.2.0, every MCP client process is a separate **agent**:

- It only sees and drives the tabs it opened (plus pop-ups its pages open).
- Its tabs show a blocking overlay in its own color while it works.
- It appears in a side panel with Halt/Resume.

All agents share one browser and one local coordination server.

## User Experience

```bash
npm install -g @amitnarw/web-mcp     # also downloads Chrome for Testing (or: web-mcp install-browser)
web-mcp setup cursor                 # or `web-mcp setup` for the menu; pins @amitnarw/web-mcp@<version>
# restart the AI client, then ask it to use the browser
```

## Architecture

```
AI client process (one chat/window)
  └── web-mcp mcp  (dist/mcp/wrapper.min.js)  = one agent
        ├── ensureServer → coordination server, 127.0.0.1:3026 (shared, long-lived)
        ├── ensureChrome → Chrome for Testing + extension, CDP 127.0.0.1:9222 (shared, long-lived)
        └── own chrome-devtools-mcp child (stdio), called with this agent's pageIds
              tools: browser_start, browser_navigate, browser_new_tab, browser_get_tabs,
                     browser_switch_tab, browser_close_tab, browser_click, browser_type,
                     browser_fill, browser_select_option, browser_hover, browser_drag,
                     browser_press_key, browser_scroll, browser_snapshot, browser_screenshot,
                     browser_wait, browser_handle_dialog, browser_get_url, browser_get_status,
                     browser_done, browser_stop, browser_evaluate (only if security.allowEvaluate)
```

### Data flow of one tool call

```
AI calls browser_click(uid)
  → act(): serial queue for this agent
    → ensureReady(): server (identity-verified), agent registered, Chromium with our extension, chrome-devtools-mcp
    → POST /agents/:id/actions          (423 if halted → error result)
    → tryClaim(): link pageId ↔ Chrome tab id (origin-bound nonce, claim.js, service worker)
    → set data-bp-ai-acting="mouse" on the page (lets CDP input through the overlay)
    → chrome-devtools-mcp click {pageId, uid}
    → scopeResult(): drop other agents'/the user's tabs, adopt pop-ups
    → clear the acting flag (~100 ms later)
  → server broadcasts StatePayload over SSE → service worker → TAB_STATE to changed tabs → overlay
```

## Components

### MCP wrapper (`src/mcp/wrapper.ts`)
- Tools are registered statically at startup (`browser_evaluate` only when `security.allowEvaluate` is true).
- Lazy readiness (`ensureReady()`): nothing starts until the first browser tool call. `chrome-devtools-mcp` is resolved from Web MCP's own `node_modules` (never `npx`) and started with `--no-usage-statistics --no-performance-crux --redactNetworkHeaders --no-file-navigations --experimentalStructuredContent` and blocked URL patterns for the DevTools port plus `security.blockedUrlPatterns`.
- Per-agent page ownership, result scoping, URL allowlist (`checkUrl`), redaction for disk (`redactTyped`, `redactUrl`), secret-field detection for the side panel, heartbeat every 15 s (restarts a dead server), re-registration with `previousAgentId` that keeps halts.

### Coordination server (`src/server/app.ts`, entry `src/server/server.ts`) — protocol 2
- Express on `127.0.0.1:<server.port>` only. It checks Host (DNS-rebinding guard) and Origin (only `chrome-extension://`), sends no CORS headers, and requires `Authorization: Bearer <~/.web-mcp/auth-token>` on everything except `/.identity` and `/ping`.
- `/.identity?challenge=` proves the server knows the token (HMAC). `POST /shutdown` stops it gracefully.
- Agents, tombstones (30 min), tab claims (origin-bound, 60 s), sticky halts (423), idle/stale sweep with a clock-jump guard, SSE `/events`, `/state`, `/logs`.
- Typed text and URL query strings are stored on disk only in redacted form. Per-agent recordings go to `~/.web-mcp/recordings/<ISO>-<agentId>.json`.
- `server/logger.ts`: `~/.web-mcp/logs/server.log`, 10 MB rotation.

### Chromium extension (`src/extension/`, built into `extension/`)
- `manifest.json`: MV3. Permission `sidePanel`; host permission `http://127.0.0.1/*`. Content scripts `claim.js` (`document_start`) and `content.js` (`document_end`) never load `env.js` (which holds the token).
- `service_worker.js` + `server_api.js`: verify the server identity, then keep the SSE connection, push `TAB_STATE` to changed tabs, and relay `CLAIM_TAB` / `HALT_TAB` / `OPEN_SIDEBAR` using `sender.tab.id`. The zombie check closes Chromium after 60 s of failed pings, once the server has been seen.
- `content.js`: no network access. Overlay in the top layer (re-attached if removed) on tabs of an active agent, badge on idle/halted agent tabs, and a capture-phase human-input blocker. All UI handlers check `isTrusted`.
- `sidepanel.*`: a card per agent (task, tabs, recent actions, Halt or Resume) plus Halt all and debug logs. `popup.*`: connection status, agent counts, Halt all.

### CLI (`bin/web-mcp.js`, `src/cli/`)
- `setup [client]`, `uninstall [client|all --yes]`, `test`, `status`, `stop`, `troubleshoot [--reset-config] [--reset-profile]`, `browser`, `install-browser`, `help`, `--version`.
- Exit codes: 0 ok, 1 failed, 2 usage error. Unknown options are rejected.

## Configuration

`~/.web-mcp/config.json` (or `$WEB_MCP_HOME/config.json`) is created with these defaults and validated on every load:

```json
{
  "server": { "port": 3026, "startupTimeout": 15000 },
  "chrome": { "port": 9222, "executable": "auto-detect", "startupTimeout": 20000, "headless": false },
  "logging": { "level": "info" },
  "security": { "allowEvaluate": true, "blockedUrlPatterns": [] },
  "agents": { "idleTimeoutMs": 90000, "staleAfterMs": 60000, "maxRecordings": 50 }
}
```

The browser profile is always `~/.web-mcp/chromium-profile-v2` (the 0.1.x `chrome.profileDir` key is ignored). All keys and the files Web MCP stores are documented in [`docs/configuration.md`](docs/configuration.md).

### AI client config locations

Written by `src/cli/setup.ts`. Full snippets are in [`docs/supported-clients.md`](docs/supported-clients.md).

| Client | File | Key |
|--------|------|-----|
| OpenCode | `~/.config/opencode/opencode.json` (also detects `~/.opencode.json`) | `mcp` (`type: "local"`, `command` array) |
| Claude Desktop | `%APPDATA%\Claude\…`, `~/Library/Application Support/Claude/…`, `~/.config/Claude/…` (`claude_desktop_config.json`) | `mcpServers` |
| Claude Code | `claude mcp add --scope user` (Windows: via `cmd /c`), else `~/.claude.json` | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| Zed | `%APPDATA%\Zed\settings.json` (Windows), `~/.config/zed/settings.json` (macOS, Linux) | `context_servers` |
| Sourcegraph Cody | VS Code `globalStorage/sourcegraph.cody-ai/mcp_servers.json` | `mcpServers` |
| Cline | `~/.cline/data/settings/cline_mcp_settings.json` | `mcpServers` |
| OpenAI Codex | `~/.codex/config.toml` + `~/.codex/web-mcp-instructions.md` (`model_instructions_file`) | `[mcp_servers.web-mcp]` |
| Antigravity IDE | `~/.gemini/antigravity/mcp_config.json` | `mcpServers` |
| ChatGPT Desktop | not supported | — |

Every entry runs `npx -y @amitnarw/web-mcp@<version> mcp`.

## Development Commands

```bash
npm install                 # exact versions from npm-shrinkwrap.json; downloads Chrome for Testing
npm run build               # tsc → dist/
npm run bundle              # dist/**/*.min.js (deletes the unminified files) + extension/ from src/extension/
npm test                    # tsc + node --test (server and setup unit tests)
node scripts/e2e-multi-agent.mjs   # after build + bundle: 17 live checks, own WEB_MCP_HOME, ports 3126/9322

node bin/web-mcp.js status  # the CLI runs from dist/*.min.js, so build + bundle first
npm pack                    # inspect what would be published
```

Publishing runs `prepublishOnly` (`npm test && npm run bundle`). The package ships `dist/`, `extension/`, `bin/`, `README.md` and `npm-shrinkwrap.json`.

## How to Continue Development

### Adding a new MCP tool
1. Open `src/mcp/wrapper.ts` and add a `tool(name, description, zodShape, handler)` call next to the others.
2. Run the work through `act({ ui, type, redacted? }, fn)` so halt checks, tab claiming, the acting flag and result scoping apply. Use `cdmCall(...)` for `chrome-devtools-mcp` tools and `pageEval(...)` for your own helper scripts.
3. Never put raw typed text or full URLs into `redacted`. Append `UNTRUSTED_NOTE` (via `withUntrustedNote`) when the result carries page content.
4. Document it in [`docs/tools-reference.md`](docs/tools-reference.md).

### Adding or changing a server endpoint
1. Add the route in `createApp()` in `src/server/app.ts`, and types in `src/shared/protocol.ts`.
2. It is authenticated by default. Validate every field and bound every list.
3. Bump `PROTOCOL_VERSION` in `src/shared/paths.ts` if the change is incompatible.
4. Add a test in `test/server.test.mjs` and update the API table in [`docs/architecture.md`](docs/architecture.md#http-api).

### Adding a config key
Add it to `WebMcpConfig`, `DEFAULT_CONFIG` and `loadConfig()` validation in `src/shared/paths.ts`, then document it in [`docs/configuration.md`](docs/configuration.md).

### Modifying the extension
1. Edit files in `src/extension/` (never `extension/`, which is regenerated).
2. `npm run build && npm run bundle`.
3. `web-mcp stop` (with the `WEB_MCP_HOME` of the instance you test). The next tool call relaunches Chromium, and the launcher copies the changed extension into `<WEB_MCP_HOME>/extension`. Reloading in `chrome://extensions` alone only reloads the old copy.

### Running a development instance
Point an AI client at `node /path/to/web-mcp/bin/web-mcp.js mcp` with `WEB_MCP_HOME` set to a scratch folder whose `config.json` uses other ports. See [`docs/contributing.md`](docs/contributing.md#use-your-build-in-an-ai-client).

## What Is Pending

The prioritized list of ideas is in [`docs/roadmap.md`](docs/roadmap.md). Engineering items not covered there:

1. **Chrome Web Store publication**, so the extension doesn't need Developer Mode.
2. **CI.** `npm test` and the e2e script exist, but nothing runs them automatically yet.
3. **`--disable-blink-features=AutomationControlled`** is kept from 0.1.x. It hides automation from sites and may conflict with some sites' terms; consider making it opt-in.

## Design Decisions

| Decision | Choice | Reason |
|---|---|---|
| Tool visibility | Static registration at startup | The AI needs to see all tools immediately |
| Auto-start | Lazy `ensureReady()` in each tool | The AI never has to call `browser_start` |
| Tool naming | `browser_*` prefix | Clear namespace, avoids conflicts with other MCP tools |
| Agent model | One MCP process = one agent, own tabs only | Several chats can share one browser without seeing or disturbing each other |
| chrome-devtools-mcp | One child per wrapper, pinned dependency | Page ids stay per agent; no surprise upgrades via `npx` |
| Tab linking | Origin-bound single-use nonce, relayed by the extension | The wrapper only knows `pageId`, the extension only knows Chrome tab ids |
| Error handling | Return error text, don't throw | The AI can read the error and retry or ask the user |
| Halt | Per agent, sticky, enforced by the server (423) | The user stays in control even of a looping agent |
| Idle timeout | 90 s (`agents.idleTimeoutMs`) | Releases the overlay if the AI forgets `browser_done` |
| Human-input blocking | Top-layer overlay + capture listeners, `data-bp-ai-acting` for CDP input | CDP input is also `isTrusted`, so the wrapper has to mark its own actions |
| Server state | In memory, tombstones for re-registration | Simple; nothing sensitive persisted except redacted logs/recordings |
| Auth | Token in `~/.web-mcp/auth-token` + HMAC identity proof | Websites, LAN hosts and port squatters can't use or impersonate the server |
| Process kills | Exact profile dir, recorded helper PIDs, verified server PID | Never touch the user's Chrome or other programs |
| Browser | Chrome for Testing via `@puppeteer/browsers`, `--load-extension` | Branded Chrome ignores `--load-extension`; `puppeteer` itself would read project config |
| Dependencies | Exact versions + published `npm-shrinkwrap.json` | Users run the tested dependency tree |
| Code protection | esbuild minification | Only `.min.js` bundles are published |
| Profile | `~/.web-mcp/chromium-profile-v2` | Isolated from the user's everyday browser; kept across upgrades |

## History

0.1.x used a single global session with a global lock, a 10-second halt, a server on all interfaces with `Access-Control-Allow-Origin: *`, and `npx chrome-devtools-mcp`. Those designs are gone. See [`docs/CHANGELOG.md`](docs/CHANGELOG.md) and the "0.1.x history" section of [`AGENTS.md`](AGENTS.md) for what changed and why.

## References

- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [chrome-devtools-mcp](https://www.npmjs.com/package/chrome-devtools-mcp)
- [Chromium Extension MV3](https://developer.chrome.com/docs/extensions/develop/migrate)
- [Chromium Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Antigravity Browser Automation Research](https://alokbishoyi.com/blogposts/reverse-engineering-browser-automation.html)
