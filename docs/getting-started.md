# Getting started

This takes you from nothing to your AI using a browser, in about five minutes.

## What you need

- Node.js 22.12 or newer (`node -v` to check).
- An AI client that supports MCP: Claude Code, Cursor, OpenCode, Codex, Claude Desktop, Windsurf, Zed, Cody or Cline. See [Supported clients](supported-clients.md).
- Windows, macOS or Linux.

You don't need to install a browser. Web MCP uses **Chrome for Testing**, a Chromium build made for automation. It downloads during install and runs with its own profile, so your regular Chrome or Edge is never touched.

## Step 1: Install

```bash
npm install -g @amitnarw/web-mcp
```

The browser download happens during install and takes about a minute. If it was skipped or failed, run:

```bash
web-mcp install-browser
```

## Step 2: Connect your AI client

```bash
web-mcp setup
```

Pick your AI client from the menu and press Enter. You can also name it directly:

```bash
web-mcp setup cursor   # also: claude-code, claude-desktop, opencode, openai-codex, zed, windsurf, cody, antigravity, cline
```

Setup pins your client to `@amitnarw/web-mcp@0.2.0` so it never silently picks up a different release. **Restart your AI client** afterwards so it loads Web MCP.

Check it worked:

```bash
web-mcp test   # shows which clients are configured, flags outdated pins
web-mcp status # shows the server, the browser and connected agents
```

## Step 3: Ask your AI

Ask for anything that needs a browser:

> Go to example.com and tell me what the page says.

> Go to google.com and search for OpenCode.

The first request takes longer: Web MCP starts its server and launches the browser. If you run several chats, you can give each one a name so you can tell them apart:

> Call browser_start with agentName "Research" before you start.

When the AI finishes, it calls `browser_done`, which removes the overlay and hands the tab back to you. If it forgets, the overlay releases itself after 90 seconds of silence.

## How to stop

| You want to… | Do this |
|---|---|
| Stop one AI | Click **Halt** on its overlay bar or side-panel card. It stays halted until you press **Resume**, even if it tries `browser_stop`. |
| Stop every AI | **Halt all** in the side panel or toolbar popup. |
| End one AI's browser session | Ask it to call `browser_stop`. It closes its own tabs; the browser keeps running for everyone else. |
| Shut everything down | Run `web-mcp stop`. It stops the local server, Web MCP's helpers and the Web MCP browser. |

The server and browser keep running until you run `web-mcp stop`. If your AI chats are still open, they restart the server within about 15 seconds; the browser comes back when one of them uses it again.

## Logging in to websites

The Web MCP browser has its own profile, so it starts logged out of everything. To let an AI use a site you're logged in to:

```bash
web-mcp browser
```

This starts the server and browser. Log in to the sites you need in that window. Every AI using Web MCP shares this profile, so they can all use those logins. If you want an AI to stay logged out, ask it to open an isolated tab (see [isolated tabs](multi-agent.md#isolated-tabs)).

## Next steps

- [Several AIs at once](multi-agent.md): tabs, names, colors, Halt/Resume.
- [Tools reference](tools-reference.md): everything the AI can do in the browser.
- [Configuration](configuration.md): ports, URL blocking, turning off JavaScript evaluation.
- [Troubleshooting](troubleshooting.md): if something doesn't work.
