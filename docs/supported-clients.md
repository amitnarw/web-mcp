# Supported AI clients

Web MCP works with any AI client that can start a local MCP server over stdio. `web-mcp setup` can configure the clients below for you. For anything else, see [Manual setup](#manual-setup).

## How setup works

Run `web-mcp setup` (or `web-mcp` → **Configure AI Client (Setup)**) and pick a client. Clients that are already configured have a `[✓]` next to them. To skip the menu, name the client:

```bash
web-mcp setup <client>
```

`<client>` is one of `opencode`, `claude-desktop`, `claude-code`, `cursor`, `windsurf`, `zed`, `cody`, `openai-codex`, `antigravity`, `cline`, `chatgpt` or `manual`. An unknown name exits with code 2 and lists the valid ones.

Setup then:

- **Adds a `web-mcp` entry** that runs `npx -y @amitnarw/web-mcp@<version> mcp`. The version is **pinned** to the Web MCP you ran setup from (examples on this page use `0.2.0`). Re-running setup after an upgrade moves the pin.
- **Never downgrades.** If the entry is pinned to a *newer* version than the one running setup, it is left alone, and setup tells you to run that version's setup instead (`npx -y @amitnarw/web-mcp@<newer> setup <client>`).
- **Backs up the file** the first time it changes an existing config, to `<file>.web-mcp.bak`. That first backup is never overwritten, so it stays your pre-Web MCP original.
- **Refuses to rewrite a file it can't parse**, for example a JSON file with comments. It leaves the file untouched and prints the snippet for you to paste by hand.
- **Keeps your environment variables** on re-runs: the `env` or `environment` block of a JSON entry, the other keys and sub-tables of the Codex table, and the `env` of a Claude Code entry (see below).
- **Keeps the file's formatting**: byte order mark, line endings and indentation. If the config file is a symbolic link (for example into a dotfiles repository), it writes the file the link points to and keeps the link.
- Writes atomically (temporary file, then rename), so a crash can't leave a half-written config.

**Restart the AI client afterwards.** Then check with:

```bash
web-mcp test     # per client: Working, outdated pin, pinned to newer, unpinned, broken, or not added
web-mcp status   # also lists configured clients and warns about outdated pins
```

`web-mcp test` exits with code 1 if any client's entry is broken.

## Clients at a glance

| Client | Config file setup writes | Key |
|--------|--------------------------|-----|
| OpenCode | `~/.config/opencode/opencode.json` | `mcp` |
| Claude Desktop | Windows `%APPDATA%\Claude\claude_desktop_config.json`<br>macOS `~/Library/Application Support/Claude/claude_desktop_config.json`<br>Linux `~/.config/Claude/claude_desktop_config.json` | `mcpServers` |
| Claude Code (CLI) | `claude mcp add --scope user …` if `claude` is on your PATH, otherwise `~/.claude.json` | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| Windsurf (Codeium) | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| Zed Editor | Windows `%APPDATA%\Zed\settings.json`<br>macOS and Linux `~/.config/zed/settings.json` | `context_servers` |
| Sourcegraph Cody | VS Code global storage: `…/Code/User/globalStorage/sourcegraph.cody-ai/mcp_servers.json` (under `%APPDATA%` on Windows, `~/Library/Application Support` on macOS, `~/.config` on Linux) | `mcpServers` |
| OpenAI Codex | `~/.codex/config.toml` (plus `~/.codex/web-mcp-instructions.md`) | `[mcp_servers.web-mcp]` |
| Antigravity IDE | `~/.gemini/antigravity/mcp_config.json` | `mcpServers` |
| Cline | `~/.cline/data/settings/cline_mcp_settings.json` | `mcpServers` |
| ChatGPT Desktop | **Not supported** (see [below](#chatgpt-desktop)) | — |

`~` is your home folder (`%USERPROFILE%` on Windows). These are the locations setup knows about. If your client reads its MCP settings from somewhere else (its settings screen usually shows the file), paste the snippet there instead.

`web-mcp test` and `status` also recognise entries that older versions wrote: `~/.opencode.json` for OpenCode, and `~/Library/Application Support/Zed/settings.json` for Zed on macOS.

## Snippets setup writes

### Cursor, Claude Desktop, Windsurf, Cody, Antigravity, Cline

```json
{
  "mcpServers": {
    "web-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@amitnarw/web-mcp@0.2.0", "mcp"]
    }
  }
}
```

Setup merges this into your existing file. Other servers and settings are kept.

### Claude Code (CLI)

If the `claude` command is on your PATH, setup removes any existing `web-mcp` entry and adds it again at user scope. Environment variables of the old entry are carried over as `-e KEY=VALUE`.

macOS and Linux:

```bash
claude mcp add --scope user web-mcp -- npx -y @amitnarw/web-mcp@0.2.0 mcp
```

Windows (Claude Code on native Windows can't start `npx` directly, so it goes through `cmd /c`):

```bash
claude mcp add --scope user web-mcp -- cmd /c npx -y @amitnarw/web-mcp@0.2.0 mcp
```

With an environment variable, for example: `claude mcp add --scope user web-mcp -e WEB_MCP_AGENT_NAME=Claude -- npx -y @amitnarw/web-mcp@0.2.0 mcp`. Setup only carries over variables whose name and value consist of letters, digits and `@._/:=+-`. It warns about any it had to skip.

If `claude` isn't found, or the command fails, setup edits `~/.claude.json` instead (top-level `mcpServers`):

```json
{
  "mcpServers": {
    "web-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@amitnarw/web-mcp@0.2.0", "mcp"]
    }
  }
}
```

On Windows, `command` is `"cmd"` and `args` is `["/c", "npx", "-y", "@amitnarw/web-mcp@0.2.0", "mcp"]`.

Claude Code rewrites `~/.claude.json` while it is running. If the entry disappears, quit Claude Code and run setup again.

### OpenCode

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "web-mcp": {
      "type": "local",
      "command": ["npx", "-y", "@amitnarw/web-mcp@0.2.0", "mcp"],
      "enabled": true
    }
  }
}
```

`$schema` is added only if your file doesn't have one.

### Zed

```json
{
  "context_servers": {
    "web-mcp": {
      "command": "npx",
      "args": ["-y", "@amitnarw/web-mcp@0.2.0", "mcp"]
    }
  }
}
```

Zed's `settings.json` often contains comments. If it does, setup won't touch it and prints this snippet instead.

### OpenAI Codex

Setup writes `~/.codex/web-mcp-instructions.md`, which tells Codex to use the Web MCP tools instead of its built-in browser, and updates `~/.codex/config.toml`:

```toml
model_instructions_file = "/home/you/.codex/web-mcp-instructions.md"

[mcp_servers.web-mcp]
command = "npx"
args = ["-y", "@amitnarw/web-mcp@0.2.0", "mcp"]
```

- `model_instructions_file` goes at the top level of the file, before the first `[table]`. If you already have your own `model_instructions_file`, setup keeps yours and tells you to copy the instructions into it.
- On a re-run, only the `command` and `args` lines of an existing `[mcp_servers.web-mcp]` table are replaced. Other keys, and sub-tables such as `[mcp_servers.web-mcp.env]`, stay. Everything else in the file stays byte for byte.
- If the file defines MCP servers in a form setup doesn't edit (an inline table, dotted keys such as `mcp_servers.web-mcp.command = …`, or `[[mcp_servers]]` arrays), setup, test and uninstall leave it untouched and tell you what to change by hand.
- After setup, reload the Codex VS Code extension (**Developer: Reload Window**).

### ChatGPT Desktop

**Not supported.** ChatGPT only connects to remote MCP servers over the internet. Web MCP controls a browser that is logged in to your accounts, so exposing it through a public tunnel or proxy would let anyone who finds the URL use those sessions. `web-mcp setup chatgpt` just prints this explanation. Use a local client instead.

## Manual setup

For any other MCP client, add a stdio server that runs:

```text
command: npx
args:    -y @amitnarw/web-mcp@0.2.0 mcp
```

In the common `mcpServers` JSON format, that is the [snippet above](#cursor-claude-desktop-windsurf-cody-antigravity-cline). `web-mcp setup manual` (**Other (Manual Setup)** in the menu) prints it, along with the OpenCode form.

Notes:

- If Web MCP is installed globally, `"command": "web-mcp", "args": ["mcp"]` works too, but then the client always runs whatever version is installed globally.
- To name the agents a client starts, add `WEB_MCP_AGENT_NAME` to the entry's environment. See [Names and colors](multi-agent.md#names-and-colors).
- The first start downloads the pinned package into the npx cache, and that can take a while. If your client gives up waiting for MCP servers, run `npx -y @amitnarw/web-mcp@0.2.0 help` once in a terminal to warm the cache. Run `npx -y @amitnarw/web-mcp@0.2.0 install-browser` if the browser is missing.
- To run Web MCP from a source checkout, see [Contributing](contributing.md#use-your-build-in-an-ai-client).

## Removing Web MCP from a client

```bash
web-mcp uninstall <client>       # one client, e.g. web-mcp uninstall cursor
web-mcp uninstall all --yes      # every client, plus all local Web MCP data
web-mcp uninstall                # menu
```

- Uninstall removes only the `web-mcp` entry. For Claude Code it uses `claude mcp remove` when it can, and also cleans `~/.claude/settings.json` from older versions. For Codex, it removes the table and the instructions file.
- It doesn't create new backups (a backup would still contain the entry).
- A file it can't parse is left untouched, and the command exits with code 1 and tells you to remove the entry by hand.

**`uninstall all`** asks for confirmation: `--yes` on the command line, or `y` at the menu's `(y/N)` prompt. It stops Web MCP (server, helpers, browser), removes the entry from every client, and deletes Web MCP's own files in `~/.web-mcp`, **including the Web MCP browser profile and its logins**. Files it didn't create are left alone. See [Configuration](configuration.md#files-web-mcp-stores).

To remove the CLI itself: `npm uninstall -g @amitnarw/web-mcp`.
