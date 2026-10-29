# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.2.0   | ✅        |
| < 0.2.0 | ❌        |

Please upgrade to 0.2.0. It fixes serious issues in 0.1.x (unauthenticated server on all network interfaces, typed text persisted to disk, full environment dumped to a file including API keys). See [docs/upgrading.md](docs/upgrading.md) and [docs/security.md](docs/security.md).

## Reporting a Vulnerability

Please email **amitnarwal115@gmail.com** with:

- what you found and its impact,
- steps to reproduce (versions, operating system, AI client),
- whether it has been shared with anyone else.

Please don't post details publicly until a fix has been released.

You'll receive an acknowledgment within 48 hours and an update on the fix timeline within 7 days.

## What to expect

For confirmed vulnerabilities we will:

- release a fix in the next published version,
- credit you if you'd like to be named,
- keep details private until the fix is out.

Web MCP runs locally on your machine (`127.0.0.1` only) with a secret token (`~/.web-mcp/auth-token`). It does not defend against software already running on your computer with access to the browser's DevTools port. Read the full threat model at [docs/security.md](docs/security.md#threat-model).
