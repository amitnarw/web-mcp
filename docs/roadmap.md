# Roadmap

What has shipped, and what we are thinking about. The ideas are things we are exploring, not promises.

## Shipped in 0.2.0

- **Several AIs at once (multi-agent tabs).** Every AI chat is its own agent with its own tabs, color and overlay. A side panel lists all agents. See [Several AIs at once](multi-agent.md).
- **Per-agent Halt / Resume.** Halts are sticky until you resume, even across restarts. **Halt all** stops everyone.
- **Isolated tabs.** A separate cookie jar per agent, on request.
- **Security hardening.** A loopback-only server that requires a token and proves its identity, no CORS, redacted logs, a blocked DevTools port, scoped cleanup, pinned client configs, a locked dependency tree, and telemetry off. See [Security](security.md).
- **Scriptable CLI.** `web-mcp setup <client>`, `web-mcp uninstall <client>`, `web-mcp install-browser`, and exit codes.
- **Clearer error messages.** Most startup failures now say what went wrong and which setting or command fixes it. See [Troubleshooting](troubleshooting.md).

## Partly done

- **Session recording.** 0.2.0 saves a redacted action log per agent in `~/.web-mcp/recordings` (what it did and when, with typed text reduced to a character count). There is no way to review or play it back in the UI yet.
- **Human in the loop.** You can halt any agent at any time, and it stays halted until you resume. There is no automatic pause before sensitive actions yet.

## Ideas under consideration

Roughly in order of priority. New ideas get added to the right group.

### Higher priority: safety and everyday use

1. **Stronger protection against prompt injection.** Clearer boundaries between what you asked for and what a web page says, so text on a page is less likely to steer the AI.
2. **Per-site rules and approvals.** For each site, choose *allow*, *ask first* or *block*, and have the agent ask you before risky actions such as payments, sending messages or deleting things.
3. **"Please take over" handoff.** When the agent hits a login, a CAPTCHA or a two-factor prompt, it asks you to step in, then continues when you're done, instead of getting stuck.
4. **Share an existing tab with an agent.** Hand a tab you already have open to a specific agent, instead of the agent always opening its own.
5. **Block keyboard input inside embedded frames.** Today, typing into an `<iframe>` (for example a payment widget) on an agent's tab isn't blocked.
6. **Overlay in a closed shadow root.** Make the overlay harder for web pages to see or tamper with.

### Medium priority: more capable and cheaper agents

7. **Richer input.** Fill a whole form in one step, tick checkboxes, right-click, and wait until text disappears or the URL changes.
8. **Token-efficient reading.** Screenshot a single element, find text on a page, or save page content to a file instead of pasting it all into the chat.
9. **Console and network inspection**, limited to the agent's own tabs, with sensitive headers (cookies, authorization) hidden.
10. **File upload with guardrails.** Only from folders you allow, with a confirmation step, and never secret files.
11. **Per-agent timeline.** Review what each agent did, step by step, building on the existing recordings.
12. **Export login state from isolated tabs**, so a logged-in isolated session can be saved and reused.

### Later

13. **Device and dark-mode emulation**: see a page as it looks on a phone, or in dark mode.
14. **Developer audits**: Lighthouse reports and performance traces of the agent's tabs.
15. **Natural language task planning**: plan and run multi-step tasks from one high-level instruction.
16. **Workflow automation**: save and replay common browser workflows.
17. **Scheduled tasks**: run browser tasks on a timer, like daily reports or monitoring.
18. **Test generation**: describe a test in plain English and let the AI generate and run it.
19. **Cross-browser support**: Firefox and Edge in addition to Chromium.
20. **Cloud-optional architecture**: a version that can run in the cloud for teams, next to the local-only version.
21. **More supported AI clients** as new tools come out, and **performance improvements** (faster startup, less memory).

## Open decisions

Questions for the maintainer: whether the bot-detection flag should become opt-in, whether to soften the "no cheating" navigation rule, verifying three clients' config paths, removing ChatGPT Desktop from setup, adding CI and dependency updates, and a license. Details and known limitations are in the [security audit](security-audit.md#part-4-open-decisions-for-the-maintainer).

## Privacy remains a priority

Web MCP keeps running locally, with no telemetry of its own. What your AI reads still goes to your AI provider, as explained in [Privacy](privacy.md).

## Suggestions

If you have ideas or feature requests, email amitnarwal115@gmail.com.
