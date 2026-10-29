# Web MCP

[![npm version](https://img.shields.io/npm/v/@amitnarw/web-mcp)](https://www.npmjs.com/package/@amitnarw/web-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Stars](https://img.shields.io/github/stars/amitnarw/web-mcp)](https://github.com/amitnarw/web-mcp)

Give your AI a real browser. It opens pages, clicks buttons, fills forms and reads results right on your screen while you watch. Use it for whatever you'd use a browser for.

<!-- Promo video goes here once it's ready (paste a YouTube link above the image or replace the image with an embed) -->

![Web MCP in Action](https://raw.githubusercontent.com/amitnarw/web-mcp/main/assets/demo.png)

## What it can do

- **Check its own frontend work** — your AI builds a page, opens it, sees it, fixes it. This is why I built it.
- Automate the boring stuff — forms, logins, dashboards, downloading reports
- Research — "read this page and tell me what matters", price checks, monitoring
- Run several AI chats in one browser, each with its own tabs

## Get started

You need Node.js 22.12 or newer. The install downloads Chromium automatically (about a minute). If it was skipped, run `web-mcp install-browser` afterward.

```bash
npm install -g @amitnarw/web-mcp
web-mcp setup
```

Pick your AI tool from the list (OpenCode, Cursor, Claude Code, Codex, Windsurf, Zed, Cody, Cline, Antigravity or any MCP client), restart your AI client, then ask it to browse:

> "Go to google.com and search for OpenCode"

Done.

## Works with

OpenCode, Cursor, Claude Desktop, Claude Code, Windsurf, Zed Editor, Sourcegraph Cody, OpenAI Codex, Cline, Antigravity IDE — and any other MCP client that can start a local server. ChatGPT Desktop is not supported; connecting it would mean exposing a logged-in browser to the internet, which isn't safe.

`web-mcp setup` configures each one for you.

## Your data stays yours

Web MCP runs locally on your computer. Pages your AI reads are shared with your AI provider, same as anything else you paste into a chat. Web MCP has no telemetry, and the local control server only listens on your machine with a secret token, so other programs and devices on your network can't reach it.

Text the AI types is stored only as "Typing (12 chars)" — never the text itself — and web addresses are saved without their query strings. See [Privacy](docs/privacy.md) for the details.

## Found a bug? Want to help?

This is open source and MIT-licensed. Fork it, break it, fix it — whatever you want.

- Issues: [github.com/amitnarw/web-mcp/issues](https://github.com/amitnarw/web-mcp/issues)
- Pull requests welcome. Start a conversation in an issue first if it's a big change.

License: [MIT](LICENSE)

## Documentation

- [Docs overview](docs/README.md)
- [Getting started](docs/getting-started.md)
- [Several AIs at once](docs/multi-agent.md)
- [Supported clients](docs/supported-clients.md)
- [Tools reference](docs/tools-reference.md)
- [Configuration](docs/configuration.md)
- [Use cases](docs/use-cases.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Upgrading from 0.1.x](docs/upgrading.md)
- [Security](docs/security.md)
- [Security audit](docs/security-audit.md)
- [Privacy](docs/privacy.md)
- [Architecture](docs/architecture.md)
- [Contributing](docs/contributing.md)
- [Changelog](docs/CHANGELOG.md) · [Roadmap](docs/roadmap.md)

Built and maintained by Amit Narwal ([amitnarwal.com](https://amitnarwal.com)).
