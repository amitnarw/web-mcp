# Web MCP

Web MCP is a tool that lets AI agents control a real web browser on your computer. Think of it like giving your AI assistant the ability to open a browser, go to websites, click buttons, fill out forms, and read what is on the page.

It works with AI tools like OpenCode, Cursor, Claude Code, and many others. When you ask your AI to "go to google.com and search for something", Web MCP opens an actual Chromium browser window and does it right in front of you.

![Web MCP in Action](https://raw.githubusercontent.com/amitnarw/web-mcp/main/assets/demo.png)

---

## What you can do with it

- **Ask your AI to browse the web** — Your AI can navigate to any website, search for things, click on links, and scroll through pages. You can watch it happen in real time.

- **Automate repetitive tasks** — Fill out forms, log in to websites, check dashboards, download reports. Your AI does the clicking and typing for you.

- **Test your website or app** — Ask your AI to go through the checkout flow, check a specific page, or run through common user actions. Useful for quick testing without writing code.

- **Extract information from websites** — Your AI can visit a page, read the content, and summarize it for you. Great for research, price checking, or monitoring.

- **Manage your accounts** — Check your inbox, look at your analytics dashboard, review orders. The AI reads what is on the screen and tells you what you need to know.

- **Run multi-step workflows** — Chain together several browser actions. For example: go to a site, log in, navigate to a report page, download data, and save it. All from one command.

---

## Several AIs at once (new in 0.2.0)

You can have several AI chats use the browser at the same time: two Claude Code chats, Cursor, OpenCode with a different model, Codex, and so on. Each chat is its own **agent**:

- Every agent works in **its own tabs**. It cannot see, list or control your tabs or another agent's tabs.
- The overlay that blocks your mouse and keyboard appears **only on the tabs of an agent that is working**. Your other tabs stay usable.
- The **side panel** lists every agent with its name, task, tabs and recent actions. **Halt** stops one agent (or all of them) and stays in effect until you press **Resume**.
- Agents can name themselves (`browser_start` with `agentName`, e.g. "Claude – flight search") so you can tell them apart. You can also set `WEB_MCP_AGENT_NAME` in a client's MCP config.
- `browser_new_tab` with `isolated: true` gives an agent a private cookie jar. It then can't use the logins saved in the Web MCP browser, and you won't see the overlay in that tab.

---

## Quick start

### 1. Install

```bash
npm install -g @amitnarw/web-mcp
```

You need Node.js 22.12 or newer. The install automatically downloads a dedicated Chromium browser (Chrome for Testing), which takes about a minute. If that download was skipped, run `web-mcp install-browser`.

### 2. Run setup

```bash
web-mcp setup
```

Pick your AI tool from the list, or name it directly (for example `web-mcp setup cursor`). This adds Web MCP to the configuration your AI client reads. Restart the client afterwards.

### 3. Ask your AI

Once setup is done, just ask your AI something like:

> "Go to google.com and search for OpenCode"

Web MCP will launch the browser, do the task, and show you what is happening.

---

## Privacy

Web MCP runs locally:

- The browser runs on your computer. Pages the AI reads (text and screenshots) are sent to **your AI provider** as part of the conversation, the same as anything else you share with it.
- Web MCP has no telemetry. Usage statistics and update checks in the bundled `chrome-devtools-mcp` are switched off.
- The local control server only listens on `127.0.0.1`, requires a secret token (`~/.web-mcp/auth-token`) and has to prove it knows that token before Web MCP talks to it, so websites, other devices on your network and other programs on the port can't read or control it.
- What is stored on disk, in `~/.web-mcp`:
  - The Web MCP browser profile, including any logins you make in it.
  - Logs and per-agent action recordings. Text the AI types is stored only as "Typing (12 chars)", never the text itself, and web addresses are stored without their query strings.
- Upgrading from 0.1.x deletes `~/.web-mcp/debug-env-dump.json` and the old logs. Older versions wrote your full environment to that file, including any API keys. If you used 0.1.x, rotate those keys.

Settings live in `~/.web-mcp/config.json`. Set `"security": { "allowEvaluate": false }` to hide the run-JavaScript tool, and use `"blockedUrlPatterns": ["*://mybank.com/*", "*://*.mybank.com/*"]` to keep agents off sites entirely.

---

## Supported AI clients

Web MCP works with these tools: OpenCode, Cursor, Claude Desktop, Claude Code (CLI), Windsurf, Zed Editor, Sourcegraph Cody, OpenAI Codex, Cline, and Antigravity IDE. Any other MCP client that can start a local (stdio) server works too.

`web-mcp setup` configures each one for you. ChatGPT Desktop is not supported: it only connects to servers on the internet, and exposing a logged-in browser that way isn't safe. See [Supported clients](docs/supported-clients.md).

---

## Full documentation

- [Getting started](docs/getting-started.md): install, set up, first task, how to stop.
- [Several AIs at once](docs/multi-agent.md): own tabs, names, colors, Halt/Resume, isolated tabs.
- [Supported clients](docs/supported-clients.md): config file locations and snippets per AI client.
- [Tools reference](docs/tools-reference.md): every browser tool and its parameters.
- [Configuration](docs/configuration.md): `config.json` settings, environment variables, stored files.
- [Use cases](docs/use-cases.md): example requests.
- [Troubleshooting](docs/troubleshooting.md): error messages and fixes.
- [Upgrading from 0.1.x](docs/upgrading.md): what changed and how to upgrade (includes rotating API keys).
- [Security](docs/security.md) and [Privacy](docs/privacy.md).
- [Architecture](docs/architecture.md) and [Contributing](docs/contributing.md): for people working on Web MCP.
- [Changelog](docs/CHANGELOG.md) and [Roadmap](docs/roadmap.md).

Reading this on npm? The docs are at [github.com/amitnarw/web-mcp/tree/main/docs](https://github.com/amitnarw/web-mcp/tree/main/docs).

---

## Credits

Built and maintained by Amit Narwal.

- Website: [amitnarwal.com](https://amitnarwal.com)
- Email: amitnarwal115@gmail.com
