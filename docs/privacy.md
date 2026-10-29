# Privacy

Web MCP runs on your computer. It has no accounts, no analytics and no telemetry of its own. But using it does send data to some places, and it does keep some files. Here is the full picture for version 0.2.0.

## What leaves your computer

- **Page content goes to your AI provider.** When the AI reads a page (`browser_snapshot`), takes a screenshot, gets a URL, or runs JavaScript, the result goes into the conversation. Your AI client sends the conversation to its provider (Anthropic, OpenAI, Google, or whoever runs your model), the same as anything else you share in that chat. Their privacy terms apply.
- **Websites see normal browser traffic.** The sites the AI visits see an ordinary Chromium-based browser, with the cookies of the Web MCP profile.
- **Downloads.** `npm` and `npx` download Web MCP and its dependencies from the npm registry. Chrome for Testing is downloaded at install time or by `web-mcp install-browser`.
- **The browser itself.** Chrome for Testing may make its own background requests like any Chromium build. Web MCP doesn't change that.

**What Web MCP turns off** in the bundled `chrome-devtools-mcp`: its usage statistics to Google (tool success rates, latency, environment information), its performance lookups in Google's CrUX service, and its update checks against the npm registry.

**What Web MCP doesn't send anywhere:** your logs, recordings, typed text, browsing history or profile. The local server only listens on your own machine (`127.0.0.1`), requires a secret token, and has to prove it knows that token before Web MCP talks to it.

## What is stored on your computer

Everything lives in `~/.web-mcp` (or the folder in `WEB_MCP_HOME`):

| What | Contains | Kept |
|------|----------|------|
| Browser profile (`chromium-profile-v2/`) | Cookies, logins, history and site data of the Web MCP browser | Until you delete it, or run `web-mcp troubleshoot --reset-profile` |
| Server log (`logs/server.log`) | When agents connect and leave, their names and tasks, the addresses they opened (without query strings), and the actions they took | Rotated at 10 MB. A few old files are kept |
| Recordings (`recordings/*.json`) | One file per finished agent: name, client, start and end time, list of actions | The newest 50 (setting: `agents.maxRecordings`) |
| Settings and secrets | `config.json`, `auth-token` (the local server's password) | Until you delete them |
| Extension copy (`extension/`) | The Web MCP browser extension, with the port and token | Refreshed whenever the extension changes |

**Typed text is never stored.** Logs and recordings record typing only as a length, for example `Typing (12 chars)` or `Filling (uid) (8 chars)`. The value of a chosen dropdown option, JavaScript code run by the AI, and text entered into prompt dialogs aren't stored either.

**Web addresses are stored without their query string.** `https://shop.example/search?q=shoes&session=abc` is logged as `https://shop.example/search`, because query strings often carry tokens.

What *is* stored in plain text: the rest of each address, agent and task names, element ids, key names (`Pressing: Enter`), and the start of text the AI waited for (`Waiting for: …`).

**The side panel shows a little more.** While an agent is connected, the side panel's action list shows full addresses and up to the first 30 characters of what it typed, so you can follow along. For fields that look like passwords, PINs, card numbers or one-time codes, it shows only the length. This text is held in memory by the local server only, and disappears when the agent is removed.

**The web page itself** can read the Web MCP overlay, because the overlay is part of the page. It therefore only shows the agent's name and the kind of action ("typing..."), never the task, other addresses or typed text.

**Screenshots** are passed straight to your AI client and aren't saved by Web MCP. The exception: `chrome-devtools-mcp` writes screenshots of 2 MB or more (usually long full-page ones) to a `chrome-devtools-mcp-*` folder in your system temp directory and gives the AI the file path. Those files aren't cleaned up automatically.

## Your regular browser is separate

Web MCP uses its own browser (Chrome for Testing) and its own profile. It never reads or changes your regular Chrome, Edge or Firefox profile, passwords, bookmarks or cookies. Sites you want the AI to use while logged in, you log in to in the Web MCP browser yourself.

All AI chats using Web MCP share that one profile. See [Several AIs at once](multi-agent.md).

## Older versions

Web MCP 0.1.6 and earlier saved your full environment, including API keys, to `~/.web-mcp/debug-env-dump.json`, and their logs and recordings could contain the start of typed text. 0.2.0 deletes those files automatically: the environment dump whenever it finds one, and the old logs and recordings once, on its first run. If you used an older version, read [If you used 0.1.x](security.md#if-you-used-01x).

## Deleting your data

1. Close your AI chats.
2. Run `web-mcp uninstall all --yes`. It stops Web MCP, removes it from your AI clients and deletes its files in `~/.web-mcp`, including the browser profile. Or run `web-mcp stop` and delete the `~/.web-mcp` folder yourself.
3. Optionally delete `~/.cache/puppeteer` (the downloaded browser).

To clear only the logins, run `web-mcp troubleshoot --reset-profile`.

## Questions

Email amitnarwal115@gmail.com.
