// Coordination server tests (node:test, no extra deps).
// Run after `npm run build`: node --test test/server.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// WEB_MCP_HOME must be set before paths.js is evaluated: PATHS is computed at import time.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "web-mcp-test-"));
process.env.WEB_MCP_HOME = HOME;

const { createApp } = await import("../dist/server/app.js");
const { PATHS, DEFAULT_CONFIG, PROTOCOL_VERSION } = await import("../dist/shared/paths.js");

const SERVER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "server", "server.js");
const TOKEN = crypto.randomBytes(32).toString("hex");
const SECRET = "hunter2-SECRET-typed-value";
const LOG_FILE = path.join(PATHS.logsDir, "server.log");

const servers = [];
const extraDirs = [];

after(async () => {
  for (const s of servers) await s.stop();
  for (const dir of [HOME, ...extraDirs]) fs.rmSync(dir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 3000, interval = 20) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await sleep(interval);
  }
}

function assertNoCors(headers) {
  const names = typeof headers.keys === "function" ? [...headers.keys()] : Object.keys(headers);
  for (const name of names) {
    assert.ok(!name.toLowerCase().startsWith("access-control-"), `unexpected CORS header ${name}`);
  }
}

const nonce = () => crypto.randomBytes(16).toString("hex");
const hmac = (key, msg) => crypto.createHmac("sha256", key).update(msg).digest("hex");

async function startServer({ agents = {}, sweepIntervalMs, claimTtlMs, onShutdown } = {}) {
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config.agents, agents);
  const { app, close } = createApp({ token: TOKEN, config, version: "0.0.0-test", sweepIntervalMs, claimTtlMs, onShutdown });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let stopped = false;

  const ctx = {
    port,
    base,
    async stop() {
      if (stopped) return;
      stopped = true;
      close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
    /** fetch wrapper: JSON body, bearer token by default, asserts no CORS headers. */
    async request(method, urlPath, { body, headers = {}, auth = true } = {}) {
      const h = { ...headers };
      if (auth) h.authorization = `Bearer ${TOKEN}`;
      let payload;
      if (body !== undefined) {
        if (!Object.keys(h).some((k) => k.toLowerCase() === "content-type")) h["content-type"] = "application/json";
        payload = typeof body === "string" ? body : JSON.stringify(body);
      }
      const res = await fetch(base + urlPath, { method, headers: h, body: payload });
      assertNoCors(res.headers);
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, headers: res.headers, json, text };
    },
  };
  servers.push(ctx);
  return ctx;
}

/** http.request lets us set Host (fetch forbids it). */
function rawRequest(port, { method = "GET", urlPath = "/ping", headers = {}, setHost = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers, setHost }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

function canConnect(host, port, timeout = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function register(s, body = { clientName: "claude-code", clientVersion: "1.0.0" }) {
  const r = await s.request("POST", "/agents", { body });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.agent;
}

const act = (s, id, body = { text: "Clicked button", type: "click" }) => s.request("POST", `/agents/${id}/actions`, { body });
const putTabs = (s, id, tabs, currentPageId = null) => s.request("PUT", `/agents/${id}/tabs`, { body: { tabs, currentPageId } });
const getState = async (s) => (await s.request("GET", "/state")).json;
const getAgent = async (s, id) => (await s.request("GET", `/agents/${id}`)).json.agent;
const tab = (pageId, url = "https://example.com/" + pageId) => ({ pageId, url, title: "Page " + pageId });

/** Wrapper registers a claim nonce for pageId, the extension reports it from tabId. */
async function claimTab(s, agentId, pageId, tabId, { origin, tabOrigin } = {}) {
  const n = nonce();
  const reg = await s.request("POST", `/agents/${agentId}/claims`, { body: { nonce: n, pageId, origin } });
  assert.equal(reg.status, 200);
  const r = await s.request("POST", "/tabs/claim", { body: { nonce: n, tabId, origin: tabOrigin } });
  return { ...r, nonce: n };
}

/** PUTs the pages, then claims a chrome tab id for each [pageId, tabId] pair with a non-null tabId. */
async function giveTabs(s, agentId, pairs, currentPageId = null) {
  await putTabs(s, agentId, pairs.map(([pageId]) => tab(pageId)), currentPageId);
  for (const [pageId, tabId] of pairs) {
    if (tabId !== null) assert.equal((await claimTab(s, agentId, pageId, tabId)).status, 200);
  }
}

function recordingFiles() {
  if (!fs.existsSync(PATHS.recordingsDir)) return [];
  return fs.readdirSync(PATHS.recordingsDir).filter((f) => f.endsWith(".json"));
}

/** Opens GET /events and returns a reader for `event: state` frames. */
async function openEvents(s, query = `?token=${TOKEN}`, headers = {}) {
  const ac = new AbortController();
  const res = await fetch(s.base + "/events" + query, { headers, signal: ac.signal });
  assertNoCors(res.headers);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  async function nextState(predicate = () => true, timeout = 3000) {
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      for (;;) {
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = frame.split("\n");
          if (lines[0] !== "event: state") continue; // keepalive comments etc.
          assert.ok(lines[1].startsWith("data: "));
          const data = JSON.parse(lines[1].slice(6));
          if (predicate(data)) return data;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE stream ended");
        buf += decoder.decode(value, { stream: true });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return { res, nextState, close: () => ac.abort() };
}

// ─── Request filtering ───────────────────────────────────────────────────

test("identity and ping need no token", async () => {
  const s = await startServer();
  const id = await s.request("GET", "/.identity", { auth: false });
  assert.equal(id.status, 200);
  assert.deepEqual(id.json, { identity: "web-mcp-server", version: "0.0.0-test", protocol: PROTOCOL_VERSION, pid: process.pid });
  assert.equal(PROTOCOL_VERSION, 2);

  const ping = await s.request("GET", "/ping", { auth: false });
  assert.equal(ping.status, 200);
  assert.deepEqual(ping.json, { status: "ok" });
  assert.equal(ping.headers.get("x-powered-by"), null);
});

test("identity proves knowledge of the token with HMAC(token, challenge)", async () => {
  const s = await startServer();
  const challenge = crypto.randomBytes(32).toString("hex");
  const r = await s.request("GET", `/.identity?challenge=${challenge}`, { auth: false });
  assert.equal(r.status, 200);
  assert.equal(r.json.identity, "web-mcp-server");
  assert.equal(r.json.proof, hmac(TOKEN, challenge));
  assert.ok(!r.text.includes(TOKEN));

  // invalid challenges are ignored: no proof at all
  for (const bad of ["", "abc", challenge.toUpperCase(), challenge + "0", challenge.slice(1)]) {
    const x = await s.request("GET", `/.identity?challenge=${bad}`, { auth: false });
    assert.equal(x.status, 200);
    assert.equal("proof" in x.json, false, bad);
  }
  const twice = await s.request("GET", `/.identity?challenge=${challenge}&challenge=${challenge}`, { auth: false });
  assert.equal("proof" in twice.json, false);
});

test("everything else needs the bearer token (401)", async () => {
  const s = await startServer();
  assert.equal((await s.request("GET", "/state", { auth: false })).status, 401);
  assert.equal((await s.request("GET", "/state", { auth: false, headers: { authorization: "Bearer " + "0".repeat(64) } })).status, 401);
  assert.equal((await s.request("GET", "/state", { auth: false, headers: { authorization: TOKEN } })).status, 401);
  assert.equal((await s.request("POST", "/agents", { auth: false, body: {} })).status, 401);
  assert.equal((await s.request("POST", "/halt-all", { auth: false })).status, 401);
  assert.equal((await s.request("POST", "/shutdown", { auth: false })).status, 401);
  assert.equal((await s.request("GET", "/logs", { auth: false })).status, 401);
  // ?token= is only accepted for the SSE stream
  assert.equal((await s.request("GET", `/state?token=${TOKEN}`, { auth: false })).status, 401);
  assert.equal((await s.request("GET", "/events?token=wrong", { auth: false })).status, 401);
  assert.equal((await s.request("GET", "/events", { auth: false })).status, 401);

  const ok = await s.request("GET", "/state");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.error, undefined);
});

test("web origins are rejected even with a valid token (403)", async () => {
  const s = await startServer();
  for (const origin of ["https://evil.example", "null", "http://127.0.0.1:" + s.port, "moz-extension://abc"]) {
    const r = await s.request("GET", "/state", { headers: { origin } });
    assert.equal(r.status, 403, origin);
    assert.equal(r.json.error, "forbidden_origin");
  }
  // also the unauthenticated routes and mutations
  assert.equal((await s.request("GET", "/.identity", { auth: false, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await s.request("POST", "/halt-all", { headers: { origin: "https://evil.example" } })).status, 403);

  const ext = await s.request("GET", "/state", { headers: { origin: "chrome-extension://abcdefghijklmnop" } });
  assert.equal(ext.status, 200);
});

test("OPTIONS: 204 for the extension, 403 otherwise, never CORS headers", async () => {
  const s = await startServer();
  const evil = await s.request("OPTIONS", "/agents", { auth: false, headers: { origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  const noOrigin = await s.request("OPTIONS", "/agents", { auth: false });
  assert.equal(noOrigin.status, 403);
  const ext = await s.request("OPTIONS", "/agents", {
    auth: false,
    headers: { origin: "chrome-extension://abcdefghijklmnop", "access-control-request-method": "POST" },
  });
  assert.equal(ext.status, 204);
  // assertNoCors runs inside request(); check explicitly once more for clarity
  assert.equal(ext.headers.get("access-control-allow-origin"), null);
});

test("bad Host header is rejected (DNS-rebinding guard)", async () => {
  const s = await startServer();
  const auth = { authorization: `Bearer ${TOKEN}` };
  const cases = [
    { headers: { Host: "evil.example:1234" }, status: 403 },
    { headers: { Host: `evil.example:${s.port}` }, status: 403 },
    { headers: { Host: "127.0.0.1:1" }, status: 403 },
    { headers: { Host: "127.0.0.1" }, status: 403 },
    // no Host at all: Node's HTTP/1.1 parser already answers 400 (requireHostHeader)
    { headers: {}, setHost: false, status: 400 },
    { headers: { Host: `localhost:${s.port}` }, status: 200 },
    { headers: { Host: `127.0.0.1:${s.port}` }, status: 200 },
  ];
  for (const c of cases) {
    for (const urlPath of ["/ping", "/state"]) {
      const r = await rawRequest(s.port, { urlPath, headers: { ...c.headers, ...auth }, setHost: c.setHost ?? true });
      assert.equal(r.status, c.status, `${JSON.stringify(c.headers)} ${urlPath}`);
      assertNoCors(r.headers);
      if (c.status === 403) assert.equal(JSON.parse(r.body).error, "forbidden_host");
      if (c.status === 200 && urlPath === "/state") assert.equal(JSON.parse(r.body).protocol, 2);
    }
  }
});

test("bodies must be JSON and at most 1 MB", async () => {
  const s = await startServer();
  const text = await s.request("POST", "/agents", { body: "clientName=x", headers: { "content-type": "text/plain" } });
  assert.equal(text.status, 415);
  const form = await s.request("POST", "/agents", { body: "a=b", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(form.status, 415);

  const big = await s.request("POST", "/agents", { body: JSON.stringify({ label: "x".repeat(1024 * 1024 + 10) }) });
  assert.equal(big.status, 413);
  assert.equal(big.json.error, "payload_too_large");

  const bad = await s.request("POST", "/agents", { body: "{not json" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "invalid_json");
  const arr = await s.request("POST", "/agents", { body: "[]" });
  assert.equal(arr.status, 400);

  // body-less POSTs (heartbeat, halt) need no content type
  const agent = await register(s);
  assert.equal((await s.request("POST", `/agents/${agent.id}/heartbeat`)).status, 200);
  // unknown route → JSON 404, not HTML
  const missing = await s.request("GET", "/nope");
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { error: "not_found" });
});

// ─── Agents ──────────────────────────────────────────────────────────────

test("registration: ids, default labels, colors, lookup", async () => {
  const s = await startServer();
  const a = await register(s, { clientName: "claude-code", clientVersion: "2.0.1" });
  const b = await register(s, { clientName: "claude-code" });
  const c = await register(s, { clientName: "cursor-vscode" });
  const d = await register(s, {});
  const e = await register(s, { clientName: "my-tool", label: "Research bot" });
  const f = await register(s, { clientName: "my-tool" });

  assert.match(a.id, /^[0-9a-f]{8}$/);
  assert.equal(a.label, "Claude Code #1");
  assert.equal(b.label, "Claude Code #2");
  assert.equal(c.label, "Cursor #1");
  assert.equal(d.label, "Agent #1");
  assert.equal(e.label, "Research bot");
  assert.equal(f.label, "my-tool #1");
  assert.deepEqual([a, b, c, d, e, f].map((x) => x.color), ["#4b8eff", "#34c759", "#ff9f0a", "#bf5af2", "#ff375f", "#64d2ff"]);
  assert.equal(a.clientVersion, "2.0.1");
  assert.equal(a.status, "idle");
  assert.equal(a.halted, false);
  assert.deepEqual(a.tabs, []);
  assert.equal(a.lastActionAt, null);

  // a freed color is reused first
  assert.equal((await s.request("DELETE", `/agents/${b.id}`)).status, 200);
  const g = await register(s, { clientName: "codex-mcp-client" });
  assert.equal(g.color, "#34c759");
  assert.equal(g.label, "Codex #1");

  assert.equal((await getAgent(s, a.id)).id, a.id);
  const unknown = await s.request("GET", "/agents/deadbeef");
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.json, { error: "unknown_agent" });
});

test("PATCH updates label/taskName/status and validates input", async () => {
  const s = await startServer();
  const a = await register(s);
  const r = await s.request("PATCH", `/agents/${a.id}`, { body: { label: "Shopper", taskName: "Buy milk", status: "active" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.agent.label, "Shopper");
  assert.equal(r.json.agent.taskName, "Buy milk");
  assert.equal(r.json.agent.status, "active");
  assert.equal((await s.request("PATCH", `/agents/${a.id}`, { body: { status: "running" } })).status, 400);
  assert.equal((await s.request("PATCH", `/agents/${a.id}`, { body: { label: 42 } })).status, 400);
});

test("actions, halt → 423, resume", async () => {
  const s = await startServer();
  const a = await register(s);

  const first = await act(s, a.id, { text: "Navigated to example.com", type: "navigate" });
  assert.equal(first.status, 200);
  assert.equal(first.json.agent.status, "active");
  assert.equal(first.json.agent.actions.length, 1);
  assert.equal(first.json.agent.actions[0].text, "(24 chars)");
  assert.equal(first.json.agent.actions[0].type, "navigate");
  assert.ok(first.json.agent.lastActionAt);

  // silent actions keep the agent active but are not listed
  const silent = await act(s, a.id, { silent: true });
  assert.equal(silent.status, 200);
  assert.equal(silent.json.agent.actions.length, 1);
  assert.equal((await act(s, a.id, { type: "click" })).status, 400); // text required unless silent

  const halted = await s.request("POST", `/agents/${a.id}/halt`);
  assert.equal(halted.status, 200);
  assert.equal(halted.json.agent.halted, true);
  assert.equal(halted.json.agent.status, "idle");

  const blocked = await act(s, a.id);
  assert.equal(blocked.status, 423);
  assert.equal(blocked.json.error, "halted");
  assert.equal(blocked.json.agent.id, a.id);
  assert.equal(blocked.json.agent.actions.length, 1); // nothing appended

  const resumed = await s.request("POST", `/agents/${a.id}/resume`);
  assert.equal(resumed.json.agent.halted, false);
  const again = await act(s, a.id);
  assert.equal(again.status, 200);
  assert.equal(again.json.agent.status, "active");

  // only the last 20 are exposed
  for (let i = 0; i < 30; i++) await act(s, a.id, { text: "step " + i, type: "click" });
  const agent = await getAgent(s, a.id);
  assert.equal(agent.actions.length, 20);
  assert.equal(agent.actions[19].text, "(7 chars)");
});

test("halt is sticky (does not expire) and halt-all halts everyone", async () => {
  const s = await startServer({ agents: { idleTimeoutMs: 50, staleAfterMs: 60_000 }, sweepIntervalMs: 20 });
  const a = await register(s);
  const b = await register(s);
  await act(s, a.id);
  await s.request("POST", `/agents/${a.id}/halt`);
  await sleep(400); // many sweeps and idle timeouts later…
  assert.equal((await act(s, a.id)).status, 423);
  const patched = await s.request("PATCH", `/agents/${a.id}`, { body: { status: "active" } });
  assert.equal(patched.json.agent.status, "idle");
  assert.equal(patched.json.agent.halted, true);
  assert.equal((await act(s, a.id)).status, 423);
  assert.equal((await act(s, b.id)).status, 200);

  assert.deepEqual((await s.request("POST", "/halt-all")).json, { success: true });
  assert.equal((await act(s, b.id)).status, 423);
  const state = await getState(s);
  assert.ok(state.agents.every((x) => x.halted && x.status === "idle"));
});

test("a reaped halted agent comes back halted via previousAgentId", async () => {
  const s = await startServer({ agents: { staleAfterMs: 400, idleTimeoutMs: 60_000 }, sweepIntervalMs: 50 });
  const a = await register(s, { clientName: "claude-code", clientVersion: "1.0.0" });
  await s.request("PATCH", `/agents/${a.id}`, { body: { taskName: "Book flights" } });
  await act(s, a.id);
  await s.request("POST", `/agents/${a.id}/halt`);

  // the wrapper goes quiet (laptop asleep, process frozen…) and gets reaped
  await waitFor(async () => !(await getState(s)).agents.some((x) => x.id === a.id));

  const back = await s.request("POST", "/agents", { body: { clientName: "claude-code", clientVersion: "1.0.1", previousAgentId: a.id } });
  assert.equal(back.status, 201);
  const agent = back.json.agent;
  assert.equal(agent.id, a.id);
  assert.equal(agent.label, a.label);
  assert.equal(agent.color, a.color);
  assert.equal(agent.taskName, "Book flights");
  assert.equal(agent.clientVersion, "1.0.1");
  assert.equal(agent.halted, true);
  assert.equal(agent.status, "idle");
  assert.equal((await act(s, a.id)).status, 423); // the halt survived

  // previousAgentId of a live agent returns that agent (200), no duplicate
  const live = await s.request("POST", "/agents", { body: { clientName: "claude-code", previousAgentId: a.id } });
  assert.equal(live.status, 200);
  assert.equal(live.json.agent.id, a.id);
  assert.equal((await getState(s)).agents.filter((x) => x.id === a.id).length, 1);

  // DELETE leaves a tombstone too
  await s.request("POST", `/agents/${a.id}/resume`);
  await s.request("DELETE", `/agents/${a.id}`);
  const again = await s.request("POST", "/agents", { body: { previousAgentId: a.id } });
  assert.equal(again.status, 201);
  assert.equal(again.json.agent.id, a.id);
  assert.equal(again.json.agent.halted, false);
  assert.equal(again.json.agent.label, a.label);

  // unknown previous id → a fresh agent; malformed → 400
  const fresh = await s.request("POST", "/agents", { body: { clientName: "cursor", previousAgentId: "0badf00d" } });
  assert.equal(fresh.status, 201);
  assert.notEqual(fresh.json.agent.id, "0badf00d");
  assert.equal(fresh.json.agent.label, "Cursor #1");
  assert.equal((await s.request("POST", "/agents", { body: { previousAgentId: "XYZ" } })).status, 400);
  assert.equal((await s.request("POST", "/agents", { body: { previousAgentId: 12345678 } })).status, 400);
});

test("clock jump (sleep/freeze) restarts timers instead of reaping or idling", async () => {
  const s = await startServer({ agents: { staleAfterMs: 300, idleTimeoutMs: 300 }, sweepIntervalMs: 50 });
  const a = await register(s);
  await act(s, a.id);

  // Freeze the event loop (the server runs in this process) like a laptop sleep.
  const until = Date.now() + 700;
  while (Date.now() < until) {
    // busy wait
  }
  await sleep(120); // let a couple of sweeps run

  const state = await getState(s);
  const agent = state.agents.find((x) => x.id === a.id);
  assert.ok(agent, "agent survived the clock jump");
  assert.equal(agent.status, "active");
  assert.ok((await s.request("GET", "/logs")).json.logs.some((l) => l.message.startsWith("Clock jump")));

  // with no heartbeats it is still reaped normally afterwards
  await waitFor(async () => !(await getState(s)).agents.some((x) => x.id === a.id));
});

test("limits: 64 live agents, tabs per agent, HEAD /events", async () => {
  const s = await startServer();
  const ids = [];
  for (let i = 0; i < 64; i++) ids.push((await register(s)).id);
  const over = await s.request("POST", "/agents", { body: {} });
  assert.equal(over.status, 429);
  assert.deepEqual(over.json, { error: "too_many_agents" });
  // reconnecting a live agent is still fine at the cap
  assert.equal((await s.request("POST", "/agents", { body: { previousAgentId: ids[0] } })).status, 200);
  await s.request("DELETE", `/agents/${ids[1]}`);
  assert.equal((await s.request("POST", "/agents", { body: {} })).status, 201);

  // claims count against the 500 tab entries of an agent
  const a = ids[2];
  const pages = Array.from({ length: 500 }, (_, i) => ({ pageId: i, url: "", title: "" }));
  assert.equal((await putTabs(s, a, pages)).status, 200);
  assert.equal((await putTabs(s, a, [...pages, { pageId: 500 }])).status, 400);
  const full = await claimTab(s, a, 1000, 42);
  assert.equal(full.status, 409);
  assert.deepEqual(full.json, { error: "too_many_tabs" });
  assert.equal((await claimTab(s, a, 3, 42)).status, 200); // existing page is fine

  // HEAD /events answers and ends instead of opening a stream
  const head = await fetch(s.base + "/events", { method: "HEAD", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

// ─── Tabs ────────────────────────────────────────────────────────────────

test("PUT tabs ignores wrapper-supplied tab ids and dedupes pages", async () => {
  const s = await startServer();
  const a = await register(s);
  const b = await register(s);
  await giveTabs(s, a.id, [[1, 101], [2, 102]], 2);
  assert.deepEqual((await getAgent(s, a.id)).tabs.map((t) => t.tabId), [101, 102]);

  // B can't bind A's tab (or any tab) by naming its id
  const rb = await putTabs(s, b.id, [{ pageId: 1, tabId: 102, url: "" }, { pageId: 2, tabId: 103, url: "" }], 1);
  assert.equal(rb.status, 200);
  assert.deepEqual(rb.json.conflicts, []);
  assert.deepEqual(rb.json.agent.tabs.map((t) => t.tabId), [null, null]);
  assert.equal(rb.json.agent.currentPageId, 1);
  let state = await getState(s);
  assert.equal(state.tabs["102"].agentId, a.id);
  assert.equal(state.tabs["103"], undefined);

  // A's own stale ids don't override what the server knows; duplicate pageIds: first wins
  const ra = await putTabs(s, a.id, [{ pageId: 2, tabId: 999, url: "https://example.com/first" }, { pageId: 2, url: "https://example.com/dup" }, { pageId: 3 }], 2);
  assert.deepEqual(ra.json.agent.tabs.map((t) => [t.pageId, t.tabId, t.url]), [
    [2, 102, "https://example.com/first"],
    [3, null, ""],
  ]);
  state = await getState(s);
  assert.equal(state.tabs["101"], undefined); // page 1 was dropped → tab released
  assert.equal(state.tabs["999"], undefined);

  // no ghost tabs: after the tab closes, re-sending its old id does not bring it back
  await s.request("POST", "/tabs/102/closed");
  const ghost = await putTabs(s, a.id, [{ pageId: 2, tabId: 102, url: "" }], 2);
  assert.deepEqual(ghost.json.agent.tabs.map((t) => t.tabId), [null]);
  assert.equal((await getState(s)).tabs["102"], undefined);

  assert.equal((await putTabs(s, a.id, "nope")).status, 400);
  assert.equal((await s.request("PUT", `/agents/${a.id}/tabs`, { body: { tabs: [{ pageId: "x" }] } })).status, 400);
  assert.equal((await s.request("PUT", `/agents/${a.id}/tabs`, { body: { tabs: [], currentPageId: "1" } })).status, 400);
});

test("/tabs/:tabId/halt halts the owning agent only", async () => {
  const s = await startServer();
  const a = await register(s);
  const b = await register(s);
  await giveTabs(s, a.id, [[1, 201]], 1);
  await giveTabs(s, b.id, [[1, 202]], 1);

  const r = await s.request("POST", "/tabs/201/halt");
  assert.equal(r.status, 200);
  assert.equal(r.json.agent.id, a.id);
  assert.equal(r.json.agent.halted, true);
  assert.equal((await act(s, a.id)).status, 423);
  assert.equal((await act(s, b.id)).status, 200);

  const unknown = await s.request("POST", "/tabs/999/halt");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error, "unknown_tab");
  assert.equal((await s.request("POST", "/tabs/abc/halt")).status, 400);
});

test("/tabs/:tabId/closed removes the tab and fixes currentPageId", async () => {
  const s = await startServer();
  const a = await register(s);
  await giveTabs(s, a.id, [[1, 301], [2, 302]], 2);
  assert.deepEqual((await s.request("POST", "/tabs/302/closed")).json, { success: true });
  const agent = await getAgent(s, a.id);
  assert.deepEqual(agent.tabs.map((t) => t.tabId), [301]);
  assert.equal(agent.currentPageId, null);
  assert.equal((await s.request("POST", "/tabs/12345/closed")).status, 200); // unknown tab is a no-op
});

test("/state maps owned tabs to minimal TabViews", async () => {
  const s = await startServer();
  const a = await register(s);
  const b = await register(s, { clientName: "opencode" });
  await giveTabs(s, a.id, [[1, 401], [2, 402], [3, null]], 2);
  await giveTabs(s, b.id, [[7, 403]], 7);
  await s.request("PATCH", `/agents/${a.id}`, { body: { taskName: "Compare prices" } });
  await act(s, a.id, { text: `Typed "${SECRET}" into #q`, redactedText: "Typed text (26 chars) into #q", type: "type" });

  const state = await getState(s);
  assert.equal(state.version, "0.0.0-test");
  assert.equal(state.protocol, 2);
  assert.equal(state.agents.length, 2);
  assert.deepEqual(Object.keys(state.tabs).sort(), ["401", "402", "403"]);

  // exactly these fields reach web pages: no task name, no action text
  assert.deepEqual(state.tabs["402"], {
    agentId: a.id,
    label: "Claude Code #1",
    color: a.color,
    status: "active",
    halted: false,
    lastActionType: "type",
    current: true,
  });
  assert.equal(state.tabs["401"].current, false);
  assert.equal(state.tabs["401"].lastActionType, null); // background tabs don't change on every action
  assert.equal(state.tabs["403"].agentId, b.id);
  assert.equal(state.tabs["403"].lastActionType, null); // b has no actions yet
  assert.ok(!JSON.stringify(state.tabs).includes("Typed"));
  assert.ok(!JSON.stringify(state.tabs).includes("Compare prices"));

  // the side panel (agents) gets the redacted form, never the raw secret
  const full = state.agents.find((x) => x.id === a.id);
  assert.equal(full.taskName, "Compare prices");
  assert.equal(full.actions.at(-1).text, "Typed text (26 chars) into #q");
  assert.ok(!full.actions.at(-1).text.includes(SECRET));
  assert.deepEqual(Object.keys(full.tabs[0]).sort(), ["pageId", "tabId", "title", "url"]); // no internal fields
});

// ─── Tab claiming ────────────────────────────────────────────────────────

test("tab claim happy path links pageId to a chrome tab id", async () => {
  const s = await startServer();
  const a = await register(s);
  await putTabs(s, a.id, [tab(5)], 5);

  const n = nonce();
  assert.deepEqual((await s.request("POST", `/agents/${a.id}/claims`, { body: { nonce: n, pageId: 5 } })).json, { success: true });
  const claimed = await s.request("POST", "/tabs/claim", { body: { nonce: n, tabId: 777 } });
  assert.equal(claimed.status, 200);
  assert.deepEqual(claimed.json, { success: true, agentId: a.id });

  const state = await getState(s);
  assert.equal(state.tabs["777"].agentId, a.id);
  assert.equal(state.tabs["777"].current, true);
  assert.deepEqual((await getAgent(s, a.id)).tabs, [{ pageId: 5, tabId: 777, url: "https://example.com/5", title: "Page 5" }]);

  // single use
  const reused = await s.request("POST", "/tabs/claim", { body: { nonce: n, tabId: 777 } });
  assert.equal(reused.status, 404);
  assert.deepEqual(reused.json, { error: "unknown_claim" });

  // a claim for a page the wrapper has not PUT yet creates the entry
  assert.equal((await claimTab(s, a.id, 6, 778)).status, 200);
  assert.deepEqual((await getAgent(s, a.id)).tabs.at(-1), { pageId: 6, tabId: 778, url: "", title: "" });
});

test("tab claim: unknown, expired and malformed nonces", async () => {
  const s = await startServer({ claimTtlMs: 50, sweepIntervalMs: 20 });
  const a = await register(s);

  assert.equal((await s.request("POST", "/tabs/claim", { body: { nonce: nonce(), tabId: 1 } })).status, 404);

  const n = nonce();
  await s.request("POST", `/agents/${a.id}/claims`, { body: { nonce: n, pageId: 1 } });
  await sleep(150);
  const expired = await s.request("POST", "/tabs/claim", { body: { nonce: n, tabId: 1 } });
  assert.equal(expired.status, 404);
  assert.equal(expired.json.error, "unknown_claim");

  // validation
  assert.equal((await s.request("POST", `/agents/${a.id}/claims`, { body: { nonce: "ABC", pageId: 1 } })).status, 400);
  assert.equal((await s.request("POST", `/agents/${a.id}/claims`, { body: { nonce: nonce().toUpperCase(), pageId: 1 } })).status, 400);
  assert.equal((await s.request("POST", `/agents/${a.id}/claims`, { body: { nonce: nonce(), pageId: "1" } })).status, 400);
  assert.equal((await s.request("POST", "/tabs/claim", { body: { nonce: nonce(), tabId: "1" } })).status, 400);
  assert.equal((await s.request("POST", "/agents/deadbeef/claims", { body: { nonce: nonce(), pageId: 1 } })).status, 404);

  // removing the agent drops its pending claims
  const s2 = await startServer();
  const b = await register(s2);
  const n2 = nonce();
  await s2.request("POST", `/agents/${b.id}/claims`, { body: { nonce: n2, pageId: 1 } });
  await s2.request("DELETE", `/agents/${b.id}`);
  assert.equal((await s2.request("POST", "/tabs/claim", { body: { nonce: n2, tabId: 1 } })).status, 404);
});

test("tab claim: a tab owned by another agent → 409", async () => {
  const s = await startServer();
  const a = await register(s);
  const b = await register(s);
  await giveTabs(s, a.id, [[1, 501]], 1);

  const r = await claimTab(s, b.id, 9, 501);
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { error: "tab_owned" });
  const state = await getState(s);
  assert.equal(state.tabs["501"].agentId, a.id);
  assert.equal(state.agents.find((x) => x.id === b.id).tabs.length, 0);
});

test("tab claim: origin binding", async () => {
  const s = await startServer();
  const a = await register(s);
  await putTabs(s, a.id, [tab(1)], 1);

  // a claim bound to an origin only succeeds from exactly that origin…
  const n = nonce();
  await s.request("POST", `/agents/${a.id}/claims`, { body: { nonce: n, pageId: 1, origin: "https://example.com" } });
  for (const origin of ["https://evil.example", "https://example.com:443x", "http://example.com", undefined]) {
    const r = await s.request("POST", "/tabs/claim", { body: { nonce: n, tabId: 11, origin } });
    assert.equal(r.status, 409, String(origin));
    assert.deepEqual(r.json, { error: "origin_mismatch" });
  }
  assert.equal((await getState(s)).tabs["11"], undefined);
  // …and the nonce stayed pending
  const ok = await s.request("POST", "/tabs/claim", { body: { nonce: n, tabId: 11, origin: "https://example.com" } });
  assert.equal(ok.status, 200);
  assert.equal((await getState(s)).tabs["11"].agentId, a.id);

  // an unbound claim accepts any origin
  assert.equal((await claimTab(s, a.id, 2, 12, { tabOrigin: "https://anything.example" })).status, 200);

  // validation
  const long = "https://" + "a".repeat(300) + ".com";
  assert.equal((await s.request("POST", `/agents/${a.id}/claims`, { body: { nonce: nonce(), pageId: 3, origin: long } })).status, 400);
  assert.equal((await s.request("POST", `/agents/${a.id}/claims`, { body: { nonce: nonce(), pageId: 3, origin: 5 } })).status, 400);
  assert.equal((await s.request("POST", "/tabs/claim", { body: { nonce: nonce(), tabId: 3, origin: {} } })).status, 400);
});

test("navigating a claimed page to another origin drops its tab id", async () => {
  const s = await startServer();
  const a = await register(s);
  await putTabs(s, a.id, [tab(1, "https://example.com/start")], 1);
  assert.equal((await claimTab(s, a.id, 1, 21, { origin: "https://example.com", tabOrigin: "https://example.com" })).status, 200);
  // an unbound claim records the origin the extension reported
  await putTabs(s, a.id, [tab(1, "https://example.com/start"), tab(2, "https://shop.example/")], 1);
  assert.equal((await claimTab(s, a.id, 2, 22, { tabOrigin: "https://shop.example" })).status, 200);

  // same origin, empty or unparsable URL → keep the tab id
  for (const url of ["https://example.com/other?x=1", "", "not a url"]) {
    const r = await putTabs(s, a.id, [tab(1, url), tab(2, "https://shop.example/cart")], 1);
    assert.deepEqual(r.json.agent.tabs.map((t) => t.tabId), [21, 22], url);
  }

  // different origin → tab id cleared, view gone, wrapper must re-claim
  const moved = await putTabs(s, a.id, [tab(1, "https://elsewhere.example/"), tab(2, "https://shop.example/cart")], 1);
  assert.deepEqual(moved.json.agent.tabs.map((t) => t.tabId), [null, 22]);
  let state = await getState(s);
  assert.equal(state.tabs["21"], undefined);
  assert.equal(state.tabs["22"].agentId, a.id);
  // coming back does not restore it by itself…
  const back = await putTabs(s, a.id, [tab(1, "https://example.com/start"), tab(2, "https://shop.example/cart")], 1);
  assert.deepEqual(back.json.agent.tabs.map((t) => t.tabId), [null, 22]);
  // …a fresh claim from the new page does
  assert.equal((await claimTab(s, a.id, 1, 21, { origin: "https://example.com", tabOrigin: "https://example.com" })).status, 200);
  state = await getState(s);
  assert.equal(state.tabs["21"].agentId, a.id);

  // opaque origins (about:blank, data:) count as a different origin
  const blank = await putTabs(s, a.id, [tab(1, "about:blank"), tab(2, "https://shop.example/cart")], 1);
  assert.deepEqual(blank.json.agent.tabs.map((t) => t.tabId), [null, 22]);
});

test("PUT tabs with tabId null keeps the claimed tab id", async () => {
  const s = await startServer();
  const a = await register(s);
  await putTabs(s, a.id, [tab(1)], 1);
  assert.equal((await claimTab(s, a.id, 1, 601)).status, 200);

  // the wrapper re-sends its list (it never learns tab ids itself)
  const r = await putTabs(s, a.id, [{ ...tab(1, "https://example.com/moved"), tabId: null }, tab(2)], 2);
  assert.deepEqual(r.json.conflicts, []);
  assert.deepEqual(r.json.agent.tabs.map((t) => [t.pageId, t.tabId, t.url]), [
    [1, 601, "https://example.com/moved"],
    [2, null, "https://example.com/2"],
  ]);
  const state = await getState(s);
  assert.equal(state.tabs["601"].agentId, a.id);
  assert.equal(state.tabs["601"].current, false);

  // dropping the page from the list releases the tab
  await putTabs(s, a.id, [tab(2)], 2);
  assert.equal((await getState(s)).tabs["601"], undefined);
});

// ─── SSE ─────────────────────────────────────────────────────────────────

test("SSE /events?token= delivers state immediately and on change", async () => {
  const s = await startServer();
  const events = await openEvents(s);
  try {
    assert.equal(events.res.status, 200);
    assert.match(events.res.headers.get("content-type"), /^text\/event-stream/);
    const initial = await events.nextState();
    assert.equal(initial.protocol, 2);
    assert.deepEqual(initial.agents, []);
    assert.deepEqual(initial.tabs, {});

    const a = await register(s);
    const withAgent = await events.nextState((st) => st.agents.some((x) => x.id === a.id));
    assert.equal(withAgent.agents[0].label, "Claude Code #1");

    await giveTabs(s, a.id, [[1, 701]], 1);
    const withTab = await events.nextState((st) => st.tabs["701"] !== undefined);
    assert.equal(withTab.tabs["701"].agentId, a.id);

    await s.request("POST", `/agents/${a.id}/halt`);
    const halted = await events.nextState((st) => st.tabs["701"]?.halted === true);
    assert.equal(halted.agents[0].halted, true);
  } finally {
    events.close();
  }

  // the Authorization header works too
  const viaHeader = await openEvents(s, "", { authorization: `Bearer ${TOKEN}` });
  try {
    assert.equal(viaHeader.res.status, 200);
    assert.equal((await viaHeader.nextState()).agents.length, 1);
  } finally {
    viaHeader.close();
  }
});

test("SSE: a client that stops reading is dropped (backpressure)", async () => {
  const s = await startServer();
  const socket = net.connect({ host: "127.0.0.1", port: s.port });
  await once(socket, "connect");
  socket.write(`GET /events?token=${TOKEN} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n\r\n`);
  await once(socket, "data"); // headers + first frame
  socket.pause(); // …and never read again
  socket.on("error", () => {}); // the server will reset us

  // ~2.4 MB snapshots: 3 agents × 200 tabs × 4 KB URLs
  const agents = [await register(s), await register(s), await register(s)];
  const longUrl = "https://example.com/" + "x".repeat(4000);
  let dropped = false;
  for (let round = 0; round < 30 && !dropped; round++) {
    for (const a of agents) {
      const pages = Array.from({ length: 200 }, (_, k) => ({ pageId: k, url: longUrl + round, title: "" }));
      assert.equal((await putTabs(s, a.id, pages)).status, 200);
      await sleep(40); // one debounced broadcast per PUT
    }
    dropped = (await s.request("GET", "/logs")).json.logs.some((l) => l.message.startsWith("SSE client dropped"));
  }
  socket.destroy();
  assert.ok(dropped, "slow SSE client was dropped");
  // the server is fine and other clients still work
  const events = await openEvents(s);
  try {
    assert.equal((await events.nextState()).agents.length, 3);
  } finally {
    events.close();
  }
});

// ─── Redaction, logs, recordings ─────────────────────────────────────────

test("typed text never reaches the log file, /logs or recordings", async () => {
  const s = await startServer();
  const a = await register(s);
  const r = await act(s, a.id, { text: `Typed "${SECRET}" into #password`, redactedText: "Typed 26 chars into #password", type: "type" });
  assert.equal(r.status, 200);
  // a malformed body with the secret must not be logged either (JSON errors quote the input)
  assert.equal((await s.request("POST", `/agents/${a.id}/actions`, { body: `{"text": "${SECRET}` })).status, 400);

  const logs = await s.request("GET", "/logs");
  assert.equal(logs.status, 200);
  assert.ok(logs.json.logs.some((l) => l.message.includes("Typed 26 chars into #password")));
  assert.ok(!logs.text.includes(SECRET));
  assert.ok(logs.json.logs.every((l) => typeof l.timestamp === "string" && typeof l.message === "string"));

  const since = await s.request("GET", "/logs?since=" + encodeURIComponent(new Date(Date.now() + 60_000).toISOString()));
  assert.deepEqual(since.json.logs, []);

  const logFile = fs.readFileSync(LOG_FILE, "utf8");
  assert.ok(logFile.includes("Typed 26 chars into #password"));
  assert.ok(!logFile.includes(SECRET));

  assert.equal((await s.request("DELETE", `/agents/${a.id}`)).status, 200);
  const file = recordingFiles().find((f) => f.endsWith(`-${a.id}.json`));
  assert.ok(file, "recording written");
  const raw = fs.readFileSync(path.join(PATHS.recordingsDir, file), "utf8");
  assert.ok(!raw.includes(SECRET));
  assert.ok(raw.includes("Typed 26 chars into #password"));

  // belt and braces: nothing under the home dir contains the secret
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const f of walk(HOME)) assert.ok(!fs.readFileSync(f, "utf8").includes(SECRET), f);
});

test("DELETE agent writes a recording and frees its tabs", async () => {
  const s = await startServer();
  const a = await register(s, { clientName: "cursor", clientVersion: "0.9" });
  await giveTabs(s, a.id, [[1, 801]], 1);
  await act(s, a.id, { text: "Clicked Login", type: "click" });
  await act(s, a.id, { text: `Typed ${SECRET}`, redactedText: "Typed (26 chars)", type: "type" });

  assert.deepEqual((await s.request("DELETE", `/agents/${a.id}`)).json, { success: true });
  assert.equal((await s.request("GET", `/agents/${a.id}`)).status, 404);
  assert.equal((await getState(s)).tabs["801"], undefined);

  const file = recordingFiles().find((f) => f.endsWith(`-${a.id}.json`));
  assert.ok(file);
  assert.match(file, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.json$/);
  const rec = JSON.parse(fs.readFileSync(path.join(PATHS.recordingsDir, file), "utf8"));
  assert.equal(rec.label, "Cursor #1");
  assert.equal(rec.clientName, "cursor");
  assert.equal(rec.clientVersion, "0.9");
  assert.ok(Date.parse(rec.createdAt) <= Date.parse(rec.endedAt));
  assert.deepEqual(rec.actions.map((x) => [x.type, x.text]), [["click", "(13 chars)"], ["type", "Typed (26 chars)"]]);
  assert.ok(rec.actions.every((x) => typeof x.timestamp === "string"));

  // no actions → no recording
  const b = await register(s);
  const before = recordingFiles().length;
  await s.request("DELETE", `/agents/${b.id}`);
  assert.equal(recordingFiles().length, before);
  assert.equal((await s.request("DELETE", `/agents/${b.id}`)).status, 404);
});

test("recordings are pruned to maxRecordings; legacy session dirs are kept", async () => {
  const legacy = path.join(PATHS.recordingsDir, "session-2025-01-01T00-00-00-000Z");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "session.json"), "{}");

  const s = await startServer({ agents: { maxRecordings: 2 } });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const a = await register(s);
    await act(s, a.id);
    await s.request("DELETE", `/agents/${a.id}`);
    ids.push(a.id);
    await sleep(5);
  }
  const files = recordingFiles();
  assert.equal(files.length, 2);
  assert.ok(files.some((f) => f.endsWith(`-${ids[1]}.json`)));
  assert.ok(files.some((f) => f.endsWith(`-${ids[2]}.json`)));
  assert.ok(fs.existsSync(path.join(legacy, "session.json")));
});

test("POST /shutdown answers 202, writes recordings, then calls onShutdown", async () => {
  let shutdowns = 0;
  const s = await startServer({ onShutdown: () => shutdowns++ });
  const a = await register(s);
  await act(s, a.id, { text: "Opened inbox", type: "navigate" });

  const r = await s.request("POST", "/shutdown");
  assert.equal(r.status, 202);
  assert.deepEqual(r.json, { success: true });
  await waitFor(() => shutdowns === 1);
  assert.ok(recordingFiles().some((f) => f.endsWith(`-${a.id}.json`)));
  assert.equal((await getState(s)).agents.length, 0);
});

// ─── Timers ──────────────────────────────────────────────────────────────

test("idle timer flips active agents to idle", async () => {
  const s = await startServer({ agents: { idleTimeoutMs: 100, staleAfterMs: 60_000 }, sweepIntervalMs: 20 });
  const a = await register(s);
  assert.equal((await act(s, a.id)).json.agent.status, "active");
  const events = await openEvents(s);
  try {
    const idle = await events.nextState((st) => st.agents.find((x) => x.id === a.id)?.status === "idle");
    assert.ok(idle.agents[0].lastActionAt);
  } finally {
    events.close();
  }
  // a new action re-activates it
  assert.equal((await act(s, a.id)).json.agent.status, "active");
});

test("stale agents are reaped (with a recording); heart-beating ones survive", async () => {
  const s = await startServer({ agents: { staleAfterMs: 1000, idleTimeoutMs: 60_000 }, sweepIntervalMs: 50 });
  const stale = await register(s);
  await act(s, stale.id, { text: "Opened page", type: "navigate" });
  await giveTabs(s, stale.id, [[1, 901]], 1);
  const alive = await register(s);

  const beats = [];
  let beating = true;
  const heartbeat = (async () => {
    while (beating) {
      beats.push((await s.request("POST", `/agents/${alive.id}/heartbeat`)).status);
      await sleep(200);
    }
  })();
  try {
    // poll /state (GET /agents/:id would count as a sign of life)
    await waitFor(async () => !(await getState(s)).agents.some((x) => x.id === stale.id), 5000, 50);
    const state = await getState(s);
    assert.ok(state.agents.some((x) => x.id === alive.id));
    assert.equal(state.tabs["901"], undefined);
  } finally {
    beating = false;
    await heartbeat;
  }
  assert.ok(beats.length >= 4, `only ${beats.length} heartbeats`);
  assert.ok(beats.every((code) => code === 200), `heartbeat statuses: ${beats}`);
  assert.equal((await s.request("GET", `/agents/${stale.id}`)).status, 404);
  assert.ok(recordingFiles().some((f) => f.endsWith(`-${stale.id}.json`)));
});

// ─── Process entry (server.ts) ───────────────────────────────────────────

function runServerProcess(home) {
  return spawn(process.execPath, [SERVER_SCRIPT], { env: { ...process.env, WEB_MCP_HOME: home }, stdio: "ignore" });
}

function makeHome(serverPort) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "web-mcp-proc-"));
  extraDirs.push(home);
  const config = structuredClone(DEFAULT_CONFIG);
  config.server.port = serverPort;
  config.chrome.port = serverPort === 9333 ? 9334 : 9333;
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
  return home;
}

const exitOf = (child) => new Promise((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once("exit", resolve)));

test("server process: a port that already answers → exit 1, pid file untouched", async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = blocker.address().port;
  const home = makeHome(port);
  const pidFile = path.join(home, "server.pid");
  fs.writeFileSync(pidFile, "424242"); // "owned" by another instance
  try {
    const child = runServerProcess(home);
    assert.equal(await exitOf(child), 1);
    assert.equal(fs.readFileSync(pidFile, "utf8"), "424242");
    assert.match(fs.readFileSync(path.join(home, "logs", "server.log"), "utf8"), /already in use/);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test("server process: loopback only, token auth, identity proof, pid file, POST /shutdown", async () => {
  // grab a free port, then release it for the child
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const home = makeHome(port);
  fs.writeFileSync(path.join(home, "debug-env-dump.json"), "{}"); // legacy file from 0.1.6
  const child = runServerProcess(home);
  try {
    const base = `http://127.0.0.1:${port}`;
    const identity = await waitFor(async () => {
      try {
        const r = await fetch(`${base}/.identity`);
        return r.ok ? r.json() : null;
      } catch {
        return null;
      }
    }, 10_000, 100);
    assert.equal(identity.pid, child.pid);
    assert.equal(identity.protocol, 2);
    const pidFile = path.join(home, "server.pid");
    assert.equal(fs.readFileSync(pidFile, "utf8"), String(child.pid));
    assert.ok(!fs.existsSync(path.join(home, "debug-env-dump.json")));

    const token = fs.readFileSync(path.join(home, "auth-token"), "utf8").trim();
    assert.match(token, /^[0-9a-f]{64}$/);
    const challenge = crypto.randomBytes(32).toString("hex");
    assert.equal((await (await fetch(`${base}/.identity?challenge=${challenge}`)).json()).proof, hmac(token, challenge));
    assert.equal((await fetch(`${base}/state`)).status, 401);
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    assert.equal((await fetch(`${base}/state`, { headers: auth })).status, 200);

    // not reachable through a LAN address
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && (i.family === "IPv4" || i.family === 4) && !i.internal);
    if (lan) assert.equal(await canConnect(lan.address, port), false, `reachable on ${lan.address}`);

    // graceful stop over HTTP: recordings written, pid file removed, exit 0
    const agent = (await (await fetch(`${base}/agents`, { method: "POST", headers: auth, body: "{}" })).json()).agent;
    await fetch(`${base}/agents/${agent.id}/actions`, { method: "POST", headers: auth, body: JSON.stringify({ text: "Opened page", type: "navigate" }) });
    const stop = await fetch(`${base}/shutdown`, { method: "POST", headers: auth });
    assert.equal(stop.status, 202);
    assert.equal(await exitOf(child), 0);
    assert.ok(!fs.existsSync(pidFile));
    assert.ok(fs.readdirSync(path.join(home, "recordings")).some((f) => f.endsWith(`-${agent.id}.json`)));
  } finally {
    if (child.exitCode === null) child.kill();
    await exitOf(child);
  }
});
