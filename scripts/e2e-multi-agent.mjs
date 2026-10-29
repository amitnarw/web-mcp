// End-to-end test: two MCP clients ("agents") share one Chromium, each in its own tabs.
//
//   npm run build && npm run bundle && node scripts/e2e-multi-agent.mjs
//
// Runs in a throwaway WEB_MCP_HOME on ports 3126/9322 with headless Chromium,
// so it never touches a real ~/.web-mcp instance.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import puppeteer from "puppeteer";
import assert from "assert/strict";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), "web-mcp-e2e-"));
const SERVER_PORT = 3126;
const CHROME_PORT = 9322;
const SECRET = "supersecret-" + Math.random().toString(36).slice(2);

fs.writeFileSync(
  path.join(HOME, "config.json"),
  JSON.stringify({ server: { port: SERVER_PORT }, chrome: { port: CHROME_PORT, headless: process.env.E2E_HEADFUL ? false : true }, logging: { level: "info" } }, null, 2)
);

// ─── Test site ───────────────────────────────────────────────────────────
const site = http.createServer((req, res) => {
  if (req.url.startsWith("/to-cdp")) {
    // An allowed page that redirects to Chromium's DevTools endpoint.
    res.writeHead(302, { Location: `http://127.0.0.1:${CHROME_PORT}/json/list` });
    return res.end();
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url.startsWith("/form")) {
    res.end(`<title>Form page</title><label>Name <input id="name"></label><button onclick="document.title='submitted:'+document.getElementById('name').value.length">Send</button>`);
  } else if (req.url.startsWith("/login")) {
    res.end(`<title>Login</title><form onsubmit="event.preventDefault(); document.title='entered:'+document.getElementById('pw').value.length"><label>Password <input id="pw" type="password" name="password"></label></form><a href="/b?popup" target="_blank">Open help</a>`);
  } else {
    res.end(`<title>Other site</title><h1>Hello from B</h1><button onclick="document.title='clicked'">Press me</button>`);
  }
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const SITE = `http://127.0.0.1:${site.address().port}`;

// ─── Helpers ─────────────────────────────────────────────────────────────
const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push([true, name]); console.log("  ✓ " + name); })
    .catch((err) => { results.push([false, name]); console.log("  ✗ " + name + "\n      " + String(err && err.message || err).split("\n").join("\n      ")); });
}

async function startAgent(clientName) {
  const client = new Client({ name: clientName, version: "1.0.0" }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "bin", "web-mcp.js"), "mcp"],
      env: { ...process.env, WEB_MCP_HOME: HOME },
      stderr: process.env.E2E_VERBOSE ? "inherit" : "ignore",
    })
  );
  return client;
}

async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { ...r, text };
}

const token = () => fs.readFileSync(path.join(HOME, "auth-token"), "utf8").trim();
async function api(method, p, body) {
  const r = await fetch(`http://127.0.0.1:${SERVER_PORT}${p}`, {
    method,
    headers: { Authorization: "Bearer " + token(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null), headers: r.headers };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(200);
  }
  throw new Error("timed out waiting; last=" + JSON.stringify(last));
}

// Find the Chromium page of an agent by URL (the test drives distinct URLs per agent).
let browser;
async function pageByUrl(prefix) {
  const pages = await browser.pages();
  return pages.find((p) => p.url().startsWith(prefix));
}
const hasOverlay = (page) => page.evaluate(() => !!document.querySelector(".bp-overlay"));

// ─── Run ─────────────────────────────────────────────────────────────────
console.log("web-mcp multi-agent e2e (home: " + HOME + ")");
let a, b;
try {
  [a, b] = await Promise.all([startAgent("claude-code"), startAgent("cursor")]);

  await check("both agents start and name themselves", async () => {
    const [ra, rb] = await Promise.all([
      call(a, "browser_start", { agentName: "Agent A", taskName: "fill the form" }),
      call(b, "browser_start", { agentName: "Agent B", taskName: "press the button" }),
    ]);
    assert.ok(!ra.isError, ra.text);
    assert.ok(!rb.isError, rb.text);
    assert.match(ra.text, /Agent A/);
    assert.match(rb.text, /Agent B/);
  });

  await check("agents navigate in parallel, each in its own tab", async () => {
    const [ra, rb] = await Promise.all([
      call(a, "browser_navigate", { url: SITE + "/form" }),
      call(b, "browser_navigate", { url: SITE + "/b" }),
    ]);
    assert.ok(!ra.isError, ra.text);
    assert.ok(!rb.isError, rb.text);
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CHROME_PORT}`, defaultViewport: null });
    assert.ok(await pageByUrl(SITE + "/form"), "form tab exists");
    assert.ok(await pageByUrl(SITE + "/b"), "b tab exists");
  });

  await check("an agent only sees its own tabs", async () => {
    const [ta, tb] = await Promise.all([call(a, "browser_get_tabs"), call(b, "browser_get_tabs")]);
    assert.match(ta.text, /\/form/);
    assert.doesNotMatch(ta.text, /\/b\b/);
    assert.match(tb.text, /\/b\b/);
    assert.doesNotMatch(tb.text, /\/form/);
    const nav = await call(a, "browser_navigate", { url: SITE + "/form?again" });
    assert.doesNotMatch(nav.text, /\/b\b/, "navigate output must not list other agents' tabs");
  });

  await check("server knows both agents and the extension claimed their chrome tabs", async () => {
    const st = await waitFor(async () => {
      const s = (await api("GET", "/state")).data;
      return s && s.agents.length === 2 && Object.keys(s.tabs).length === 2 ? s : null;
    });
    const labels = st.agents.map((x) => x.label).sort();
    assert.deepEqual(labels, ["Agent A", "Agent B"]);
    assert.ok(st.agents.every((x) => x.tabs.length === 1 && x.tabs[0].tabId !== null));
  });

  await check("overlay is shown on both agents' tabs while active", async () => {
    await waitFor(async () => (await hasOverlay(await pageByUrl(SITE + "/form"))) && (await hasOverlay(await pageByUrl(SITE + "/b"))));
  });

  await check("agent A fills a form through the overlay (secret typed)", async () => {
    const snap = await call(a, "browser_snapshot");
    const uid = (snap.text.match(/uid=(\S+) textbox/) || [])[1];
    assert.ok(uid, "textbox uid in snapshot:\n" + snap.text.slice(0, 400));
    const filled = await call(a, "browser_fill", { uid, value: SECRET });
    assert.ok(!filled.isError, filled.text);
    const btn = (snap.text.match(/uid=(\S+) button "Send"/) || [])[1];
    await call(a, "browser_click", { uid: btn });
    const title = await (await pageByUrl(SITE + "/form")).title();
    assert.equal(title, "submitted:" + SECRET.length, "typed through the human-input blocker");
  });

  await check("browser_done releases only that agent's overlay", async () => {
    await call(a, "browser_done");
    await waitFor(async () => !(await hasOverlay(await pageByUrl(SITE + "/form"))));
    assert.ok(await hasOverlay(await pageByUrl(SITE + "/b")), "agent B overlay still there");
  });

  await check("halt is per agent and sticky until resume", async () => {
    const st = (await api("GET", "/state")).data;
    const idA = st.agents.find((x) => x.label === "Agent A").id;
    assert.equal((await api("POST", `/agents/${idA}/halt`)).status, 200);
    const blocked = await call(a, "browser_snapshot");
    assert.ok(blocked.isError && /halted/i.test(blocked.text), blocked.text);
    await sleep(1500);
    assert.ok((await call(a, "browser_snapshot")).isError, "still halted later");
    const snapB = await call(b, "browser_snapshot");
    assert.ok(!snapB.isError, "agent B unaffected");
    const btn = (snapB.text.match(/uid=(\S+) button "Press me"/) || [])[1];
    assert.ok(!(await call(b, "browser_click", { uid: btn })).isError);
    assert.equal(await (await pageByUrl(SITE + "/b")).title(), "clicked");
    assert.equal((await api("POST", `/agents/${idA}/resume`)).status, 200);
    assert.ok(!(await call(a, "browser_snapshot")).isError, "works after resume");
  });

  await check("blocked URL schemes (file://, chrome://)", async () => {
    for (const url of ["file:///C:/Windows/win.ini", "chrome://settings", "javascript:alert(1)"]) {
      const r = await call(a, "browser_navigate", { url });
      assert.ok(r.isError, url + " should be refused");
    }
  });

  await check("agents can't reach Chromium's DevTools endpoint (directly or via redirect)", async () => {
    for (const url of [`http://127.0.0.1:${CHROME_PORT}/json/list`, `http://localhost:${CHROME_PORT}/json/list`, `http://127.0.0.1:${SERVER_PORT}/.identity`]) {
      assert.ok((await call(a, "browser_navigate", { url })).isError, url + " should be refused");
    }
    await call(a, "browser_navigate", { url: SITE + "/to-cdp" });
    const snap = await call(a, "browser_snapshot");
    assert.doesNotMatch(snap.text, /webSocketDebuggerUrl|devtoolsFrontendUrl/, "DevTools target list leaked:\n" + snap.text.slice(0, 300));
    assert.doesNotMatch(snap.text, new RegExp(SITE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/b"), "other agent's tab leaked");
  });

  await check("password input: Enter submits, value never shown in the side panel", async () => {
    await call(a, "browser_navigate", { url: SITE + "/login" });
    const snap = await call(a, "browser_snapshot");
    const uid = (snap.text.match(/uid=(\S+) textbox "Password\s*"/) || [])[1];
    assert.ok(uid, "password textbox uid:\n" + snap.text.slice(0, 400));
    await call(a, "browser_click", { uid });
    const PASSWORD = "pw-" + Math.random().toString(36).slice(2);
    const typed = await call(a, "browser_type", { text: PASSWORD, submitKey: "Enter" });
    assert.ok(!typed.isError, typed.text);
    assert.equal(await (await pageByUrl(SITE + "/login")).title(), "entered:" + PASSWORD.length, "Enter submitted the form through the blocker");
    const st = (await api("GET", "/state")).data;
    assert.ok(!JSON.stringify(st).includes(PASSWORD), "password visible in /state (side panel)");
  });

  await check("a popup the agent opens becomes the agent's tab", async () => {
    const snap = await call(a, "browser_snapshot");
    const link = (snap.text.match(/uid=(\S+) link "Open help"/) || [])[1];
    assert.ok(link, "link uid");
    await call(a, "browser_click", { uid: link });
    const tabs = await waitFor(async () => {
      const t = await call(a, "browser_get_tabs");
      return /\?popup/.test(t.text) ? t : null;
    });
    assert.match(tabs.text, /\/login/);
  });

  await check("browser_stop can't be used to escape a halt", async () => {
    const st = (await api("GET", "/state")).data;
    const idA = st.agents.find((x) => x.label === "Agent A").id;
    await api("POST", `/agents/${idA}/halt`);
    const stop = await call(a, "browser_stop");
    assert.ok(stop.isError && /halted/i.test(stop.text), "stop refused while halted: " + stop.text);
    assert.ok((await call(a, "browser_snapshot")).isError, "still halted");
    await api("POST", `/agents/${idA}/resume`);
    assert.ok(!(await call(a, "browser_snapshot")).isError, "works after resume");
  });

  await check("server: auth, origin and CORS hardening", async () => {
    const base = `http://127.0.0.1:${SERVER_PORT}`;
    assert.equal((await fetch(base + "/state")).status, 401);
    const evil = await fetch(base + "/state", { headers: { Authorization: "Bearer " + token(), Origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    const ok = await fetch(base + "/state", { headers: { Authorization: "Bearer " + token() } });
    assert.equal(ok.headers.get("access-control-allow-origin"), null);
    assert.equal((await fetch(base + "/logs")).status, 401);
  });

  await check("typed secret never reaches disk or /logs", async () => {
    const logs = (await api("GET", "/logs")).data;
    assert.ok(!JSON.stringify(logs).includes(SECRET), "/logs contains secret");
    const logFile = path.join(HOME, "logs", "server.log");
    assert.ok(!fs.readFileSync(logFile, "utf8").includes(SECRET), "server.log contains secret");
  });

  await check("browser_stop closes the agent's tabs and removes it", async () => {
    const r = await call(b, "browser_stop");
    assert.ok(!r.isError, r.text);
    await waitFor(async () => !(await browser.pages()).some((p) => p.url() === SITE + "/b"));
    const st = (await api("GET", "/state")).data;
    assert.deepEqual(st.agents.map((x) => x.label), ["Agent A"]);
  });
} finally {
  await Promise.allSettled([a?.close(), b?.close()]);
  await sleep(500);
  if (process.env.E2E_VERBOSE) console.log("recordings:", fs.existsSync(path.join(HOME, "recordings")) && fs.readdirSync(path.join(HOME, "recordings")));
  const recDir = path.join(HOME, "recordings");
  const recLeak = fs.existsSync(recDir) && fs.readdirSync(recDir).some((f) => fs.statSync(path.join(recDir, f)).isFile() && fs.readFileSync(path.join(recDir, f), "utf8").includes(SECRET));
  results.push([!recLeak, "recordings contain no typed secret"]);
  console.log((recLeak ? "  ✗ " : "  ✓ ") + "recordings contain no typed secret");

  try { browser && (await browser.disconnect()); } catch {}
  // Tear down our private server + Chromium only.
  try {
    const pid = Number(fs.readFileSync(path.join(HOME, "server.pid"), "utf8"));
    if (pid) process.kill(pid);
  } catch {}
  const { killProfileChrome } = await import(new URL("../dist/shared/launcher.min.js", import.meta.url));
  killProfileChrome(path.join(HOME, "chromium-profile-v2"));
  site.close();
  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (!process.env.E2E_KEEP) setTimeout(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {} }, 1500);
  setTimeout(() => process.exit(failed ? 1 : 0), 2000);
}
