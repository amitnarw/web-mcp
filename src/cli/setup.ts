import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";
import { PATHS, loadConfig, readPackageVersion } from "../shared/paths.js";
import { CommandLines, withOk } from "./common.js";

export const PACKAGE_NAME = "@amitnarw/web-mcp";
const BACKUP_SUFFIX = ".web-mcp.bak";
const INSTRUCTIONS_FILE_NAME = "web-mcp-instructions.md";

export const SETUP_OPTIONS = [
  { value: "opencode", label: "OpenCode" },
  { value: "claude-desktop", label: "Claude Desktop" },
  { value: "claude-code", label: "Claude Code (CLI)" },
  { value: "cursor", label: "Cursor" },
  { value: "windsurf", label: "Windsurf (Codeium)" },
  { value: "zed", label: "Zed Editor" },
  { value: "cody", label: "Sourcegraph Cody" },
  { value: "chatgpt", label: "ChatGPT Desktop (OpenAI)" },
  { value: "openai-codex", label: "OpenAI Codex" },
  { value: "antigravity", label: "Antigravity IDE" },
  { value: "cline", label: "Cline" },
  { value: "manual", label: "Other (Manual Setup)" },
  { value: "cancel", label: "Cancel" }
];

// Individual clients first and "all" last (just above Cancel) so the
// destructive option is never the one under the cursor by default.
export const UNINSTALL_OPTIONS = [
  { value: "opencode", label: "OpenCode" },
  { value: "claude-desktop", label: "Claude Desktop" },
  { value: "claude-code", label: "Claude Code (CLI)" },
  { value: "cursor", label: "Cursor" },
  { value: "windsurf", label: "Windsurf (Codeium)" },
  { value: "zed", label: "Zed Editor" },
  { value: "cody", label: "Sourcegraph Cody" },
  { value: "openai-codex", label: "OpenAI Codex" },
  { value: "antigravity", label: "Antigravity IDE" },
  { value: "cline", label: "Cline" },
  { value: "all", label: "Uninstall from ALL clients (also deletes local data and browser logins)" },
  { value: "cancel", label: "Cancel" }
];

/** Values accepted by `web-mcp setup <client>` / `web-mcp uninstall <client>`. */
export const SETUP_CLIENT_VALUES = SETUP_OPTIONS.map(o => o.value).filter(v => v !== "cancel");
export const UNINSTALL_CLIENT_VALUES = UNINSTALL_OPTIONS.map(o => o.value).filter(v => v !== "cancel");

const FILE_CLIENTS = SETUP_OPTIONS.map(o => o.value).filter(v => v !== "manual" && v !== "cancel" && v !== "chatgpt");

function labelFor(client: string): string {
  return SETUP_OPTIONS.find(o => o.value === client)?.label || client;
}

// ─── Package spec / version pinning ──────────────────────────────────────

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function currentVersion(): string | null {
  const v = readPackageVersion();
  return v !== "0.0.0" && SEMVER_RE.test(v) ? v : null;
}

/** Semver precedence: -1 / 0 / 1, or null if either side is not a plain semver. */
export function compareVersions(a: string, b: string): number | null {
  const ma = SEMVER_RE.exec(a);
  const mb = SEMVER_RE.exec(b);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const pa = ma[4] ? ma[4].split(".") : [];
  const pb = mb[4] ? mb[4].split(".") : [];
  if (!pa.length || !pb.length) return pa.length === pb.length ? 0 : pa.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The npx spec written into client configs. Pinned to the installed version so
 * a client never silently runs a different release (with a different
 * protocol) than the one that was set up. Re-running setup updates the pin.
 */
export function packageSpec(version: string | null = currentVersion()): string {
  return version ? `${PACKAGE_NAME}@${version}` : PACKAGE_NAME;
}

export type PinState = "current" | "outdated" | "newer" | "unpinned" | "unknown";

/** Accepts both `@amitnarw/web-mcp` and `@amitnarw/web-mcp@<version>`. */
export function parsePackageSpec(arg: unknown): { matches: boolean; version: string | null } {
  if (typeof arg !== "string") return { matches: false, version: null };
  if (arg === PACKAGE_NAME) return { matches: true, version: null };
  if (arg.startsWith(PACKAGE_NAME + "@")) {
    const v = arg.slice(PACKAGE_NAME.length + 1);
    return { matches: true, version: v && v !== "latest" ? v : null };
  }
  return { matches: false, version: null };
}

/**
 * "newer" = pinned to a release newer than this CLI (never downgraded by
 * setup); non-semver pins (dist-tags, ranges) count as "outdated".
 */
export function pinStateFor(args: unknown[], current: string | null = currentVersion()): { pin: PinState; version: string | null } {
  for (const a of args) {
    const s = parsePackageSpec(a);
    if (!s.matches) continue;
    if (!s.version) return { pin: "unpinned", version: null };
    if (!current) return { pin: "current", version: s.version };
    const cmp = compareVersions(s.version, current);
    if (cmp === 0) return { pin: "current", version: s.version };
    if (cmp !== null && cmp > 0) return { pin: "newer", version: s.version };
    return { pin: "outdated", version: s.version };
  }
  return { pin: "unknown", version: null };
}

function newerPinLines(client: string, file: string, version: string | null): CommandLines {
  const current = currentVersion();
  return withOk([
    `\x1b[33m! web-mcp in ${file} is pinned to v${version}, which is newer than this web-mcp (v${current}).\x1b[0m`,
    "\x1b[33m  Left unchanged (setup never downgrades). To set it up again, run that version's setup:\x1b[0m",
    `  npx -y ${PACKAGE_NAME}@${version} setup ${client}`,
  ], true);
}

// ─── Client config locations ─────────────────────────────────────────────

function getConfigPath(choiceValue: string): string {
  if (choiceValue === "opencode") {
    return path.join(os.homedir(), ".config", "opencode", "opencode.json");
  } else if (choiceValue === "claude-desktop") {
    if (process.platform === "win32") {
      return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    } else if (process.platform === "darwin") {
      return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    } else {
      return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
    }
  } else if (choiceValue === "claude-code") {
    // User-scoped MCP servers live in ~/.claude.json (top-level "mcpServers").
    // ~/.claude/settings.json does NOT hold MCP servers.
    return path.join(os.homedir(), ".claude.json");
  } else if (choiceValue === "cursor") {
    return path.join(os.homedir(), ".cursor", "mcp.json");
  } else if (choiceValue === "windsurf") {
    return path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json");
  } else if (choiceValue === "zed") {
    if (process.platform === "win32") {
      // Zed on Windows uses APPDATA (Roaming), not LOCALAPPDATA
      return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Zed", "settings.json");
    }
    // macOS and Linux both read ~/.config/zed/settings.json
    return path.join(os.homedir(), ".config", "zed", "settings.json");
  } else if (choiceValue === "cody") {
    // Sourcegraph Cody stores MCP config in VS Code's global storage
    if (process.platform === "win32") {
      return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Code", "User", "globalStorage", "sourcegraph.cody-ai", "mcp_servers.json");
    } else if (process.platform === "darwin") {
      return path.join(os.homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "sourcegraph.cody-ai", "mcp_servers.json");
    } else {
      return path.join(os.homedir(), ".config", "Code", "User", "globalStorage", "sourcegraph.cody-ai", "mcp_servers.json");
    }
  } else if (choiceValue === "antigravity") {
    return path.join(os.homedir(), ".gemini", "antigravity", "mcp_config.json");
  } else if (choiceValue === "cline") {
    // Cline IDE extension global MCP settings
    // Cline CLI uses ~/.cline/mcp.json (separate from extension config)
    return path.join(os.homedir(), ".cline", "data", "settings", "cline_mcp_settings.json");
  } else if (choiceValue === "openai-codex") {
    return path.join(os.homedir(), ".codex", "config.toml");
  }
  return "";
}

/** Files checked by test/status (includes locations 0.1.x wrote to). */
function detectionPaths(client: string): string[] {
  if (client === "opencode") return [getConfigPath(client), path.join(os.homedir(), ".opencode.json")];
  if (client === "zed" && process.platform === "darwin") {
    return [getConfigPath(client), path.join(os.homedir(), "Library", "Application Support", "Zed", "settings.json")];
  }
  return [getConfigPath(client)];
}

/** Files cleaned by uninstall. */
function uninstallPaths(client: string): string[] {
  if (client === "claude-code") return [getConfigPath(client), path.join(os.homedir(), ".claude", "settings.json")];
  return detectionPaths(client);
}

// ─── Safe file helpers ───────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Dotfiles are often symlinks into a dotfiles repo: write the target, never replace the link. */
function resolveWriteTarget(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // missing, or a dangling symlink
  }
  try {
    if (fs.lstatSync(p).isSymbolicLink()) return path.resolve(path.dirname(p), fs.readlinkSync(p));
  } catch {
    // does not exist
  }
  return p;
}

/** Temp file + rename so a crash never leaves a half-written client config. Keeps the file mode. */
function writeFileAtomic(p: string, data: string): void {
  const target = resolveWriteTarget(p);
  let mode: number | undefined;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    // new file
  }
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
    // Windows: the target may be briefly locked by the client/antivirus.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, target);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt < 10 && (code === "EPERM" || code === "EACCES" || code === "EBUSY")) {
          sleepSync(100);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/** Copies an existing file to <file>.web-mcp.bak once (the first backup is the pre-web-mcp original). */
function backupOnce(p: string): string | null {
  const bak = p + BACKUP_SUFFIX;
  if (!fs.existsSync(p) || fs.existsSync(bak)) return null;
  fs.copyFileSync(p, bak, fs.constants.COPYFILE_EXCL);
  return bak;
}

type JsonRead =
  | { ok: true; config: Record<string, any>; existed: boolean; raw: string }
  | { ok: false; error: string; raw: string };

/** Never "repairs" a file it cannot parse: callers must refuse to write on ok:false. */
function readJsonConfig(p: string): JsonRead {
  if (!fs.existsSync(p)) return { ok: true, config: {}, existed: false, raw: "" };
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (err) {
    return { ok: false, error: "cannot read the file: " + errMessage(err), raw: "" };
  }
  const text = raw.replace(/^﻿/, "");
  if (text.trim() === "") return { ok: true, config: {}, existed: true, raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: errMessage(err), raw };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: "the top-level value is not a JSON object", raw };
  return { ok: true, config: parsed, existed: true, raw };
}

/** Serializes like the original file: same BOM, line endings, indentation and trailing newline. */
function serializeJsonLike(config: unknown, raw: string): string {
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const m = /\n([ \t]+)\S/.exec(raw);
  const indent: string | number = m ? (m[1].includes("\t") ? "\t" : m[1].length <= 8 ? m[1] : 2) : 2;
  const trailing = raw.trim() === "" || /\n\s*$/.test(raw);
  let out = JSON.stringify(config, null, indent);
  if (eol === "\r\n") out = out.replace(/\n/g, "\r\n"); // JSON.stringify never emits raw newlines inside strings
  return bom + out + (trailing ? eol : "");
}

// ─── Client entries & manual snippets ────────────────────────────────────

// Claude Code on native Windows cannot spawn npx (a .cmd shim) directly; its
// docs require wrapping local npx servers in `cmd /c`.
function claudeCodeLaunch(spec: string, platform: string = process.platform): { command: string; args: string[] } {
  return platform === "win32"
    ? { command: "cmd", args: ["/c", "npx", "-y", spec, "mcp"] }
    : { command: "npx", args: ["-y", spec, "mcp"] };
}

function jsonEntryFor(client: string, spec: string): { container: string; entry: Record<string, unknown> } {
  if (client === "claude-code") {
    return { container: "mcpServers", entry: { type: "stdio", ...claudeCodeLaunch(spec) } };
  }
  if (client === "opencode") {
    // OpenCode uses the 'mcp' key with type: local and command as an array
    return { container: "mcp", entry: { type: "local", command: ["npx", "-y", spec, "mcp"], enabled: true } };
  }
  if (client === "zed") {
    return { container: "context_servers", entry: { command: "npx", args: ["-y", spec, "mcp"] } };
  }
  return { container: "mcpServers", entry: { type: "stdio", command: "npx", args: ["-y", spec, "mcp"] } };
}

export function buildCodexBlock(spec: string, eol = "\n"): string {
  return ["[mcp_servers.web-mcp]", `command = "npx"`, `args = ["-y", ${JSON.stringify(spec)}, "mcp"]`].join(eol) + eol;
}

function manualSnippet(client: string, spec: string): string[] {
  if (client === "openai-codex") {
    return buildCodexBlock(spec).trimEnd().split("\n").map(l => "  " + l);
  }
  const { container, entry } = jsonEntryFor(client, spec);
  const doc: Record<string, unknown> = client === "opencode" ? { $schema: "https://opencode.ai/config.json" } : {};
  doc[container] = { "web-mcp": entry };
  const out = JSON.stringify(doc, null, 2).split("\n").map(l => "  " + l);
  if (client === "claude-code") {
    out.push("");
    out.push("  Or run:");
    out.push(`  claude ${buildClaudeMcpAddArgs(spec, {}).args.join(" ")}`);
  }
  return out;
}

function parseFailureLines(client: string, file: string, error: string, spec: string): CommandLines {
  return withOk([
    `\x1b[31m✗ Could not parse ${file}\x1b[0m`,
    `\x1b[31m  ${error}\x1b[0m`,
    `\x1b[31m  The file was left untouched.\x1b[0m It may contain comments (JSONC) or other non-JSON syntax,`,
    "  so web-mcp will not rewrite it automatically. Add this entry by hand:",
    "",
    ...manualSnippet(client, spec),
  ], false);
}

// ─── TOML helpers (OpenAI Codex config.toml) ─────────────────────────────

interface TomlLine {
  start: number;
  end: number;
  /** The line starts outside any string, array or inline table. */
  safe: boolean;
  /** Key segments if this line is a [table] or [[array-of-tables]] header. */
  header: string[] | null;
  arrayHeader: boolean;
}

function quoteRun(s: string, i: number, q: string): number {
  let n = 0;
  while (s[i + n] === q) n++;
  return Math.min(n, 5); // TOML allows 1-2 quotes right before the closing delimiter
}

/** Splits a (dotted, possibly quoted) TOML key ending at `stop` (or end of text). */
function splitTomlKey(text: string, from: number, stop: string): { parts: string[]; end: number } | null {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let j = from; j < text.length; j++) {
    const c = text[j];
    if (quote) {
      if (quote === '"' && c === "\\") {
        cur += text[j + 1] ?? "";
        j++;
        continue;
      }
      if (c === quote) {
        quote = null;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === stop) {
      parts.push(cur);
      return parts.every(p => p.length > 0) ? { parts, end: j } : null;
    }
    if (c === ".") {
      parts.push(cur);
      cur = "";
      continue;
    }
    if (c === " " || c === "\t" || c === "﻿") continue;
    if (!/[A-Za-z0-9_-]/.test(c)) return null;
    cur += c;
  }
  return null;
}

function parseTomlHeader(text: string): string[] | null {
  const j = text.indexOf("[");
  if (j === -1) return null;
  return splitTomlKey(text, j + (text[j + 1] === "[" ? 2 : 1), "]")?.parts ?? null;
}

/** Key path of a `key = value` line, or null if the line is not an assignment. */
function parseTomlKey(text: string): string[] | null {
  return splitTomlKey(text, 0, "=")?.parts ?? null;
}

/**
 * Minimal line scanner: knows which lines start at top level (outside
 * strings/arrays/inline tables) and which are table headers. Enough to edit
 * config.toml surgically without a TOML dependency.
 */
function scanTomlLines(content: string): TomlLine[] {
  const NORMAL = 0, BASIC = 1, LITERAL = 2, ML_BASIC = 3, ML_LITERAL = 4, COMMENT = 5;
  let state = NORMAL;
  let depth = 0;
  const lines: TomlLine[] = [];
  let i = 0;
  for (;;) {
    const nl = content.indexOf("\n", i);
    const end = nl === -1 ? content.length : nl;
    const line: TomlLine = { start: i, end, safe: state === NORMAL && depth === 0, header: null, arrayHeader: false };
    lines.push(line);
    const text = content.slice(i, end);
    if (line.safe && /^[﻿ \t]*\[/.test(text)) {
      line.header = parseTomlHeader(text);
      line.arrayHeader = /^[﻿ \t]*\[\[/.test(text);
      i = end;
    }
    while (i < end) {
      const ch = content[i];
      if (state === NORMAL) {
        if (ch === "#") {
          state = COMMENT;
          break;
        }
        if (ch === '"') {
          if (content.startsWith('"""', i)) { state = ML_BASIC; i += 3; } else { state = BASIC; i++; }
          continue;
        }
        if (ch === "'") {
          if (content.startsWith("'''", i)) { state = ML_LITERAL; i += 3; } else { state = LITERAL; i++; }
          continue;
        }
        if (ch === "[" || ch === "{") depth++;
        else if (ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
        i++;
      } else if (state === BASIC) {
        if (ch === "\\") { i += 2; continue; }
        if (ch === '"') state = NORMAL;
        i++;
      } else if (state === LITERAL) {
        if (ch === "'") state = NORMAL;
        i++;
      } else if (state === ML_BASIC) {
        if (ch === "\\") { i += 2; continue; }
        if (content.startsWith('"""', i)) { i += quoteRun(content, i, '"'); state = NORMAL; continue; }
        i++;
      } else if (state === ML_LITERAL) {
        if (content.startsWith("'''", i)) { i += quoteRun(content, i, "'"); state = NORMAL; continue; }
        i++;
      } else {
        break;
      }
    }
    // Comments and single-line strings end at the newline.
    if (state === COMMENT || state === BASIC || state === LITERAL) state = NORMAL;
    if (nl === -1) break;
    i = nl + 1;
  }
  return lines;
}

function detectEol(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const isCommentText = (t: string) => /^[﻿ \t]*#/.test(t);
const isBlankText = (t: string) => /^[﻿ \t\r]*$/.test(t);

function isWebMcpHeader(h: string[] | null): boolean {
  return !!h && h.length >= 2 && h[0] === "mcp_servers" && h[1] === "web-mcp";
}

/** Joins kept lines back together, dropping leading blank lines and trailing whitespace. */
function joinKept(content: string, lines: TomlLine[], remove: boolean[]): string {
  if (!remove.some(Boolean)) return content;
  const result = lines
    .filter((_, k) => !remove[k])
    .map(l => content.slice(l.start, l.end))
    .join("\n")
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .replace(/\s+$/, "");
  return result ? result + detectEol(content) : "";
}

/** True if `key` is assigned at the top level (before the first table header). */
export function hasTomlTopLevelKey(content: string, key: string): boolean {
  const k = escapeRegex(key);
  const re = new RegExp(`^[\\uFEFF \\t]*(?:${k}|"${k}"|'${k}')[ \\t]*=`);
  for (const l of scanTomlLines(content)) {
    if (l.header) break;
    if (l.safe && re.test(content.slice(l.start, l.end))) return true;
  }
  return false;
}

/**
 * Inserts `key = valueLiteral` as a top-level key, i.e. BEFORE the first
 * [table] header (appending at the end of the file would put it inside the
 * last table). Returns the content unchanged if the key is already set at top
 * level. `valueLiteral` must already be a TOML literal (e.g. JSON.stringify(str)).
 */
export function insertTomlTopLevelKey(content: string, key: string, valueLiteral: string): string {
  if (hasTomlTopLevelKey(content, key)) return content;
  const eol = detectEol(content);
  const assignment = `${key} = ${valueLiteral}`;
  const lines = scanTomlLines(content);
  const first = lines.findIndex(l => l.header !== null);
  if (first === -1) {
    const body = content.replace(/\s+$/, "");
    return (body ? body + eol : "") + assignment + eol;
  }
  const text = (l: TomlLine) => content.slice(l.start, l.end);
  // Keep comments that are attached to the first header together with it…
  let idx = first;
  while (idx > 0 && lines[idx - 1].safe && isCommentText(text(lines[idx - 1]))) idx--;
  // …and place the key right after the last top-level line.
  let at = idx;
  while (at > 0 && lines[at - 1].safe && isBlankText(text(lines[at - 1]))) at--;
  let offset = lines[at].start;
  if (offset === 0 && content.startsWith("﻿")) offset = 1;
  const insertion = assignment + eol + (at === idx ? eol : "");
  return content.slice(0, offset) + insertion + content.slice(offset);
}

const WEB_MCP_INSTRUCTIONS_LINE =
  /^[﻿ \t]*["']?model_instructions_file["']?[ \t]*=[ \t]*(["'])[^"'\r\n]*web-mcp-instructions\.md\1[ \t]*(?:#.*)?\r?$/;

/**
 * Returns a description if config.toml defines mcp_servers / web-mcp in a form
 * these helpers do not edit (inline tables, dotted keys, arrays of tables).
 * Such files are left untouched.
 */
export function codexUnsupportedForm(content: string): string | null {
  let table: string[] = [];
  for (const l of scanTomlLines(content)) {
    const t = content.slice(l.start, l.end);
    if (l.header) {
      table = l.header;
      if (l.arrayHeader && table[0] === "mcp_servers") return `[[${table.join(".")}]] (array of tables)`;
      continue;
    }
    if (!l.safe || isBlankText(t) || isCommentText(t)) continue;
    const key = parseTomlKey(t);
    if (!key) continue;
    if (table.length === 0 && key[0] === "mcp_servers") return `top-level "${key.join(".")} = …"`;
    if (table.length === 1 && table[0] === "mcp_servers" && key[0] === "web-mcp") return `"${key.join(".")} = …" inside [mcp_servers]`;
  }
  return null;
}

/** True if config.toml has a [mcp_servers.web-mcp] table (or one of its sub-tables). */
export function hasCodexWebMcp(content: string): boolean {
  return scanTomlLines(content).some(l => isWebMcpHeader(l.header));
}

/** Text of the [mcp_servers.web-mcp] table (and its sub-tables), or null. */
function codexWebMcpBlock(content: string): string | null {
  const lines = scanTomlLines(content);
  const k = lines.findIndex(l => isWebMcpHeader(l.header));
  if (k === -1) return null;
  let e = k + 1;
  while (e < lines.length && !(lines[e].header && !isWebMcpHeader(lines[e].header))) e++;
  return content.slice(lines[k].start, e < lines.length ? lines[e].start : content.length);
}

function codexPin(content: string): { pin: PinState; version: string | null } {
  const block = codexWebMcpBlock(content);
  const m = block ? /["']@amitnarw\/web-mcp(?:@([^"'\s]+))?["']/.exec(block) : null;
  return m ? pinStateFor([PACKAGE_NAME + (m[1] ? "@" + m[1] : "")]) : { pin: "unknown", version: null };
}

/** Removes `model_instructions_file` lines pointing at web-mcp-instructions.md, wherever 0.1.x put them. */
function removeWebMcpInstructionLines(content: string): string {
  const lines = scanTomlLines(content);
  const remove = lines.map(l => l.safe && !l.header && WEB_MCP_INSTRUCTIONS_LINE.test(content.slice(l.start, l.end)));
  return joinKept(content, lines, remove);
}

/**
 * Removes the [mcp_servers.web-mcp] table (with sub-tables) and any
 * `model_instructions_file` line pointing at web-mcp-instructions.md.
 * Everything else is preserved byte for byte.
 */
export function removeCodexWebMcp(content: string): string {
  const lines = scanTomlLines(content);
  const text = (l: TomlLine) => content.slice(l.start, l.end);
  const remove = new Array<boolean>(lines.length).fill(false);
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (isWebMcpHeader(l.header)) {
      let e = k + 1;
      while (e < lines.length && !(lines[e].header && !isWebMcpHeader(lines[e].header))) e++;
      if (e < lines.length) {
        // Comments directly above the next header belong to that header.
        while (e - 1 > k && lines[e - 1].safe && isCommentText(text(lines[e - 1]))) e--;
      }
      for (let r = k; r < e; r++) remove[r] = true;
      k = e - 1;
      continue;
    }
    if (l.safe && !l.header && WEB_MCP_INSTRUCTIONS_LINE.test(text(l))) remove[k] = true;
  }
  return joinKept(content, lines, remove);
}

/**
 * Re-setup: replaces only the `command` and `args` assignments of an existing
 * [mcp_servers.web-mcp] table (other keys and sub-tables such as
 * [mcp_servers.web-mcp.env] stay). Returns null if there is no such table.
 */
function updateCodexWebMcpLaunch(content: string, spec: string): string | null {
  const lines = scanTomlLines(content);
  const k = lines.findIndex(l => !l.arrayHeader && l.header?.length === 2 && isWebMcpHeader(l.header));
  if (k === -1) return null;
  const text = (i: number) => content.slice(lines[i].start, lines[i].end);
  let end = k + 1;
  while (end < lines.length && !lines[end].header) end++;

  const spans: Record<string, { from: number; to: number }> = {};
  for (let i = k + 1; i < end; i++) {
    if (!lines[i].safe) continue;
    const key = parseTomlKey(text(i));
    if (!key || key.length !== 1 || (key[0] !== "command" && key[0] !== "args") || spans[key[0]]) continue;
    let j = i + 1;
    while (j < end && !lines[j].safe) j++; // continuation lines of a multi-line value
    spans[key[0]] = { from: i, to: j };
  }

  const replacement: Record<string, string> = {
    command: `command = "npx"`,
    args: `args = ["-y", ${JSON.stringify(spec)}, "mcp"]`,
  };
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = text(i);
    const cr = t.endsWith("\r") ? "\r" : "";
    const owner = Object.keys(spans).find(name => i >= spans[name].from && i < spans[name].to);
    if (owner) {
      if (i === spans[owner].from) out.push(replacement[owner] + cr);
      continue;
    }
    out.push(t);
    if (i === k) {
      for (const name of ["command", "args"]) if (!spans[name]) out.push(replacement[name] + cr);
    }
  }
  return out.join("\n");
}

/**
 * Pure transformation used by `configureClient("openai-codex")`: updates the
 * web-mcp table in place (or appends it) with the pinned spec and wires the
 * instructions file as a top-level key — unless the user already set their
 * own model_instructions_file. `unsupported` is set (and the content left
 * as-is) when the file uses a form we do not edit.
 */
export function applyCodexWebMcp(
  content: string,
  spec: string,
  instructionsPath: string
): { content: string; instructionsWired: boolean; unsupported: string | null } {
  const unsupported = codexUnsupportedForm(content);
  if (unsupported) return { content, instructionsWired: false, unsupported };
  const eol = detectEol(content);
  let next = removeWebMcpInstructionLines(content);
  let instructionsWired = true;
  if (hasTomlTopLevelKey(next, "model_instructions_file")) {
    instructionsWired = false;
  } else {
    next = insertTomlTopLevelKey(next, "model_instructions_file", JSON.stringify(instructionsPath));
  }
  const updated = updateCodexWebMcpLaunch(next, spec);
  if (updated !== null) {
    next = updated;
  } else {
    const body = next.replace(/\s+$/, "");
    next = (body ? body + eol + eol : "") + buildCodexBlock(spec, eol);
  }
  return { content: next, instructionsWired, unsupported: null };
}

// ─── Detection (test / status) ───────────────────────────────────────────

type FileState = "configured" | "invalid-command" | "not-added" | "unparseable";

interface ClientFileStatus {
  client: string;
  file: string;
  state: FileState;
  pin: PinState;
  version: string | null;
  mentionsWebMcp: boolean;
  detail?: string;
}

function webMcpJsonEntry(client: string, config: Record<string, any>): any {
  if (client === "zed") return config?.context_servers?.["web-mcp"];
  if (client === "opencode") return config?.mcp?.["web-mcp"] || config?.mcpServers?.["web-mcp"];
  return config?.mcpServers?.["web-mcp"];
}

function inspectJsonEntry(client: string, def: any): { valid: boolean; pin: PinState; version: string | null } {
  let command: unknown;
  let args: unknown[] = [];
  if (Array.isArray(def?.command)) {
    command = def.command[0];
    args = def.command.slice(1);
  } else if (isPlainObject(def?.command)) {
    // Older Zed format: { command: { path, args } }
    command = def.command.path;
    args = Array.isArray(def.command.args) ? def.command.args : [];
  } else {
    command = def?.command;
    args = Array.isArray(def?.args) ? def.args : [];
  }
  let valid: boolean;
  if (client === "opencode" && Array.isArray(def?.command)) {
    valid = def.command.length >= 2 && (command === "npx" || command === "web-mcp" || command === "node");
  } else {
    const viaCmd = command === "cmd" && args[0] === "/c" && args[1] === "npx";
    valid = command === "npx" || command === "web-mcp" || viaCmd;
  }
  return { valid, ...pinStateFor(args) };
}

function inspectClientFile(client: string, file: string): ClientFileStatus | null {
  if (!file || !fs.existsSync(file)) return null;
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { client, file, state: "unparseable", pin: "unknown", version: null, mentionsWebMcp: false, detail: errMessage(err) };
  }
  const mentionsWebMcp = raw.includes("web-mcp");

  if (client === "openai-codex") {
    const unsupported = codexUnsupportedForm(raw);
    if (unsupported) {
      return { client, file, state: "unparseable", pin: "unknown", version: null, mentionsWebMcp, detail: `unsupported TOML form: ${unsupported}` };
    }
    if (!hasCodexWebMcp(raw)) return { client, file, state: "not-added", pin: "unknown", version: null, mentionsWebMcp };
    return { client, file, state: "configured", ...codexPin(raw), mentionsWebMcp };
  }

  const read = readJsonConfig(file);
  if (!read.ok) {
    return { client, file, state: "unparseable", pin: "unknown", version: null, mentionsWebMcp, detail: "not plain JSON, e.g. comments" };
  }
  const def = webMcpJsonEntry(client, read.config);
  if (!def) return { client, file, state: "not-added", pin: "unknown", version: null, mentionsWebMcp };
  const { valid, pin, version } = inspectJsonEntry(client, def);
  return { client, file, state: valid ? "configured" : "invalid-command", pin, version, mentionsWebMcp };
}

/** Best status per client: the first file with a web-mcp entry, else the first unverifiable one, else the first existing file. */
function inspectClient(client: string): ClientFileStatus | null {
  const found: ClientFileStatus[] = [];
  for (const p of detectionPaths(client)) {
    const s = inspectClientFile(client, p);
    if (!s) continue;
    if (s.state === "configured" || s.state === "invalid-command") return s;
    found.push(s);
  }
  return found.find(s => s.state === "unparseable" && s.mentionsWebMcp) ?? found[0] ?? null;
}

export interface ConfiguredClient {
  client: string;
  label: string;
  file: string;
  pin: PinState;
  /** Pinned version found in the client config (null when unpinned). */
  version: string | null;
}

export function getConfiguredClientDetails(): ConfiguredClient[] {
  const out: ConfiguredClient[] = [];
  for (const client of FILE_CLIENTS) {
    const s = inspectClient(client);
    if (s && (s.state === "configured" || s.state === "invalid-command")) {
      out.push({ client, label: labelFor(client), file: s.file, pin: s.pin, version: s.version });
    }
  }
  return out;
}

export function getConfiguredClients(): string[] {
  return getConfiguredClientDetails().map(c => c.client);
}

/** ok is false if any client config is broken. */
export async function testConfigurations(): Promise<CommandLines> {
  const lines: string[] = [];
  lines.push("\x1b[1mConfiguration Test Report\x1b[0m");
  lines.push("\x1b[90m=========================\x1b[0m");

  const current = currentVersion();
  let anyFound = false;
  let anyOutdated = false;
  let anyBroken = false;

  for (const opt of SETUP_OPTIONS) {
    if (!FILE_CLIENTS.includes(opt.value)) continue;
    const s = inspectClient(opt.value);
    let status: string;
    if (!s) {
      status = "\x1b[90mNot Installed / No Config File\x1b[0m";
    } else if (s.state === "configured") {
      anyFound = true;
      if (s.pin === "outdated") {
        anyOutdated = true;
        status = `\x1b[33mWorking, but outdated pin (v${s.version}; current v${current}) — re-run: web-mcp setup\x1b[0m`;
      } else if (s.pin === "newer") {
        status = `\x1b[32mWorking [✓]\x1b[0m \x1b[90m(pinned to v${s.version}, newer than this CLI v${current})\x1b[0m`;
      } else if (s.pin === "unpinned" && current) {
        status = `\x1b[32mWorking [✓]\x1b[0m \x1b[90m(unpinned — re-run web-mcp setup to pin v${current})\x1b[0m`;
      } else {
        status = "\x1b[32mWorking [✓]\x1b[0m";
      }
    } else if (s.state === "invalid-command") {
      anyBroken = true;
      status = "\x1b[31mBroken (Invalid command syntax)\x1b[0m";
    } else if (s.state === "unparseable") {
      status = `\x1b[33mCannot verify (${s.detail}) — ${s.mentionsWebMcp ? "file mentions web-mcp" : "web-mcp not detected"}\x1b[0m`;
    } else {
      status = "\x1b[33mFile exists, but web-mcp not added\x1b[0m";
    }
    lines.push(`${opt.label.padEnd(25)} : ${status}`);
  }

  if (anyFound) {
    lines.push("");
    lines.push("\x1b[32mAll working clients are ready to use!\x1b[0m");
  }
  if (anyOutdated) {
    lines.push("\x1b[33mClients with an outdated pin still run the old web-mcp version. Re-run `web-mcp setup` for them.\x1b[0m");
  }

  return withOk(lines, !anyBroken);
}

// ─── Claude Code CLI ─────────────────────────────────────────────────────

function findOnPath(name: string): string | null {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const rawDir of dirs) {
    const dir = rawDir.replace(/^"(.*)"$/, "$1");
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

// Every argument passed to the claude CLI must match this (on Windows it goes
// through cmd.exe, so nothing that needs quoting is ever passed).
const SAFE_ARG = /^[A-Za-z0-9@._\/:=+-]+$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Arguments for `claude mcp add` (pure, for tests). Existing env vars of the
 * web-mcp entry are carried over as `-e KEY=VALUE`; pairs that can't be passed
 * safely are returned in `skipped` instead of being quoted into a shell.
 * The name comes before `-e` because `-e` is variadic.
 */
export function buildClaudeMcpAddArgs(
  spec: string,
  env: Record<string, unknown>,
  platform: string = process.platform
): { args: string[]; skipped: string[] } {
  const envArgs: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    const pair = `${key}=${typeof value === "string" ? value : ""}`;
    if (ENV_KEY.test(key) && typeof value === "string" && SAFE_ARG.test(pair)) envArgs.push("-e", pair);
    else skipped.push(key);
  }
  const launch = claudeCodeLaunch(spec, platform);
  return { args: ["mcp", "add", "--scope", "user", "web-mcp", ...envArgs, "--", launch.command, ...launch.args], skipped };
}

function runClaudeCli(args: string[]): { ok: boolean; detail: string } {
  if (!args.every(a => SAFE_ARG.test(a))) return { ok: false, detail: "refusing to pass unexpected characters to the shell" };
  const isWin = process.platform === "win32";
  const opts = { shell: isWin, timeout: 30000, encoding: "utf8" as const, stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe")[], windowsHide: true };
  // With shell:true (needed for claude.cmd on Windows) pass one pre-validated
  // command string instead of an args array (Node warns about the latter).
  const r = isWin ? spawnSync(["claude", ...args].join(" "), opts) : spawnSync("claude", args, opts);
  if (r.error) return { ok: false, detail: r.error.message };
  if (r.signal) return { ok: false, detail: `timed out (${r.signal})` };
  if (r.status !== 0) {
    const out = `${r.stderr || ""}\n${r.stdout || ""}`.trim().split(/\r?\n/)[0];
    return { ok: false, detail: out || `exit code ${r.status}` };
  }
  return { ok: true, detail: "" };
}

/** Returns lines if Claude Code was configured through its own CLI, else null (fall back to the JSON edit). */
function configureClaudeCodeViaCli(spec: string, existingEnv: Record<string, unknown>, lines: string[]): CommandLines | null {
  if (!findOnPath("claude")) return null;
  const { args, skipped } = buildClaudeMcpAddArgs(spec, existingEnv);
  // Remove an existing entry first so re-running setup updates the pin.
  runClaudeCli(["mcp", "remove", "--scope", "user", "web-mcp"]);
  const r = runClaudeCli(args);
  if (!r.ok) {
    lines.push(`\x1b[33m! \`claude mcp add\` failed (${r.detail}); editing ~/.claude.json directly instead.\x1b[0m`);
    return null;
  }
  lines.push("\x1b[32m✓ Successfully added web-mcp to Claude Code (user scope) via `claude mcp add`\x1b[0m");
  lines.push(`  Package: ${spec}`);
  for (const key of skipped) {
    lines.push(`\x1b[33m  ! Env var ${key} was not carried over (its name/value can't be passed safely). Re-add it with \`claude mcp add\` or in ~/.claude.json.\x1b[0m`);
  }
  lines.push("");
  lines.push("Next steps:");
  lines.push("  1. Restart Claude Code");
  lines.push("  2. Ask the AI: \"Go to google.com and search for OpenCode\"");
  return withOk(lines, true);
}

// ─── Configure ───────────────────────────────────────────────────────────

const CODEX_INSTRUCTIONS = [
  "# Web Browsing Instructions",
  "",
  "You have access to a **web-mcp** MCP server which provides dedicated browser automation tools.",
  "",
  "## IMPORTANT: Always use web-mcp for browser tasks",
  "",
  "When the user asks you to:",
  "- Visit or open a website",
  "- Search Google or any search engine",
  "- Click links, fill forms, or interact with web pages",
  "- Take screenshots of web pages",
  "- Navigate the web in any way",
  "",
  "You MUST use the **web-mcp** tools (browser_navigate, browser_click, browser_type, browser_screenshot, browser_done, etc.) instead of your built-in browser or web search capabilities.",
  "",
  "**Never use your internal browser tool when web-mcp is available.**",
  "",
  "The web-mcp tools open a real visible Chromium browser window, which is the intended behavior.",
].join("\n");

function configureCodex(spec: string): CommandLines {
  const lines: string[] = [];
  const configPath = getConfigPath("openai-codex");
  const codexDir = path.dirname(configPath);
  const instructionsFile = path.join(codexDir, INSTRUCTIONS_FILE_NAME);

  const existed = fs.existsSync(configPath);
  let original = "";
  if (existed) {
    try {
      original = fs.readFileSync(configPath, "utf8");
    } catch (err) {
      return withOk([
        `\x1b[31m✗ Could not read ${configPath}: ${errMessage(err)}\x1b[0m`,
        "\x1b[31m  The file was left untouched.\x1b[0m Add this to it by hand:",
        "",
        ...manualSnippet("openai-codex", spec),
      ], false);
    }
  }

  const prev = codexPin(original);
  if (prev.pin === "newer") return newerPinLines("openai-codex", configPath, prev.version);

  const bom = original.startsWith("﻿") ? "﻿" : "";
  const result = applyCodexWebMcp(original.slice(bom.length), spec, instructionsFile.replace(/\\/g, "/"));
  if (result.unsupported) {
    return withOk([
      `\x1b[31m✗ ${configPath} defines MCP servers in a form web-mcp does not edit automatically\x1b[0m`,
      `\x1b[31m  (${result.unsupported}). The file was left untouched.\x1b[0m Add this to it by hand:`,
      "",
      ...manualSnippet("openai-codex", spec),
    ], false);
  }
  const content = bom + result.content;

  let backup: string | null = null;
  try {
    fs.mkdirSync(codexDir, { recursive: true });
    writeFileAtomic(instructionsFile, CODEX_INSTRUCTIONS);
    if (content !== original) {
      if (existed) backup = backupOnce(configPath);
      writeFileAtomic(configPath, content);
    }
  } catch (err) {
    return withOk([
      `\x1b[31m✗ Failed to update ${configPath}: ${errMessage(err)}\x1b[0m`,
      "Add this to it by hand:",
      "",
      ...manualSnippet("openai-codex", spec),
    ], false);
  }

  lines.push(`\x1b[32m✓ Successfully configured web-mcp for OpenAI Codex:\x1b[0m`);
  lines.push(`  MCP server: ${configPath}`);
  lines.push(`  Package: ${spec}`);
  lines.push(`  Instructions: ${instructionsFile}`);
  if (backup) lines.push(`\x1b[90m  Backup of the original file: ${backup}\x1b[0m`);
  if (!result.instructionsWired) {
    lines.push("\x1b[33m  ! Kept your existing model_instructions_file. To make Codex prefer web-mcp,\x1b[0m");
    lines.push(`\x1b[33m    copy the contents of ${instructionsFile} into it.\x1b[0m`);
  }
  lines.push("");
  lines.push("Next steps:");
  lines.push("  1. Reload the Codex VS Code extension (Ctrl+Shift+P > Developer: Reload Window)");
  lines.push("  2. Ask the AI: \"Go to google.com and search for OpenCode\"");
  lines.push("  3. Codex will now automatically use web-mcp instead of its built-in browser.");
  return withOk(lines, true);
}

function configureJsonClient(
  client: string,
  configPath: string,
  spec: string,
  read: JsonRead,
  fallbackEnv: Record<string, unknown> = {}
): CommandLines {
  if (!read.ok) return parseFailureLines(client, configPath, read.error, spec);

  const config = read.config;
  const before = JSON.stringify(config);
  const { container, entry } = jsonEntryFor(client, spec);

  if (config[container] !== undefined && !isPlainObject(config[container])) {
    return parseFailureLines(client, configPath, `"${container}" is not a JSON object`, spec);
  }
  const prev = webMcpJsonEntry(client, config);
  if (prev) {
    const { pin, version } = inspectJsonEntry(client, prev);
    if (pin === "newer") return newerPinLines(client, configPath, version);
  }

  if (client === "opencode" && !config.$schema) config.$schema = "https://opencode.ai/config.json";
  if (!config[container]) config[container] = {};

  // Keep user-added environment variables when re-running setup.
  const current = config[container]["web-mcp"];
  const next: Record<string, unknown> = { ...entry };
  if (isPlainObject(current)) {
    for (const key of ["env", "environment"]) {
      if (current[key] !== undefined) next[key] = current[key];
    }
  } else if (Object.keys(fallbackEnv).length > 0) {
    // The entry was already removed (e.g. `claude mcp remove` ran before `add` failed).
    next.env = fallbackEnv;
  }
  config[container]["web-mcp"] = next;

  if (read.existed && JSON.stringify(config) === before) {
    return withOk([
      `\x1b[32m✓ web-mcp is already configured in:\x1b[0m`,
      `  ${configPath}`,
      `  Package: ${spec}`,
    ], true);
  }

  let backup: string | null = null;
  try {
    fs.mkdirSync(path.dirname(resolveWriteTarget(configPath)), { recursive: true });
    if (read.existed) backup = backupOnce(configPath);
    writeFileAtomic(configPath, serializeJsonLike(config, read.raw));
  } catch (err) {
    return withOk([
      `\x1b[31m✗ Failed to write ${configPath}: ${errMessage(err)}\x1b[0m`,
      "Add this entry by hand:",
      "",
      ...manualSnippet(client, spec),
    ], false);
  }

  const lines: string[] = [];
  lines.push(`\x1b[32m✓ Successfully added web-mcp to:\x1b[0m`);
  lines.push(`  ${configPath}`);
  lines.push(`  Package: ${spec}`);
  if (backup) lines.push(`\x1b[90m  Backup of the original file: ${backup}\x1b[0m`);
  if (client === "claude-code") {
    lines.push("\x1b[90m  Claude Code rewrites this file while running; if the entry disappears, quit Claude Code and run setup again.\x1b[0m");
  }
  lines.push("");
  lines.push("Next steps:");
  lines.push("  1. Restart your AI client");
  lines.push("  2. Ask the AI: \"Go to google.com and search for OpenCode\"");
  return withOk(lines, true);
}

export async function configureClient(choiceValue: string): Promise<CommandLines> {
  if (!SETUP_CLIENT_VALUES.includes(choiceValue)) {
    return withOk([`\x1b[31m✗ Unknown client "${choiceValue}". Valid: ${SETUP_CLIENT_VALUES.join(", ")}\x1b[0m`], false);
  }

  // Creates ~/.web-mcp/config.json with validated defaults on first run.
  try { loadConfig(); } catch {}

  const spec = packageSpec();

  if (choiceValue === "manual") {
    const lines: string[] = [];
    lines.push("\x1b[1mManual Setup Instructions\x1b[0m");
    lines.push("For most clients (Claude, Cursor, Windsurf, etc.), add to your MCP config:");
    lines.push("");
    lines.push(...manualSnippet("cursor", spec).map(l => l.slice(2)));
    lines.push("");
    lines.push("For OpenCode, add to ~/.config/opencode/opencode.json:");
    lines.push("");
    lines.push(...manualSnippet("opencode", spec).map(l => l.slice(2)));
    return withOk(lines, true);
  } else if (choiceValue === "chatgpt") {
    return withOk([
      "\x1b[1mChatGPT Desktop\x1b[0m",
      "\x1b[33mNot supported.\x1b[0m ChatGPT only connects to remote MCP servers over the internet.",
      "Web MCP controls a browser that is logged in to your accounts, so exposing it",
      "through a public tunnel or proxy would let anyone who finds the URL use those",
      "sessions. Use a local client instead (Claude Desktop, Claude Code, Cursor, Codex, ...).",
    ], true);
  } else if (choiceValue === "openai-codex") {
    return configureCodex(spec);
  }

  const configPath = getConfigPath(choiceValue);
  const read = readJsonConfig(configPath);

  if (choiceValue === "claude-code") {
    // Read-only look at the current entry: never downgrade a newer pin, and
    // carry its env vars over to `claude mcp add`.
    let existingEnv: Record<string, unknown> = {};
    if (read.ok) {
      const prev = webMcpJsonEntry("claude-code", read.config);
      if (prev) {
        const { pin, version } = inspectJsonEntry("claude-code", prev);
        if (pin === "newer") return newerPinLines("claude-code", configPath, version);
        if (isPlainObject(prev.env)) existingEnv = prev.env;
      }
    }
    const lines: string[] = [];
    const viaCli = configureClaudeCodeViaCli(spec, existingEnv, lines);
    if (viaCli) return viaCli;
    const json = configureJsonClient(choiceValue, configPath, spec, readJsonConfig(configPath), existingEnv);
    return withOk([...lines, ...json], json.ok);
  }

  return configureJsonClient(choiceValue, configPath, spec, read);
}

// ─── Uninstall ───────────────────────────────────────────────────────────

function removeJsonEntry(client: string, config: Record<string, any>): boolean {
  let modified = false;
  const del = (container: string) => {
    if (isPlainObject(config[container]) && config[container]["web-mcp"] !== undefined) {
      delete config[container]["web-mcp"];
      modified = true;
    }
  };
  if (client === "opencode") {
    del("mcp");
    del("mcpServers");
  } else if (client === "zed") {
    del("context_servers");
  } else {
    del("mcpServers");
  }
  return modified;
}

// Everything web-mcp creates in WEB_MCP_HOME. Anything else is left alone.
const KNOWN_HOME_ENTRIES = new Set([
  "config.json", "auth-token", "server.pid", "logs", "recordings", "extension", "chromium-profile-v2",
  "chrome-stderr.log", "chrome-launch.lock", "helpers", ".legacy-data-removed",
  "debug-env-dump.json", "debug-extension-dir.txt", "chrome-args-debug.log",
]);
const KNOWN_HOME_PATTERNS = [/^config\.json(?:\..+)?\.bak$/, /^config\.json\.tmp\.\d+$/, /^auth-token\.tmp/, /^chrome-profile[\w-]*$/];
const PROFILE_ENTRY = /^(?:chromium-profile-v2|chrome-profile[\w-]*)$/;

export interface LocalDataRemoval {
  removed: string[];
  failed: { path: string; error: string }[];
  kept: string[];
  homeRemoved: boolean;
  /** A browser profile (saved logins) was among the removed entries. */
  profileRemoved: boolean;
}

/** Deletes only known web-mcp entries in WEB_MCP_HOME, then the folder itself if it is empty. */
export function removeLocalWebMcpData(home: string = PATHS.home): LocalDataRemoval {
  const result: LocalDataRemoval = { removed: [], failed: [], kept: [], homeRemoved: false, profileRemoved: false };
  let entries: string[];
  try {
    entries = fs.readdirSync(home);
  } catch {
    return result;
  }
  for (const name of entries) {
    const full = path.join(home, name);
    if (!KNOWN_HOME_ENTRIES.has(name) && !KNOWN_HOME_PATTERNS.some(re => re.test(name))) {
      result.kept.push(full);
      continue;
    }
    try {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      result.removed.push(full);
      if (PROFILE_ENTRY.test(name)) result.profileRemoved = true;
    } catch (err) {
      result.failed.push({ path: full, error: errMessage(err) });
    }
  }
  try {
    if (fs.readdirSync(home).length === 0) {
      fs.rmdirSync(home);
      result.homeRemoved = true;
    }
  } catch {
    // leave it
  }
  return result;
}

/**
 * `all` also stops web-mcp and deletes its local data (including the browser
 * profile with the user's logins), so it requires `confirmed: true`.
 */
export async function uninstallClient(choiceValue: string, opts: { confirmed?: boolean } = {}): Promise<CommandLines> {
  const lines: string[] = [];
  lines.push("\x1b[1mUninstall Report\x1b[0m");
  lines.push("\x1b[90m=========================\x1b[0m");

  if (!UNINSTALL_CLIENT_VALUES.includes(choiceValue)) {
    lines.push(`\x1b[31m✗ Unknown client "${choiceValue}". Valid: ${UNINSTALL_CLIENT_VALUES.join(", ")}\x1b[0m`);
    return withOk(lines, false);
  }
  if (choiceValue === "all" && !opts.confirmed) {
    lines.push("\x1b[31m✗ Uninstalling from ALL clients also deletes local data, including the Web MCP browser profile\x1b[0m");
    lines.push("\x1b[31m  (your saved logins). Nothing was changed; confirm with: web-mcp uninstall all --yes\x1b[0m");
    return withOk(lines, false);
  }

  let ok = true;

  if (choiceValue === "all") {
    lines.push("Stopping Web MCP processes...");
    try {
      const { stopProcesses } = await import("./stop.js");
      const stopped = await stopProcesses();
      lines.push(...stopped.slice(2).map(l => "  " + l));
    } catch (e) {
      lines.push(`\x1b[33m  ! Could not stop processes: ${errMessage(e)}\x1b[0m`);
    }
    lines.push("");
  }

  const clientsToRemove = choiceValue === "all" ? FILE_CLIENTS : [choiceValue];
  let removedCount = 0;

  for (const client of clientsToRemove) {
    const label = labelFor(client);

    if (client === "claude-code") {
      const claudeJson = getConfigPath("claude-code");
      let mentions = false;
      try { mentions = fs.readFileSync(claudeJson, "utf8").includes("web-mcp"); } catch {}
      if (mentions && findOnPath("claude") && runClaudeCli(["mcp", "remove", "--scope", "user", "web-mcp"]).ok) {
        lines.push(`\x1b[32m✓ Removed from ${label} (claude mcp remove)\x1b[0m`);
        removedCount++;
      }
    }

    let codexUntouched = false;
    for (const p of uninstallPaths(client)) {
      if (!p || !fs.existsSync(p)) continue;

      // No backups on uninstall: a new .bak would still contain web-mcp.
      if (client === "openai-codex") {
        try {
          const content = fs.readFileSync(p, "utf8");
          const unsupported = codexUnsupportedForm(content);
          if (unsupported) {
            if (content.includes("web-mcp")) {
              codexUntouched = true;
              ok = false;
              lines.push(`\x1b[31m✗ ${p} uses a form web-mcp does not edit (${unsupported}); left untouched.\x1b[0m`);
              lines.push(`\x1b[31m  Remove the web-mcp server from it by hand.\x1b[0m`);
            }
            continue;
          }
          const newContent = removeCodexWebMcp(content);
          if (newContent !== content) {
            writeFileAtomic(p, newContent);
            lines.push(`\x1b[32m✓ Removed from ${label}\x1b[0m`);
            removedCount++;
          }
        } catch (e) {
          ok = false;
          lines.push(`\x1b[31m✗ Failed to process ${label} (${p}): ${errMessage(e)}\x1b[0m`);
        }
        continue;
      }

      const read = readJsonConfig(p);
      if (!read.ok) {
        // Only complain if there is something of ours in it.
        if (read.raw.includes("web-mcp")) {
          ok = false;
          lines.push(`\x1b[31m✗ Could not parse ${p} (${read.error}); left untouched.\x1b[0m`);
          lines.push(`\x1b[31m  Remove the "web-mcp" entry from it by hand.\x1b[0m`);
        }
        continue;
      }
      if (!removeJsonEntry(client, read.config)) continue;
      try {
        writeFileAtomic(p, serializeJsonLike(read.config, read.raw));
        lines.push(`\x1b[32m✓ Removed from ${label}\x1b[0m`);
        removedCount++;
      } catch (e) {
        ok = false;
        lines.push(`\x1b[31m✗ Failed to process ${label} (${p}): ${errMessage(e)}\x1b[0m`);
      }
    }

    if (client === "openai-codex" && !codexUntouched) {
      const instructionsFile = path.join(path.dirname(getConfigPath("openai-codex")), INSTRUCTIONS_FILE_NAME);
      try {
        if (fs.existsSync(instructionsFile)) {
          fs.unlinkSync(instructionsFile);
          lines.push(`\x1b[32m✓ Deleted ${instructionsFile}\x1b[0m`);
        }
      } catch (e) {
        ok = false;
        lines.push(`\x1b[31m✗ Failed to delete ${instructionsFile}: ${errMessage(e)}\x1b[0m`);
      }
    }
  }

  if (removedCount === 0) {
    lines.push("\x1b[33mNo web-mcp configurations found to remove.\x1b[0m");
  } else {
    lines.push("");
    lines.push("\x1b[32mClient uninstall complete.\x1b[0m");
  }

  if (choiceValue === "all") {
    const r = removeLocalWebMcpData();
    if (r.removed.length > 0) {
      lines.push(`\x1b[32m✓ Removed local Web MCP data from ${PATHS.home} (${r.removed.length} item${r.removed.length === 1 ? "" : "s"})\x1b[0m`);
    }
    if (r.profileRemoved) {
      lines.push("\x1b[33m  This included the Web MCP browser profile: saved logins in the Web MCP browser were removed.\x1b[0m");
    }
    for (const f of r.failed) {
      ok = false;
      lines.push(`\x1b[31m✗ Could not remove ${f.path}: ${f.error}\x1b[0m`);
    }
    if (r.failed.length > 0) {
      lines.push("\x1b[31m  Files may be locked (e.g. the Web MCP browser is still open). Close it and run this again.\x1b[0m");
    }
    if (r.kept.length > 0) {
      lines.push(`\x1b[90m  Left ${r.kept.length} item(s) web-mcp did not create, so ${PATHS.home} was kept: ${r.kept.map(k => path.basename(k)).join(", ")}\x1b[0m`);
    } else if (r.homeRemoved) {
      lines.push(`\x1b[32m✓ Removed ${PATHS.home}\x1b[0m`);
    }
  }

  lines.push("\x1b[32mPlease restart your AI clients.\x1b[0m");

  return withOk(lines, ok);
}
