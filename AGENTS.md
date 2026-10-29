# Web MCP — Agent Context

This file provides critical context for AI agents working on the Web MCP project. Read this first before making any changes. User and contributor documentation lives in `docs/` (start with `docs/architecture.md` and `docs/contributing.md`).

## 0.2.0 architecture (supersedes older notes below)

- **One wrapper = one agent.** Every MCP client process registers with the coordination server (`POST /agents`) and only drives tabs it opened itself, plus pop-ups its own pages open (`openedPages`). Tabs are addressed by chrome-devtools-mcp `pageId`, which is per wrapper process. The wrapper strips other pages out of every chrome-devtools-mcp response (`scopeResult` in `src/mcp/wrapper.ts`).
- **Shared code** lives in `src/shared/`:
  - `paths.ts`: `WEB_MCP_HOME`, validated config (`agents.staleAfterMs` ≥ 45 s), auth token, redaction, one-time legacy cleanup.
  - `protocol.ts`: HTTP payload types.
  - `launcher.ts`: the only place that starts the server or Chromium. It verifies the server's identity (HMAC challenge), finds or installs Chrome for Testing via `@puppeteer/browsers` (never imports `puppeteer`), recognises our extension by its exact unpacked-extension id, holds a cross-process launch lock, keeps the helper registry (`~/.web-mcp/helpers`), and kills processes only by exact profile dir or recorded helper PID.
- **Coordination server** (`src/server/app.ts`):
  - Listens on 127.0.0.1 only and checks Host and Origin. Every route except `/.identity` and `/ping` needs `Authorization: Bearer <~/.web-mcp/auth-token>`. It sends no CORS headers.
  - `/.identity?challenge=<64 hex>` returns `proof = HMAC-SHA256(token, challenge)`. Nobody sends the token to a server that hasn't passed this check.
  - Per-agent state: tabs, actions, a sticky `halted` flag, and idle/stale timers with a clock-jump guard. Removed agents leave a tombstone for 30 min, so a wrapper re-registering with `previousAgentId` gets the same id and halt state back. At most 64 live agents.
  - `POST /shutdown` (authenticated) is how `web-mcp stop` stops it.
  - Typed text and URL query strings are persisted only in redacted form. `TabView` (what the page-side overlay gets) carries no task name and no action text.
- **Linking a page to its Chrome tab:**
  1. The wrapper reads the page's `location.origin` and registers a nonce (`POST /agents/:id/claims {nonce, pageId, origin}`).
  2. It posts the nonce from the page (`window.postMessage({__webMcpClaim})`).
  3. `claim.js` (content script at `document_start`) consumes it and relays it, and the service worker calls `POST /tabs/claim` with `sender.tab.id` and `sender.origin`. Origins must match. `PUT /agents/:id/tabs` ignores wrapper-supplied tab ids, and a page that changes origin must be claimed again.
- **Extension:** content scripts never talk to the server and never see the token, which is in `env.js` and loaded only by the service worker and extension pages (via `server_api.js`, which verifies the server identity first). Permissions: `sidePanel` only, plus host access to `http://127.0.0.1/*`. The overlay appears only on tabs owned by an active agent, lives in the top layer, re-attaches if removed, and blocks pointer, wheel, context-menu and key input.
- **Halt** is per agent and sticky until Resume. `browser_stop` is refused while halted, and the wrapper re-applies a halt after re-registering.
- **Tests:**
  - `npm test`: server and setup unit tests.
  - `npm run build && npm run bundle && node scripts/e2e-multi-agent.mjs`: 17 live checks with two real MCP clients against headless Chromium, in a throwaway `WEB_MCP_HOME` on ports 3126/9322.
- `PROTOCOL_VERSION` (in `paths.ts`) must be bumped on incompatible HTTP changes. Wrappers refuse to use a server with a different protocol.
- **Packaging:** exact dependency versions plus a published `npm-shrinkwrap.json`; `engines.node` is `>=22.12.0`; `.gitattributes` keeps `bin/*` and `*.mjs` at LF.

## 🔴 CRITICAL: AI Behavior Rules (READ IMMEDIATELY)

**0. WE STRICTLY USE CHROMIUM (Chrome for Testing)**: We exclusively use the Chrome for Testing build pinned by our Puppeteer version, found in `~/.cache/puppeteer` (downloaded at install, or with `web-mcp install-browser`). Modern Google Chrome ignores `--load-extension`, so **DO NOT** attempt to launch or connect to the user's system Google Chrome. The product relies on this dedicated Chromium instance.
**1. NEVER Manually Start Chromium**: You MUST NOT run commands like `start chrome` or `chrome.exe` in powershell. The `web-mcp` MCP tools (like `browser_navigate`) will automatically launch the dedicated Chromium instance for you if it is not running. 
**2. NEVER Use `taskkill` on Chromium**: You MUST NOT run commands like `taskkill /f /im chrome.exe`. This kills the user's personal browsing sessions. If you absolutely must clean up stale processes, ONLY use `web-mcp stop` or `web-mcp troubleshoot`.
**3. NEVER Try to Fix the Port**: If port 9222 is busy or Chromium fails to connect, do NOT try to kill all chromes or change the port manually. Report the error to the user or run `web-mcp troubleshoot`.
**4. NO CHEATING - SIMULATE REAL USERS**: The purpose of this tool is to test website functionality like a real user. You MUST NOT use `browser_navigate` to jump directly to internal pages or cheat by typing direct URLs. Use `browser_navigate` ONLY for the initial entry point, and then rely strictly on `browser_click`, `browser_type`, etc., to navigate the site.
**5. HOLISTIC DEBUGGING REQUIRED**: You must look at the whole codebase and trace the full execution lifecycle end-to-end. Do not just focus on one isolated section or assume an isolated fix is sufficient. A bug or configuration generation issue in one file (e.g., `setup.ts`) can silently override and break fixes you made in another file (e.g., `wrapper.ts`). Always consider how your changes impact the whole system, and what other sections might be impacting the current problem.
**6. CONSIDER PERSISTENT EXTERNAL STATE**: Configuration files (e.g., `~/.web-mcp/config.json`) survive package uninstallations, codebase rebuilds, and laptop restarts. Never assume `npm install` or restarting processes clears out stale application data.
**7. VERIFY SYSTEM COMMANDS**: Do not blindly assume commands like `Stop-Process`, `pkill`, or `npm install -g .` worked. Always verify that your regex/filter actually matched the running processes, confirm they are dead, and read error logs carefully.
**8. DON'T TOUCH THE USER'S LIVE INSTANCE**: For experiments and tests, set `WEB_MCP_HOME` to a fresh folder and use other ports in its `config.json` (the e2e script uses 3126/9322). Never point experiments at `~/.web-mcp` or ports 3026/9222 while the user is using Web MCP.

## 🔴 CRITICAL: Updating the extension after code changes

The browser never loads the extension from the repository. At each browser launch, the launcher copies the built `extension/` folder into `<WEB_MCP_HOME>/extension` (and writes `env.js` with the port and token there). It re-copies whenever the extension's files changed, but **only when it launches the browser**.

So after every change to `src/extension/`:

```bash
npm run build
npm run bundle          # regenerates extension/ (never edit extension/ by hand)
web-mcp stop            # with the same WEB_MCP_HOME as the instance you are testing
```

The next browser tool call relaunches Chromium with the new extension. Clicking reload in `chrome://extensions` is **not** enough: it reloads the stale copy in `<WEB_MCP_HOME>/extension`, not your build. Refresh open pages afterwards if you test by hand.

## Process Lifecycle

```
AI client chat/window → spawns `web-mcp mcp` (dist/mcp/wrapper.min.js) = one agent
    ├── ensureServer: coordination server on 127.0.0.1:3026 (started if absent) — LONG LIVED, shared
    ├── ensureChrome: Chromium with CDP on 127.0.0.1:9222 (launched under the lock) — LONG LIVED, shared
    └── its own chrome-devtools-mcp helper (recorded in ~/.web-mcp/helpers/<pid>.json)

Wrapper exits → DELETE /agents/:id; its tabs stay open; server + Chromium keep running (no idle shutdown).
```

**Key rule:** The server and Chromium are long-lived singletons shared by every AI client (e.g. OpenCode and Cursor running simultaneously).
- Each wrapper heartbeats every 15 s. If the server is gone, the wrapper restarts it and re-registers (same agent id if the server still has its tombstone; a halt is re-applied).
- If nothing restarts the server, the extension's service worker closes all Chromium windows after 60 s of failed `/ping`s (armed only after one successful ping), so no zombie Chromium is left behind.
- `browser_stop` only closes the calling agent's own tabs and removes that agent. It never kills Chromium or the server, and it is refused while the agent is halted.
- `web-mcp stop` sends an authenticated `POST /shutdown` (fallback: the verified PID from `server.pid`), stops only the helpers in `~/.web-mcp/helpers`, and only Chromium processes with the exact Web MCP `--user-data-dir`. Wrappers of still-open chats restart the server within ~15 s; Chromium comes back on the next tool call.

### Clean up stale processes
```powershell
web-mcp stop            # stop server, our helpers and the Web MCP Chromium
web-mcp troubleshoot    # also checks config, deletes the extension copy, checks Chromium (keeps logins and settings)
```

## Overlay or side panel not working? Checklist

| Step | Check | Command |
|------|-------|---------|
| 1 | Server running and verified? | `web-mcp status` (version, protocol, identity proof, agents with status and tab count) |
| 2 | Agent active and tab linked? | `web-mcp status` shows the agent `active`. In the side panel, a tab marked `not linked` has no Chrome tab id yet. Overlays only show on linked tabs of active agents (never on isolated, `about:`/`data:`/`chrome://` or non-HTML pages). |
| 3 | Chromium on 9222? | `Invoke-RestMethod "http://127.0.0.1:9222/json/version"` |
| 4 | Extension up to date? | After rebuilding: `npm run bundle`, then `web-mcp stop`; the next tool call relaunches with a fresh copy (see above) |
| 5 | Content script injected? | F12 → Console → look for `[Web MCP] Content script loaded on …`; on an owned tab, `document.querySelector(".bp-overlay, .bp-badge")` returns the overlay or badge |
| 6 | Console errors? | F12 → Console (page) and `chrome://extensions` → Web MCP → service worker, look for `[Web MCP]` logs (e.g. "server identity not verified", "Token mismatch") |

## 0.1.x history (context only; superseded by 0.2.0)

> The "Key Fixes" sections below describe how **0.1.x** worked and why. They are kept as background. Many of the mechanisms they name (`ensureBrowserReady`, `callChromeDevtoolsTool`, sidebar sessions, `killStaleServer`, `lastUserHaltTime`) no longer exist. **Where anything below contradicts the 0.2.0 sections of this file or the code, the 0.2.0 sections and the code win.** Notes marked *0.2.0:* say what replaced each item.

## Key Fixes Applied (May 2026) — 0.1.x

### 1. Sidebar Activation Order Fix
**Problem:** `ensureSidebarActive()` was called BEFORE `startServer()` → silently failed because server wasn't running.
**Fix:** Moved `ensureSidebarActive()` to AFTER server is confirmed healthy.

### 2. Sidebar Active State Fix
**Problem:** `ensureBrowserReady()` returned early if `chromeDevtoolsClient` existed but `sidebarActive` was false.
**Fix:** Added `&& sidebarActive` to the early return condition.

### 3. Content Script Deduplication
**Problem:** Service worker polled every 2 seconds, content script called `removeOverlay()` repeatedly causing infinite log spam.
**Fix:** Added `lastActiveState` tracking — only acts when state actually changes.

### 4. Extension Cache Auto-Clear
**Problem:** Chromium cached old extension files (content.js with broken sidePanel.open()).
**Fix:** `launchChrome()` now deletes `Default/Extensions/` and `extensions_crx_cache/` before launch.
*0.2.0:* the launcher refreshes `~/.web-mcp/extension` whenever the extension's files change (signature in `.web-mcp-source`); see "Updating the extension" above.

### 5. Stale Process Cleanup
**Problem:** Wrapper crashes left server + Chromium running as orphans.
**Fix:** Added `killStaleServer()` before starting new server + heartbeat check every 30 seconds.
*0.2.0:* nothing is killed by port. `ensureServer` refuses foreign servers; wrappers heartbeat every 15 s and restart a dead server; `web-mcp stop` uses `POST /shutdown` or a verified PID.

### 6. fetchWithTimeout Bug Fix
**Problem:** `fetchWithTimeout()` in wrapper.ts was dropping `method`/`headers`/`body` options — all POST requests became GETs, returning HTML 404. Session never started, sidebar never activated.
**Fix:** Now passes `options` via `{ ...options, signal: AbortSignal.timeout() }`.

### 7. submitKey Unreliable in chrome-devtools-mcp
**Problem:** Passing `submitKey` to chrome-devtools-mcp's `type_text` tool didn't reliably press the key after typing.
**Fix:** `browser_type` now calls `type_text` first, then calls `press_key` separately if `submitKey` is provided.
*0.2.0:* `browser_type` passes `submitKey` to `type_text` (chrome-devtools-mcp 1.12.0 presses it after typing), with the acting flag set to `true` so the resulting submit passes the overlay.

### 8. JavaScript Capture Listeners Blocked AI Tool Events
**Problem:** Content.js added capture-phase listeners on `document` for `click`, `keydown`, etc. that called `e.stopPropagation()` + `e.preventDefault()`. This blocked ALL events — including CDP-dispatched events from AI tools (click, type, press_key). Attempted `isTrusted` check but CDP's `Input.dispatchMouseEvent/Key` creates trusted events (isTrusted=true).
**Fix:** Removed all JavaScript capture listeners. CSS overlay with `pointer-events: auto` already blocks user mouse/touch interactions naturally. BUT we re-added them to block keyboard inputs, see fix 10.
*0.2.0:* capture listeners on `window` block trusted pointer, wheel, context-menu, touch and key events while an agent is active; CDP input passes via `data-bp-ai-acting` (`mouse` / `true` / `capture`).

### 9. Content.js Simplified
**Problem:** 340px embedded sidebar panel was complex and conflicted with native side panel.
**Fix:** Content script now injects:
- Full-page transparent overlay (blocks page interaction while AI active)
- Status bar at bottom-right: dot + "Web MCP" + task name + "Take Control" + "Open full →"
- Idle badge when session inactive
- "Open full →" opens native side panel
*0.2.0:* the overlay is a centred bottom bar with the agent's label, an action verb, a side-panel button and a Halt button, in the agent's color; idle/halted tabs get a badge. No task name or action text is shown in the page.

### 10. Isolated World Boundary for AI Acting Flag
**Problem:** To allow CDP clicks to pass through the JS event blockers, we injected `window.__bp_ai_acting = true` into the page via CDP. But `content.js` runs in an Isolated World and couldn't see this flag, so it continued blocking AI clicks.
**Fix:** Switched to using a shared DOM attribute (`document.documentElement.setAttribute('data-bp-ai-acting', 'true')`) which can be read across context boundaries.

### 11. The Zombie Blocker (try/finally)
**Problem:** The `data-bp-ai-acting` flag was set before a CDP action and removed afterward. If the CDP action threw an error (e.g. element not found), the flag was never removed. The JS blockers stayed permanently disabled, destroying the security boundary.
**Fix:** Wrapped the CDP action execution in a strict `try/finally` block to guarantee the flag is always removed.

### 12. The Unstoppable AI (ensureBrowserReady Short-Circuit)
**Problem:** When the user clicked "Halt", the local server stopped the session. But if the AI was stuck in a tight loop calling tools, its local `wrapper.ts` state remained "running". `ensureBrowserReady()` returned `true` immediately without pinging the server to check for the halt. The AI essentially ignored the Halt button and instantly took control back.
**Fix:** Moved the server health check (which looks for `lastUserHaltTime` < 10 seconds) directly into `callChromeDevtoolsTool` before ANY short-circuits. If the user halted recently, it throws a fatal error, forcing the AI to stop its loop immediately.
*0.2.0:* halt is per agent and sticky: every tool call goes through `POST /agents/:id/actions`, which returns 423 until Resume; `browser_stop` is refused while halted, and re-registration keeps the halt.

### 13. The CDP keyup Race Condition
**Problem:** When typing text and pressing Enter (`submitKey=Enter`), Google Search would not submit. This happened because `wrapper.ts` removed the `data-bp-ai-acting` flag *immediately* after the CDP `press_key` call completed. However, the browser's event queue processes the `keyup` event asynchronously. Because the flag was already gone, `content.js` intercepted the `keyup` event and called `e.preventDefault()`, which prevented Google's React logic from seeing the Enter key release and submitting the form.
**Fix:** Added a 100ms `await sleep(100)` delay before removing the `data-bp-ai-acting` flag, giving the browser's DOM event queue enough time to process trailing `keyup` and React synthetic events before the human-blocker re-engages.

### 14. The CDP MouseEvent Hit-Testing Race Condition
**Problem:** AI clicks (`browser_click`) were silently failing, but `browser_type` still typed text into the void. `wrapper.ts` set the `data-bp-ai-acting = true` flag (which sets the blocking overlay to `pointer-events: none`) *immediately* before dispatching the CDP click. The browser did not have time to recalculate the CSS/layout tree before the CDP click arrived, meaning hit-testing still saw the overlay as `pointer-events: auto`. The overlay swallowed the click, stealing focus from auto-focused inputs.
**Fix:** Swapped the order of execution. `wrapper.ts` now sets the flag, forces a synchronous layout flush (`document.documentElement.offsetHeight`), and *then* sleeps for 500ms *before* dispatching the CDP click. This guarantees the hit-testing tree is updated before the click arrives.
*0.2.0:* see fix 21 — a layout flush plus two animation frames (`setFlag()` in `wrapper.ts`).

### 15. The Silent evaluate_script Failure
**Problem:** Even after fixing the layout flush, clicks still hit the overlay. `wrapper.ts` was passing `{ script: "..." }` to the MCP tool `evaluate_script`. However, the `chrome-devtools-mcp` package expects `{ function: "() => { ... }" }`. Because the argument was named wrong, `evaluate_script` silently executed `(undefined)()`, never actually setting the `data-bp-ai-acting` flag at all! This left the `pointer-events: auto` overlay permanently active, completely blinding the AI to any click interactions.
**Fix:** Refactored `wrapper.ts` to pass the correct parameter `{ function: "() => { ... }" }` to `evaluate_script`, permanently fixing the AI's ability to click elements.

## Key Fixes Applied (June 2026 - Concurrency & Lifecycle) — 0.1.x

### 16. Zombie Chromium Prevention (The Heartbeat)
**Problem:** Wrappers crashing or being forcefully closed left Chromium running endlessly in the background.
**Fix:** Implemented a heartbeat in `service_worker.js`. It pings the server every 3s. If the server goes offline for >60s, Chromium automatically self-destructs by closing all windows.
*0.2.0:* still true, but armed only after one successful ping, and while a chat is open its wrapper restarts a dead server before the 60 s run out.

### 17. Multi-Agent Orchestration Safety
**Problem:** If two OpenCode chats used Web MCP concurrently, one calling `browser_stop` would run `Stop-Process` and kill the shared server/browser, violently disconnecting the other agent.
**Fix:** Removed destructive process kills from `browser_stop` and `cleanup()`. They now only disconnect the local CDP session. Hard kills are reserved exclusively for the `web-mcp stop` CLI command.
*0.2.0:* `browser_stop` closes the calling agent's own tabs and removes the agent (refused while halted); `cleanup()` only deregisters the agent.

### 18. EADDRINUSE Port Squatter Safety
**Problem:** If `server.pid` was missing, but port 3026 was in use, `startServer()` crashed with `EADDRINUSE`.
**Fix:** `killStaleServer()` now uses aggressive OS-level commands (`Get-NetTCPConnection` or `lsof`) to forcefully reclaim the port if the server fails the `/ping` check, bypassing the need for a PID file entirely.
*0.2.0: REMOVED — never do this.* Killing whatever owns a port can take down unrelated programs. A foreign process on the port is now reported as an error (`Port 3026 is in use by another program…`).

### 19. Strict Chromium Port Hijack Prevention
**Problem:** If the user manually opened Chromium on port 9222, the AI would connect to it but silently fail to inject the extension, operating an unprotected browser.
**Fix:** `ensureBrowserReady()` now strictly verifies the extension's `service_worker` is loaded. If missing, it throws a fatal error rather than hijacking the browser.
*0.2.0:* `ensureChrome` accepts a browser only if a `service_worker.js` target has *our* exact unpacked-extension id (derived from the `~/.web-mcp/extension` path).

### 20. Atomic File JSON Safety
**Problem:** Multiple wrappers booting simultaneously corrupted `config.json` via synchronous `fs.writeFileSync`.
**Fix:** Refactored all configuration writes across `setup.ts`, `browser.ts`, and `wrapper.ts` to use atomic `.tmp` file creation + `fs.renameSync`.

### 21. Bulletproof CDP Hit-Testing Sync
**Problem:** The arbitrary `sleep(500)` before CDP clicks was brittle and slow.
**Fix:** Replaced it with a native `requestAnimationFrame` layout flush injected via `evaluate_script`, mathematically guaranteeing the CSS pointer-events blocker is disabled before the click lands.

### 22. Stealth Mode / CAPTCHA Bypass (v0.1.3)
**Problem:** Google and other web applications blocked requests or presented constant CAPTCHAs due to the standard automation flag (`--enable-automation`).
**Fix:** Replaced the `--enable-automation` flag with `--disable-blink-features=AutomationControlled` in both wrapper and browser runners to bypass standard bot/automation detection.

### 23. Interactive Browser Launch Freeze (v0.1.3)
**Problem:** In `src/cli/browser.ts`, executing the `wmic` process termination was synchronous/awaited, causing the interactive command line interface to freeze.
**Fix:** Refactored the process termination check to use `spawn` with `{ detached: true, stdio: 'ignore' }.unref()` so that it runs asynchronously without blocking execution.
*0.2.0:* `web-mcp browser` uses the shared launcher; process kills are scoped (`killProfileChrome`).

### 24. Puppeteer Dynamic Import (v0.1.3)
**Problem:** Using standard CJS `require("puppeteer")` inside the ES Modules output files of the wrapper was throwing import errors.
**Fix:** Refactored `findChromePath` to dynamically load Puppeteer using `await import("puppeteer")`.
*0.2.0:* `findChromePath` never imports `puppeteer` (it would read `.puppeteerrc` from the AI client's project); it uses `@puppeteer/browsers` and `~/.cache/puppeteer`, then system Chromium.

### 25. OpenAI Codex Integration Support (v0.1.3)
**Problem:** OpenAI Codex does not use standard JSON MCP settings or would bypass Web MCP in favor of its built-in browser engine.
**Fix:** Configured the setup script to automatically parse, write, and append config settings to Codex's `~/.codex/config.toml` using the correct `[mcp_servers.web-mcp]` block and referencing a generated `~/.codex/web-mcp-instructions.md` model instructions file (using `model_instructions_file = "..."`). This instructs the Codex model to always prefer Web MCP over its built-in browser.

### 26. Unified Configuration Paths and Keys (v0.1.3 — updated v0.1.5)
**Problem:** Configuration setup used outdated or incorrect paths/keys for several clients.
**Fix:** Updated `src/cli/setup.ts` with correct paths and schemas:
- **OpenCode**: `~/.config/opencode/opencode.json` with `mcp` key (`type: "local"`, `command` array).
- **Claude Desktop**: macOS/Windows/Linux standard Claude paths, `mcpServers` key with `type: "stdio"`.
- **Claude Code (CLI)**: `~/.claude.json` (user-scoped MCP, per Anthropic docs).
- **Cursor**: `~/.cursor/mcp.json`, `mcpServers` key with `type: "stdio"`.
- **Windsurf**: `~/.codeium/windsurf/mcp_config.json`, `mcpServers` key with `type: "stdio"`.
- **Zed**: Platform-appropriate path (`APPDATA` on Windows), `context_servers` key.
- **Sourcegraph Cody**: VS Code `globalStorage/sourcegraph.cody-ai/mcp_servers.json`.
- **Cline**: `~/.cline/data/settings/cline_mcp_settings.json`, `mcpServers` key.
- **OpenAI Codex**: `~/.codex/config.toml` (TOML format with `[mcp_servers.web-mcp]`).
- **Antigravity IDE**: `~/.gemini/antigravity/mcp_config.json`.
- **ChatGPT Desktop**: Manual setup via local bridge proxy.
*0.2.0:* Zed on macOS uses `~/.config/zed/settings.json`; ChatGPT Desktop is **not supported** (it would require exposing the browser to the internet); configs are pinned to `@amitnarw/web-mcp@<version>`. See `docs/supported-clients.md`.

## How It Works (End-to-End Flow)

1. **User asks AI:** `"go to google and search for phone"`
2. **AI calls `browser_navigate`** → URL allowlist check (`checkUrl`: http(s)/`about:blank`/`data:` only, never Web MCP's own ports) → `act()` in the wrapper
3. **`ensureReady()`** runs once per wrapper (again after the browser or server went away):
   - `ensureServer()`: verifies `/.identity` with a token challenge, starts the server if nothing answers, and refuses a server with a different protocol or without a valid proof
   - `POST /agents`: registers this agent (label from `WEB_MCP_AGENT_NAME`, `browser_start({agentName})` or the MCP client name; `previousAgentId` on re-registration)
   - `ensureChrome()`: uses a running Chromium only if it has *our* extension; otherwise launches it under the launch lock, refreshing the extension copy and writing `env.js` with the port and token
   - spawns the pinned chrome-devtools-mcp (`node <resolved bin> --browserUrl=... --no-usage-statistics --no-performance-crux --redactNetworkHeaders --no-file-navigations --experimentalStructuredContent --blockedUrlPattern=<DevTools port> …`, with `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1` and `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1`) and records it in `~/.web-mcp/helpers`
4. **`POST /agents/:id/actions`**: returns 423 if the user halted this agent, and otherwise marks it active. Typed input is announced redacted when the target field looks secret; navigation is recorded without query strings.
5. **First navigate** opens a new tab for this agent (`new_page`). The wrapper records the `pageId` and claims the Chrome tab (origin-bound nonce flow via `claim.js`).
6. **Server broadcasts** `StatePayload` over SSE (`/events?token=`, after the service worker verified the server). The service worker sends `TAB_STATE` only to the tabs whose view changed.
7. **Content script** shows the overlay (agent label + action verb), tinted with the agent's colour, on that agent's tabs only. During CDP input the wrapper sets `data-bp-ai-acting` (`mouse` / `true` / `capture`) so the input passes.
8. **AI calls `browser_done`** → `PATCH status=idle`, which removes that agent's overlay only
9. **Idle timeout** (`agents.idleTimeoutMs`, default 90 s) marks agents idle if they forget `browser_done`. Agents without a heartbeat for `agents.staleAfterMs` (default 60 s, min 45 s) are removed and leave a 30-minute tombstone.

## File Structure

```
web-mcp/
├── bin/web-mcp.js              # CLI entry: command dispatch, allowed flags, exit codes (0/1/2)
├── src/
│   ├── cli/
│   │   ├── browser.ts          # `web-mcp browser` and `web-mcp install-browser`
│   │   ├── common.ts           # help text, {ok} report-lines type
│   │   ├── interactive.ts      # Interactive menu interface (orb.ts: its animation)
│   │   ├── setup.ts            # Setup/uninstall for all AI clients, version pinning, Codex TOML editing
│   │   ├── status.ts           # Status report (identity-verified before sending the token)
│   │   ├── stop.ts             # POST /shutdown, verified-PID fallback, helper + profile Chromium kills
│   │   └── troubleshoot.ts     # Checks + cleanup (--reset-config, --reset-profile)
│   ├── mcp/
│   │   └── wrapper.ts          # MCP server (one agent): browser tools scoped to the agent's own tabs
│   ├── server/
│   │   ├── app.ts              # Coordination API: identity proof, agents, tombstones, tabs, claims, halt, SSE, recordings, shutdown
│   │   ├── server.ts           # Entry point: port probe, loopback listen, pid file
│   │   └── logger.ts           # Persistent file logger with rotation
│   ├── shared/
│   │   ├── paths.ts            # WEB_MCP_HOME, config validation, auth token, PROTOCOL_VERSION, legacy cleanup
│   │   ├── protocol.ts         # HTTP payload types
│   │   └── launcher.ts         # ensureServer / ensureChrome, browser discovery/install, extension id + copy, lock, helper registry, scoped kills
│   └── extension/              # SOURCE FILES: Edit extension code here!
│       ├── manifest.json       # MV3 manifest (permissions: sidePanel; host: http://127.0.0.1/*)
│       ├── service_worker.js   # Verified SSE client; sends TAB_STATE; relays CLAIM_TAB / HALT_TAB / OPEN_SIDEBAR; zombie check
│       ├── server_api.js       # Identity-checking server client for service worker, side panel, popup
│       ├── claim.js            # document_start: consumes tab-claim nonces before page scripts
│       ├── content.js          # Overlay (top layer) + badge + human-input blocker
│       ├── popup.html/.js      # Extension popup
│       ├── sidepanel.html/.js  # Side panel: agent cards, Halt/Resume, Halt all, debug logs
│       └── env.js              # Placeholder; the launcher writes the real one into ~/.web-mcp/extension
├── extension/                  # BUILD OUTPUT: Minified extension files (Do not edit)
├── dist/                       # BUILD OUTPUT: tsc output, then *.min.js bundles (Do not edit)
├── scripts/
│   ├── bundle.mjs              # esbuild bundling + extension minify
│   └── e2e-multi-agent.mjs     # Live end-to-end test (17 checks)
├── test/                       # node:test unit tests (server.test.mjs, setup.test.mjs)
├── docs/                       # User and contributor documentation
├── npm-shrinkwrap.json         # Locked dependency tree (published)
└── AGENTS.md                   # This file
```

## Common Commands

```powershell
# Status (verifies the server identity before sending the token)
web-mcp status

# Stop the server, our chrome-devtools-mcp helpers and the Web MCP Chromium (scoped: never kills other apps)
web-mcp stop

# Checks and cleanup (keeps logins and settings); add --reset-config / --reset-profile only when needed
web-mcp troubleshoot

# Download the pinned Chrome for Testing build
web-mcp install-browser

# Launch the browser manually (for testing extension UI)
web-mcp browser

# Rebuild everything (from the repository root)
npm run build; npm run bundle

# Unit tests / live e2e (own WEB_MCP_HOME, ports 3126/9322)
npm test
npm run build; npm run bundle; node scripts/e2e-multi-agent.mjs

# Raw server state and logs (only against your own instance; `web-mcp status` is the safe way)
$t = Get-Content "$env:USERPROFILE\.web-mcp\auth-token"
Invoke-RestMethod "http://127.0.0.1:3026/state" -Headers @{ Authorization = "Bearer $t" } | ConvertTo-Json -Depth 5
Invoke-RestMethod "http://127.0.0.1:3026/logs" -Headers @{ Authorization = "Bearer $t" } | ConvertTo-Json -Depth 2

# Check Chromium remote debugging
Invoke-RestMethod "http://127.0.0.1:9222/json/version" | ConvertTo-Json

# Server log file
Get-Content "$env:USERPROFILE\.web-mcp\logs\server.log" -Tail 20
```

## Debug Logging

### In Extension UI
- **Popup**: Click "Debug Logs" to see real-time server logs
- **Side Panel**: Click "Show Debug Logs" at the bottom to see real-time server logs
- Both use `GET /logs` with the token from `env.js`, after verifying the server identity. If verification fails they show why (token mismatch, another program on the port, no token, unreachable).
- Extension console: `chrome://extensions` → Web MCP → **service worker**; page console for the content script. All lines start with `[Web MCP]`.

### Wrapper Logging
The wrapper logs to stderr with a `[web-mcp] [LEVEL]` prefix: agent registration, server/Chromium launch, chrome-devtools-mcp connection and browser-state resets. chrome-devtools-mcp's own stderr is captured and shown in the error when it fails to start. Set `"logging": { "level": "debug" }` in `~/.web-mcp/config.json` for more. These logs appear in the AI client's MCP log / terminal.

## Important Notes

- **`browser_start` is optional**: it names the agent and task for the side panel
- **Halt** (overlay button, side panel or popup) is per agent and sticky until the user presses **Resume** in the side panel; `browser_stop` is refused while halted, and halts survive server restarts
- **Extension changes need a rebuild + `web-mcp stop`** (see "Updating the extension" above) — this is the #1 cause of "my change doesn't show"
- **Server is independent** of wrappers — survives wrapper crashes; wrappers restart it if it dies
- **Chromium is independent** of wrappers — the user can close it; the next tool call relaunches it
- **`browser_done`** signals task completion — AI should call it when done (90 s idle timeout as fallback)
- **Input blocking** = the overlay covering the page (top layer) **plus** capture-phase listeners on `window` for trusted pointer/wheel/context-menu/key events. CDP input is also `isTrusted`, so the wrapper must set `data-bp-ai-acting` around every input action (see `actingFlag()` in `wrapper.ts`); `true` for typing so Enter can submit forms, `capture` hides the overlay for screenshots
- **Keyboard input inside iframes is not blocked** (content scripts run in the top frame only)
- **Never log or persist typed text, URL query strings or the claim nonce**; `TabView` must stay minimal because the page can read the overlay DOM
- **Server logs** at `~/.web-mcp/logs/server.log` — 10 MB rotation, up to 7 files
