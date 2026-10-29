# Several AIs at once

Since 0.2.0, several AI chats can use the Web MCP browser at the same time — two Claude Code chats, a Cursor window, OpenCode with another model, Codex, and so on. Each chat works in its own tabs, and you can see and stop each one separately.

## What an "agent" is

Every AI client process that starts Web MCP is one **agent**. Each Claude Code chat, Cursor window or OpenCode session that uses Web MCP starts its own `web-mcp mcp` process, so each one is its own agent.

All agents share **one** browser (one Chromium window and profile) and **one** local coordination server. An agent exists from its first browser tool call until its chat ends or it goes silent too long. Up to 64 agents can be connected at once.

## Each agent only uses its own tabs

An agent can only see and control tabs **it opened itself**: with `browser_navigate` (which opens a tab when the agent has none), with `browser_new_tab`, or by opening a pop-up or `target="_blank"` link from its own page. Those new tabs become the agent's tabs too.

It can't list, read or click in your tabs or in other agents' tabs. Web MCP removes other tabs from every tool result before the AI sees them, so their URLs and titles never reach it. If an AI tries to use a tab that isn't its own, it gets:

> ERROR: Tab 7 is not one of your tabs. You can only use tabs you opened …

Each agent's first tab comes to the front. Later tabs open in the background, so agents don't keep stealing focus. One agent's tool calls run one at a time; different agents run in parallel.

Tab numbers are per agent. Two agents can both have a "tab 2" that are actually different browser tabs.

## Names and colors

Each agent gets a name and a color, shown in the overlay, on the badge, in the side panel and in `web-mcp status`.

**Default names** come from the client and a counter: `Claude Code #1`, `Cursor #1`, `OpenCode #1`, and so on. Recognised clients: Claude Code, Claude Desktop, Cursor, OpenCode, Codex, Windsurf, Zed and Cline. Any other client shows the name it reports, or `Agent` if it reports none.

**The AI can name itself** with `browser_start`:

```json
{ "agentName": "Claude – flight search", "taskName": "Compare flights to Lisbon" }
```

`agentName` is up to 60 characters; `taskName` up to 120. You can simply ask: "Call browser_start with agentName 'Research' before you begin."

**Or set a name in your client's MCP config** with `WEB_MCP_AGENT_NAME`. Every chat from that config gets the same name (different colors). An `agentName` passed to `browser_start` overrides it. See [Supported clients](supported-clients.md) for the exact snippet per client.

**Colors** are assigned in order: blue, green, orange, purple, pink, light blue, yellow, brown — then they repeat.

## The overlay

While an agent is active, its tabs show the overlay: the page dims, an animated border glows in the agent's color, and a bar at the bottom shows the agent's name and what it's doing ("clicking…", "typing…", "navigating…"). Your mouse clicks, right-clicks, scrolling, touch and keyboard input are blocked on those tabs, so you and the AI don't collide. The AI's own clicks and key presses still get through, including Enter to submit a form.

- The overlay appears on **every tab of an active agent**, nowhere else. Other tabs of the same agent say "working in another tab".
- Your own tabs, and tabs of idle or halted agents, are never blocked.
- When idle or halted, tabs show a small badge instead (`Research · idle`, `Research · halted`). Click it to open the side panel.
- The overlay only shows the agent's name, color and action type — never the task, URLs or typed text.
- It sits in the browser's top layer and comes back if a page removes it. Screenshots the AI takes don't include it.
- After `browser_hover`, mouse input passes through until the agent's next action, so hovered menus stay open.

The overlay does **not** appear on isolated tabs, `about:blank` or `data:` pages, `chrome://` pages, or non-HTML pages (PDFs, raw XML).

The overlay prevents accidents; it isn't a security boundary. If keyboard focus is inside an embedded frame (an `<iframe>`, like a payment widget), your typing there isn't blocked.

## The side panel

Open it from the overlay bar's side-panel button, from a badge, or from the Web MCP toolbar icon → **Open side panel**. It shows:

- a **Live / Offline** indicator for the local server connection,
- a **Halt all** button,
- one **card per agent**: color dot, name, client name and version, agent id, status pill (`active`, `idle` or `halted`), task name, the agent's tabs (click one to switch to it), its last 8 actions, and a **Halt** or **Resume** button,
- **Show Debug Logs**: recent server log lines.

The action list shows up to the first 30 characters of what the agent typed. For password-like fields it shows only the length: `Typing (12 chars)`. This text lives only in memory and is never written to disk.

The toolbar popup is a smaller version: connection status, agent count, **Open side panel** and **Halt all agents**.

If the side panel says the tokens differ, or another program is answering on the server port, see [Troubleshooting](troubleshooting.md#the-side-panel-says-token-mismatch-or-another-program-is-answering).

## Halt and Resume

Stop an agent at any time:

- **On its tab**: the stop button on the overlay bar, then confirm **Halt agent**.
- **In the side panel**: **Halt** on the agent's card.
- **Everyone**: **Halt all** in the side panel or popup, then confirm.

A halt is **sticky**. The agent stays halted until you press **Resume** on its card. While halted, its browser tools fail and `browser_stop` is refused, so an agent can't end its session to get around a halt.

A halt survives server restarts and laptop sleep: when the agent reconnects, it is halted again. Other agents keep running. **Halt all** halts agents that exist at that moment, not ones that connect later.

## `browser_done` vs `browser_stop`

| | `browser_done` | `browser_stop` |
|---|---|---|
| When | After finishing your request | When completely done with the browser |
| Overlay | Released | Gone |
| The agent's tabs | Stay open | Closed |
| The agent | Stays registered; next call makes it active again | Removed from the side panel; next call registers it again |

Neither closes the browser or affects other agents. To shut everything down, run `web-mcp stop`.

## Isolated tabs

`browser_new_tab` with `isolated: true` opens a tab in a separate browser context, with its own cookies and storage:

- It doesn't see the logins saved in the Web MCP profile, and anything it logs in to stays out of the profile.
- Isolated tabs of one agent share cookies with each other, but not with other agents or the normal profile.
- They get **no overlay** and no input blocking, and the side panel lists them as `not linked`.

Use isolated tabs to test a site logged out, or to keep an agent away from your logged-in sessions.

## Idle and stale agents

- **Idle**: an active agent quiet for **90 seconds** (`agents.idleTimeoutMs`) becomes idle and its overlay releases. Its next tool call makes it active again.
- **Stale**: each Web MCP process heartbeats every 15 seconds. An agent the server hasn't heard from for **60 seconds** (`agents.staleAfterMs`, at least 45 seconds) is removed — for example when a client crashed without saying goodbye.
- **Sleep**: if the computer was asleep or the clock jumped, the server restarts these timers instead of removing everyone.
- **Coming back**: a removed agent whose chat is still running reconnects as the same agent — same id, name, color and halt state — as long as the server hasn't restarted and it's within 30 minutes. After a server restart it reconnects as a new agent, and a halt is re-applied.
- **Chat closed**: when a client exits normally, its agent is removed right away.

Removed agents' tabs stay open but belong to no one: no overlay, and no AI can use them. Close them yourself, or ask the agent to call `browser_stop` before you close the chat. If the agent did anything, a redacted record is saved in `~/.web-mcp/recordings` (see [Privacy](privacy.md)).

The timeouts can be changed in [Configuration](configuration.md).

## Limitations

- An agent can't take over a tab you opened yourself. It always opens its own tab. To work on a site you're logged in to, it opens a new tab in the same profile and uses your login from there.
- All agents share the profile's logins unless they use isolated tabs. Any agent can use any site you're logged in to in the Web MCP browser. Keep sensitive sites out with `security.blockedUrlPatterns` (see [Configuration](configuration.md)).
- Everything shares one browser: same window size, downloads folder and extensions.
- All clients must speak the same protocol. A 0.1.x client and a 0.2.0 client can't share a browser. Pin every client to the same version with `web-mcp setup`. See [Upgrading](upgrading.md).

## Example: two chats side by side

1. In Claude Code: "Call browser_start with agentName 'Research', then find the opening hours of the three nearest libraries."
2. In Cursor at the same time: "Call browser_start with agentName 'Form', then open http://localhost:3000/signup and fill in the form with test data."

Each opens its own tab. Both tabs show an overlay in a different color, and both cards appear in the side panel. If "Form" starts doing something you didn't want, press **Halt** on its card. "Research" carries on. Press **Resume** when you're ready, and tell the Cursor chat to continue.
