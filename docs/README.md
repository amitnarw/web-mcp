# Web MCP documentation

Web MCP lets your AI assistant (Claude Code, Cursor, OpenCode, Codex and others) use a real, visible browser on your computer. These pages cover version **0.2.0**.

New here? Start with [Getting started](getting-started.md).

## Using Web MCP

| Page | What it covers |
|------|----------------|
| [Getting started](getting-started.md) | Install, connect your AI client, run a first task, and stop everything again. |
| [Several AIs at once](multi-agent.md) | How each AI chat gets its own tabs, colors, overlay, Halt/Resume, and isolated tabs. |
| [Supported clients](supported-clients.md) | Where setup writes the config for each AI client, the exact snippet, and how to set it up by hand. |
| [Tools reference](tools-reference.md) | Every browser tool the AI can call, with its parameters and limits. |
| [Configuration](configuration.md) | Every setting in `~/.web-mcp/config.json`, environment variables, and the files Web MCP keeps on disk. |
| [Use cases](use-cases.md) | Example requests, including several chats working side by side. |
| [Troubleshooting](troubleshooting.md) | Error messages, what causes them, and how to fix them. |
| [Upgrading from 0.1.x](upgrading.md) | What changed in 0.2.0 and the steps to upgrade safely. |

## Security and privacy

| Page | What it covers |
|------|----------------|
| [Security](security.md) | What Web MCP protects against, what it does not, and how to report a vulnerability. |
| [Privacy](privacy.md) | What stays on your computer, what is sent to your AI provider, and what is stored on disk. |
| [Security audit 0.1.6 → 0.2.0](security-audit.md) | Every issue found in 0.1.6 and in the 0.2.0 review, how each was fixed, known limitations, and open decisions. |

## For contributors

| Page | What it covers |
|------|----------------|
| [Architecture](architecture.md) | Components, process lifecycle, tab claiming, the local HTTP API and extension messages. |
| [Contributing](contributing.md) | Build, test and bundle commands, the end-to-end test, reloading the extension, project layout. |

## Project

| Page | What it covers |
|------|----------------|
| [Changelog](CHANGELOG.md) | What changed in each version. |
| [Roadmap](roadmap.md) | What has shipped and ideas under consideration. |
