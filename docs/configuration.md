# Configuration

Web MCP works without any configuration. This page lists everything you can change, the environment variables it reads, and the files it keeps on disk.

## The config file

Settings live in `~/.web-mcp/config.json`. On Windows that is `%USERPROFILE%\.web-mcp\config.json`. If you set [`WEB_MCP_HOME`](#environment-variables), it is `$WEB_MCP_HOME/config.json`.

- The file is **created with all defaults** the first time Web MCP runs, if it doesn't exist yet.
- An existing file is **never rewritten**. If you upgraded from 0.1.x, your file won't contain the newer keys; their defaults apply until you add them.
- Every value is **validated**. An invalid value (wrong type, out of range) is ignored and the default is used instead, with a warning. Warnings appear in `web-mcp status`, in `web-mcp troubleshoot`, in the server log (`CONFIG WARNING: …`) and in the MCP server's stderr output (your client's MCP logs).
- If the file isn't valid JSON, or isn't a JSON object, **all** defaults are used.
- Unknown keys are ignored. That includes the 0.1.x keys `server.script`, `chrome.profileDir` and `extension.dir`, which no longer exist.
- `web-mcp troubleshoot` keeps your settings. Only `web-mcp troubleshoot --reset-config` resets the file to defaults, after saving a copy as `config.json.<timestamp>.bak`.

### When changes take effect

Each process reads the config once, when it starts:

| Process | What it uses | To apply a change |
|---------|--------------|-------------------|
| The MCP server inside each AI client (`web-mcp mcp`) | Everything. It also uses these values when it starts the coordination server or launches the browser. | Restart the AI client. |
| The local coordination server | `server.port`, `agents.*`, `logging.level` | `web-mcp stop`. The next tool call starts it again. |
| The Web MCP browser | The server port and auth token, written into the extension at launch | `web-mcp stop` |

When in doubt: close your AI chats, run `web-mcp stop`, then start the chats again.

## All settings

| Key | Type | Default | Valid values | What it does |
|-----|------|---------|--------------|--------------|
| `server.port` | integer | `3026` | 1024–65535 | Port of the local coordination server (always bound to `127.0.0.1`). |
| `server.startupTimeout` | integer (ms) | `15000` | > 0 | How long to wait for the server to start. |
| `chrome.port` | integer | `9222` | 1024–65535 | Chrome DevTools Protocol port of the Web MCP browser. Agent tabs can never open it. |
| `chrome.executable` | string | `"auto-detect"` | non-empty string | Browser to launch. See [below](#chromeexecutable). Any value other than `auto-detect` must be the path of an existing file. |
| `chrome.startupTimeout` | integer (ms) | `20000` | > 0 | How long to wait for the browser's debugging port. |
| `chrome.headless` | boolean | `false` | `true` / `false` | Run the browser without a window. You then have no overlay or side panel, so you can't halt agents. |
| `logging.level` | string | `"info"` | `debug`, `info`, `warn`, `error` | How much the MCP server writes to stderr. `debug` also adds tab-claim and connection lines to the server log. |
| `security.allowEvaluate` | boolean | `true` | `true` / `false` | `false` removes the `browser_evaluate` tool (arbitrary JavaScript in the page). |
| `security.blockedUrlPatterns` | array of strings | `[]` | strings | URL patterns agents must not load. See [below](#blockedurlpatterns). |
| `agents.idleTimeoutMs` | integer (ms) | `90000` | > 0 | An active agent with no browser activity for this long becomes idle and its overlay is released. |
| `agents.staleAfterMs` | integer (ms) | `60000` | ≥ 45000 | An agent the server hasn't heard from for this long is removed. Values below 45000 (three heartbeat intervals) are raised to 45000, with a warning. |
| `agents.maxRecordings` | integer | `50` | > 0 | Number of per-agent recordings kept in `~/.web-mcp/recordings`. Older ones are deleted. |

Extra rules:

- If `server.port` and `chrome.port` are equal, both fall back to their defaults.
- All AI clients on your machine share this file, the server and the browser. If you change a port, every client uses the new one after a restart.

### Full example

```json
{
  "server": { "port": 3026, "startupTimeout": 15000 },
  "chrome": { "port": 9222, "executable": "auto-detect", "startupTimeout": 20000, "headless": false },
  "logging": { "level": "info" },
  "security": {
    "allowEvaluate": false,
    "blockedUrlPatterns": ["*://mybank.com/*", "*://*.mybank.com/*"]
  },
  "agents": { "idleTimeoutMs": 90000, "staleAfterMs": 60000, "maxRecordings": 50 }
}
```

### `chrome.executable`

Leave it at `auto-detect` unless you have a reason not to. With `auto-detect`, Web MCP looks for, in order:

1. The Chrome for Testing build that this Web MCP version is pinned to, in `~/.cache/puppeteer`.
2. The newest other Chrome for Testing build in `~/.cache/puppeteer`.
3. A system Chromium:
   - Windows: `%LOCALAPPDATA%\Chromium\Application\chrome.exe`
   - macOS: `/Applications/Chromium.app/Contents/MacOS/Chromium`
   - Linux: `/usr/bin/chromium`, then `/usr/bin/chromium-browser`

If nothing is found, run `web-mcp install-browser` to download the pinned build into `~/.cache/puppeteer`. Web MCP doesn't load the `puppeteer` package to find the browser, so Puppeteer config files (`.puppeteerrc`, `PUPPETEER_*` settings) don't affect where it looks.

The browser has to accept the `--load-extension` flag, because Web MCP loads its extension that way. Recent versions of the regular, branded Google Chrome ignore that flag, so pointing this setting at Google Chrome usually ends in "the Web MCP extension did not load". Use Chromium or Chrome for Testing.

### `blockedUrlPatterns`

Each string is passed to `chrome-devtools-mcp` as a `--blockedUrlPattern` flag. It blocks matching navigations, redirects and requests in the pages it controls. Patterns use [URL Pattern](https://urlpattern.spec.whatwg.org/) syntax:

- `*` is a wildcard. `*://*.mybank.com/*` matches `https://www.mybank.com/login` but **not** `https://mybank.com/`. Add `*://mybank.com/*` as well to cover the bare domain.
- If you leave out the port, only the default port matches. `https://internal.corp/*` doesn't match `https://internal.corp:8443/`. Use `https://internal.corp:*/*` for any port.
- `chrome-devtools-mcp` rejects regexp groups like `(foo|bar)`, named groups like `:name`, and partial IPv4 wildcards like `*://127.0.0.*/*`.

A pattern it rejects stops `chrome-devtools-mcp` from starting, and every browser tool then fails with `Could not start chrome-devtools-mcp: <reason>. Check security.blockedUrlPatterns in ~/.web-mcp/config.json.` Web MCP only checks that the values are strings.

Web MCP always adds patterns for the browser's own DevTools port (`http://127.0.0.1:<chrome.port>/*`, and the same for `localhost` and `0.0.0.0`). You don't need to list those.

These patterns restrict the AI. They don't stop you from opening those sites yourself in the Web MCP browser.

## Environment variables

| Variable | Where to set it | Effect |
|----------|-----------------|--------|
| `WEB_MCP_HOME` | Your shell, or the `env` block of an MCP config | Uses a different data folder instead of `~/.web-mcp`: config, token, logs, recordings, extension copy and browser profile. Useful for testing, or for a second, fully separate instance. A separate instance also needs its own `server.port` and `chrome.port` in its own config. Otherwise the two instances fight over the ports: Web MCP then refuses to send its token to the other instance's server ("cannot prove it knows this machine's web-mcp token"). |
| `WEB_MCP_AGENT_NAME` | The `env` (or OpenCode `environment`) block of a client's MCP config | Default name for every agent started from that config. `browser_start` with `agentName` overrides it. See [Names and colors](multi-agent.md#names-and-colors). |

When Web MCP starts `chrome-devtools-mcp`, it passes:

- the flags `--no-usage-statistics`, `--no-performance-crux`, `--redactNetworkHeaders` and `--no-file-navigations`,
- the environment variables `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1` and `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1`.

When it launches the browser, it drops environment variables starting with `ELECTRON_`, `OPENCODE_` and `VSCODE_`, because those break Chromium when Web MCP runs inside an editor.

## Files Web MCP stores

Everything lives in `~/.web-mcp` (or `$WEB_MCP_HOME`). On macOS and Linux, Web MCP creates the folder readable only by you (mode 700). A folder that already existed, for example from 0.1.x, keeps its old permissions. Run `chmod 700 ~/.web-mcp` to fix that.

| Path | What it is |
|------|-----------|
| `config.json` | Your settings (see above). |
| `config.json.<timestamp>.bak` | Previous settings, saved by `web-mcp troubleshoot --reset-config`. |
| `auth-token` | Random 64-character secret shared by the MCP servers, the local server and the extension. Created once (readable only by you on macOS and Linux) and reused. |
| `server.pid` | Process id of the running coordination server. Used as a fallback by `web-mcp stop`. |
| `logs/server.log` | Server log: agents connecting and leaving, URLs opened (without query strings), task names, actions with typed text redacted. Rotated at 10 MB, and a few old files are kept (`server.log.1`, …). |
| `recordings/<time>-<agentId>.json` | One file per finished agent that did anything: its name, client, start and end time, and its action list (redacted). The newest `agents.maxRecordings` (default 50) are kept. |
| `extension/` | Copy of the Web MCP browser extension that the browser loads. Its `env.js` holds the server port and the auth token (readable only by you on macOS and Linux). The copy is refreshed at browser launch whenever the extension's files change. |
| `chromium-profile-v2/` | The Web MCP browser profile: cookies, logins, history, site data. Run `web-mcp troubleshoot --reset-profile` (or delete it while the browser is closed) to sign out everywhere. |
| `helpers/<pid>.json` | One small record per `chrome-devtools-mcp` helper this instance started, so `web-mcp stop` only stops its own helpers. |
| `chrome-stderr.log` | The browser's error output from the latest launch. |
| `chrome-launch.lock` | Exists only while a browser launch is in progress. It stops two AI clients from launching the browser at the same time. |
| `.legacy-data-removed` | Marker that the one-time 0.1.x cleanup (below) has run. |

Left over from older versions:

| Path | Status |
|------|--------|
| `debug-env-dump.json`, `debug-extension-dir.txt`, `chrome-args-debug.log` | Written by 0.1.6 and earlier. 0.2.0 deletes them whenever it finds them. `debug-env-dump.json` contained your full environment, including API keys. See [Upgrading](upgrading.md#6-rotate-your-keys). |
| `logs/server.log*` and `recordings/session-*` from 0.1.x | They could contain the start of text the AI typed. 0.2.0 deletes them once, the first time it runs. |
| `chrome-profile/`, `chrome-profile-v2/` | Profiles from 0.1.3 and earlier. Removed by `web-mcp troubleshoot --reset-profile`. |

Outside that folder:

| Path | What it is |
|------|-----------|
| `~/.cache/puppeteer/` | Chrome for Testing, downloaded at install or by `web-mcp install-browser`. |
| System temp folder, `chrome-devtools-mcp-*` | Screenshots of 2 MB or more (see [`browser_screenshot`](tools-reference.md#browser_screenshot)). |
| Your AI clients' config files, plus `<file>.web-mcp.bak` | Written by `web-mcp setup` (see [Supported clients](supported-clients.md)). |
| `~/.codex/web-mcp-instructions.md` | Written by setup for OpenAI Codex. |

To remove all Web MCP data and client entries, run `web-mcp uninstall all --yes` (or **Uninstall Web MCP → Uninstall from ALL clients** in the `web-mcp` menu). It stops Web MCP first, then deletes the files and folders Web MCP creates. Anything else in the folder is left alone, and then the folder itself is kept. In 0.2.0 the `.legacy-data-removed` marker is also left behind, so the folder usually stays; you can delete it by hand.
