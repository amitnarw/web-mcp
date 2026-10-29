# Upgrading from 0.1.x to 0.2.0

0.2.0 is a large update: several AI chats can now share the browser safely, and the local server was locked down. Upgrading takes a few minutes. Every AI client has to move to 0.2.0, because 0.1.x and 0.2.0 can't share a browser.

## What changes for you

- **Each chat gets its own tabs.** Every AI chat or window is a separate agent. It only sees and controls the tabs it opened, never yours or another chat's. See [Several AIs at once](multi-agent.md).
- **The overlay only covers the AI's tabs.** Your other tabs in the Web MCP browser stay usable while an AI works.
- **Halt is per agent and sticky.** Halting one agent no longer affects the others, and the halt lasts until you press **Resume** in the side panel. In 0.1.x, a halt expired after 10 seconds.
- **`browser_stop` closes the agent's tabs.** It ends only that agent's session; the browser keeps running for everyone else. It is refused while the agent is halted. `browser_done` still just releases the overlay and leaves the tabs open.
- **The side panel lists every agent**, with its tabs, recent actions and Halt/Resume buttons.
- **Client configs are pinned** to `@amitnarw/web-mcp@0.2.0` instead of "whatever is newest".
- **Node.js 22.12 or newer is required.** 0.1.x accepted Node 18.
- **The local server needs a token.** Only the extension and the MCP servers can talk to it. If you used `http://localhost:3026/logs` and similar in scripts, see [Architecture](architecture.md#http-api).
- **ChatGPT Desktop is no longer offered**, because connecting it would mean exposing your logged-in browser to the internet.

What stays the same:

- **Your Web MCP browser logins.** The profile folder (`~/.web-mcp/chromium-profile-v2`) is the same, so you stay logged in.
- **Your `config.json`.** It is kept as is. New settings use their defaults until you add them (see [Configuration](configuration.md)). The 0.1.x keys `server.script`, `chrome.profileDir` and `extension.dir` are ignored now. The profile is always `chromium-profile-v2` inside the Web MCP folder.
- **The ports** (3026 for the server, 9222 for the browser).

## Steps

### 1. Close your AI clients

Quit every AI client that uses Web MCP, or at least make sure none of them is using the browser.

### 2. Install 0.2.0

```bash
npm install -g @amitnarw/web-mcp@0.2.0
```

If `web-mcp status` later says the browser isn't installed, run `web-mcp install-browser`.

### 3. Stop the old processes

```bash
web-mcp stop
```

The 0.2.0 `stop` command also knows how to stop a 0.1.x server. It only stops the server named in `~/.web-mcp/server.pid`, after confirming that this process is the Web MCP server listening on the port, plus the browser using the Web MCP profile. Nothing else is touched. If it says it is not stopping a process it couldn't confirm, check that process yourself.

### 4. Re-run setup for every client

```bash
web-mcp setup <client>     # e.g. web-mcp setup cursor; or plain `web-mcp setup` for the menu
```

Do this once for **each** AI client you use. Old configs run `npx -y @amitnarw/web-mcp mcp` without a version, so the version that actually starts depends on what npx resolves, and that can be an old cached copy. Setup replaces it with the pinned `@amitnarw/web-mcp@0.2.0`. Then check:

```bash
web-mcp test     # every client should be "Working", none "outdated pin" or "unpinned"
```

### 5. Start your clients again

Restart your AI clients and use them as usual. The first browser request starts the 0.2.0 server, copies the new extension into `~/.web-mcp/extension`, and launches the browser.

On that first run, 0.2.0 also cleans up after 0.1.x:

- It deletes `debug-env-dump.json`, `debug-extension-dir.txt` and `chrome-args-debug.log`.
- It deletes the old logs (`logs/server.log*`) and session recordings (`recordings/session-*`), which could contain the start of text the AI typed.

### 6. Rotate your keys

Web MCP 0.1.6 and earlier wrote your **entire environment**, including any API keys and tokens set in it (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, cloud credentials, …), to `~/.web-mcp/debug-env-dump.json` every time it launched the browser.

0.2.0 deletes that file, but it can't take back what was already written. If you used 0.1.x, **rotate every secret that was in the environment of your AI clients or terminal at the time**. Any backup or sync tool that copied your home folder may also hold a copy, including of the old logs.

### 7. Tidy up (optional)

- **Permissions (macOS and Linux):** 0.2.0 creates `~/.web-mcp` readable only by you, but a folder that already exists keeps its old permissions. Run `chmod 700 ~/.web-mcp`.
- **Very old profiles:** `~/.web-mcp/chrome-profile` and `~/.web-mcp/chrome-profile-v2` (0.1.3 and earlier) can be deleted. `web-mcp troubleshoot --reset-profile` removes them, together with your current profile.

## Behaviour changes in detail

| Area | 0.1.x | 0.2.0 |
|------|-------|-------|
| Several chats | Shared one session and one overlay. One chat's `browser_done` hid the others' overlay. | Each chat is an agent with its own tabs, color and overlay. |
| Tabs the AI sees | Every tab in the browser | Only the tabs it opened, plus pop-ups its pages opened |
| New tabs | Opened in the foreground | First tab in the foreground, later ones in the background |
| Overlay | Session-wide, in every tab | Only on tabs of an active agent. Shows the agent's name and the kind of action, never typed text |
| Halt | Global, expired after 10 s | Per agent, sticky until Resume, survives server restarts. **Halt all** available |
| `browser_stop` | Disconnected the client | Closes the agent's tabs and removes the agent. Refused while halted |
| `browser_start` | Described as "internal, do not call" | Optional: sets `agentName` and `taskName` |
| `browser_navigate` | URL only | `action: back / forward / reload`. Only `http(s)`, `data:` and `about:blank` URLs, and never Web MCP's own ports |
| `browser_new_tab` | URL only | Adds `isolated: true` for a separate cookie jar |
| New tools | — | `browser_select_option`, `browser_handle_dialog`. `browser_click` gets `dblClick` |
| `browser_evaluate` | Always on | Can be turned off with `security.allowEvaluate` |
| Local server | All network interfaces, no auth, `Access-Control-Allow-Origin: *` | `127.0.0.1` only, token required (and proven), no CORS |
| Logs and recordings | Contained the start of typed text | Typed text only as a character count. URLs without query strings |
| `web-mcp troubleshoot` | Always deleted the browser profile (signing you out) and `config.json` | Keeps both. `--reset-profile` and `--reset-config` reset them on request |
| CLI | Interactive only | `web-mcp setup <client>`, `web-mcp uninstall <client>` / `all --yes`, `install-browser`. Exit codes 0 / 1 / 2 |
| Extension updates | The extension copy was only refreshed if missing | Refreshed whenever its files change |
| Dependencies | `chrome-devtools-mcp` started with `npx` (newest version), usage statistics on | Exact versions locked by `npm-shrinkwrap.json`. Usage statistics and update checks off |

If you wrote custom instructions for your AI that mention tab handling or `browser_start` being internal, update them. The tool descriptions explain the new behaviour to the AI.

## Mixing versions

- A **0.2.0 client** that finds a **0.1.x server** running fails with `An older web-mcp (0.1.x) is already running on port 3026 …`. Run `web-mcp stop` and re-run setup for the old client.
- A **0.1.x client** can't use a 0.2.0 server: it doesn't have the token and doesn't know the new API. Re-run setup for it.

`web-mcp status` shows the running server's version and protocol, and flags clients with an outdated pin.

## Going back to 0.1.6

Not recommended, because of the security fixes above. If you must: run `web-mcp stop`, install `@amitnarw/web-mcp@0.1.6`, and run its setup for each client. 0.1.6 doesn't use the files 0.2.0 added (`auth-token`, `helpers/`, `.legacy-data-removed`), so you can delete them.
