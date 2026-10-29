# Contributing

Want to help? Fork it, break it, fix it — whatever you want. Web MCP is MIT-licensed and open to contributions.

## Quick start for contributors

Read [Architecture](docs/architecture.md) first — it explains how the server, browser and extension fit together. Then:

```bash
npm install
npm run build && npm run bundle
npm test          # unit tests
node scripts/e2e-multi-agent.mjs   # live checks against a real browser
```

Ground rules are at [docs/contributing.md](docs/contributing.md#ground-rules) — they keep the 0.2.0 guarantees intact (no typed text persisted, no unverified token sends, minimal extension permissions, no process kills by port).

## Opening an issue or PR

- **Bug reports**: use the issue templates in `.github/ISSUE_TEMPLATE/` so we get repro steps, versions and your OS.
- **Feature requests**: open an issue first to discuss before writing code.
- **Big changes**: open an issue first, then submit a PR when there's agreement.

Pull requests are welcome on `main`. Run the unit tests and the end-to-end script before asking for review.

Email: amitnarwal115@gmail.com
