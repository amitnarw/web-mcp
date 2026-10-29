# Troubleshooting

Most problems show up as an error message in your AI chat. Find the message below, or start with the [tools](#tools-that-help).

> **If you are an AI reading this:** don't kill Chromium or Node processes yourself, and don't rebuild Web MCP. Report the error to the user. The only cleanup commands to use are `web-mcp stop` and `web-mcp troubleshoot`.

## Tools that help

| Command | What it does |
|---------|--------------|
| `web-mcp status` | Shows whether the server runs (version, protocol, PID, and whether it proved its identity), the connected agents with their status and tab count, whether the browser runs or is installed, config warnings, and which clients are configured (with outdated-pin warnings). |
| `web-mcp test` | Checks each AI client's config: working, outdated pin, pinned to a newer version, unpinned, broken, can't verify (JSON with comments, unsupported TOML form), or not added. |
| `web-mcp stop` | Stops the coordination server, the `chrome-devtools-mcp` helpers this Web MCP started, and the Web MCP browser. Nothing else is touched. |
| `web-mcp troubleshoot` | Cleanup and checks (details [below](#what-web-mcp-troubleshoot-does)). Keeps your browser logins and your settings. |
| `web-mcp troubleshoot --reset-config` | The same, and also resets `~/.web-mcp/config.json` to defaults (your old file is saved as `config.json.<timestamp>.bak`). |
| `web-mcp troubleshoot --reset-profile` | The same, and also deletes the Web MCP browser profile. **This signs you out of every site in the Web MCP browser.** The two flags can be combined. |
| `web-mcp install-browser` | Downloads the Chrome for Testing build Web MCP uses. |
| `web-mcp browser` | Starts the server and the browser by hand (opens example.com). Shows any startup error directly in your terminal. |

Commands exit with code **0** on success, **1** if they ran but something failed, and **2** for a usage error (unknown command, unknown option, unknown client name). Unknown options are never ignored.

Logs:

- **Server log:** `~/.web-mcp/logs/server.log`.
- **Browser errors:** `~/.web-mcp/chrome-stderr.log`.
- **MCP server output:** Web MCP writes `[web-mcp]` lines to stderr. Your AI client's MCP logs show them. Set `"logging": { "level": "debug" }` in `~/.web-mcp/config.json` for more detail.
- **In the browser:** side panel → **Show Debug Logs**. For the extension's own console, open `chrome://extensions`, find the Web MCP extension and click **service worker**. Messages start with `[Web MCP]`.

## Error messages

### "An older web-mcp (0.1.x) is already running" / "A different web-mcp version … is already running"

```text
An older web-mcp (0.1.x) is already running on port 3026, probably started by another AI client. Update that client's web-mcp or run `web-mcp stop`, then retry.
```

**Why:** another AI client started the server with a Web MCP version that speaks a different protocol, usually an old 0.1.x one. `web-mcp status` shows `Legacy 0.1.x server (protocol 1)` or a protocol mismatch.

**Fix:**

1. Run `web-mcp setup <client>` for **every** client you use, so they are all pinned to the same version. `web-mcp test` flags clients with an outdated pin.
2. Restart those clients.
3. Run `web-mcp stop`, then retry. The next browser tool call starts a compatible server.

### "The program on port 3026 claims to be web-mcp but cannot prove it knows this machine's web-mcp token"

**Why:** something answers on the server port and says it is Web MCP, but it can't answer the identity challenge with your token. Either it was started by a Web MCP with a different home folder (`WEB_MCP_HOME`) and therefore a different token, or another user or program is squatting the port. Web MCP didn't send it anything. `web-mcp status` shows "It cannot prove it knows this machine's web-mcp token".

**Fix:** if it is another Web MCP instance of yours, stop it with that instance's `WEB_MCP_HOME` set (`web-mcp stop`), and give separate instances separate ports. Otherwise choose another port:

```json
{ "server": { "port": 3027 } }
```

Then run `web-mcp stop` and restart your AI clients.

### "Port 3026 is in use by another program"

```text
Port 3026 is in use by another program. Set "server.port" in ~/.web-mcp/config.json to a free port.
```

**Why:** something that isn't Web MCP is listening on the server port. Web MCP never kills whatever owns the port.

**Fix:** stop that program, or pick another port as shown above. A related message, `Port 3026 was taken by another program (or an incompatible web-mcp server) while starting.`, means something grabbed the port while the server was starting. Treat it the same way.

### "A browser is listening on CDP port 9222 but the Web MCP extension is not loaded in it"

**Why:** another browser is using the debugging port. Typically that is your own Chrome started with `--remote-debugging-port=9222`, another automation tool's browser, or a Web MCP browser from a different `WEB_MCP_HOME`. Web MCP only drives a browser that has its own extension loaded.

**Fix:** close that browser, or give Web MCP its own port:

```json
{ "chrome": { "port": 9223 } }
```

Then run `web-mcp stop` and restart your AI clients.

### "Chromium not found"

```text
Chromium not found. Run `web-mcp install-browser` (or `npx -y @amitnarw/web-mcp install-browser`), or set chrome.executable in ~/.web-mcp/config.json
```

**Why:** the Chrome for Testing download didn't happen or didn't finish. Common causes: the install ran with `--ignore-scripts`, Puppeteer's download was turned off, or the network dropped. `web-mcp status` shows `Chromium: Not installed`.

**Fix:** run `web-mcp install-browser`. It downloads the pinned build into `~/.cache/puppeteer`. Or point `chrome.executable` at a Chromium build you have (see [Configuration](configuration.md#chromeexecutable)).

`Configured chrome.executable does not exist: …` means the path in `chrome.executable` is wrong.

### "Chromium started but the Web MCP extension did not load"

```text
Chromium started but the Web MCP extension did not load. Run `web-mcp troubleshoot` and check ~/.web-mcp/chrome-stderr.log
```

**Why:** the browser came up, but Web MCP's extension service worker never appeared. Usual causes:

- `chrome.executable` points at the regular Google Chrome, which ignores `--load-extension`.
- The extension copy in `~/.web-mcp/extension` is damaged.
- A broken profile.

**Fix:**

1. Set `chrome.executable` back to `"auto-detect"` if you changed it.
2. Run `web-mcp troubleshoot`. It deletes the extension copy, and a fresh one is made on the next launch.
3. Check `~/.web-mcp/chrome-stderr.log`.
4. Last resort: `web-mcp troubleshoot --reset-profile` (signs you out of the Web MCP browser).

### "Chromium did not open its debugging port within 20s"

**Why:** the browser didn't start in time. It may have crashed (see `chrome-stderr.log`), a hung Web MCP browser may be holding the profile, or the machine is slow.

**Fix:** run `web-mcp stop` and retry. On a slow machine, raise `chrome.startupTimeout` (milliseconds).

### "Coordination server did not start within 15s"

**Fix:** check `~/.web-mcp/logs/server.log`. Run `web-mcp stop` and retry. If needed, raise `server.startupTimeout`.

### "Timed out waiting for another web-mcp process to finish launching Chromium"

**Why:** several clients tried to launch the browser at once, and the one holding the launch lock didn't finish. A lock whose owner has exited is cleaned up automatically.

**Fix:** retry. If it keeps happening, run `web-mcp stop`. If no Web MCP process is running, delete `~/.web-mcp/chrome-launch.lock`.

### "Could not start chrome-devtools-mcp: …"

```text
Could not start chrome-devtools-mcp: <last lines of its error output>. Check security.blockedUrlPatterns in ~/.web-mcp/config.json.
```

**Why:** the `chrome-devtools-mcp` helper exited at startup. The text after the colon says why. Usual causes:

- An invalid entry in `security.blockedUrlPatterns`. Regexp groups, `:name` groups and partial IP wildcards are rejected (see [Configuration](configuration.md#blockedurlpatterns)).
- An unsupported Node.js version. You need 22.12 or newer.

**Fix:** correct the pattern or upgrade Node.js, then restart your AI client.

### "Could not register with the coordination server"

**Why:** the server refused a new agent. The most likely reason is that 64 agents are already connected, which is the limit. The MCP server's stderr shows the HTTP status (`429 too_many_agents`).

**Fix:** close AI chats you no longer need. Agents of closed chats disappear right away; crashed ones after about a minute.

### "The user halted this agent"

```text
ERROR: The user halted this agent ("Claude Code #1") from the Web MCP browser. Stop now and ask the user how to proceed. …
```

**Why:** you, or someone using the browser, pressed Halt or Halt all. Halts are sticky, also across server restarts, and `browser_stop` is refused while halted.

**Fix:** open the side panel (toolbar icon → **Open side panel**, or click the agent's `… · halted` badge on its tab) and press **Resume** on that agent's card. Then tell the AI to continue.

### "You have no tab open yet"

```text
ERROR: You have no tab open yet. Call browser_navigate with a URL (it opens a tab for you) or browser_new_tab.
```

**Why:** the agent tried to click or read a page before opening one. That happens on a fresh start, after `browser_stop`, after its last tab was closed, or after the browser restarted (tab ids don't survive a browser restart).

**Fix:** nothing to fix. The AI should open a tab with `browser_navigate` and a URL. If it keeps looping, tell it to.

### "The browser was closed or restarted, so your tabs are gone"

**Why:** the Web MCP browser was closed (by you, by `web-mcp stop`, or by a crash) while the agent was using it.

**Fix:** nothing to fix. The agent's next browser tool call relaunches the browser, and it starts again with `browser_navigate`.

### "Tab N is not one of your tabs"

```text
ERROR: Tab 3 is not one of your tabs. You can only use tabs you opened (yours: 1, 2). Other tabs belong to the user or to other AI agents.
```

**Why:** the AI used a tab id it doesn't own. Maybe it guessed, or remembered one from before a restart. Agents can't use your tabs or each other's.

**Fix:** ask the AI to call `browser_get_tabs` and use one of its own tabs, or to open a new one. To have an AI work on a page you have open, give it the URL. It opens its own tab, and shares your login if you're logged in in the Web MCP browser.

### "web-mcp only opens http(s), about:blank and data: URLs"

```text
ERROR: web-mcp only opens http(s), about:blank and data: URLs (refused: file:///C:/report.html). Local files, chrome:// and extension pages are blocked.
```

**Why:** the [URL allowlist](tools-reference.md#url-allowlist) refused the URL.

**Fix:** for local files, serve the folder over HTTP and open `http://localhost:<port>/…`. For example, run `npx http-server` or `python -m http.server` in that folder. `chrome://` and extension pages can't be opened by agents.

### "That address is web-mcp's own control port and is off-limits to agents"

**Why:** the URL points at the Web MCP server port (3026) or the browser's DevTools port (9222) on your machine. Agents may never open those.

**Fix:** if your own app happens to use one of these ports, move your app, or move Web MCP with `server.port` / `chrome.port` in `~/.web-mcp/config.json`.

### "The Web MCP coordination server is not reachable"

**Why:** the local server stopped, for example because you ran `web-mcp stop`.

**Fix:** retry the request. The next browser tool call starts the server again. Open chats also restart it on their own within about 15 seconds.

## Other symptoms

### Nothing happens / the AI doesn't see the browser tools

1. Run `web-mcp test`. Your client should be listed as **Working**.
2. If not, run `web-mcp setup <client>` and **restart the client**.
3. If setup says it couldn't parse the config file (often JSON with comments), paste the printed snippet in by hand. See [Supported clients](supported-clients.md).
4. The first start downloads the pinned package through npx and can be slow. If your client times out, run `npx -y @amitnarw/web-mcp@0.2.0 help` once in a terminal, then restart the client.

### The overlay doesn't appear

- The overlay only shows while the agent is **active**. After `browser_done`, or 90 seconds without activity, the tab shows an `… · idle` badge instead.
- It never shows on isolated tabs, `about:blank`, `data:` and `chrome://` pages, or non-HTML pages such as PDFs. In the side panel, such tabs are marked `not linked`.
- Right after the page moved to another site, the tab is linked again on the agent's next action.
- Check `web-mcp status`: the agent should be `active` with at least one tab.
- If you changed the extension's code, see [Contributing](contributing.md#reloading-the-extension).

### An overlay is stuck

The page re-checks its state every 5 seconds. If the local server can't be reached for 15 seconds, all overlays are removed. You can also press the stop button on the overlay bar to halt that agent, or ask the AI to call `browser_done`.

### The side panel says "Token mismatch" or "another program is answering"

The side panel and popup check the server's identity before they send it the token:

- **"Extension and server tokens differ — restart the browser via the AI client or run `web-mcp stop`."** The browser was launched with a different token than the running server has, for example after `auth-token` was deleted, or when two `WEB_MCP_HOME` folders share a port. Run `web-mcp stop`. The next browser tool call starts both again with the same token.
- **"Another program is answering on 127.0.0.1:3026 and is not a Web MCP server. The token was not sent."** Something else owns the server port. See [Port 3026 is in use](#port-3026-is-in-use-by-another-program).
- **"The extension has no token"**. The browser wasn't started by Web MCP. Let your AI client (or `web-mcp browser`) start it.

### The browser closed all its windows by itself

**Why:** the extension closes every window of the Web MCP browser once the local server has been unreachable for about 60 seconds, so no orphaned browser keeps running after a crash. This only happens if it has reached the server at least once since the browser started. While an AI chat is open, its Web MCP process normally restarts the server before that happens.

**Fix:** use the AI as normal. The next browser tool call starts the server and browser again. If it keeps happening, check `~/.web-mcp/logs/server.log`.

### `web-mcp stop` says it is "not stopping" a process

```text
Not stopping PID 1234: it could not be confirmed as the web-mcp server listening on port 3026 …
```

**Why:** the PID in `~/.web-mcp/server.pid` couldn't be confirmed as the Web MCP server on that port (for example a reused PID, or an old 0.1.x server that was started differently). Web MCP never kills a process it can't identify. The command exits with code 1.

**Fix:** check the process yourself and stop it if it is Web MCP, or close the AI clients that keep it running.

### The server comes back after `web-mcp stop`

That's expected while AI chats are open: their Web MCP processes restart the local server within about 15 seconds, so the browser isn't left without one. The browser itself only comes back when an AI uses it. To shut down completely, close the AI chats first, then run `web-mcp stop`.

### The Claude Code entry disappears

Claude Code rewrites `~/.claude.json` while it runs. Quit Claude Code, run `web-mcp setup claude-code` again, then start Claude Code.

### Setup says a client is "pinned to … newer"

Setup never downgrades a client that another, newer Web MCP set up. Upgrade this Web MCP (`npm install -g @amitnarw/web-mcp@latest`), or run the newer version's setup as printed (`npx -y @amitnarw/web-mcp@<version> setup <client>`).

### I was signed out of everything in the Web MCP browser

`web-mcp troubleshoot --reset-profile` and `web-mcp uninstall all --yes` delete the browser profile. Log in again, for example after running `web-mcp browser`.

## What `web-mcp troubleshoot` does

1. Checks `config.json` and lists invalid values (it doesn't change the file unless you pass `--reset-config`).
2. Deletes debug files left by 0.1.6 and earlier (`debug-env-dump.json`, `debug-extension-dir.txt`, `chrome-args-debug.log`), and on first run 0.1.x logs and session recordings. If it finds `debug-env-dump.json`, it warns you to rotate your API keys (see [Upgrading](upgrading.md#6-rotate-your-keys)).
3. Stops the coordination server (see `web-mcp stop`), the `chrome-devtools-mcp` helpers this Web MCP started, and every browser process using the Web MCP profile folder.
4. With `--reset-config`: resets `config.json` to defaults, keeping a timestamped `.bak` copy.
5. With `--reset-profile`: deletes `chromium-profile-v2` and the legacy `chrome-profile` and `chrome-profile-v2` folders. Otherwise the profile is kept.
6. Deletes the cached extension copy (`~/.web-mcp/extension`). A fresh copy with a new `env.js` is made on the next launch.
7. Checks that a Chromium executable can be found, and suggests `web-mcp install-browser` if not.

It exits with code 1 if any step failed. Your AI clients start the server and browser again on their next browser tool call.

## Still stuck?

Email amitnarwal115@gmail.com with the output of `web-mcp status`, the error message, and the relevant lines from `~/.web-mcp/logs/server.log`. The server log never contains typed text or query strings, but it does contain the addresses the AI visited, so check it before sending.
