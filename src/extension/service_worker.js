// web-mcp extension service worker (Manifest V3).
//
// The only extension context that talks to the coordination server on behalf of
// content scripts. It holds the auth token (from env.js, written by the launcher);
// content scripts never see it. It keeps the latest StatePayload from /events and
// pushes a per-tab TabView ({type:"TAB_STATE"}) only to tabs whose view changed.
// server_api.js verifies the server's identity (HMAC proof) before the token is sent.

try {
  importScripts("env.js");
} catch (e) {
  console.log("[Web MCP] env.js could not be loaded: " + (e && e.message));
}
importScripts("server_api.js");

var Api = globalThis.WebMcpApi;
var VERSION = chrome.runtime.getManifest().version;
// Identifies this service-worker lifetime; content scripts use (boot, seq) to drop
// replies that are older than a push they already applied.
var BOOT_ID = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
var NONCE_RE = /^[0-9a-f]{32}$/;

var RECONNECT_CHECK_MS = 3000;
var PING_INTERVAL_MS = 3000;
var PING_TIMEOUT_MS = 2500;
var ZOMBIE_PING_FAILURES = 20; // 20 * 3 s = 60 s
var STALE_STATE_MS = 15000;    // drop tab UI if the server has been unreachable this long
var KEEPALIVE_MS = 20000;

var eventSource = null;
var sseConnecting = false;     // identity check in flight before opening the stream
var pollTimer = null;          // only used if EventSource is unavailable
var lastPollJson = null;
var latestState = null;        // last StatePayload (null = unknown / server unreachable)
var latestViews = Object.create(null); // tabId string -> normalized TabView
var stateSeq = 0;
var sentViews = Object.create(null);   // tabId string -> JSON of the TabView last sent to that tab
var fullSyncDone = false;
var stateFetch = null;         // in-flight GET /state promise
var lastServerContactAt = 0;

var pingInFlight = false;
var pingEverOk = false;        // zombie prevention is armed only after a successful ping
var pingFailures = 0;
var selfDestructStarted = false;

var throttled = Object.create(null);

function log(msg) {
  console.log("[Web MCP] " + msg);
}

function logThrottled(key, msg, ms) {
  var now = Date.now();
  if (throttled[key] && now - throttled[key] < ms) return;
  throttled[key] = now;
  log(msg);
}

// ─── State → per-tab views ────────────────────────────────────────────

function str(v, fallback) {
  return typeof v === "string" ? v : fallback;
}

// TabView carries no task name and no action text (the page can read the overlay).
function normalizeView(v) {
  if (!v || typeof v !== "object" || typeof v.agentId !== "string") return null;
  return {
    agentId: v.agentId,
    label: str(v.label, "Agent") || "Agent",
    color: str(v.color, ""),
    status: v.status === "active" ? "active" : "idle",
    halted: v.halted === true,
    lastActionType: typeof v.lastActionType === "string" ? v.lastActionType : null,
    current: v.current === true
  };
}

function computeViews(state) {
  var out = Object.create(null);
  var tabs = state && state.tabs;
  if (!tabs || typeof tabs !== "object") return out;
  Object.keys(tabs).forEach(function(key) {
    if (!/^\d+$/.test(key)) return;
    var view = normalizeView(tabs[key]);
    if (view) out[key] = view;
  });
  return out;
}

function describeView(view) {
  if (!view) return "none";
  return view.label + " [" + view.agentId + "] " + (view.halted ? "halted" : view.status) + (view.current ? " current" : "");
}

function sendTabState(tabId, view) {
  try {
    chrome.tabs.sendMessage(tabId, { type: "TAB_STATE", state: view, boot: BOOT_ID, seq: stateSeq }, { frameId: 0 }, function() {
      // No content script there (chrome:// page, still loading, closed tab) — the
      // content script asks with GET_TAB_STATE when it loads.
      void chrome.runtime.lastError;
    });
  } catch (err) {
    log("[TAB_STATE] sendMessage to tab " + tabId + " failed: " + err.message);
  }
}

function pushDiff() {
  var keys = Object.keys(latestViews);
  Object.keys(sentViews).forEach(function(k) {
    if (!(k in latestViews)) keys.push(k);
  });
  keys.forEach(function(k) {
    var view = latestViews[k] || null;
    var json = view ? JSON.stringify(view) : null;
    var prev = k in sentViews ? sentViews[k] : null;
    if (json === prev) return;
    if (json === null) delete sentViews[k];
    else sentViews[k] = json;
    log("[TAB_STATE] tab " + k + " -> " + describeView(view));
    sendTabState(Number(k), view);
  });
}

// First state of this service-worker lifetime: we don't know what the content
// scripts are showing (a previous worker may have pushed views that are now stale),
// so send every tab its current view, including null. (tabs.query needs no
// "tabs" permission for ids.)
function fullSync() {
  chrome.tabs.query({}, function(tabs) {
    if (chrome.runtime.lastError) {
      log("[fullSync] chrome.tabs.query error: " + chrome.runtime.lastError.message);
      pushDiff();
      return;
    }
    var count = 0;
    (tabs || []).forEach(function(tab) {
      if (typeof tab.id !== "number" || tab.id < 0) return;
      var k = String(tab.id);
      var view = latestViews[k] || null;
      if (view) sentViews[k] = JSON.stringify(view);
      else delete sentViews[k];
      sendTabState(tab.id, view);
      count++;
    });
    log("[fullSync] Sent current view to " + count + " tabs (" + Object.keys(latestViews).length + " owned)");
    pushDiff(); // owned tabs that tabs.query did not return
  });
}

function applyState(state, source) {
  if (!state || typeof state !== "object" || !Array.isArray(state.agents)) {
    log("[state] Ignoring malformed state from " + source);
    return;
  }
  lastServerContactAt = Date.now();
  latestState = state;
  latestViews = computeViews(state);
  stateSeq++;
  var active = 0;
  state.agents.forEach(function(a) { if (a && a.status === "active" && !a.halted) active++; });
  log("[state] #" + stateSeq + " via " + source + ": agents=" + state.agents.length + " active=" + active + " ownedTabs=" + Object.keys(latestViews).length);
  if (!fullSyncDone) {
    fullSyncDone = true;
    fullSync();
  } else {
    pushDiff();
  }
}

// Server unreachable for a while: stop blocking the user's tabs with stale overlays.
function clearState(reason) {
  if (!latestState) return;
  log("[state] Clearing tab views: " + reason);
  latestState = null;
  latestViews = Object.create(null);
  stateSeq++;
  pushDiff();
}

function fetchState(force) {
  if (stateFetch) return stateFetch;
  stateFetch = Api.request("GET", "/state").then(function(r) {
    if (r.ok && r.data) {
      // Don't overwrite a state that SSE delivered while we were waiting.
      if (force || !latestState) applyState(r.data, "GET /state");
    } else {
      logThrottled("state-fail", "[state] GET /state failed: " + Api.errorText(r), 10000);
    }
  }).then(function() {
    stateFetch = null;
  });
  return stateFetch;
}

function viewResponse(tabId) {
  var k = String(tabId);
  var view = latestViews[k] || null;
  if (view) sentViews[k] = JSON.stringify(view);
  else delete sentViews[k];
  return { state: view, boot: BOOT_ID, seq: stateSeq };
}

// ─── Live updates (SSE) ───────────────────────────────────────────────

function sseIsOpen() {
  return !!eventSource && eventSource.readyState === EventSource.OPEN;
}

function closeSSE() {
  if (!eventSource) return;
  try { eventSource.close(); } catch (e) { /* ignore */ }
  eventSource = null;
}

// Every (re)connect first proves the server's identity; only then is the token
// put in the /events URL. EventSource's own auto-retry is never used (we close
// on error), so the token is never re-sent to whoever holds the port later.
function connectSSE() {
  if (typeof EventSource !== "function") {
    startPolling();
    return;
  }
  if (sseConnecting) return;
  sseConnecting = true;
  closeSSE();
  Api.verifyIdentity().then(function(v) {
    sseConnecting = false;
    if (!v.ok) {
      logThrottled("sse-identity-" + v.reason, "[SSE] Not connecting: server identity not verified (" + v.reason + ") — " + Api.describe(v.reason) + " Retrying.", 30000);
      return;
    }
    openEventSource();
  });
}

function openEventSource() {
  if (eventSource) return;
  log("[SSE] Identity verified — connecting to " + Api.BASE + "/events");
  var es = new EventSource(Api.eventsUrl());
  eventSource = es;

  es.addEventListener("state", function(event) {
    if (es !== eventSource) return;
    var state;
    try {
      state = JSON.parse(event.data);
    } catch (err) {
      log("[SSE] Parse error: " + err.message);
      return;
    }
    applyState(state, "SSE");
  });

  es.onopen = function() {
    if (es !== eventSource) return;
    lastServerContactAt = Date.now();
    log("[SSE] Connection opened");
  };

  es.onerror = function() {
    if (es !== eventSource) return;
    log("[SSE] Connection lost — will re-verify the server before reconnecting");
    closeSSE();
    Api.invalidate();
  };
}

// Fallback for runtimes without EventSource in service workers.
function startPolling() {
  if (pollTimer) return;
  log("[SSE] EventSource unavailable in this service worker — polling GET /state");
  var poll = function() {
    Api.request("GET", "/state").then(function(r) {
      if (!r.ok || !r.data) {
        logThrottled("poll-fail", "[poll] GET /state failed: " + Api.errorText(r), 15000);
        return;
      }
      lastServerContactAt = Date.now();
      var json = JSON.stringify(r.data);
      if (json === lastPollJson && latestState) return;
      lastPollJson = json;
      applyState(r.data, "poll");
    });
  };
  poll();
  pollTimer = setInterval(poll, 1500);
}

// Periodic reconnection check — handles service-worker restarts, server restarts
// and initial connection failures (server not yet running).
setInterval(function() {
  if (pollTimer) {
    // polling mode: lastServerContactAt is refreshed by successful polls
  } else if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
    if (!sseConnecting) connectSSE();
  } else if (eventSource.readyState === EventSource.OPEN) {
    lastServerContactAt = Date.now();
  }
  if (latestState && Date.now() - lastServerContactAt > STALE_STATE_MS) {
    clearState("server unreachable for " + Math.round(STALE_STATE_MS / 1000) + " s");
  }
}, RECONNECT_CHECK_MS);

// ─── Zombie process prevention ────────────────────────────────────────
// If the server/launcher dies, Chromium would stay alive forever as an orphan.
// After 60 s of failed checks we close every window. A check fails only when both
// /ping and /.identity fail. Only armed once a check has succeeded in this
// service-worker lifetime, so a Chromium opened without the server is never killed.

function onPingOk() {
  var wasFailing = pingFailures > 0;
  if (!Api.hasToken) {
    // No token means this extension is running outside a web-mcp profile
    // (e.g. sideloaded into the user's personal browser). Never arm zombie
    // prevention here — we must not close the user's own windows.
    if (!pingEverOk) log("[ping] Server reachable, but no token — zombie prevention not armed");
    pingEverOk = false;
    pingFailures = 0;
    selfDestructStarted = false;
    return;
  }
  if (!pingEverOk) log("[ping] Server reachable — zombie prevention armed");
  else if (wasFailing) log("[ping] Server reachable again after " + pingFailures + " failed checks");
  pingEverOk = true;
  pingFailures = 0;
  selfDestructStarted = false;
  if (wasFailing && !pollTimer && !eventSource && !sseConnecting) connectSSE();
}

function onPingFail() {
  pingFailures++;
  Api.invalidate();
  if (pingFailures === 1 || pingFailures % 5 === 0) {
    log("[ping] /ping and /.identity both failed, consecutive=" + pingFailures + (pingEverOk ? "" : " — zombie prevention not armed (server never seen)"));
  }
  if (!pingEverOk || selfDestructStarted) return;
  if (pingFailures >= ZOMBIE_PING_FAILURES) selfDestruct();
}

function selfDestruct() {
  selfDestructStarted = true;
  log("Server heartbeat failed for 60 seconds. Parent process likely crashed. Closing all Chromium windows to prevent a zombie process...");
  chrome.windows.getAll({}, function(windows) {
    if (chrome.runtime.lastError) {
      log("[zombie] windows.getAll error: " + chrome.runtime.lastError.message);
      selfDestructStarted = false;
      return;
    }
    (windows || []).forEach(function(win) {
      chrome.windows.remove(win.id, function() { void chrome.runtime.lastError; });
    });
  });
}

function pingOnce() {
  if (pingInFlight) return;
  pingInFlight = true;
  // Both probes are unauthenticated (no token) and run in parallel, so the
  // timing stays one check per interval.
  Promise.all([Api.probe("/ping", PING_TIMEOUT_MS), Api.probe("/.identity", PING_TIMEOUT_MS)]).then(function(r) {
    pingInFlight = false;
    if (r[0] || r[1]) onPingOk();
    else onPingFail();
  });
}

setInterval(pingOnce, PING_INTERVAL_MS);

// MV3 terminates an idle service worker after ~30 s, which would drop the SSE
// connection (overlays would stop updating) and the zombie check. Extension API
// calls reset the idle timer (Chrome 110+), so make a cheap one periodically.
setInterval(function() {
  try {
    chrome.runtime.getPlatformInfo(function() { void chrome.runtime.lastError; });
  } catch (e) { /* ignore */ }
}, KEEPALIVE_MS);

// ─── Messages from content scripts ────────────────────────────────────
// Every tab-scoped request uses sender.tab.id — never a tab id from the message.

function senderTabId(sender) {
  var tab = sender && sender.tab;
  if (!tab || typeof tab.id !== "number" || tab.id < 0) return null;
  if (typeof sender.frameId === "number" && sender.frameId !== 0) return null; // top frame only
  return tab.id;
}

// Origin of the sending document. sender.origin / sender.url describe the frame
// and need no "tabs" permission (sender.tab.url would).
function senderOrigin(sender) {
  if (sender && typeof sender.origin === "string" && sender.origin) return sender.origin;
  try {
    return new URL(sender.url).origin;
  } catch (e) {
    return null;
  }
}

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return false;
  if (!sender || sender.id !== chrome.runtime.id) return false;

  if (msg.type === "GET_TAB_STATE") {
    var stateTabId = senderTabId(sender);
    if (stateTabId === null) {
      sendResponse({ state: null, boot: BOOT_ID, seq: stateSeq });
      return false;
    }
    if (latestState) {
      sendResponse(viewResponse(stateTabId));
      return false;
    }
    // Worker just started (or server unreachable): fetch once, then answer.
    if (!pollTimer && !sseConnecting && (!eventSource || eventSource.readyState === EventSource.CLOSED)) connectSSE();
    fetchState(false).then(function() {
      sendResponse(viewResponse(stateTabId));
    });
    return true;
  }

  if (msg.type === "HALT_TAB") {
    var haltTabId = senderTabId(sender);
    if (haltTabId === null) {
      sendResponse({ success: false, error: "no_tab" });
      return false;
    }
    log("[HALT_TAB] User halted the agent owning tab " + haltTabId);
    Api.request("POST", "/tabs/" + haltTabId + "/halt").then(function(r) {
      log("[HALT_TAB] tab " + haltTabId + " -> " + (r.status || r.reason) + (r.ok && r.data && r.data.agent ? " (agent " + r.data.agent.id + " halted)" : ""));
      if (r.ok && !sseIsOpen()) fetchState(true);
      sendResponse({ success: r.ok, error: r.ok ? undefined : Api.errorText(r) });
    });
    return true;
  }

  if (msg.type === "OPEN_SIDEBAR") {
    var tab = sender.tab;
    if (!tab || typeof tab.windowId !== "number") {
      sendResponse({ success: false, error: "no_tab" });
      return false;
    }
    log("[OPEN_SIDEBAR] Opening side panel in window " + tab.windowId);
    try {
      // Called synchronously inside the handler so the user gesture still counts.
      chrome.sidePanel.open({ windowId: tab.windowId }).then(function() {
        sendResponse({ success: true });
      }, function(err) {
        log("[OPEN_SIDEBAR] Failed: " + err.message);
        sendResponse({ success: false, error: err.message });
      });
    } catch (err) {
      log("[OPEN_SIDEBAR] Failed: " + err.message);
      sendResponse({ success: false, error: err.message });
      return false;
    }
    return true;
  }

  if (msg.type === "CLAIM_TAB") {
    var claimTabId = senderTabId(sender);
    var nonce = msg.nonce;
    var origin = senderOrigin(sender);
    if (claimTabId === null || origin === null || typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
      sendResponse({ success: false });
      return false;
    }
    Api.request("POST", "/tabs/claim", { nonce: nonce, tabId: claimTabId, origin: origin }).then(function(r) {
      // The nonce is a credential — never log it.
      log("[CLAIM_TAB] tab " + claimTabId + " (" + origin + ") -> " + (r.status || r.reason) + (r.ok && r.data && r.data.agentId ? " (agent " + r.data.agentId + ")" : (r.ok ? "" : " " + Api.errorText(r))));
      if (r.ok && !sseIsOpen()) fetchState(true);
      sendResponse({ success: r.ok });
    });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener(function(tabId) {
  var k = String(tabId);
  var owned = k in latestViews;
  delete sentViews[k];
  Api.request("POST", "/tabs/" + tabId + "/closed").then(function(r) {
    if (owned || !r.ok) logThrottled("closed-" + (r.ok ? "ok" : r.reason), "[onRemoved] tab " + tabId + (owned ? " (owned)" : "") + " closed -> " + (r.status || r.reason), r.ok ? 0 : 10000);
  });
});

chrome.runtime.onInstalled.addListener(function(details) {
  log("[onInstalled] reason=" + (details && details.reason) + " version=" + VERSION);
});

chrome.runtime.onStartup.addListener(function() {
  log("[onStartup] Browser started");
});

log("Service worker v" + VERSION + " loaded — server " + Api.BASE + ", token " + (Api.hasToken ? "present" : "MISSING (env.js not written by the launcher; nothing will be sent)"));
connectSSE();
pingOnce();
