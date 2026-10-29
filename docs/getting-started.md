# Getting started

This guide takes you from nothing to your AI using a browser, in about five minutes.

## What you need

- **Node.js 22.12 or newer.** Check with `node -v`.
- **An AI client that supports MCP**, such as Claude Code, Cursor, OpenCode, Codex, Claude Desktop, Windsurf, Zed or Cline. See [Supported clients](supported-clients.md).
- Windows, macOS or Linux.

You don't need to install a browser. Web MCP uses **Chrome for Testing**, a Chromium build made for automation. It is downloaded into `~/.cache/puppeteer` when Web MCP is installed, and you can (re)download it at any time with `web-mcp install-browser`. Web MCP runs it with its own profile, so your normal Chrome or Edge is never touched.

## Step 1: Install

```bash
npm install -g @amitnarw/web-mcp
```

The browser download happens during install and can take a minute. If it was skipped or failed (for example with `--ignore-scripts`), run:

```bash
web-mcp install-browser
```

You can also skip the global install and use npx for every command, for example `npx @amitnarw/web-mcp setup`. Your AI client always starts Web MCP through `npx` anyway (see step 2).

## Step 2: Connect your AI client

```bash
web-mcp setup
```

Pick your AI client from the list with the arrow keys and press Enter. This needs a real terminal (it is an interactive menu). You can also name the client directly, which works anywhere, including in scripts:

```bash
web-mcp setup cursor        # or: claude-code, claude-desktop, opencode, openai-codex, zed, windsurf, cody, antigravity, cline
```

Setup adds a `web-mcp` entry to your client's MCP configuration that starts:

```text
npx -y @amitnarw/web-mcp@0.2.0 mcp
```

The version is pinned to the one you have installed, so the client never silently picks up a different release. Re-run `web-mcp setup` after every upgrade to move the pin. The exact file and snippet for each client are in [Supported clients](supported-clients.md).

Then **restart your AI client** so it loads the new MCP server.

To check that it worked:

```bash
web-mcp test      # shows which clients are configured, and flags outdated pins
web-mcp status    # shows the server, the browser and connected agents
```

## Step 3: Ask your AI

Ask for something that needs a browser, for example:

> Go to example.com and tell me what the page says.

> Go to google.com and search for OpenCode.

The first request takes a little longer: Web MCP starts its local server and launches the browser. If you run several chats, you can ask each one to name itself so you can tell them apart:

> Call browser_start with agentName "Research" before you start.

## What you will see

- **A browser window** opens. The AI works in a tab of its own. The first tab an AI opens comes to the front; later tabs open in the background. Pop-ups and links the AI's page opens in a new tab become the AI's tabs too.
- **An overlay on the AI's tab** while it is working. The page is dimmed, an animated border glows in the AI's color, and a bar at the bottom shows the AI's name and what kind of thing it is doing ("clicking...", "typing...", "reading page..."). Your mouse, scroll wheel and keyboard are blocked on that tab so you don't collide with the AI. Clicking the dimmed page reminds you that you can halt it. The bar has two buttons: one opens the side panel, the other halts this AI.
- **A small badge** in the bottom-right corner of the AI's tab once it is idle or halted, for example `Claude Code #1 · idle`. Click it to open the side panel.
- **The side panel**. Open it from the overlay bar, from the badge, or from the Web MCP icon in the browser toolbar (it may be under the puzzle-piece Extensions menu) → **Open side panel**. It lists every connected AI with its name, client, status, task, tabs and recent actions, and has **Halt** / **Resume** buttons and a **Halt all** button.

Your own tabs in that browser are never blocked. More detail is in [Several AIs at once](multi-agent.md).

## When the AI is finished

AI clients are told to call `browser_done` when they finish a request. That removes the overlay and hands the tab back to you. The tab stays open, and the next browser request picks up where it left off.

If the AI doesn't use the browser for 90 seconds, its overlay is released automatically.

## Logging in to websites

The Web MCP browser has its own profile, so it starts logged out of everything. To let the AI use a site you're logged in to:

```bash
web-mcp browser
```

This starts the server and the Web MCP browser (it opens example.com). Log in to the sites you need in that window. Every AI using Web MCP shares this profile, so they can all use those logins. If you want an AI to stay logged out, ask it to open an isolated tab (see [isolated tabs](multi-agent.md#isolated-tabs)).

## How to stop

| You want to... | Do this |
|----------------|---------|
| Stop one AI right now | Click the stop button on its overlay bar, or **Halt** on its card in the side panel. It stays halted until you press **Resume**, even if it tries `browser_stop`. |
| Stop every AI | **Halt all** in the side panel or in the toolbar popup. |
| End one AI's browser session | Ask it to call `browser_stop`. That closes the tabs it opened. The browser keeps running for everyone else. |
| Shut everything down | Close your AI chats, then run `web-mcp stop`. It stops the local server, Web MCP's `chrome-devtools-mcp` helpers and the Web MCP browser. |

The server and the browser keep running after your chats end, until you run `web-mcp stop`. If AI chats are still open when you run it, they start the local server again within about 15 seconds. The browser comes back only when one of them uses it again.

Closing an AI chat removes that AI from the side panel but leaves its tabs open. If you close the browser while a chat is still running, the chat's next browser request reports that its tabs are gone, and the request after that opens the browser again.

## Next steps

- [Several AIs at once](multi-agent.md): tabs, names, Halt/Resume, isolated tabs.
- [Tools reference](tools-reference.md): everything the AI can do in the browser.
- [Configuration](configuration.md): ports, URL blocking, turning off JavaScript evaluation.
- [Troubleshooting](troubleshooting.md): if something doesn't work.
