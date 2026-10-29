import express, { NextFunction, Request, Response } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { PATHS, PROTOCOL_VERSION, WebMcpConfig, tokensEqual } from "../shared/paths.js";
import {
  AgentAction,
  AgentPublic,
  AgentStatus,
  AgentTab,
  IdentityPayload,
  SERVER_IDENTITY,
  StatePayload,
  TabView,
} from "../shared/protocol.js";
import { logToFile } from "./logger.js";

// Coordination server (protocol 2). Every MCP wrapper registers as an agent
// that owns its own tabs; the extension renders per-tab overlays and the side
// panel from GET /state + GET /events. All state is in memory; only redacted
// logs and recordings ever reach the disk.

// ─── Constants ───────────────────────────────────────────────────────────

const AGENT_COLORS = ["#4b8eff", "#34c759", "#ff9f0a", "#bf5af2", "#ff375f", "#64d2ff", "#ffd60a", "#ac8e68"];

// MCP clientInfo.name → human label. Matched exactly or as a "<name>-…" prefix
// (e.g. "cursor-vscode" → "Cursor").
const CLIENT_LABELS: [string, string][] = [
  ["claude-code", "Claude Code"],
  ["claude-ai", "Claude Desktop"],
  ["cursor", "Cursor"],
  ["opencode", "OpenCode"],
  ["codex-mcp-client", "Codex"],
  ["codex", "Codex"],
  ["windsurf", "Windsurf"],
  ["zed", "Zed"],
  ["cline", "Cline"],
];

const MAX_AGENTS = 64; // live agents
const MAX_TOMBSTONES = 200;
const MAX_ACTIONS_KEPT = 50; // in memory per agent
const MAX_ACTIONS_PUBLIC = 20; // exposed in AgentPublic.actions
const MAX_RECORDED_ACTIONS = 5000; // per recording, so a runaway agent can't grow memory forever
const MAX_LOG_ENTRIES = 200;
const MAX_TABS = 500; // per agent, including entries created by tab claims
const MAX_CLAIMS_PER_AGENT = 100;
const MAX_NAME_LEN = 100; // clientName, clientVersion, label
const MAX_TYPE_LEN = 40;
const MAX_TASK_LEN = 300;
const MAX_TEXT_LEN = 2000;
const MAX_URL_LEN = 4096;
const MAX_TITLE_LEN = 300;
const MAX_ORIGIN_LEN = 300;
const MAX_SSE_BUFFER = 1024 * 1024; // bytes queued for one SSE client before we drop it

const SWEEP_INTERVAL_MS = 5_000;
const CLAIM_TTL_MS = 60_000;
const TOMBSTONE_TTL_MS = 30 * 60_000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const BROADCAST_DEBOUNCE_MS = 30;
const SHUTDOWN_DELAY_MS = 50;

const AGENT_ID_RE = /^[0-9a-f]{8}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const CHALLENGE_RE = /^[0-9a-f]{64}$/;

// ─── Types ───────────────────────────────────────────────────────────────

interface OwnedTab extends AgentTab {
  /** Origin the tab id was claimed from; navigating elsewhere drops the tab id. Never sent out. */
  claimedOrigin: string | null;
}

interface Agent {
  id: string;
  clientName: string;
  clientVersion: string;
  label: string;
  color: string;
  taskName: string;
  status: AgentStatus;
  halted: boolean;
  tabs: OwnedTab[];
  currentPageId: number | null;
  /** Raw action text, memory only: shown in the side panel, never written to disk. */
  actions: AgentAction[];
  /** Redacted (`redactedText ?? text`) copy of every non-silent action, written out when the agent is removed. */
  recording: AgentAction[];
  createdAt: number;
  lastActionAt: number | null;
  /** Last action or explicit PATCH status:"active" — drives the idle timer. */
  activityAt: number;
  /** Last request from the agent's wrapper — drives stale reaping. */
  lastSeen: number;
}

/**
 * What survives an agent's removal for a while, so a wrapper that was reaped
 * (e.g. across laptop sleep) can come back as the same agent — and, above all,
 * still halted if the user halted it.
 */
interface Tombstone {
  id: string;
  label: string;
  color: string;
  clientName: string;
  clientVersion: string;
  taskName: string;
  halted: boolean;
  expiresAt: number;
}

interface PendingClaim {
  agentId: string;
  pageId: number;
  /** If set, /tabs/claim must report exactly this origin. */
  origin: string | null;
  expiresAt: number;
}

interface LogEntry {
  timestamp: string;
  message: string;
}

export interface CreateAppOptions {
  token: string;
  config: WebMcpConfig;
  version: string;
  /** Called after POST /shutdown has been answered and close() has run (server.ts exits here). */
  onShutdown?: () => void;
  /** Test hook: how often idle/stale/claim timers run (default 5 s). */
  sweepIntervalMs?: number;
  /** Test hook: lifetime of a pending tab claim (default 60 s). */
  claimTtlMs?: number;
}

/** Thrown from route handlers; rendered as `{error: code}` by the error handler. */
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail?: string) {
    super(code);
  }
}

function badRequest(detail: string): never {
  throw new HttpError(400, "invalid_body", detail);
}

// ─── Validation helpers ──────────────────────────────────────────────────

/** Strips control characters (keeps logs one entry per line) and bounds the length. */
function cleanString(value: string, max: number): string {
  const s = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** undefined when absent, a cleaned string when valid, 400 otherwise. */
function optString(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") badRequest(`${name} must be a string`);
  return cleanString(value, max);
}

/** Origins are compared byte for byte, so they are validated but never rewritten. "" = none. */
function optOrigin(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_ORIGIN_LEN) badRequest(`origin must be a string of at most ${MAX_ORIGIN_LEN} chars`);
  return value;
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function readBody(req: Request): Record<string, unknown> {
  const body = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) badRequest("body must be a JSON object");
  return body as Record<string, unknown>;
}

/** Parses a wrapper-supplied tab. Its tabId is ignored: tab ids only come from /tabs/claim. */
function parseTab(value: unknown): OwnedTab {
  if (!value || typeof value !== "object" || Array.isArray(value)) badRequest("each tab must be an object");
  const t = value as Record<string, unknown>;
  if (!isInt(t.pageId)) badRequest("tab.pageId must be an integer");
  return {
    pageId: t.pageId,
    tabId: null,
    url: typeof t.url === "string" ? t.url.slice(0, MAX_URL_LEN) : "",
    title: typeof t.title === "string" ? cleanString(t.title, MAX_TITLE_LEN) : "",
    claimedOrigin: null,
  };
}

/** Origin of a URL, or null for empty/unparsable ones (opaque origins give "null"). */
function urlOrigin(url: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function parseTabIdParam(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new HttpError(400, "invalid_tab_id");
  return Number(raw);
}

function prettyClientName(clientName: string): string {
  const key = clientName.toLowerCase();
  if (!key) return "Agent";
  for (const [name, label] of CLIENT_LABELS) {
    if (key === name || key.startsWith(name + "-")) return label;
  }
  return clientName;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ─── App ─────────────────────────────────────────────────────────────────

export function createApp(opts: CreateAppOptions): { app: express.Express; close(): void } {
  const { token, config, version } = opts;
  // An empty token would make `?token=` match and disable auth entirely.
  if (!token) throw new Error("createApp: token is required");

  const sweepIntervalMs = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  const claimTtlMs = opts.claimTtlMs ?? CLAIM_TTL_MS;
  const agents = new Map<string, Agent>();
  const tombstones = new Map<string, Tombstone>(); // agent id → tombstone, oldest first
  const claims = new Map<string, PendingClaim>(); // nonce → claim
  const labelCounters = new Map<string, number>(); // pretty client name → last #n
  const logBuffer: LogEntry[] = [];
  const sseClients = new Set<Response>();
  let broadcastTimer: NodeJS.Timeout | null = null;
  let lastSweepAt = Date.now();
  let closed = false;

  // ─── Logging ───────────────────────────────────────────────────────────
  // Callers must only pass redacted text: everything here is written to disk
  // and served by GET /logs.

  function addLog(message: string): void {
    const clean = message.replace(/[\r\n]+/g, " ");
    logBuffer.push({ timestamp: new Date().toISOString(), message: clean });
    if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();
    logToFile(clean);
  }

  function debugLog(message: string): void {
    if (config.logging.level === "debug") logToFile(message);
  }

  // ─── Agent helpers ─────────────────────────────────────────────────────

  function newAgentId(): string {
    let id: string;
    do {
      id = crypto.randomBytes(4).toString("hex");
    } while (agents.has(id) || tombstones.has(id));
    return id;
  }

  function pickColor(): string {
    const used = new Set([...agents.values()].map((a) => a.color));
    return AGENT_COLORS.find((c) => !used.has(c)) ?? AGENT_COLORS[agents.size % AGENT_COLORS.length];
  }

  function defaultLabel(clientName: string): string {
    const pretty = prettyClientName(clientName);
    const n = (labelCounters.get(pretty) ?? 0) + 1;
    labelCounters.set(pretty, n);
    return `${pretty} #${n}`;
  }

  /** Looks up :id (404 if unknown). `touch` marks the wrapper as alive. */
  function requireAgent(req: Request, touch = true): Agent {
    const agent = agents.get(String(req.params.id));
    if (!agent) throw new HttpError(404, "unknown_agent");
    if (touch) agent.lastSeen = Date.now();
    return agent;
  }

  function tabOwner(tabId: number): Agent | undefined {
    for (const agent of agents.values()) {
      if (agent.tabs.some((t) => t.tabId === tabId)) return agent;
    }
    return undefined;
  }

  function haltAgent(agent: Agent, source: string): void {
    if (!agent.halted) addLog(`HALT ${agent.id} "${agent.label}" (${source})`);
    agent.halted = true;
    agent.status = "idle";
  }

  function liveTombstone(id: string): Tombstone | undefined {
    const t = tombstones.get(id);
    if (t && t.expiresAt <= Date.now()) {
      tombstones.delete(id);
      return undefined;
    }
    return t;
  }

  function removeAgent(agent: Agent, reason: string): void {
    agents.delete(agent.id);
    for (const [nonce, claim] of claims) {
      if (claim.agentId === agent.id) claims.delete(nonce);
    }
    tombstones.delete(agent.id); // re-insert so the Map stays ordered oldest → newest
    tombstones.set(agent.id, {
      id: agent.id,
      label: agent.label,
      color: agent.color,
      clientName: agent.clientName,
      clientVersion: agent.clientVersion,
      taskName: agent.taskName,
      halted: agent.halted,
      expiresAt: Date.now() + TOMBSTONE_TTL_MS,
    });
    while (tombstones.size > MAX_TOMBSTONES) tombstones.delete(tombstones.keys().next().value as string);
    writeRecording(agent);
    addLog(`AGENT REMOVED ${agent.id} "${agent.label}" (${reason}, ${agent.recording.length} actions${agent.halted ? ", halted" : ""})`);
    scheduleBroadcast();
  }

  function toPublic(agent: Agent): AgentPublic {
    return {
      id: agent.id,
      clientName: agent.clientName,
      clientVersion: agent.clientVersion,
      label: agent.label,
      color: agent.color,
      taskName: agent.taskName,
      status: agent.status,
      halted: agent.halted,
      tabs: agent.tabs.map(({ pageId, tabId, url, title }) => ({ pageId, tabId, url, title })),
      currentPageId: agent.currentPageId,
      actions: agent.actions.slice(-MAX_ACTIONS_PUBLIC).map(({ text, type, timestamp }) => ({ text, type, timestamp })),
      createdAt: iso(agent.createdAt),
      lastActionAt: agent.lastActionAt === null ? null : iso(agent.lastActionAt),
    };
  }

  // ─── State & SSE ───────────────────────────────────────────────────────

  function buildState(): StatePayload {
    // Tab views end up inside arbitrary web pages (the page can read the
    // overlay DOM), so they carry no task name and no action text — only the
    // latest action type, and only on the agent's current tab so background
    // tabs don't change (and get a push) on every action. The side panel gets
    // everything via `agents`.
    const tabs: Record<string, TabView> = {};
    for (const agent of agents.values()) {
      const lastType = agent.actions.length ? agent.actions[agent.actions.length - 1].type : null;
      for (const tab of agent.tabs) {
        if (tab.tabId === null) continue;
        const current = tab.pageId === agent.currentPageId;
        tabs[String(tab.tabId)] = {
          agentId: agent.id,
          label: agent.label,
          color: agent.color,
          status: agent.status,
          halted: agent.halted,
          lastActionType: current ? lastType : null,
          current,
        };
      }
    }
    return { version, protocol: PROTOCOL_VERSION, agents: [...agents.values()].map(toPublic), tabs };
  }

  function sendFrame(res: Response, frame: string): void {
    if (res.writableEnded || res.destroyed) {
      sseClients.delete(res);
      return;
    }
    // Every frame is a full snapshot, so a client that stopped reading loses
    // nothing by being dropped; EventSource reconnects on its own.
    const queued = res.writableLength;
    if (queued > MAX_SSE_BUFFER) {
      sseClients.delete(res);
      res.destroy();
      addLog(`SSE client dropped (${queued} bytes unread)`);
      return;
    }
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }

  function stateFrame(): string {
    return `event: state\ndata: ${JSON.stringify(buildState())}\n\n`;
  }

  /** Coalesces bursts of changes into one SSE frame. */
  function scheduleBroadcast(): void {
    if (closed || broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      if (sseClients.size === 0) return;
      const frame = stateFrame();
      for (const res of sseClients) sendFrame(res, frame);
    }, BROADCAST_DEBOUNCE_MS);
    broadcastTimer.unref();
  }

  // ─── Recordings ────────────────────────────────────────────────────────

  function writeRecording(agent: Agent): void {
    if (agent.recording.length === 0) return;
    try {
      fs.mkdirSync(PATHS.recordingsDir, { recursive: true });
      const endedAt = Date.now();
      // ':' is not allowed in Windows file names.
      const file = path.join(PATHS.recordingsDir, `${iso(endedAt).replace(/[:.]/g, "-")}-${agent.id}.json`);
      const data = {
        label: agent.label,
        clientName: agent.clientName,
        clientVersion: agent.clientVersion,
        createdAt: iso(agent.createdAt),
        endedAt: iso(endedAt),
        actions: agent.recording,
      };
      fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
      pruneRecordings();
    } catch (err) {
      addLog("ERROR writing recording for " + agent.id + ": " + (err as Error).message);
    }
  }

  /** Keeps the newest `maxRecordings` *.json files; legacy session-* dirs are left alone. */
  function pruneRecordings(): void {
    const files = fs
      .readdirSync(PATHS.recordingsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => {
        const full = path.join(PATHS.recordingsDir, e.name);
        return { full, name: e.name, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
    for (const f of files.slice(config.agents.maxRecordings)) {
      try {
        fs.unlinkSync(f.full);
      } catch {
        // ignore
      }
    }
  }

  // ─── Timers ────────────────────────────────────────────────────────────

  function sweep(): void {
    const now = Date.now();
    const gap = now - lastSweepAt;
    lastSweepAt = now;

    for (const [nonce, claim] of claims) {
      if (claim.expiresAt <= now) claims.delete(nonce);
    }
    for (const [id, t] of tombstones) {
      if (t.expiresAt <= now) tombstones.delete(id);
    }

    // Clock jump (laptop sleep, debugger pause, wall-clock change): nobody had
    // a chance to heartbeat, so restart everyone's timers instead of reaping
    // or idling agents whose wrappers are probably fine.
    if (gap < 0 || gap > 3 * sweepIntervalMs) {
      for (const agent of agents.values()) {
        agent.lastSeen = now;
        agent.activityAt = now;
      }
      if (agents.size) addLog(`Clock jump of ${Math.round(gap / 1000)}s detected; agent timers restarted`);
      return;
    }

    let changed = false;
    for (const agent of [...agents.values()]) {
      if (now - agent.lastSeen >= config.agents.staleAfterMs) {
        removeAgent(agent, "stale");
        continue;
      }
      if (agent.status === "active" && now - agent.activityAt >= config.agents.idleTimeoutMs) {
        agent.status = "idle";
        addLog(`AGENT IDLE ${agent.id} "${agent.label}"`);
        changed = true;
      }
    }
    if (changed) scheduleBroadcast();
  }

  const sweepTimer = setInterval(sweep, sweepIntervalMs);
  sweepTimer.unref();

  const keepaliveTimer = setInterval(() => {
    for (const res of sseClients) sendFrame(res, ": keepalive\n\n");
  }, KEEPALIVE_INTERVAL_MS);
  keepaliveTimer.unref();

  // ─── HTTP app ──────────────────────────────────────────────────────────

  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");

  function deny(res: Response, status: number, error: string): void {
    res.status(status).json({ error });
  }

  function isPublicRoute(req: Request): boolean {
    return (req.method === "GET" || req.method === "HEAD") && (req.path === "/.identity" || req.path === "/ping");
  }

  function hasValidToken(req: Request): boolean {
    const auth = req.headers.authorization;
    if (typeof auth === "string") {
      const m = /^Bearer +(\S+) *$/i.exec(auth);
      if (m && tokensEqual(m[1], token)) return true;
    }
    // EventSource cannot set headers, so the SSE stream may pass ?token=.
    if (req.method === "GET" && req.path === "/events" && typeof req.query.token === "string") {
      return tokensEqual(req.query.token, token);
    }
    return false;
  }

  function hasBody(req: Request): boolean {
    if (req.headers["transfer-encoding"] !== undefined) return true;
    const len = Number(req.headers["content-length"]);
    return Number.isFinite(len) && len > 0;
  }

  // Request filtering, in contract order. No Access-Control-* header is ever
  // sent: extension pages have host_permissions and Node wrappers need no CORS.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Cache-Control", "no-store");

    // 1. DNS-rebinding guard: only loopback names for the port we listen on.
    const port = req.socket.localPort;
    const host = (req.headers.host || "").toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return deny(res, 403, "forbidden_host");

    // 2. Browsers attach Origin to cross-origin requests; only the extension may talk to us.
    const origin = req.headers.origin;
    const fromExtension = typeof origin === "string" && origin.startsWith("chrome-extension://");
    if (origin !== undefined && !fromExtension) return deny(res, 403, "forbidden_origin");
    if (req.method === "OPTIONS") {
      if (fromExtension) return void res.status(204).end();
      return deny(res, 403, "forbidden_origin");
    }

    // 3. Shared-secret auth for everything except the liveness probes.
    if (!isPublicRoute(req) && !hasValidToken(req)) return deny(res, 401, "unauthorized");

    // 4. Bodies must be JSON (a cross-site form can't send that without a preflight).
    const mutating = req.method === "POST" || req.method === "PUT" || req.method === "PATCH";
    if (mutating && hasBody(req) && !req.is("application/json")) return deny(res, 415, "unsupported_media_type");

    next();
  });

  app.use(express.json({ limit: "1mb" }));

  // ─── Identity & lifecycle ──────────────────────────────────────────────

  app.get("/.identity", (req: Request, res: Response) => {
    const identity: IdentityPayload & { proof?: string } = {
      identity: SERVER_IDENTITY,
      version,
      protocol: PROTOCOL_VERSION,
      pid: process.pid,
    };
    // Anyone can claim to be us on this port; only the real server knows the
    // token, so it proves itself with HMAC(token, challenge) without revealing it.
    const challenge = req.query.challenge;
    if (typeof challenge === "string" && CHALLENGE_RE.test(challenge)) {
      identity.proof = crypto.createHmac("sha256", token).update(challenge).digest("hex");
    }
    res.json(identity);
  });

  app.get("/ping", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // Graceful stop (Windows has no catchable SIGTERM): answer first, then
  // close() so recordings are written, then let server.ts exit.
  app.post("/shutdown", (_req: Request, res: Response) => {
    addLog("SHUTDOWN requested over HTTP");
    // "close" fires once the response is flushed (or the client went away).
    res.once("close", () => {
      setTimeout(() => {
        close();
        opts.onShutdown?.();
      }, SHUTDOWN_DELAY_MS);
    });
    res.status(202).json({ success: true });
  });

  // ─── Agents ────────────────────────────────────────────────────────────

  app.post("/agents", (req: Request, res: Response) => {
    const body = readBody(req);
    const clientName = optString(body.clientName, "clientName", MAX_NAME_LEN);
    const clientVersion = optString(body.clientVersion, "clientVersion", MAX_NAME_LEN);
    const label = optString(body.label, "label", MAX_NAME_LEN);
    const previousAgentId = body.previousAgentId;
    if (previousAgentId !== undefined && previousAgentId !== null) {
      if (typeof previousAgentId !== "string" || !AGENT_ID_RE.test(previousAgentId)) badRequest("previousAgentId must be 8 hex chars");
    }

    // A wrapper reconnecting after its agent was reaped (or after a server
    // hiccup) comes back as the same agent: same id, look and halt state.
    const prevId = typeof previousAgentId === "string" ? previousAgentId : undefined;
    const live = prevId ? agents.get(prevId) : undefined;
    if (live) {
      live.lastSeen = Date.now();
      return void res.status(200).json({ agent: toPublic(live) });
    }
    if (agents.size >= MAX_AGENTS) throw new HttpError(429, "too_many_agents");
    const tomb = prevId ? liveTombstone(prevId) : undefined;
    if (tomb) tombstones.delete(tomb.id);

    const now = Date.now();
    const agent: Agent = {
      id: tomb?.id ?? newAgentId(),
      clientName: clientName ?? tomb?.clientName ?? "",
      clientVersion: clientVersion ?? tomb?.clientVersion ?? "",
      label: tomb?.label ?? (label || defaultLabel(clientName ?? "")),
      color: tomb?.color ?? pickColor(),
      taskName: tomb?.taskName ?? "",
      status: "idle",
      halted: tomb?.halted ?? false,
      tabs: [],
      currentPageId: null,
      actions: [],
      recording: [],
      createdAt: now,
      lastActionAt: null,
      activityAt: now,
      lastSeen: now,
    };
    agents.set(agent.id, agent);

    const client = `${agent.clientName || "unknown client"} ${agent.clientVersion}`.trimEnd();
    addLog(`AGENT ${tomb ? "RESTORE" : "REGISTER"} ${agent.id} "${agent.label}" (${client})${agent.halted ? " [halted]" : ""}`);
    scheduleBroadcast();
    res.status(201).json({ agent: toPublic(agent) });
  });

  app.get("/agents/:id", (req: Request, res: Response) => {
    res.json({ agent: toPublic(requireAgent(req)) });
  });

  app.patch("/agents/:id", (req: Request, res: Response) => {
    const agent = requireAgent(req);
    const body = readBody(req);
    const label = optString(body.label, "label", MAX_NAME_LEN);
    const taskName = optString(body.taskName, "taskName", MAX_TASK_LEN);
    if (body.status !== undefined && body.status !== "active" && body.status !== "idle") {
      badRequest('status must be "active" or "idle"');
    }

    if (label) agent.label = label;
    if (taskName !== undefined && taskName !== agent.taskName) {
      agent.taskName = taskName;
      addLog(`AGENT TASK ${agent.id} "${agent.label}": ${taskName || "(cleared)"}`);
    }
    if (body.status === "idle") agent.status = "idle";
    // A halted agent stays idle until the user resumes it.
    if (body.status === "active" && !agent.halted) {
      agent.status = "active";
      agent.activityAt = Date.now();
    }

    scheduleBroadcast();
    res.json({ agent: toPublic(agent) });
  });

  app.post("/agents/:id/heartbeat", (req: Request, res: Response) => {
    res.json({ agent: toPublic(requireAgent(req)) });
  });

  app.delete("/agents/:id", (req: Request, res: Response) => {
    removeAgent(requireAgent(req), "disconnected");
    res.json({ success: true });
  });

  app.put("/agents/:id/tabs", (req: Request, res: Response) => {
    const agent = requireAgent(req);
    const body = readBody(req);
    if (!Array.isArray(body.tabs)) badRequest("tabs must be an array");
    if (body.tabs.length > MAX_TABS) badRequest(`at most ${MAX_TABS} tabs`);
    if (body.currentPageId !== undefined && body.currentPageId !== null && !isInt(body.currentPageId)) {
      badRequest("currentPageId must be an integer or null");
    }
    const incoming = body.tabs.map(parseTab);

    // The server is the only source of tab ids (learned via /tabs/claim): every
    // page keeps the id we already know for it, or none. This way a wrapper
    // can't resurrect a closed tab, override a claim, or bind a user's tab.
    const known = new Map<number, OwnedTab>();
    for (const t of agent.tabs) if (t.tabId !== null) known.set(t.pageId, t);

    const kept: OwnedTab[] = [];
    const conflicts: number[] = [];
    const seenPageIds = new Set<number>();
    const reclaim: number[] = [];
    for (const tab of incoming) {
      if (seenPageIds.has(tab.pageId)) continue; // duplicate pageId: first wins
      seenPageIds.add(tab.pageId);
      const prev = known.get(tab.pageId);
      if (prev) {
        // The page left the origin it was claimed from: whoever answered that
        // claim must not keep the agent's feed, so the wrapper has to re-claim.
        const origin = urlOrigin(tab.url);
        if (prev.claimedOrigin !== null && origin !== null && origin !== prev.claimedOrigin) {
          reclaim.push(tab.pageId);
        } else {
          tab.tabId = prev.tabId;
          tab.claimedOrigin = prev.claimedOrigin;
        }
      }
      if (tab.tabId !== null) {
        // Can't normally happen (claims check ownership), kept as a safety net.
        const owner = tabOwner(tab.tabId);
        if (owner && owner !== agent) {
          conflicts.push(tab.tabId);
          continue;
        }
      }
      kept.push(tab);
    }

    agent.tabs = kept;
    const current = isInt(body.currentPageId) ? body.currentPageId : null;
    agent.currentPageId = current !== null && kept.some((t) => t.pageId === current) ? current : null;

    if (conflicts.length) addLog(`TABS CONFLICT ${agent.id}: tab(s) ${conflicts.join(", ")} owned by another agent`);
    if (reclaim.length) debugLog(`TABS ${agent.id}: page(s) ${reclaim.join(", ")} changed origin; tab id dropped`);
    scheduleBroadcast();
    res.json({ agent: toPublic(agent), conflicts });
  });

  app.post("/agents/:id/claims", (req: Request, res: Response) => {
    const agent = requireAgent(req);
    const body = readBody(req);
    if (typeof body.nonce !== "string" || !NONCE_RE.test(body.nonce)) badRequest("nonce must be 32 lowercase hex chars");
    if (!isInt(body.pageId)) badRequest("pageId must be an integer");
    const origin = optOrigin(body.origin);

    const existing = claims.get(body.nonce);
    if (existing && existing.agentId !== agent.id) throw new HttpError(409, "claim_exists");

    // Bound memory: drop this agent's oldest pending claims beyond the cap.
    const mine = [...claims.entries()].filter(([, c]) => c.agentId === agent.id);
    for (const [nonce] of mine.slice(0, Math.max(0, mine.length - MAX_CLAIMS_PER_AGENT + 1))) claims.delete(nonce);

    claims.set(body.nonce, { agentId: agent.id, pageId: body.pageId, origin, expiresAt: Date.now() + claimTtlMs });
    res.json({ success: true });
  });

  app.post("/agents/:id/actions", (req: Request, res: Response) => {
    const agent = requireAgent(req);
    const body = readBody(req);
    if (agent.halted) return void res.status(423).json({ error: "halted", agent: toPublic(agent) });

    const silent = body.silent === true;
    const text = optString(body.text, "text", MAX_TEXT_LEN);
    const redactedText = optString(body.redactedText, "redactedText", MAX_TEXT_LEN);
    const type = optString(body.type, "type", MAX_TYPE_LEN) || "default";
    if (!silent && !text) badRequest("text is required");

    const now = Date.now();
    agent.status = "active";
    agent.lastActionAt = now;
    agent.activityAt = now;
    agent.lastSeen = now;

    if (!silent && text) {
      const timestamp = iso(now);
      // Never persist raw typed text: fall back to a length-only form when the
      // caller did not supply an explicit redactedText. This keeps the
      // "typed text is never persisted" contract even if a future caller
      // omits redactedText.
      const safeText = redactedText ?? `(${text.length} chars)`;
      agent.actions.push({ text: safeText, type, timestamp });
      if (agent.actions.length > MAX_ACTIONS_KEPT) agent.actions.splice(0, agent.actions.length - MAX_ACTIONS_KEPT);
      agent.recording.push({ type, text: safeText, timestamp });
      if (agent.recording.length > MAX_RECORDED_ACTIONS) agent.recording.shift();
      addLog(`ACTION ${agent.id} [${type}] ${safeText}`);
    }

    scheduleBroadcast();
    res.json({ agent: toPublic(agent) });
  });

  // Halt / resume come from the user (side panel, overlay), not the wrapper,
  // so they don't count as a sign of life for stale reaping.
  app.post("/agents/:id/halt", (req: Request, res: Response) => {
    const agent = requireAgent(req, false);
    haltAgent(agent, "user");
    scheduleBroadcast();
    res.json({ agent: toPublic(agent) });
  });

  app.post("/agents/:id/resume", (req: Request, res: Response) => {
    const agent = requireAgent(req, false);
    if (agent.halted) addLog(`RESUME ${agent.id} "${agent.label}"`);
    agent.halted = false;
    scheduleBroadcast();
    res.json({ agent: toPublic(agent) });
  });

  app.post("/halt-all", (_req: Request, res: Response) => {
    for (const agent of agents.values()) haltAgent(agent, "halt all");
    scheduleBroadcast();
    res.json({ success: true });
  });

  // ─── Tabs (called by the extension service worker) ─────────────────────

  app.post("/tabs/claim", (req: Request, res: Response) => {
    const body = readBody(req);
    if (typeof body.nonce !== "string" || !NONCE_RE.test(body.nonce)) badRequest("nonce must be 32 lowercase hex chars");
    if (!isInt(body.tabId) || body.tabId < 0) badRequest("tabId must be a non-negative integer");
    const tabId = body.tabId;
    const origin = optOrigin(body.origin);

    const claim = claims.get(body.nonce);
    const agent = claim && claim.expiresAt > Date.now() ? agents.get(claim.agentId) : undefined;
    if (!claim || !agent) {
      if (claim) claims.delete(body.nonce);
      throw new HttpError(404, "unknown_claim");
    }
    // The nonce was posted from the page the wrapper navigated; a different
    // origin means some other page replayed it. Leave it pending.
    if (claim.origin !== null && claim.origin !== origin) throw new HttpError(409, "origin_mismatch");
    const owner = tabOwner(tabId);
    if (owner && owner !== agent) throw new HttpError(409, "tab_owned");
    const entry = agent.tabs.find((t) => t.pageId === claim.pageId);
    if (!entry && agent.tabs.length >= MAX_TABS) throw new HttpError(409, "too_many_tabs");

    // A chrome tab maps to exactly one page of this agent.
    for (const t of agent.tabs) {
      if (t.tabId === tabId && t.pageId !== claim.pageId) {
        t.tabId = null;
        t.claimedOrigin = null;
      }
    }
    const claimedOrigin = claim.origin ?? origin;
    if (entry) {
      entry.tabId = tabId;
      entry.claimedOrigin = claimedOrigin;
    } else {
      agent.tabs.push({ pageId: claim.pageId, tabId, url: "", title: "", claimedOrigin });
    }
    claims.delete(body.nonce);

    debugLog(`TAB CLAIM ${agent.id}: page ${claim.pageId} → tab ${tabId}`);
    scheduleBroadcast();
    res.json({ success: true, agentId: agent.id });
  });

  app.post("/tabs/:tabId/halt", (req: Request, res: Response) => {
    const owner = tabOwner(parseTabIdParam(String(req.params.tabId)));
    if (!owner) throw new HttpError(404, "unknown_tab");
    haltAgent(owner, "tab overlay");
    scheduleBroadcast();
    res.json({ agent: toPublic(owner) });
  });

  app.post("/tabs/:tabId/closed", (req: Request, res: Response) => {
    const tabId = parseTabIdParam(String(req.params.tabId));
    const owner = tabOwner(tabId);
    if (owner) {
      const removed = owner.tabs.filter((t) => t.tabId === tabId);
      owner.tabs = owner.tabs.filter((t) => t.tabId !== tabId);
      if (removed.some((t) => t.pageId === owner.currentPageId)) owner.currentPageId = null;
      scheduleBroadcast();
    }
    res.json({ success: true });
  });

  // ─── State, events, logs ───────────────────────────────────────────────

  app.get("/state", (_req: Request, res: Response) => {
    res.json(buildState());
  });

  // Express would route HEAD to the GET handler and register a stream that
  // never gets a body; just answer with the headers.
  app.head("/events", (_req: Request, res: Response) => {
    res.status(200).set("Content-Type", "text/event-stream; charset=utf-8").end();
  });

  app.get("/events", (req: Request, res: Response) => {
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    res.write(stateFrame());

    sseClients.add(res);
    debugLog("SSE client connected (total: " + sseClients.size + ")");
    req.on("close", () => {
      sseClients.delete(res);
      debugLog("SSE client disconnected (total: " + sseClients.size + ")");
    });
  });

  app.get("/logs", (req: Request, res: Response) => {
    const since = typeof req.query.since === "string" ? Date.parse(req.query.since) : NaN;
    const logs = Number.isNaN(since) ? logBuffer.slice() : logBuffer.filter((l) => Date.parse(l.timestamp) > since);
    res.json({ logs });
  });

  // ─── Fallbacks ─────────────────────────────────────────────────────────
  // JSON only — never echo request data back into an HTML error page.

  app.use((_req: Request, res: Response) => {
    deny(res, 404, "not_found");
  });

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) {
      return void res.status(err.status).json(err.detail ? { error: err.code, detail: err.detail } : { error: err.code });
    }
    // body-parser errors. Never log their messages: a JSON SyntaxError quotes
    // the request body, which may contain typed text.
    const e = err as { type?: string; status?: number };
    if (e.type === "entity.too.large") return deny(res, 413, "payload_too_large");
    if (e.type === "entity.parse.failed") return deny(res, 400, "invalid_json");
    if (typeof e.status === "number" && e.status >= 400 && e.status < 500) {
      return deny(res, e.status, e.status === 415 ? "unsupported_media_type" : "bad_request");
    }
    addLog(`ERROR ${req.method} ${req.path}: ${err instanceof Error ? err.message : String(err)}`);
    deny(res, 500, "internal_error");
  });

  // ─── Shutdown ──────────────────────────────────────────────────────────

  function close(): void {
    if (closed) return;
    clearInterval(sweepTimer);
    clearInterval(keepaliveTimer);
    if (broadcastTimer) clearTimeout(broadcastTimer);
    broadcastTimer = null;
    closed = true; // removeAgent → scheduleBroadcast is now a no-op
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    sseClients.clear();
    // The server is going away, so every session ends here: keep their recordings.
    for (const agent of [...agents.values()]) removeAgent(agent, "server shutdown");
    claims.clear();
  }

  return { app, close };
}
