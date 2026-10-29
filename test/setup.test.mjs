// Run after compiling: node --test test/setup.test.mjs
// Uses throw-away home directories; never touches the real ~/.web-mcp or client
// configs, never runs the real `claude` CLI, and never calls a stop/kill helper.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "web-mcp-test-home-"));
const WEB_MCP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "web-mcp-test-data-"));

// Must be set BEFORE importing setup.js (paths are resolved at import / call time).
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.APPDATA = path.join(HOME, "AppData", "Roaming");
process.env.WEB_MCP_HOME = WEB_MCP_HOME;
assert.equal(os.homedir(), HOME, "os.homedir() must point at the temp home");

const setup = await import("../dist/cli/setup.js");
// Pure helpers only — nothing in stop.js runs at import time.
const { isLegacyServerCommandLine } = await import("../dist/cli/stop.js");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const SPEC = `@amitnarw/web-mcp@${VERSION}`;
const IS_WIN = process.platform === "win32";
const CLAUDE_LAUNCH = IS_WIN ? ["cmd", "/c", "npx", "-y", SPEC, "mcp"] : ["npx", "-y", SPEC, "mcp"];

after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(WEB_MCP_HOME, { recursive: true, force: true });
});

const stripAnsi = (lines) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

/** Runs fn with an empty PATH so the real `claude` CLI can never be found/spawned. */
async function withoutPath(fn) {
  const saved = process.env.PATH;
  process.env.PATH = "";
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

function freshDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const cursorDir = path.join(HOME, ".cursor");
const cursorFile = path.join(cursorDir, "mcp.json");
const codexDir = path.join(HOME, ".codex");
const tomlFile = path.join(codexDir, "config.toml");

// ─── TOML helpers ────────────────────────────────────────────────────────

test("insertTomlTopLevelKey inserts before the first table, after top-level keys", () => {
  const input = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n';
  assert.equal(
    setup.insertTomlTopLevelKey(input, "model_instructions_file", '"/p/i.md"'),
    'model = "o3"\nmodel_instructions_file = "/p/i.md"\n\n[mcp_servers.other]\ncommand = "x"\n'
  );
});

test("insertTomlTopLevelKey keeps comments attached to the first header", () => {
  const input = "# my servers\n[mcp_servers.other]\ncommand = \"x\"\n";
  assert.equal(
    setup.insertTomlTopLevelKey(input, "k", '"v"'),
    'k = "v"\n\n# my servers\n[mcp_servers.other]\ncommand = "x"\n'
  );
});

test("insertTomlTopLevelKey appends when there are no tables, handles empty input", () => {
  assert.equal(setup.insertTomlTopLevelKey('a = 1\n\n', "k", '"v"'), 'a = 1\nk = "v"\n');
  assert.equal(setup.insertTomlTopLevelKey("", "k", '"v"'), 'k = "v"\n');
});

test("insertTomlTopLevelKey ignores brackets inside multi-line arrays and strings", () => {
  const input = 'arr = [\n  ["a"]\n]\ns = """\n[not.a.table]\n"""\n[real]\nx = 1\n';
  const out = setup.insertTomlTopLevelKey(input, "k", '"v"');
  assert.equal(out, 'arr = [\n  ["a"]\n]\ns = """\n[not.a.table]\n"""\nk = "v"\n\n[real]\nx = 1\n');
});

test("insertTomlTopLevelKey leaves an existing top-level key alone, but not one inside a table", () => {
  const top = 'k = "mine"\n[t]\nx = 1\n';
  assert.equal(setup.insertTomlTopLevelKey(top, "k", '"v"'), top);
  assert.equal(setup.hasTomlTopLevelKey(top, "k"), true);

  const inTable = '[t]\nk = "nested"\n';
  assert.equal(setup.hasTomlTopLevelKey(inTable, "k"), false);
  assert.equal(setup.insertTomlTopLevelKey(inTable, "k", '"v"'), 'k = "v"\n\n[t]\nk = "nested"\n');
});

test("insertTomlTopLevelKey preserves CRLF line endings", () => {
  const input = 'a = 1\r\n\r\n[t]\r\nx = 1\r\n';
  assert.equal(setup.insertTomlTopLevelKey(input, "k", '"v"'), 'a = 1\r\nk = "v"\r\n\r\n[t]\r\nx = 1\r\n');
});

test("removeCodexWebMcp cleans up the 0.1.6 layout (instructions key stuck inside the table)", () => {
  const legacy =
    'model = "o3"\n\n[mcp_servers.web-mcp]\ncommand = "npx"\nargs = ["-y", "@amitnarw/web-mcp", "mcp"]\n\n' +
    'model_instructions_file = "C:/Users/x/.codex/web-mcp-instructions.md"\n';
  assert.equal(setup.removeCodexWebMcp(legacy), 'model = "o3"\n');
});

test("removeCodexWebMcp removes sub-tables and keeps neighbours and their comments", () => {
  const input =
    'model_instructions_file = "/home/x/.codex/web-mcp-instructions.md"\n' +
    'model = "o3"\n\n' +
    '[mcp_servers.web-mcp]\ncommand = "npx"\n\n[mcp_servers.web-mcp.env]\nFOO = "1"\n\n' +
    "# the other server\n[mcp_servers.other]\ncommand = \"y\"\n";
  assert.equal(setup.removeCodexWebMcp(input), 'model = "o3"\n\n# the other server\n[mcp_servers.other]\ncommand = "y"\n');
});

test("removeCodexWebMcp keeps a user's own model_instructions_file and is a no-op without web-mcp", () => {
  const input = 'model_instructions_file = "/home/x/mine.md"\n[mcp_servers.other]\ncommand = "y"\n';
  assert.equal(setup.removeCodexWebMcp(input), input);
  assert.equal(setup.hasCodexWebMcp(input), false);
});

test("applyCodexWebMcp fixes a 0.1.6 config, pins the spec and is idempotent", () => {
  const legacy =
    'model = "o3"\n\n[mcp_servers.other]\ncommand = "y"\n\n[mcp_servers.web-mcp]\ncommand = "npx"\n' +
    'args = ["-y", "@amitnarw/web-mcp", "mcp"]\n\nmodel_instructions_file = "/h/.codex/web-mcp-instructions.md"\n';
  const once = setup.applyCodexWebMcp(legacy, SPEC, "/h/.codex/web-mcp-instructions.md");
  assert.equal(once.instructionsWired, true);
  assert.equal(once.unsupported, null);
  assert.equal(
    once.content,
    'model = "o3"\nmodel_instructions_file = "/h/.codex/web-mcp-instructions.md"\n\n[mcp_servers.other]\ncommand = "y"\n\n' +
      `[mcp_servers.web-mcp]\ncommand = "npx"\nargs = ["-y", "${SPEC}", "mcp"]\n`
  );
  assert.equal(setup.applyCodexWebMcp(once.content, SPEC, "/h/.codex/web-mcp-instructions.md").content, once.content);

  const own = setup.applyCodexWebMcp('model_instructions_file = "/mine.md"\n', SPEC, "/h/i.md");
  assert.equal(own.instructionsWired, false);
  assert.match(own.content, /^model_instructions_file = "\/mine\.md"\n\n\[mcp_servers\.web-mcp\]/);
});

test("applyCodexWebMcp re-setup replaces only command/args and keeps other keys and the env sub-table", () => {
  const input =
    'model = "o3"\nmodel_instructions_file = "/h/web-mcp-instructions.md"\n\n' +
    '[mcp_servers.web-mcp]\ncommand = "node"\nargs = [\n  "-y",\n  "@amitnarw/web-mcp@0.0.1", # old\n  "mcp",\n]\nstartup_timeout_sec = 30\n\n' +
    '[mcp_servers.web-mcp.env]\nWEB_MCP_AGENT_NAME = "codex"\n';
  const out = setup.applyCodexWebMcp(input, SPEC, "/h/web-mcp-instructions.md");
  assert.equal(
    out.content,
    'model = "o3"\nmodel_instructions_file = "/h/web-mcp-instructions.md"\n\n' +
      `[mcp_servers.web-mcp]\ncommand = "npx"\nargs = ["-y", "${SPEC}", "mcp"]\nstartup_timeout_sec = 30\n\n` +
      '[mcp_servers.web-mcp.env]\nWEB_MCP_AGENT_NAME = "codex"\n'
  );

  // A table without command/args gets them right below its header.
  const bare = setup.applyCodexWebMcp('[mcp_servers.web-mcp]\nenabled = true\n', SPEC, "/i.md").content;
  assert.ok(bare.endsWith(`[mcp_servers.web-mcp]\ncommand = "npx"\nargs = ["-y", "${SPEC}", "mcp"]\nenabled = true\n`), bare);
});

test("codexUnsupportedForm flags inline/dotted/array forms and leaves them untouched", () => {
  const unsupported = [
    'mcp_servers = { other = { command = "x" } }\n',
    '[mcp_servers]\nweb-mcp = { command = "npx", args = ["@amitnarw/web-mcp"] }\n',
    '[mcp_servers]\n"web-mcp".command = "npx"\n',
    'mcp_servers.web-mcp.command = "npx"\n',
    '[[mcp_servers]]\nname = "x"\n',
  ];
  for (const input of unsupported) {
    assert.ok(setup.codexUnsupportedForm(input), input);
    const r = setup.applyCodexWebMcp(input, SPEC, "/i.md");
    assert.ok(r.unsupported);
    assert.equal(r.content, input);
  }
  // A [mcp_servers] table holding other servers is fine: web-mcp becomes a sub-table.
  const fine = '[mcp_servers]\nother = { command = "x" }\n';
  assert.equal(setup.codexUnsupportedForm(fine), null);
  assert.match(setup.applyCodexWebMcp(fine, SPEC, "/i.md").content, /\[mcp_servers\.web-mcp\]\ncommand = "npx"/);
});

// ─── Package spec / pins ─────────────────────────────────────────────────

test("packageSpec is pinned to the package version; pins are classified incl. newer", () => {
  assert.equal(setup.packageSpec(), SPEC);
  assert.deepEqual(setup.parsePackageSpec("@amitnarw/web-mcp"), { matches: true, version: null });
  assert.deepEqual(setup.parsePackageSpec("@amitnarw/web-mcp@0.1.6"), { matches: true, version: "0.1.6" });
  assert.equal(setup.parsePackageSpec("@amitnarw/web-mcp-other").matches, false);
  assert.equal(setup.pinStateFor(["-y", "@amitnarw/web-mcp", "mcp"], "0.2.0").pin, "unpinned");
  assert.equal(setup.pinStateFor(["-y", "@amitnarw/web-mcp@0.1.6", "mcp"], "0.2.0").pin, "outdated");
  assert.equal(setup.pinStateFor(["-y", "@amitnarw/web-mcp@0.2.0", "mcp"], "0.2.0").pin, "current");
  assert.equal(setup.pinStateFor(["-y", "@amitnarw/web-mcp@0.10.0", "mcp"], "0.2.0").pin, "newer");
  assert.equal(setup.pinStateFor(["-y", "@amitnarw/web-mcp@0.2.0-beta.1", "mcp"], "0.2.0").pin, "outdated");
  assert.equal(setup.pinStateFor(["-y", "@amitnarw/web-mcp@next", "mcp"], "0.2.0").pin, "outdated");
  assert.equal(setup.compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10"), -1);
  assert.equal(setup.compareVersions("1.0.0", "1.0.0-rc.1"), 1);
});

// ─── Claude Code CLI args (pure) ─────────────────────────────────────────

test("buildClaudeMcpAddArgs carries env vars as -e KEY=VALUE and skips unsafe ones", () => {
  const env = { WEB_MCP_AGENT_NAME: "my-agent", EMPTY: "", "1BAD": "x", SPACED: "a b", WINPATH: "C:\\Users\\x", QUOTE: 'a"b', NUM: 5 };
  const linux = setup.buildClaudeMcpAddArgs(SPEC, env, "linux");
  assert.deepEqual(linux.args, [
    "mcp", "add", "--scope", "user", "web-mcp", "-e", "WEB_MCP_AGENT_NAME=my-agent", "-e", "EMPTY=",
    "--", "npx", "-y", SPEC, "mcp",
  ]);
  assert.deepEqual(linux.skipped, ["1BAD", "SPACED", "WINPATH", "QUOTE", "NUM"]);
  const win = setup.buildClaudeMcpAddArgs(SPEC, {}, "win32");
  assert.deepEqual(win.args, ["mcp", "add", "--scope", "user", "web-mcp", "--", "cmd", "/c", "npx", "-y", SPEC, "mcp"]);
  assert.deepEqual(win.skipped, []);
});

test("isLegacyServerCommandLine only matches web-mcp coordination servers", () => {
  assert.equal(isLegacyServerCommandLine('"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\a1\\node_modules\\@amitnarw\\web-mcp\\dist\\server\\server.min.js'), true);
  assert.equal(isLegacyServerCommandLine("node /opt/app/dist/server/server.min.js"), true);
  assert.equal(isLegacyServerCommandLine("node /home/x/other-app/server.js"), false);
  assert.equal(isLegacyServerCommandLine("node C:\\x\\@amitnarw\\web-mcp\\dist\\mcp\\wrapper.min.js"), false);
  assert.equal(isLegacyServerCommandLine(""), false);
});

// ─── configureClient: JSON clients ───────────────────────────────────────

test("an unparseable client config is left untouched and an error is returned", async () => {
  freshDir(cursorDir);
  const corrupt = '{\n  // my servers\n  "mcpServers": { "other": { "command": "x" } },\n}\n';
  fs.writeFileSync(cursorFile, corrupt);

  const lines = await setup.configureClient("cursor");
  const plain = stripAnsi(lines).join("\n");

  assert.equal(lines.ok, false);
  assert.equal(fs.readFileSync(cursorFile, "utf8"), corrupt, "file must be byte-for-byte unchanged");
  assert.equal(fs.existsSync(cursorFile + ".web-mcp.bak"), false, "nothing may be written, not even a backup");
  assert.deepEqual(fs.readdirSync(cursorDir), ["mcp.json"], "no temp files left behind");
  assert.ok(lines.some((l) => l.includes("\x1b[31m") && l.includes("Could not parse")), "red error line expected");
  assert.match(plain, /left untouched/);
  assert.ok(plain.includes(SPEC), "manual snippet with the pinned spec expected");

  const report = stripAnsi(await setup.testConfigurations());
  assert.match(report.find((l) => l.startsWith("Cursor")), /Cannot verify/);
});

test("happy path: writes the pinned spec, keeps other servers, creates the backup once", async () => {
  freshDir(cursorDir);
  const original = JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }, null, 2) + "\n";
  fs.writeFileSync(cursorFile, original);

  const result = await setup.configureClient("cursor");
  assert.equal(result.ok, true);
  assert.ok(stripAnsi(result).some((l) => l.includes("Successfully added web-mcp")), result.join("\n"));

  const written = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(written.mcpServers["web-mcp"], { type: "stdio", command: "npx", args: ["-y", SPEC, "mcp"] });
  assert.deepEqual(written.mcpServers.other, { command: "x" });
  assert.equal(written.theme, "dark");
  assert.equal(fs.readFileSync(cursorFile + ".web-mcp.bak", "utf8"), original);
  assert.ok(fs.existsSync(path.join(WEB_MCP_HOME, "config.json")), "web-mcp config created in WEB_MCP_HOME");

  // An outdated pin is detected and re-running setup updates it without touching the first backup.
  written.mcpServers["web-mcp"].args = ["-y", "@amitnarw/web-mcp@0.0.1", "mcp"];
  written.mcpServers["web-mcp"].env = { FOO: "1" };
  fs.writeFileSync(cursorFile, JSON.stringify(written, null, 2));
  const details = setup.getConfiguredClientDetails().find((c) => c.client === "cursor");
  assert.equal(details.pin, "outdated");
  assert.equal(details.version, "0.0.1");
  const report = stripAnsi(await setup.testConfigurations()).find((l) => l.startsWith("Cursor"));
  assert.match(report, /outdated pin \(v0\.0\.1/);

  await setup.configureClient("cursor");
  const updated = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(updated.mcpServers["web-mcp"].args, ["-y", SPEC, "mcp"]);
  assert.deepEqual(updated.mcpServers["web-mcp"].env, { FOO: "1" }, "user env is preserved");
  assert.equal(fs.readFileSync(cursorFile + ".web-mcp.bak", "utf8"), original, "backup is never overwritten");
  assert.equal(setup.getConfiguredClientDetails().find((c) => c.client === "cursor").pin, "current");

  // Unpinned specs are still accepted as configured.
  updated.mcpServers["web-mcp"].args = ["-y", "@amitnarw/web-mcp", "mcp"];
  fs.writeFileSync(cursorFile, JSON.stringify(updated, null, 2));
  assert.equal(setup.getConfiguredClientDetails().find((c) => c.client === "cursor").pin, "unpinned");
  assert.ok(setup.getConfiguredClients().includes("cursor"));

  // Uninstall removes only our entry.
  const un = await setup.uninstallClient("cursor");
  assert.equal(un.ok, true);
  const afterUninstall = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.equal(afterUninstall.mcpServers["web-mcp"], undefined);
  assert.deepEqual(afterUninstall.mcpServers.other, { command: "x" });
});

test("a pin newer than this CLI is never downgraded", async () => {
  freshDir(cursorDir);
  const newer = JSON.stringify({ mcpServers: { "web-mcp": { command: "npx", args: ["-y", "@amitnarw/web-mcp@99.0.0", "mcp"] } } }, null, 2);
  fs.writeFileSync(cursorFile, newer);
  const lines = await setup.configureClient("cursor");
  assert.equal(lines.ok, true);
  assert.equal(fs.readFileSync(cursorFile, "utf8"), newer);
  assert.ok(lines.some((l) => l.includes("\x1b[33m") && l.includes("newer")), lines.join("\n"));
  assert.equal(setup.getConfiguredClientDetails().find((c) => c.client === "cursor").pin, "newer");
  assert.doesNotMatch(stripAnsi(await setup.testConfigurations()).find((l) => l.startsWith("Cursor")), /outdated/);
});

test("JSON writes keep the file's BOM, CRLF line endings and indentation", async () => {
  freshDir(cursorDir);
  const raw = '\uFEFF{\r\n\t"mcpServers": {\r\n\t\t"other": {\r\n\t\t\t"command": "x"\r\n\t\t}\r\n\t}\r\n}\r\n';
  fs.writeFileSync(cursorFile, raw);
  assert.equal((await setup.configureClient("cursor")).ok, true);
  const out = fs.readFileSync(cursorFile, "utf8");
  assert.ok(out.startsWith('\uFEFF{\r\n\t"mcpServers": {\r\n\t\t"other"'), JSON.stringify(out.slice(0, 40)));
  assert.equal(/[^\r]\n/.test(out), false, "only CRLF line endings");
  assert.ok(out.endsWith("}\r\n"));
  assert.deepEqual(JSON.parse(out.slice(1)).mcpServers["web-mcp"].args, ["-y", SPEC, "mcp"]);
});

test("uninstall does not create a backup that still contains web-mcp", async () => {
  freshDir(cursorDir);
  fs.writeFileSync(cursorFile, JSON.stringify({ mcpServers: { "web-mcp": { command: "npx", args: ["-y", SPEC, "mcp"] } } }));
  const un = await setup.uninstallClient("cursor");
  assert.equal(un.ok, true);
  assert.equal(fs.existsSync(cursorFile + ".web-mcp.bak"), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(cursorFile, "utf8")), { mcpServers: {} });
});

test("a symlinked config is written through, the link is kept", async (t) => {
  freshDir(cursorDir);
  const realDir = freshDir(path.join(HOME, "dotfiles"));
  const real = path.join(realDir, "cursor-mcp.json");
  fs.writeFileSync(real, "{}\n");
  try {
    fs.symlinkSync(real, cursorFile, "file");
  } catch (err) {
    t.skip(`cannot create symlinks here (${err.code})`);
    return;
  }
  assert.equal((await setup.configureClient("cursor")).ok, true);
  assert.ok(fs.lstatSync(cursorFile).isSymbolicLink(), "symlink must survive");
  assert.deepEqual(JSON.parse(fs.readFileSync(real, "utf8")).mcpServers["web-mcp"].args, ["-y", SPEC, "mcp"]);
  fs.rmSync(cursorFile);
});

test("a broken entry makes testConfigurations report ok:false", async () => {
  freshDir(cursorDir);
  fs.writeFileSync(cursorFile, JSON.stringify({ mcpServers: { "web-mcp": { command: "bogus" } } }));
  const report = await setup.testConfigurations();
  assert.equal(report.ok, false);
  assert.match(stripAnsi(report).find((l) => l.startsWith("Cursor")), /Broken/);
  fs.rmSync(cursorDir, { recursive: true, force: true });
});

test("zed config goes to %APPDATA%\\Zed on Windows and ~/.config/zed elsewhere (incl. macOS)", async () => {
  const expected = IS_WIN ? path.join(process.env.APPDATA, "Zed", "settings.json") : path.join(HOME, ".config", "zed", "settings.json");
  assert.equal((await setup.configureClient("zed")).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(expected, "utf8")).context_servers["web-mcp"].args, ["-y", SPEC, "mcp"]);
  assert.ok(setup.getConfiguredClients().includes("zed"));
  assert.equal((await setup.uninstallClient("zed")).ok, true);
  assert.equal(setup.getConfiguredClients().includes("zed"), false);
});

test("chatgpt is reported as not supported; unknown clients fail", async () => {
  const chat = stripAnsi(await setup.configureClient("chatgpt")).join("\n");
  assert.match(chat, /Not supported/);
  assert.doesNotMatch(chat, /ngrok|proxy URL/i);
  assert.equal((await setup.configureClient("not-a-client")).ok, false);
  assert.equal((await setup.uninstallClient("not-a-client")).ok, false);
});

// ─── Claude Code (JSON fallback; PATH emptied so the real CLI is never used) ───

test("claude-code JSON fallback: corrupt ~/.claude.json is untouched, valid one keeps all state", async () => {
  const claudeJson = path.join(HOME, ".claude.json");
  await withoutPath(async () => {
    fs.writeFileSync(claudeJson, '{"projects": {"/x": {}}, ');
    const lines = await setup.configureClient("claude-code");
    assert.equal(lines.ok, false);
    assert.equal(fs.readFileSync(claudeJson, "utf8"), '{"projects": {"/x": {}}, ');
    assert.ok(stripAnsi(lines).some((l) => l.includes("claude mcp add --scope user web-mcp -- " + CLAUDE_LAUNCH.join(" "))));

    const state = { numStartups: 42, projects: { "/x": { allowedTools: ["a"] } }, oauthAccount: { id: "u" } };
    fs.writeFileSync(claudeJson, JSON.stringify(state));
    assert.equal((await setup.configureClient("claude-code")).ok, true);
    const written = JSON.parse(fs.readFileSync(claudeJson, "utf8"));
    assert.deepEqual({ ...written, mcpServers: undefined }, { ...state, mcpServers: undefined });
    assert.deepEqual([written.mcpServers["web-mcp"].command, ...written.mcpServers["web-mcp"].args], CLAUDE_LAUNCH);
    assert.equal(fs.existsSync(path.join(HOME, ".claude", "settings.json")), false, "never writes ~/.claude/settings.json");
    assert.ok(setup.getConfiguredClients().includes("claude-code"), "cmd /c npx form is recognised");

    // Re-running setup keeps the user's env on the entry and updates the pin.
    written.mcpServers["web-mcp"] = { type: "stdio", command: "npx", args: ["-y", "@amitnarw/web-mcp@0.0.1", "mcp"], env: { WEB_MCP_AGENT_NAME: "claude" } };
    fs.writeFileSync(claudeJson, JSON.stringify(written));
    await setup.configureClient("claude-code");
    const again = JSON.parse(fs.readFileSync(claudeJson, "utf8")).mcpServers["web-mcp"];
    assert.deepEqual(again.env, { WEB_MCP_AGENT_NAME: "claude" });
    assert.deepEqual([again.command, ...again.args], CLAUDE_LAUNCH);
  });
});

// ─── OpenAI Codex ────────────────────────────────────────────────────────

test("openai-codex: configure writes a top-level instructions key; uninstall removes it and the file", async () => {
  freshDir(codexDir);
  const original = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "y"\n';
  fs.writeFileSync(tomlFile, original);

  assert.equal((await setup.configureClient("openai-codex")).ok, true);
  const configured = fs.readFileSync(tomlFile, "utf8");
  const instructions = path.join(codexDir, "web-mcp-instructions.md");
  assert.ok(fs.existsSync(instructions));
  assert.ok(configured.indexOf("model_instructions_file") < configured.indexOf("[mcp_servers.other]"));
  assert.ok(configured.includes(`args = ["-y", "${SPEC}", "mcp"]`));
  assert.equal(fs.readFileSync(tomlFile + ".web-mcp.bak", "utf8"), original);
  assert.ok(setup.getConfiguredClients().includes("openai-codex"));

  // Re-setup keeps user keys and the env sub-table of the web-mcp table.
  fs.writeFileSync(
    tomlFile,
    configured.replace(`args = ["-y", "${SPEC}", "mcp"]`, 'args = ["-y", "@amitnarw/web-mcp@0.0.1", "mcp"]\nstartup_timeout_sec = 30') +
      '\n[mcp_servers.web-mcp.env]\nWEB_MCP_AGENT_NAME = "codex"\n'
  );
  assert.equal((await setup.configureClient("openai-codex")).ok, true);
  const resetup = fs.readFileSync(tomlFile, "utf8");
  assert.ok(resetup.includes(`args = ["-y", "${SPEC}", "mcp"]\nstartup_timeout_sec = 30`), resetup);
  assert.ok(resetup.includes('[mcp_servers.web-mcp.env]\nWEB_MCP_AGENT_NAME = "codex"'), resetup);

  assert.equal((await setup.uninstallClient("openai-codex")).ok, true);
  assert.equal(fs.readFileSync(tomlFile, "utf8"), original);
  assert.equal(fs.existsSync(instructions), false);
});

test("openai-codex: unsupported TOML forms are left untouched by setup, test and uninstall", async () => {
  freshDir(codexDir);
  const inline = '[mcp_servers]\nweb-mcp = { command = "npx", args = ["-y", "@amitnarw/web-mcp", "mcp"] }\n';
  fs.writeFileSync(tomlFile, inline);

  const lines = await setup.configureClient("openai-codex");
  assert.equal(lines.ok, false);
  assert.equal(fs.readFileSync(tomlFile, "utf8"), inline);
  assert.ok(stripAnsi(lines).join("\n").includes(`args = ["-y", "${SPEC}", "mcp"]`), "manual snippet expected");
  assert.deepEqual(fs.readdirSync(codexDir), ["config.toml"], "nothing else written");

  assert.match(stripAnsi(await setup.testConfigurations()).find((l) => l.startsWith("OpenAI Codex")), /Cannot verify/);

  const un = await setup.uninstallClient("openai-codex");
  assert.equal(un.ok, false);
  assert.equal(fs.readFileSync(tomlFile, "utf8"), inline);
  fs.rmSync(codexDir, { recursive: true, force: true });
});

// ─── Uninstall all / local data ──────────────────────────────────────────

test('uninstall "all" refuses without confirmation and changes nothing', async () => {
  freshDir(cursorDir);
  const cfg = JSON.stringify({ mcpServers: { "web-mcp": { command: "npx", args: ["-y", SPEC, "mcp"] } } });
  fs.writeFileSync(cursorFile, cfg);
  const lines = await setup.uninstallClient("all");
  assert.equal(lines.ok, false);
  assert.match(stripAnsi(lines).join("\n"), /--yes/);
  assert.equal(fs.readFileSync(cursorFile, "utf8"), cfg);
  assert.ok(fs.existsSync(WEB_MCP_HOME));
  assert.equal(setup.UNINSTALL_OPTIONS[0].value === "all", false, "'all' is not the first menu item");
  assert.equal(setup.UNINSTALL_OPTIONS.at(-1).value, "cancel");
});

test("removeLocalWebMcpData deletes only known entries and keeps a non-empty home", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "web-mcp-test-wipe-"));
  for (const f of ["config.json", "auth-token", "server.pid", "chrome-stderr.log", "chrome-launch.lock", "debug-env-dump.json", "config.json.2026-01-01T00-00-00-000Z.bak"]) {
    fs.writeFileSync(path.join(home, f), "x");
  }
  for (const d of ["logs", "recordings", "extension", "helpers", "chrome-profile", path.join("chromium-profile-v2", "Default")]) {
    fs.mkdirSync(path.join(home, d), { recursive: true });
  }
  fs.writeFileSync(path.join(home, "my-notes.txt"), "keep me");

  const r = setup.removeLocalWebMcpData(home);
  assert.deepEqual(fs.readdirSync(home), ["my-notes.txt"]);
  assert.equal(r.profileRemoved, true);
  assert.equal(r.homeRemoved, false);
  assert.deepEqual(r.kept.map((k) => path.basename(k)), ["my-notes.txt"]);
  assert.deepEqual(r.failed, []);

  fs.rmSync(path.join(home, "my-notes.txt"));
  assert.equal(setup.removeLocalWebMcpData(home).homeRemoved, true);
  assert.equal(fs.existsSync(home), false);
});
