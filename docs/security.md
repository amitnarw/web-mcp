# Security

Web MCP gives an AI control of a real browser, and through it every site you're logged in to in that browser. This page explains what 0.2.0 protects against, what it doesn't, and how to use it safely.

## The short version

Web MCP runs locally on your computer. Its control server only listens on `127.0.0.1`, requires a secret token, and proves it knows that token before anyone can talk to it. Websites, other devices on your network and other programs can't reach it. Websites can't read its responses, and the AI can only open `http(s)`, `data:` and `about:blank` URLs — never local files or the browser's own debug port.

Web MCP doesn't protect you from software already running on your computer, or from a model that follows instructions it reads on a web page. Keep that in mind.

## What Web MCP is

Three local pieces work together:

- The **MCP server** (`web-mcp mcp`). Your AI client starts one per chat or window. Each is one agent.
- The **coordination server**, a small HTTP server on `127.0.0.1` that tracks agents, tabs and halts.
- A **dedicated browser** (Chrome for Testing) with the Web MCP extension, controlled through the Chrome DevTools Protocol (CDP) on `127.0.0.1:9222`.

See [Architecture](architecture.md) for details.

## Threat model

Web MCP 0.2.0 is designed to protect you from:

1. **Websites** trying to read or control the local server or the browser's DevTools port (cross-site requests, DNS rebinding, redirects to localhost).
2. **Other devices on your network** reaching the server.
3. **Another local user or program squatting the server port** to collect the token or typed text.
4. **One agent** seeing or driving another agent's tabs, or yours, and pages hijacking the link between an agent and its tab.
5. **Secrets leaking to disk or to web pages**: typed text, URL query strings, environment variables.
6. **Collateral damage** from cleanup: killing your personal Chrome, other tools' processes, or an unrelated program on port 3026.
7. **Supply-chain drift and project-local tampering**: a client silently running a different Web MCP or dependency than you installed, or a repository changing how Web MCP finds its browser.

It does **not** protect against software already running on your computer with access to the browser's DevTools port, or against a model that follows instructions it reads on a web page (see [What is not protected](#what-is-not-protected)).

## Protections

### The local server

- **Loopback only.** The server listens on `127.0.0.1` only (0.1.x listened on all interfaces). It refuses to start if something else already answers on the port.
- **Token required.** Every route except `GET /.identity` and `GET /ping` needs `Authorization: Bearer <token>`. The token is a random 64-character hex string in `~/.web-mcp/auth-token`, compared in constant time.
- **The server proves itself before anyone sends the token.** MCP servers, the CLI (`status`, `stop`) and the extension first send a random challenge to `/.identity`. The real server answers with an HMAC of the challenge keyed with the token. A program that squats the port can't answer, so it never receives the token or typed text, and Web MCP stops with an error instead.
- **Host check.** Requests whose `Host` header isn't `127.0.0.1:<port>` or `localhost:<port>` are rejected (403). This blocks DNS-rebinding attacks.
- **Origin check.** Requests with an `Origin` header are rejected (403) unless the origin is a `chrome-extension://` page.
- **No CORS.** The server never sends `Access-Control-*` headers (0.1.x sent `Access-Control-Allow-Origin: *`), so web pages can't read its responses.
- **Strict bodies.** `POST`, `PUT` and `PATCH` bodies must be `application/json` (415 otherwise), so a plain cross-site form can't post to it. Bodies are capped at 1 MB, and string fields have length limits.
- **Bounded resources.** At most 64 connected agents. Event-stream clients that stop reading are dropped. Errors are always JSON and never echo the request.
- **Clean shutdown.** `web-mcp stop` asks the server to shut down through an authenticated request (`POST /shutdown`), so it writes its recordings and exits.

### The extension

- **Content scripts never talk to the server and never see the token.** The token is in the extension's `env.js`, which only the service worker, side panel and popup load. The extension declares no web-accessible resources, so web pages can't load `env.js`.
- **Minimal permissions**: `sidePanel`, plus host access to `127.0.0.1` only.
- Every tab-scoped message uses the sender's real tab id (`sender.tab.id`) and origin, never values from the message, and only from the top frame.
- **Tab claims are bound to the page.** Linking an agent's page to its browser tab uses a random single-use nonce that expires after 60 seconds. It's only accepted from a tab on the same origin as the page the agent opened. A script that runs before any page script (`claim.js`, at `document_start`) consumes the nonce, so page scripts can't relay it to another tab. When the page moves to another origin, the link is dropped and remade. See [Architecture](architecture.md#linking-a-page-to-its-chrome-tab).
- **The page learns almost nothing.** The overlay is part of the page's DOM, so it only receives the agent's name, color, status and the *type* of its last action. No task name, no URLs, no typed text.
- **Robust overlay.** It sits in the browser's top layer, comes back if a page removes it, and blocks clicks, right-clicks, scrolling, touch and keyboard input from you while an agent is active. Overlay buttons only react to real (trusted) clicks.

### Agents

- **Per-agent isolation.** An agent can only use the tabs it opened, and pop-ups its own pages opened. Every `chrome-devtools-mcp` result is rewritten before the AI sees it, so URLs and titles of other tabs never reach it. Tab ids it doesn't own are refused.
- **Halt is per agent and sticky** until you press Resume (0.1.x halts expired after 10 seconds). `browser_stop` is refused while halted, and a halt survives server restarts and laptop sleep.

### What the AI can open

- **URL allowlist.** `browser_navigate` and `browser_new_tab` only open `http(s)`, `data:` and `about:blank` URLs. `file://`, `chrome://`, extension pages and other schemes are refused, and `chrome-devtools-mcp` runs with `--no-file-navigations`.
- **Control ports are off-limits.** The browser's DevTools HTTP endpoint lists (and can close) every tab, including yours. Agent tabs can't load it at all, directly or through a redirect, and Web MCP's own ports are refused as navigation targets.
- **`blockedUrlPatterns`.** In `~/.web-mcp/config.json` you can list sites agents must never load. See [Configuration](configuration.md#blockedurlpatterns).
- **`allowEvaluate`.** Set `"security": { "allowEvaluate": false }` to remove `browser_evaluate` (arbitrary JavaScript in the page).
- **Untrusted content note.** Snapshots, text waits and `browser_evaluate` results end with a reminder that page content is untrusted.

### Data on disk and in the side panel

- **Redaction.** Logs, recordings and the page overlay never contain typed text, only its length (`Typing (12 chars)`, `Filling (uid) (8 chars)`). Selected option values, JavaScript code and dialog prompt text aren't stored. URLs are logged without query strings or fragments.
- **Secret fields.** The side panel shows the start of what the AI types, but not for fields that look like passwords, PINs, card numbers or one-time codes. Those show only the length. If the field can't be checked, it's treated as secret.
- **No environment dumps.** 0.1.6 and earlier wrote your full environment, including API keys, to `~/.web-mcp/debug-env-dump.json` on every browser launch. 0.2.0 writes nothing like that and deletes `debug-env-dump.json`, `debug-extension-dir.txt` and `chrome-args-debug.log` when it finds them. On its first run it also deletes 0.1.x logs and session recordings, which could contain the start of typed text.
- **Owner-only files** on macOS and Linux: the `~/.web-mcp` folder (when Web MCP creates it), the token, the extension's `env.js`, the server log and recordings.
- **`chrome-devtools-mcp` runs with `--redactNetworkHeaders`.**

### Processes

- **Scoped kills.** `web-mcp stop` and `web-mcp troubleshoot` only stop:
  - the coordination server. First they try the authenticated `POST /shutdown`. Otherwise they stop only the PID in `~/.web-mcp/server.pid`, and only after `/.identity` reports that same PID. For an old 0.1.x server, or one that can't prove it knows the token, the PID must also own the listening port and look like a Web MCP server,
  - browser processes started with exactly the Web MCP profile folder (`--user-data-dir=…/chromium-profile-v2`),
  - `chrome-devtools-mcp` helpers this Web MCP instance started itself. Each is recorded in `~/.web-mcp/helpers` and re-checked by its command line before it is stopped.

  Your own Chrome, other Web MCP instances' helpers, other tools and unrelated programs are never touched. 0.1.x force-killed whatever listened on port 3026.
- **No hijacking.** If something else answers on the server port, Web MCP stops with an error instead of killing it. It only drives a browser on the CDP port if that browser has *this* Web MCP's extension loaded, recognised by its exact extension id. A browser you started with `--remote-debugging-port` is refused.

### Dependencies and telemetry

- **Pinned client configs.** `web-mcp setup` writes `@amitnarw/web-mcp@<version>`, so clients run exactly the version you set up, not whatever is newest.
- **Locked dependency tree.** Dependencies are pinned to exact versions, and the published package includes `npm-shrinkwrap.json`, so `npm` and `npx` install exactly the tested versions.
- **No `npx chrome-devtools-mcp`.** 0.1.x started `chrome-devtools-mcp` through `npx`, which could download and run the newest release. 0.2.0 runs the copy installed with Web MCP.
- **No project config.** Web MCP finds its browser without loading the `puppeteer` package. Puppeteer reads `.puppeteerrc` and `package.json` settings from the current folder, and the MCP server runs in whatever project your AI client opened, so a malicious repository could otherwise change which executable is launched.
- **Telemetry off.** `chrome-devtools-mcp` sends usage statistics to Google by default. Web MCP turns that off, along with its CrUX performance lookups and its npm update checks. Web MCP itself has no telemetry.

## What is not protected

- **Software running on your computer.** The browser's **CDP port (9222)** has no authentication. Any program on your machine that can reach `127.0.0.1` can connect to it and fully control the browser: every tab, every cookie, every logged-in session. Programs running as you can also read `~/.web-mcp/auth-token`. Treat malware on your machine as game over, with or without Web MCP.
- **Other users of the same computer** can reach the loopback interface too, and anyone with administrator rights can read your files. Don't use the Web MCP browser for sensitive accounts on a shared machine.
- **Prompt injection.** A web page can contain text that tries to make the AI do something you didn't ask for: visit another site, type data into a form, reveal what it knows. Web MCP marks page content as untrusted, but it can't stop a model from following such instructions, and the model acts with whatever access the Web MCP browser has.
- **Shared logins.** All agents share the Web MCP profile. Any agent can use any site you're logged in to there, unless it works in an [isolated tab](multi-agent.md#isolated-tabs).
- **The overlay is not a security boundary.** It prevents you and the AI from colliding. Isolated tabs and non-HTML pages have no overlay, and keyboard input inside embedded frames (`<iframe>`) isn't blocked.
- **Your AI provider sees the pages.** Snapshots, screenshots, URLs and `browser_evaluate` results go into the conversation and are sent to your AI provider, like anything else in the chat.
- **The side panel shows the start of typed text** for fields that don't look secret, and full URLs. That's kept in memory only, but anyone looking at your screen can see it. Field detection is a heuristic.
- **The URL allowlist only covers URLs the AI asks to open.** Links and redirects inside a page behave as in any browser, except for the blocked DevTools port and your `blockedUrlPatterns`.
- **`browser_evaluate` is powerful.** When enabled, the AI can run any JavaScript the page itself could run.

## Recommendations

- **Only log in to what the agents need** in the Web MCP browser. Don't log in to your bank, password manager, or primary email there.
- **Block sensitive sites** with `security.blockedUrlPatterns`. Cover both the bare domain and its subdomains: `"*://mybank.com/*", "*://*.mybank.com/*"`.
- **Turn off `browser_evaluate`** (`"allowEvaluate": false`) if your tasks don't need it.
- **Use isolated tabs** for untrusted sites, or when testing logged-out flows.
- **Watch the side panel** during unattended work, and use Halt freely. It's sticky and only affects the agent you halt.
- **Re-run `web-mcp setup` after every upgrade**, so all clients are pinned to the same version. `web-mcp status` warns about outdated pins.
- **Never expose Web MCP to the network.** Don't tunnel it (ngrok and similar) or forward ports 3026 or 9222. This is also why ChatGPT Desktop isn't supported.
- **Don't run untrusted software** on the same machine while the Web MCP browser is open. Anything local can drive it through the CDP port.
- **On macOS and Linux, check folder permissions** if you upgraded from 0.1.x: `chmod 700 ~/.web-mcp`.

## Reporting a vulnerability

Please email **amitnarwal115@gmail.com** with:

- what you found and its impact,
- steps to reproduce (versions, operating system, AI client),
- whether it has been shared with anyone else.

Please don't post details publicly until a fix has been released.
