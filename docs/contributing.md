# Contributing

Notes for working on the Web MCP source. Read [Architecture](architecture.md) first. `AGENTS.md` in the repository root has extra rules for AI coding agents working on this repo, and `DEVELOPMENT.md` has design notes.

## Prerequisites

- Node.js 22.12 or newer (`engines` in `package.json`).
- `npm install` in the repository. It installs the exact versions locked in `npm-shrinkwrap.json`, and Puppeteer's install script downloads Chrome for Testing into `~/.cache/puppeteer`. If that download is skipped, run `node bin/web-mcp.js install-browser` after building.

Dependencies are pinned to exact versions in `package.json` and locked by `npm-shrinkwrap.json`, which is published with the package. When you add or update a dependency, commit the updated `npm-shrinkwrap.json`. `.gitattributes` keeps `bin/*` and `*.mjs` files at LF line endings, so the CLI's shebang works everywhere. Keep it that way.

## Commands

| Command | What it does |
|---------|--------------|
| `npm run build` | `tsc`: compiles `src/**/*.ts` into `dist/` (ES2022, Node16 modules). |
| `npm run bundle` | `node scripts/bundle.mjs`. It (1) bundles every `dist/**/*.js` into a minified `*.min.js` with esbuild (target Node 22, all npm packages external), then **deletes the unminified `dist` files**; (2) recreates the repository-root `extension/` folder from `src/extension/`, minifying the `.js` files and copying the rest. |
| `npm test` | `tsc && node --test test/server.test.mjs test/setup.test.mjs`: coordination-server and setup unit tests. They use throwaway home folders and never touch your real `~/.web-mcp` or client configs. |
| `node scripts/e2e-multi-agent.mjs` | End-to-end test with two real MCP clients and a real browser (see below). |
| `npm run setup` / `npm run status` / `npm run stop` | Shortcuts for `node bin/web-mcp.js setup`, `status` and `stop`. These need a bundled build. |

`bin/web-mcp.js` imports `dist/**/*.min.js`, so the CLI and the MCP server only run after `npm run build && npm run bundle`. On `npm publish`, the `prepublishOnly` script runs `npm test && npm run bundle`.

The unit tests import the plain `dist/*.js` files, and `npm test` re-runs `tsc` to create them, so it works after a bundle too.

The CLI returns exit code 0 on success, 1 when a command ran but failed (commands return their report lines with an `ok` flag, see `src/cli/common.ts`), and 2 for usage errors. `bin/web-mcp.js` rejects unknown options per command (`ALLOWED_FLAGS`), so add new flags there.

## End-to-end test

```bash
npm run build && npm run bundle && node scripts/e2e-multi-agent.mjs
```

It starts two MCP clients (`claude-code` and `cursor`), each spawning `node bin/web-mcp.js mcp`, against a local test site and a **headless** browser, and runs 17 checks:

- the agents name themselves, navigate in parallel and see only their own tabs,
- the extension claims their Chrome tabs and shows the overlays,
- a form is filled through the overlay, and `browser_done` releases only one agent's overlay,
- halt is per agent and sticky,
- `file://` and `chrome://` are refused, and agents can't reach the DevTools endpoint (directly or via a redirect),
- Enter submits a password form, and the value never shows in the side panel,
- a pop-up becomes the agent's tab,
- `browser_stop` can't escape a halt, and otherwise closes the agent's tabs,
- the server enforces auth, Origin and no-CORS,
- a typed secret never reaches disk, `/logs` or recordings.

It runs in a throwaway `WEB_MCP_HOME` with ports **3126** (server) and **9322** (CDP), so it doesn't interfere with a normal instance on 3026/9222. Don't run two copies at once, though: they would share those ports.

| Variable | Effect |
|----------|--------|
| `E2E_HEADFUL=1` | Show the browser window instead of running headless. |
| `E2E_VERBOSE=1` | Pass the wrappers' stderr through and list the recordings at the end. |
| `E2E_KEEP=1` | Keep the temporary home folder afterwards for inspection. |
| `E2E_TMP=<dir>` | Create the temporary home folder inside `<dir>` instead of the OS temp folder. |

The script exits with code 1 if any check fails, and stops only the server and browser it started.

## Use your build in an AI client

Point a client at your checkout, and give it its own home folder and ports so it doesn't collide with an installed Web MCP:

```json
{
  "mcpServers": {
    "web-mcp-dev": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/web-mcp/bin/web-mcp.js", "mcp"],
      "env": { "WEB_MCP_HOME": "/path/to/web-mcp-dev-home" }
    }
  }
}
```

Then create `/path/to/web-mcp-dev-home/config.json` with different ports, for example:

```json
{ "server": { "port": 3226 }, "chrome": { "port": 9422 } }
```

Use the same `WEB_MCP_HOME` when you run the CLI against that instance, for example `WEB_MCP_HOME=/path/to/web-mcp-dev-home node bin/web-mcp.js status` (in PowerShell: `$env:WEB_MCP_HOME = "…"; node bin/web-mcp.js status`).

## Reloading the extension

The browser doesn't load the extension from the repository. At each browser launch, the launcher copies the built `extension/` folder (or `src/extension/` if there is no build) into `<WEB_MCP_HOME>/extension`, and writes `env.js` there. It re-copies whenever the source files change (it compares a signature of names, sizes and modification times), but only when it launches the browser. So after changing extension code:

1. `npm run build && npm run bundle`, which rebuilds `extension/`.
2. `web-mcp stop`, with the same `WEB_MCP_HOME`, so the running browser closes.
3. Use any browser tool. The next launch copies the new extension, with a fresh `env.js`.

Pressing reload in `chrome://extensions` is **not** enough: it reloads the old copy in `<WEB_MCP_HOME>/extension`, not your repository. You don't need to delete anything by hand, and `web-mcp troubleshoot` isn't needed for this.

The side panel and popup use a prebuilt `tailwind.css`. There is no npm script for it, so if you add Tailwind classes, regenerate it with the Tailwind CLI and `src/extension/tailwind.config.js`.

## Project layout

```text
bin/web-mcp.js              CLI entry point: command dispatch, flag checks, exit codes
src/mcp/wrapper.ts          MCP stdio server: one process = one agent; all browser_* tools
src/server/app.ts           Coordination server: routes, agents, tombstones, claims, SSE, recordings
src/server/server.ts        Server process: port probe, listen on 127.0.0.1, PID file, shutdown
src/server/logger.ts        logs/server.log with rotation
src/shared/paths.ts         PROTOCOL_VERSION, WEB_MCP_HOME/PATHS, config validation, token, redaction, legacy cleanup
src/shared/protocol.ts      HTTP payload types (AgentPublic, TabView, StatePayload, IdentityPayload)
src/shared/launcher.ts      ensureServer / ensureChrome, identity proof, browser discovery and install,
                            extension id and copy, launch lock, helper registry, scoped process kills
src/cli/common.ts           Help text and the {ok} report-lines type
src/cli/interactive.ts      Interactive menu (orb.ts: its animation)
src/cli/setup.ts            Client setup/uninstall, version pinning, Codex TOML editing
src/cli/status.ts, stop.ts, troubleshoot.ts, browser.ts (browser + install-browser)
src/extension/              MV3 extension source: manifest.json, service_worker.js, server_api.js,
                            claim.js, content.js, sidepanel.*, popup.*, env.js (placeholder), fonts, tailwind
extension/                  Generated by `npm run bundle` from src/extension/ (shipped in the npm package)
dist/                       Generated by `npm run build` / `bundle` (not committed)
scripts/bundle.mjs          esbuild bundling + extension minify
scripts/e2e-multi-agent.mjs End-to-end test
test/server.test.mjs        Coordination server tests (node:test)
test/setup.test.mjs         Setup/config-writing tests (node:test)
npm-shrinkwrap.json         Locked dependency tree (published)
docs/                       This documentation
```

The npm package ships `dist/`, `extension/`, `bin/`, `README.md` and `npm-shrinkwrap.json` (the `files` field in `package.json`).

## Ground rules

These keep the 0.2.0 guarantees intact. Reviewers check for them.

- **Edit `src/extension/`, not `extension/`.** The latter is regenerated by every bundle.
- **TypeScript imports use the `.js` suffix** (Node16 resolution): `import { loadConfig } from "../shared/paths.js";`.
- **Never persist typed text or query strings.** Pass a `redacted` form (see `redactTyped()` and `redactUrl()`) for anything typed or navigated. Only `redactedText ?? text` may reach `addLog` or recordings, and no action text may reach `TabView`.
- **Never send the token to an unverified server.** Use `getServerIdentity(port, token)` (Node) or `WebMcpApi.request` (extension), which do the HMAC challenge first.
- **Never add `Access-Control-*` headers** to the server, never let content scripts talk to the server or see the token, and keep the extension's permissions minimal.
- **Never kill processes by port or broad patterns.** Use `killProfileChrome`, `killStaleChromeDevtoolsMcp` (registry-based) or `stopCoordinationServer`.
- **Only `src/shared/launcher.ts` starts the server or the browser.** Don't import the `puppeteer` package at runtime.
- **Bump `PROTOCOL_VERSION`** for incompatible HTTP changes, and update `src/shared/protocol.ts` and [Architecture](architecture.md#http-api).
- **New config keys** go through `loadConfig()` validation with a default in `DEFAULT_CONFIG`, and into [Configuration](configuration.md).
- **New or changed tools:** keep them scoped to the agent's own pages, route them through `act()` so halt applies, use `pageEval` for helper scripts, append `UNTRUSTED_NOTE` to results that carry page content, and update [Tools reference](tools-reference.md).
- Add or extend tests in `test/` for server and setup changes. Run the e2e script for anything touching the wrapper, the extension or the launcher.
- Don't run tests or experiments against your real `~/.web-mcp` or ports 3026/9222 while you are using Web MCP. Use `WEB_MCP_HOME` and other ports.

## Questions

Email amitnarwal115@gmail.com.
