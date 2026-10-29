# Several AIs at once

Since 0.2.0, several AI chats can use the Web MCP browser at the same time: two Claude Code chats, a Cursor window, OpenCode with a different model, Codex, and so on. Each one works in its own tabs, and you can see and stop each one separately.

## What an "agent" is

Every AI client process that starts Web MCP is one **agent**. In practice:

- Each Claude Code chat, Cursor window or OpenCode session that uses Web MCP is its own agent, because each one starts its own `web-mcp mcp` process.
- All agents share **one** browser (one Chromium window and profile) and **one** local coordination server.
- An agent exists from its first browser tool call until its chat ends or it goes silent for too long (see [Idle and stale agents](#idle-and-stale-agents)).
- Up to 64 agents can be connected at once.

## Each agent only uses its own tabs

- An agent can only see and control tabs **it opened itself**: with `browser_navigate` (which opens a tab when the agent has none), with `browser_new_tab`, or by doing something on its own page that opens a pop-up or a `target="_blank"` link. Such new tabs become the agent's tabs.
- It can't list, read or click in your tabs or in other agents' tabs. Web MCP removes other tabs from every tool result before the AI sees it, so their URLs and titles never reach the AI.
- If an AI tries to use a tab that isn't its own, it gets: `ERROR: Tab 7 is not one of your tabs. You can only use tabs you opened …`
- Each agent's first tab comes to the front. Its later tabs open in the background, so agents don't keep stealing focus from you or from each other.
- One agent's tool calls run one at a time. Different agents run in parallel.

Tab numbers are per agent. Two agents can both have a "tab 2" that are different browser tabs.

## Names and colors

Each agent gets a name (label) and a color, shown in the overlay, on the badge, in the side panel and in `web-mcp status`.

**Default names** come from the client and a counter, for example `Claude Code #1`, `Claude Code #2`, `Cursor #1`. Recognised clients: Claude Code, Claude Desktop, Cursor, OpenCode, Codex, Windsurf, Zed and Cline. Any other client shows the name it reports, or `Agent` if it reports none. The counter keeps going for as long as the local server runs.

**The AI can name itself** by calling `browser_start`:

```json
{ "agentName": "Claude – flight search", "taskName": "Compare flights to Lisbon" }
```

`agentName` is up to 60 characters and `taskName` up to 120. You can simply ask: "Call browser_start with agentName 'Research' before you begin."

**You can set a name in the client's MCP config** with the `WEB_MCP_AGENT_NAME` environment variable. Every chat started from that config gets the same name (they still get different colors). An `agentName` passed to `browser_start` overrides it.

For most JSON clients (Cursor, Claude Desktop, Windsurf, Cline, Antigravity, Cody, and Claude Code's `~/.claude.json`), add `env` to the entry setup created:

```json
{
  "mcpServers": {
    "web-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@amitnarw/web-mcp@0.2.0", "mcp"],
      "env": { "WEB_MCP_AGENT_NAME": "Cursor – frontend" }
    }
  }
}
```

OpenCode uses `environment` instead of `env`:

```json
{
  "mcp": {
    "web-mcp": {
      "type": "local",
      "command": ["npx", "-y", "@amitnarw/web-mcp@0.2.0", "mcp"],
      "enabled": true,
      "environment": { "WEB_MCP_AGENT_NAME": "OpenCode – tests" }
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.web-mcp]
command = "npx"
args = ["-y", "@amitnarw/web-mcp@0.2.0", "mcp"]

[mcp_servers.web-mcp.env]
WEB_MCP_AGENT_NAME = "Codex"
```

Re-running `web-mcp setup` keeps these variables:

- For JSON clients, it keeps the entry's `env` or `environment` block.
- For Codex, it only replaces `command` and `args`. Other keys and the `env` sub-table stay.
- For Claude Code, it passes them on to `claude mcp add` as `-e KEY=VALUE`. A value with characters that can't be passed safely (spaces, for example) is skipped with a warning, so stick to letters, digits and `@._/:=+-` in names you want to survive re-setup.

**Colors** are assigned in this order, skipping colors already in use: blue `#4b8eff`, green `#34c759`, orange `#ff9f0a`, purple `#bf5af2`, pink `#ff375f`, light blue `#64d2ff`, yellow `#ffd60a`, brown `#ac8e68`. With more than eight agents, colors repeat.

## The overlay

While an agent is **active**, its tabs show the overlay: the page is dimmed, an animated border glows in the agent's color, and a bar at the bottom shows the agent's name and what kind of action it is doing ("clicking...", "typing...", "navigating..."). Your mouse clicks, right-clicks, scrolling, touch and keyboard input are blocked on those tabs, so you and the AI don't get in each other's way. The AI's own clicks and key presses still get through, including Enter to submit a form.

- The overlay appears on **every tab of an active agent**, and nowhere else. Tabs other than the agent's current one say "working in another tab".
- Your own tabs, and the tabs of idle or halted agents, are never blocked.
- When the agent is idle or halted, its tabs show a small badge instead (`Research · idle`, `Research · halted`). Click it to open the side panel.
- The overlay is part of the web page, so the site could read it. That's why it only shows the agent's name, its color and the kind of action. It never shows the task, URLs or typed text.
- The overlay sits in the browser's top layer, above everything on the page, including full-screen elements. If a page removes it, it is put back.
- Screenshots the AI takes don't include the overlay.
- After `browser_hover`, mouse input (yours too) passes through the overlay until the agent's next action, so the hovered menu stays open for the AI to read.

The overlay does **not** appear on:

- isolated tabs (see below),
- `about:blank` and `data:` pages, `chrome://` pages, and other pages where extensions can't run,
- pages that aren't HTML documents (for example PDFs or raw XML).

The overlay is there to prevent accidents, not as a security boundary. In particular, if keyboard focus is inside an embedded frame (an `<iframe>`, such as a payment widget), your typing there isn't blocked.

## The side panel

Open it from the overlay bar's side-panel button, by clicking a badge, or from the Web MCP toolbar icon → **Open side panel**. It shows:

- a **Live / Offline** indicator for the connection to the local server,
- a **Halt all** button,
- one **card per agent**: color dot, name, client name and version, agent id, a status pill (`active`, `idle` or `halted`), the task name, the agent's tabs (click one to switch to it; `not linked` means Web MCP doesn't know which browser tab it is, for example an isolated tab), its last 8 actions, and a **Halt** or **Resume** button,
- **Show Debug Logs**: the server's recent log lines.

The action list shows what the agent typed (up to the first 30 characters), so you can follow along. For fields that look like passwords, PINs, card numbers or one-time codes, it shows only the length, for example `Typing (12 chars)`. This text lives only in memory and is never written to disk.

The toolbar popup is a smaller version: connection status, number of agents and how many are active, **Open side panel** and **Halt all agents**.

If the side panel says the tokens differ, or that another program is answering on the server port, see [Troubleshooting](troubleshooting.md#the-side-panel-says-token-mismatch-or-another-program-is-answering).

## Halt and Resume

You can stop an agent at any time:

- **On its tab**: the stop button on the overlay bar (or the Halt button in the reminder bubble), then confirm **Halt agent**.
- **In the side panel**: **Halt** on the agent's card.
- **Everyone at once**: **Halt all** in the side panel or the popup, then confirm.

A halt is **sticky**. The agent stays halted until you press **Resume** on its card in the side panel. While halted, its browser tools fail with:

```text
ERROR: The user halted this agent ("Research") from the Web MCP browser. Stop now and ask the user how to proceed. Browser tools stay blocked until the user presses Resume for "Research" in the Web MCP side panel.
```

- `browser_stop` is refused while halted too, so an agent can't end its session to get around a halt.
- A halt survives a restart of the local server and laptop sleep: when the agent reconnects, it is halted again.
- Other agents keep running. Halting one agent doesn't affect anyone else.
- **Halt all** halts the agents that exist at that moment, not ones that connect later.
- The halt ends when you press Resume, or when the agent's chat is closed.

## `browser_done` vs `browser_stop`

| | `browser_done` | `browser_stop` |
|---|---|---|
| When the AI should use it | After finishing your request | When it is completely done with the browser |
| Overlay | Released (agent becomes idle) | Gone |
| The agent's tabs | Stay open | Closed |
| The agent | Stays registered. Its next browser tool call makes it active again | Removed from the side panel. Its next browser tool call registers it again, normally with the same id, name and color |
| While halted | Allowed | Refused |
| Shared browser and server | Keep running | Keep running |

Neither one closes the browser or affects other agents. To shut everything down, run `web-mcp stop`.

## Isolated tabs

`browser_new_tab` with `isolated: true` opens a tab in a separate browser context, with its own cookies and storage:

- It doesn't see the logins saved in the Web MCP profile, and anything it logs in to stays out of the profile.
- All isolated tabs of one agent share one context, so they share cookies with each other, but not with other agents or with the normal profile. Pop-ups opened from an isolated tab are isolated too.
- Web MCP doesn't link isolated tabs to the extension, so they get **no overlay** and no input blocking, and the side panel lists them as `not linked`.

Use isolated tabs to test a site logged out, or to keep an agent away from your logged-in sessions.

## Idle and stale agents

- **Idle**: an active agent that hasn't used the browser for **90 seconds** (`agents.idleTimeoutMs`) becomes idle and its overlay is released. Its next tool call makes it active again.
- **Stale**: each Web MCP process sends a heartbeat every 15 seconds. An agent the server hasn't heard from for **60 seconds** (`agents.staleAfterMs`, at least 45 seconds) is removed, for example when a client crashed without saying goodbye.
- **Sleep**: if the computer was asleep (or the clock jumped), the server restarts these timers instead of removing everyone.
- **Coming back**: an agent that was removed but whose chat is still running reconnects as the same agent, with the same id, name, color and halt state, as long as the local server hasn't restarted in the meantime and it is within 30 minutes. After a server restart, it reconnects as a new agent, and a halt is re-applied.
- **Chat closed**: when a client exits normally, its agent is removed right away.

When an agent is removed, its tabs **stay open** but no longer belong to anyone: no overlay, and no AI can use them. Close them yourself, or ask the agent to call `browser_stop` before you close the chat. If the agent did anything, a redacted record of its actions is saved in `~/.web-mcp/recordings` (see [Privacy](privacy.md)).

The timeouts can be changed in [Configuration](configuration.md).

## Limitations

- **An agent can't take over a tab that is already open**, such as one you opened yourself. It always opens its own tab. If you want it to work on a site you're logged in to, it opens a new tab in the same profile and uses your login from there.
- **All agents share the profile's logins**, unless they use isolated tabs. Any agent can use any site you are logged in to in the Web MCP browser. Keep sensitive sites out with `security.blockedUrlPatterns` (see [Configuration](configuration.md)).
- **Everything shares one browser**: same window size, same downloads folder, same extensions.
- **All clients must speak the same protocol.** A 0.1.x client and a 0.2.0 client can't share the browser. The simplest rule is to pin every client to the same version by re-running `web-mcp setup` for each one. See [Upgrading](upgrading.md).

## Example: two chats side by side

1. In Claude Code: "Call browser_start with agentName 'Research', then find the opening hours of the three nearest libraries."
2. In Cursor at the same time: "Call browser_start with agentName 'Form', then open http://localhost:3000/signup and fill in the form with test data."

Each opens its own tab. Both tabs show an overlay in a different color, and both cards appear in the side panel. If "Form" starts doing something you didn't want, press **Halt** on its card. "Research" carries on. Press **Resume** when you're ready, and tell the Cursor chat to continue.
