# Security audit and review: 0.1.6 → 0.2.0

This page records the security and robustness audit of web-mcp 0.1.6, the internal review of the 0.2.0 changes, what was fixed, what remains open, and how it was verified. For the current protections and threat model, see [Security](security.md).

## Scope and method

- **Code audited:** the 0.1.6 source (MCP wrapper, coordination server, Chrome extension, CLI, packaging). The 0.2.0 changes then went through a second, independent review in four areas: core runtime, coordination server, extension, and CLI/packaging.
- **How findings were confirmed:**
  - reading the code paths
  - probe scripts against throwaway headless Chromium instances and test servers on separate ports, with a separate `WEB_MCP_HOME`
  - a clean `npm pack` install of the package
- **Tests added:**
  - `npm test`: 63 unit tests covering the server and setup (one is skipped on Windows, where creating symlinks needs extra rights).
  - `scripts/e2e-multi-agent.mjs`: 17 live checks with two real MCP clients sharing one Chromium.
- **Platform:** all testing ran on Windows 10. macOS and Linux paths (POSIX file modes, `pkill`/`lsof`, Chromium locations) were reviewed but not executed.

Severity: **Critical** means remote or cross-site compromise or secret exposure. **High** means serious data exposure, data loss or a safety failure. **Medium** means a limited exposure or a reliability problem with a security impact. **Low** covers hygiene items.

## Part 1: findings in 0.1.6 (all fixed in 0.2.0)

| # | Severity | Finding | Impact | Fix in 0.2.0 |
|---|---|---|---|---|
| 1 | Critical | Every browser launch wrote the full process environment to `~/.web-mcp/debug-env-dump.json`. | API keys and tokens from the AI client's environment were stored in plain text. | The dump is no longer written, and 0.2.0 deletes it. Rotate any key that was in that environment. |
| 2 | Critical | The control server listened on all network interfaces, sent `Access-Control-Allow-Origin: *`, and had no authentication. | Any website open in any browser, or any device on the network, could read logs (URLs, typed text) and recordings, and could stop or drive sessions. | Listens on `127.0.0.1` only. A secret token is required, Host and Origin headers are checked, and no CORS headers are sent. |
| 3 | High | Every action, including the first 30 characters of typed text, was broadcast into the page DOM of **every** open tab, and written to logs and recordings. | Any open site could read what the AI typed on another site. Typed passwords ended up on disk. | Each tab only gets its own agent's label, colour and action type. Values typed into password-like fields are never shown. Disk copies say "Typing (N chars)". |
| 4 | High | `web-mcp setup` replaced an AI client's config file with `{}` when it could not parse it (Zed's commented JSON, for example). | Data loss: client settings were wiped, `~/.claude.json` included. | Unparseable files are left untouched. A backup is made before the first change, and writes are atomic. |
| 5 | High | Process cleanup force-killed **any** program listening on port 3026. `troubleshoot` killed every node process whose command line mentioned `chrome-devtools`. | Unrelated applications and other AI clients' tools could be killed. | Only processes proven to be web-mcp's own are killed: checked by identity, owned port and exact profile path, with helpers tracked by PID. |
| 6 | High | Halt lasted 10 seconds, after which the agent resumed on its own. | The user's stop button did not reliably stop the AI. | Halt is per agent and stays until the user presses Resume. |
| 7 | High | `chrome-devtools-mcp` was started with `npx` at whatever version was newest that day. Google usage statistics were on, contradicting the privacy page. | Supply-chain exposure and undisclosed telemetry. | The pinned dependency is run directly. Usage statistics, CrUX lookups and update checks are off. |
| 8 | High | Agents could open `file://`, `chrome://` and extension pages. | Local files could be read into the AI's context. | Only `http(s)`, `about:blank` and `data:` are allowed; file navigation is also disabled in `chrome-devtools-mcp`. |
| 9 | High (functional) | `chrome-devtools-mcp` 1.8 and later require a `pageId`, which 0.1.6 never sent. `wait_for` now takes a list of strings. | Click, type, snapshot, screenshot, navigate and wait failed with current dependency versions. | Every call sends the agent's own `pageId`, with the current parameter shapes. |
| 10 | Medium | `web-mcp browser` started Chromium without the server. | The extension closed every browser window after 60 seconds. | The server starts first. |
| 11 | Medium | The extension copy in `~/.web-mcp` was never refreshed after an upgrade. | Fixes to the extension never reached users. | The copy is refreshed whenever its files change. |
| 12 | Medium | Any extension with a `service_worker.js` passed the "our extension is loaded" check. | web-mcp could drive the user's own debug-enabled Chrome. | The check now requires web-mcp's exact unpacked-extension ID. |
| 13 | Medium | Codex setup appended `model_instructions_file` after the last TOML table. | The key landed inside the wrong table. | Top-level keys are inserted before the first table. |
| 14 | Medium | `troubleshoot` crashed on a leftover CommonJS `require` and deleted the browser profile (saved logins) by default. | Lost logins, and a broken tool. | The `require` crash is gone, and the profile is only reset with `--reset-profile`. |
| 15 | Low | The declared Node version was wrong, four dependencies were unused, and an empty `postinstall` script ran. | Install surface and confusion. | Engines corrected, unused dependencies removed, script removed. |

## Part 2: issues found in the 0.2.0 review (all fixed before release)

| Severity | Finding | Fix |
|---|---|---|
| Critical | Agent tabs could open Chromium's DevTools HTTP endpoint on the debugging port, which lists **every** tab (including the user's and other agents') and can close any of them. | The endpoint is blocked for agent tabs, for direct navigation, redirects and subresources. The URL check also refuses web-mcp's own ports. |
| High | Finding Chromium imported `puppeteer`, which loads `.puppeteerrc*` and `package.json` config from the AI client's working directory. | A malicious repository could run code inside web-mcp or swap the browser executable. Chrome for Testing is now located without loading any config files. |
| High | A halted agent could escape the halt: via `browser_stop`, by re-registering after a server restart, or after a laptop sleep longer than about a minute. | `browser_stop` is refused while halted. The server keeps halted agents' state (tombstones, clock-jump guard), and the wrapper re-applies a halt it has seen. |
| High | `troubleshoot` reset `config.json` on every run, turning `allowEvaluate` back on and dropping `blockedUrlPatterns`. | The config is kept. A reset only happens with `--reset-config`, which first makes a timestamped backup. |
| High | Dependencies used caret ranges and no lockfile was published, so `npx` installs ran untested versions. Per-agent tab filtering depends on `chrome-devtools-mcp`'s output format. | Exact versions plus a published `npm-shrinkwrap.json`. Tab filtering fails closed on output it doesn't recognise. |
| High | "Uninstall from all clients" was the default menu choice, ran without confirmation, and deleted the whole home folder (logins included). | It asks for confirmation (`--yes` on the CLI), stops processes first, and deletes only web-mcp's own files. |
| High (functional) | Enter on a form, button or link was swallowed by the overlay, and a closed browser was never relaunched. | Typing lets keyboard-triggered clicks through. A closed browser is detected and relaunched on the next call. |
| Medium | A page could intercept the tab-link nonce and attach the agent's overlay and live feed to another tab. | Claims are bound to the page's origin, the claim relay runs first (`document_start`, capture phase), and the overlay gets only minimal information. |
| Medium | Another local user could squat the server port and receive the token. | Every client checks the server's challenge-response proof (HMAC of the token) before sending the token. |
| Medium | The overlay's own UI swallowed the agent's clicks; wheel, pointer and top-layer page elements got past the human-input blocker. | All overlay UI lets the agent's input through while it acts. The overlay sits in the browser's top layer, more event types are blocked, and the overlay is re-attached if a page removes it. |
| Medium | A stalled side-panel connection made server memory grow without bound. Agents and claims had no limits. | Slow SSE clients are dropped, and there are caps on agents, tabs and claims. |
| Medium | The token copy in `env.js` was world-readable on macOS/Linux. | The home folder is 0700 and `env.js` is 0600. |
| Medium | Helper scripts waited up to 3 s for the DOM to settle and silently accepted `confirm()` dialogs. | Helpers don't wait for the DOM and dismiss dialogs. |
| Medium | Popups the agent opened weren't its own tabs, hover menus closed immediately, and screenshots included the overlay. | Popups are adopted, hover state is held (for at most 8 s), and the overlay is hidden during screenshots. |
| Medium | On Windows, `web-mcp stop` hard-killed the server, so recordings were lost. | An authenticated graceful `POST /shutdown` is tried first. |
| Low | Assorted: exit codes always 0, a race in the launch lock and token creation, typographic quotes in PowerShell paths, legacy stop could hit a reused PID, Codex and Claude Code `env` lost on re-setup, URLs with query strings in logs. | All fixed. See the [changelog](CHANGELOG.md). |

## Part 3: residual risks and known limitations

These are known, documented, and not fixed in 0.2.0:

- **Local processes running as the same OS user** can read `~/.web-mcp/auth-token` and connect to Chromium's debugging port. web-mcp doesn't defend against malware already running as you.
- **Prompt injection from web pages.** Page content is marked as untrusted, and URL rules, `blockedUrlPatterns` and `allowEvaluate` limit the damage, but an AI can still be talked into acting with the logins in the Web MCP browser profile. Keep sensitive sites blocked.
- **Agents share the profile's logins** unless they use isolated tabs, and the overlay is not shown in isolated tabs.
- **Keyboard input inside iframes** (embedded widgets) isn't blocked while an agent works.
- **The page can read the agent's label** from the overlay (not the task or actions), and can weaken the human-input blocker on its own tab.
- **A halt pressed less than ~15 s before the coordination server crashes** can be lost, because the wrapper only re-applies halts it has already seen.
- **`web-mcp stop` is partly undone by open AI chats:** their heartbeat restarts the server within ~15 s. Chromium only relaunches on the next browser tool call.
- **Windows file permissions:** the 0600/0700 modes have no effect there. Privacy relies on your user folder's ACL, so a custom `WEB_MCP_HOME` outside your profile should be protected the same way.
- **Large screenshots** (2 MB or more) may be written by `chrome-devtools-mcp` to the OS temp folder.
- **Agents can't take over an existing tab.** They always open their own.

## Part 4: open decisions for the maintainer

1. **`--disable-blink-features=AutomationControlled`** (kept from 0.1.x) hides automation from websites and may conflict with some sites' terms. Recommendation: make it opt-in in `config.json`.
2. **The `browser_navigate` "no cheating" instruction** tells the AI to click through sites instead of opening URLs directly. That makes tasks slower and more expensive. Recommendation: soften it or make it configurable.
3. **Unverified client config paths:** Cline, Sourcegraph Cody and Antigravity. Setup writes the paths documented in [Supported clients](supported-clients.md); they need checking against each client's current docs.
4. **ChatGPT Desktop** is still listed in the setup menu but only prints "not supported". Recommendation: remove it from the menu.
5. **Exact pins plus shrinkwrap** mean dependency security fixes need a web-mcp release. Recommendation: add Dependabot or Renovate and CI, which the project doesn't have yet.
6. **License:** resolved — `package.json` now has `"license": "MIT"` and a `LICENSE` file is present (MIT, © 2026 Amit Narwal).

## For users of 0.1.x

Upgrade to 0.2.0, rotate any API keys that were in your AI client's environment, and see [Upgrading](upgrading.md). 0.2.0 deletes `debug-env-dump.json` and 0.1.x logs and recordings that contained typed text.

## Reporting a vulnerability

See [Security → Reporting a vulnerability](security.md#reporting-a-vulnerability).
