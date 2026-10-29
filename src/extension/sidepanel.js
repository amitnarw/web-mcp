(function() {
  "use strict";

  // Extension page: env.js (port + token) and server_api.js are loaded by
  // sidepanel.html. Web pages cannot load them (no web_accessible_resources).
  var Api = globalThis.WebMcpApi;
  var PORT = Api.PORT;
  var MAX_ACTIONS = 8;
  var DISCONNECT_GRACE_MS = 4000;
  var RECONNECT_MS = 3000;
  var DEFAULT_RGB = [75, 142, 255];

  var eventSource = null;
  var esOpen = false;
  var attemptInFlight = false;
  var lastAttemptAt = 0;
  var lostAt = 0;              // when the stream last dropped (0 = not dropped)
  var connected = false;       // live stream (with a grace period on drops)
  var everConnected = false;
  var problem = "connecting";  // "" or a WebMcpApi failure reason
  var lastAgentsJson = null;
  var agents = [];
  var cards = Object.create(null);    // agentId -> { el, json }
  var uiState = Object.create(null);  // agentId -> { pending, error }
  var bannerTimer = null;

  var spinner = document.getElementById("spinner");
  var versionEl = document.getElementById("version");
  var conn = document.getElementById("conn");
  var connText = document.getElementById("conn-text");
  var haltAllBtn = document.getElementById("halt-all-btn");
  var banner = document.getElementById("banner");
  var list = document.getElementById("agents-list");
  var emptyState = document.getElementById("empty-state");
  var emptyIcon = document.getElementById("empty-icon");
  var emptyTitle = document.getElementById("empty-title");
  var emptyDesc = document.getElementById("empty-desc");
  var debugSection = document.getElementById("debug-section");
  var debugLogs = document.getElementById("debug-logs");
  var debugToggle = document.getElementById("debug-toggle");
  var debugClear = document.getElementById("debug-clear");
  var debugVisible = false;
  var debugPollTimer = null;
  var logsSince = null;

  function log(msg) {
    console.log("[Web MCP] " + msg);
  }

  try {
    versionEl.textContent = "v" + chrome.runtime.getManifest().version;
  } catch (e) { /* ignore */ }

  // ─── Helpers ───────────────────────────────────────────────────────────

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function icon(name) {
    var s = el("span", "material-symbols-outlined", name);
    s.setAttribute("aria-hidden", "true");
    return s;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function show(node, visible) {
    node.classList.toggle("bp-hidden", !visible);
  }

  function formatTime(timestamp) {
    var d = new Date(timestamp);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function parseHex(color) {
    var m = /^#([0-9a-fA-F]{6})$/.exec(typeof color === "string" ? color : "");
    if (!m) return DEFAULT_RGB.slice();
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function str(v) {
    return typeof v === "string" ? v : "";
  }

  function isActive(agent) {
    return agent.status === "active" && !agent.halted;
  }

  function showBanner(text, isError, ms) {
    banner.textContent = text;
    banner.classList.toggle("bp-banner-error", !!isError);
    show(banner, true);
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function() { show(banner, false); }, ms || 4000);
  }

  // ─── Rendering ─────────────────────────────────────────────────────────

  function uiFor(id) {
    if (!uiState[id]) uiState[id] = { pending: false, error: "" };
    return uiState[id];
  }

  function focusTab(tabId) {
    try {
      chrome.tabs.update(tabId, { active: true }, function(tab) {
        if (chrome.runtime.lastError) {
          log("Could not focus tab " + tabId + ": " + chrome.runtime.lastError.message);
          return;
        }
        if (tab && typeof tab.windowId === "number") {
          chrome.windows.update(tab.windowId, { focused: true }, function() { void chrome.runtime.lastError; });
        }
      });
    } catch (e) {
      log("Could not focus tab " + tabId + ": " + e.message);
    }
  }

  function buildTabs(agent) {
    var section = el("div", "bp-agent-section");
    var tabs = Array.isArray(agent.tabs) ? agent.tabs : [];
    section.appendChild(el("span", "bp-section-label", "Tabs (" + tabs.length + ")"));
    if (tabs.length === 0) {
      section.appendChild(el("span", "bp-empty-line", "No tabs yet"));
      return section;
    }
    var tabList = el("div", "bp-tab-list");
    tabs.forEach(function(tab) {
      if (!tab || typeof tab !== "object") return;
      var current = tab.pageId === agent.currentPageId;
      var hasTabId = typeof tab.tabId === "number";
      var row = el("button", "bp-tab-row" + (current ? " bp-is-current" : ""));
      row.type = "button";
      var title = str(tab.title) || str(tab.url) || "(blank page)";
      row.title = str(tab.url) || title;
      row.appendChild(icon(current ? "arrow_right" : "tab"));
      row.appendChild(el("span", "bp-tab-title", title));
      if (current) row.appendChild(el("span", "bp-tab-tag", "current"));
      if (!hasTabId) row.appendChild(el("span", "bp-tab-tag bp-muted", "not linked"));
      if (hasTabId) {
        row.addEventListener("click", function() { focusTab(tab.tabId); });
      } else {
        row.disabled = true;
      }
      tabList.appendChild(row);
    });
    section.appendChild(tabList);
    return section;
  }

  function buildActions(agent) {
    var section = el("div", "bp-agent-section");
    var actions = Array.isArray(agent.actions) ? agent.actions.slice(-MAX_ACTIONS) : [];
    section.appendChild(el("span", "bp-section-label", "Recent actions"));
    if (actions.length === 0) {
      section.appendChild(el("span", "bp-empty-line", "No actions yet"));
      return section;
    }
    var ul = el("ul", "bp-action-list");
    // Newest first.
    for (var i = actions.length - 1; i >= 0; i--) {
      var a = actions[i];
      if (!a || typeof a !== "object") continue;
      var li = el("li", "bp-action-row" + (i === actions.length - 1 ? " bp-is-latest" : ""));
      li.appendChild(el("span", "bp-action-bullet"));
      li.appendChild(el("span", "bp-action-text", str(a.text) || str(a.type) || "action"));
      li.appendChild(el("span", "bp-action-time", formatTime(a.timestamp)));
      ul.appendChild(li);
    }
    section.appendChild(ul);
    return section;
  }

  function buildCard(card, agent) {
    clear(card);
    var ui = uiFor(agent.id);
    var rgb = parseHex(agent.color);
    var light = rgb.map(function(v) { return Math.round(v + (255 - v) * 0.55); });
    card.className = "bp-agent-card" + (isActive(agent) ? " bp-is-active" : "") + (agent.halted ? " bp-is-halted" : "");
    card.style.setProperty("--bp-agent-color", "rgb(" + rgb.join(", ") + ")");
    card.style.setProperty("--bp-agent-rgb", rgb.join(", "));
    card.style.setProperty("--bp-agent-light-rgb", light.join(", "));

    // Header: dot, label, client, status pill
    var head = el("div", "bp-agent-head");
    head.appendChild(el("span", "bp-agent-dot"));
    var titles = el("div", "bp-agent-titles");
    var label = str(agent.label) || "Agent";
    var labelEl = el("span", "bp-agent-label", label);
    labelEl.title = label;
    titles.appendChild(labelEl);
    var client = str(agent.clientName) || "unknown client";
    if (str(agent.clientVersion)) client += " " + agent.clientVersion;
    titles.appendChild(el("span", "bp-agent-client", client + " · " + agent.id));
    head.appendChild(titles);
    var pillKind = agent.halted ? "halted" : (agent.status === "active" ? "active" : "idle");
    head.appendChild(el("span", "bp-pill bp-pill-" + pillKind, pillKind));
    card.appendChild(head);

    // Task
    if (str(agent.taskName)) {
      var task = el("div", "bp-agent-task");
      task.appendChild(el("span", "bp-section-label", "Task"));
      task.appendChild(el("span", "bp-agent-task-text", agent.taskName));
      card.appendChild(task);
    }

    card.appendChild(buildTabs(agent));
    card.appendChild(buildActions(agent));

    // Footer: error + Halt / Resume
    var footer = el("div", "bp-agent-footer");
    if (ui.error) footer.appendChild(el("span", "bp-agent-error", ui.error));
    var btn;
    if (agent.halted) {
      btn = el("button", "bp-agent-btn bp-agent-btn-resume");
      btn.appendChild(icon("play_arrow"));
      btn.appendChild(document.createTextNode(ui.pending ? "Resuming…" : "Resume"));
      btn.title = "Let " + label + " control its tabs again";
    } else {
      btn = el("button", "bp-agent-btn bp-agent-btn-halt");
      btn.appendChild(icon("pause"));
      btn.appendChild(document.createTextNode(ui.pending ? "Halting…" : "Halt"));
      btn.title = "Stop " + label + " until you press Resume";
    }
    btn.type = "button";
    btn.disabled = ui.pending || !connected;
    var command = agent.halted ? "resume" : "halt";
    var agentId = agent.id;
    btn.addEventListener("click", function() { agentCommand(agentId, command); });
    footer.appendChild(btn);
    card.appendChild(footer);
  }

  var EMPTY_STATES = {
    token_mismatch: { icon: "key_off", title: "Token mismatch" },
    no_token: { icon: "key_off", title: "No token" },
    not_web_mcp: { icon: "gpp_bad", title: "Unexpected server" }
  };

  function renderEmpty() {
    if (connected) {
      emptyIcon.textContent = "hourglass_empty";
      emptyTitle.textContent = "No agents connected";
      emptyDesc.textContent = "When an AI client starts using Web MCP, it shows up here with its own color and tabs.";
      return;
    }
    if (problem === "connecting") {
      emptyIcon.textContent = "hourglass_empty";
      emptyTitle.textContent = "Connecting…";
      emptyDesc.textContent = "Looking for the Web MCP server on 127.0.0.1:" + PORT + ".";
      return;
    }
    var special = EMPTY_STATES[problem];
    if (special) {
      emptyIcon.textContent = special.icon;
      emptyTitle.textContent = special.title;
      emptyDesc.textContent = Api.describe(problem);
      return;
    }
    if (problem === "http") {
      emptyIcon.textContent = "error";
      emptyTitle.textContent = "Server error";
      emptyDesc.textContent = "The Web MCP server answered with an error. Retrying…";
      return;
    }
    emptyIcon.textContent = "cloud_off";
    emptyTitle.textContent = "Server not reachable";
    emptyDesc.textContent = (everConnected ? "Lost the connection to" : "Could not reach") + " the Web MCP server on 127.0.0.1:" + PORT + ". Retrying…";
  }

  function connLabel() {
    if (connected) return "Live";
    if (problem === "token_mismatch" || problem === "no_token") return "Auth error";
    if (problem === "not_web_mcp") return "Unverified";
    if (problem === "connecting") return "Connecting";
    return "Offline";
  }

  function render() {
    var visible = connected ? agents : [];
    var anyActive = visible.some(isActive);
    spinner.classList.toggle("hidden", !anyActive);

    conn.classList.toggle("bp-on", connected);
    connText.textContent = connLabel();
    haltAllBtn.disabled = !connected || !visible.some(function(a) { return !a.halted; });

    show(list, visible.length > 0);
    show(emptyState, visible.length === 0);
    if (visible.length === 0) renderEmpty();

    var seen = Object.create(null);
    visible.forEach(function(agent, idx) {
      var json = JSON.stringify(agent) + "|" + JSON.stringify(uiFor(agent.id)) + "|" + connected;
      var entry = cards[agent.id];
      if (!entry) {
        entry = { el: el("section"), json: null };
        cards[agent.id] = entry;
      }
      if (entry.json !== json) {
        buildCard(entry.el, agent);
        entry.json = json;
      }
      if (list.children[idx] !== entry.el) list.insertBefore(entry.el, list.children[idx] || null);
      seen[agent.id] = true;
    });
    Object.keys(cards).forEach(function(id) {
      if (seen[id]) return;
      if (cards[id].el.parentNode) cards[id].el.parentNode.removeChild(cards[id].el);
      delete cards[id];
      delete uiState[id];
    });
  }

  function onState(state) {
    if (!state || typeof state !== "object" || !Array.isArray(state.agents)) return;
    var valid = state.agents.filter(function(a) { return a && typeof a === "object" && typeof a.id === "string"; });
    var json = JSON.stringify(valid);
    if (json === lastAgentsJson) return;
    lastAgentsJson = json;
    agents = valid;
    render();
  }

  // ─── Commands ──────────────────────────────────────────────────────────

  function agentCommand(agentId, command) {
    var ui = uiFor(agentId);
    if (ui.pending) return;
    ui.pending = true;
    ui.error = "";
    render();
    log("POST /agents/" + agentId + "/" + command);
    Api.request("POST", "/agents/" + encodeURIComponent(agentId) + "/" + command).then(function(r) {
      ui.pending = false;
      if (!r.ok) {
        ui.error = (command === "halt" ? "Halt" : "Resume") + " failed: " + Api.errorText(r);
        log(ui.error);
        if (r.reason === "token_mismatch") setProblem("token_mismatch");
      } else if (r.data && r.data.agent && r.data.agent.id === agentId) {
        // Apply right away; the SSE update follows.
        agents = agents.map(function(a) { return a.id === agentId ? r.data.agent : a; });
        lastAgentsJson = JSON.stringify(agents);
      }
      render();
    });
  }

  function showHaltAllDialog() {
    var dOverlay = el("div", "bp-dialog-overlay");
    dOverlay.addEventListener("click", function(e) {
      if (e.target === dOverlay) dOverlay.remove();
    });

    var dialog = el("div", "bp-dialog");
    var title = el("h3", "bp-dialog-title");
    var ic = icon("error");
    ic.style.fontSize = "18px";
    title.appendChild(ic);
    title.appendChild(el("span", null, "Halt all agents?"));

    var desc = el("p", "bp-dialog-desc", "Every agent stops controlling the browser until you press Resume on its card.");

    var actions = el("div", "bp-dialog-actions");
    var cancelBtn = el("button", "bp-dialog-btn bp-dialog-btn-cancel", "Cancel");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", function() { dOverlay.remove(); });

    var stopBtn = el("button", "bp-dialog-btn bp-dialog-btn-stop", "Halt all");
    stopBtn.type = "button";
    stopBtn.addEventListener("click", function() {
      dOverlay.remove();
      log("POST /halt-all");
      Api.request("POST", "/halt-all").then(function(r) {
        if (r.ok) {
          showBanner("All agents halted. Press Resume on a card to continue.", false, 4000);
        } else {
          showBanner("Halt all failed: " + Api.errorText(r), true, 6000);
          if (r.reason === "token_mismatch") setProblem("token_mismatch");
        }
      });
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(stopBtn);
    dialog.appendChild(title);
    dialog.appendChild(desc);
    dialog.appendChild(actions);
    dOverlay.appendChild(dialog);
    document.body.appendChild(dOverlay);
  }

  haltAllBtn.addEventListener("click", function() {
    if (haltAllBtn.disabled) return;
    showHaltAllDialog();
  });

  // ─── Connection: verify identity → GET /state (detects 401) → SSE ─────

  function setConnected(value) {
    if (value) {
      everConnected = true;
      problem = "";
      lostAt = 0;
    }
    if (connected === value) return;
    connected = value;
    if (!connected) {
      lastAgentsJson = null;
      agents = [];
    }
    render();
  }

  // Auth/identity problems drop the connection right away (no grace period).
  var HARD_PROBLEMS = { token_mismatch: true, no_token: true, not_web_mcp: true };

  function setProblem(reason) {
    if (problem !== reason) log("Connection problem: " + reason + " — " + Api.describe(reason));
    problem = reason;
    if (HARD_PROBLEMS[reason]) {
      closeSSE();
      if (connected) {
        connected = false;
        lastAgentsJson = null;
        agents = [];
      }
    }
    render();
  }

  function closeSSE() {
    if (eventSource) {
      try { eventSource.close(); } catch (e) { /* ignore */ }
    }
    eventSource = null;
    esOpen = false;
  }

  function reconnect() {
    attemptInFlight = true;
    lastAttemptAt = Date.now();
    Api.verifyIdentity().then(function(v) {
      if (!v.ok) return { ok: false, reason: v.reason };
      return Api.request("GET", "/state").then(function(r) {
        return r.ok ? { ok: true, state: r.data } : { ok: false, reason: r.reason || "http" };
      });
    }).then(function(res) {
      attemptInFlight = false;
      if (!res.ok) {
        setProblem(res.reason);
        return;
      }
      setConnected(true);
      onState(res.state);
      openSSE();
    });
  }

  function openSSE() {
    closeSSE();
    var es = new EventSource(Api.eventsUrl());
    eventSource = es;

    es.addEventListener("state", function(event) {
      if (es !== eventSource) return;
      var state;
      try {
        state = JSON.parse(event.data);
      } catch (err) {
        log("SSE parse error: " + err.message);
        return;
      }
      esOpen = true;
      setConnected(true);
      onState(state);
    });

    es.onopen = function() {
      if (es !== eventSource) return;
      log("SSE connected");
      esOpen = true;
      setConnected(true);
    };

    // Never let EventSource retry on its own: every reconnect re-verifies the server.
    es.onerror = function() {
      if (es !== eventSource) return;
      log("SSE connection lost — re-verifying the server before reconnecting");
      closeSSE();
      Api.invalidate();
      lostAt = Date.now();
    };
  }

  setInterval(function() {
    var now = Date.now();
    if (!eventSource && !attemptInFlight && now - lastAttemptAt >= RECONNECT_MS) reconnect();
    if (connected && !esOpen && lostAt && now - lostAt >= DISCONNECT_GRACE_MS) {
      if (problem === "") problem = "unreachable";
      setConnected(false);
    }
  }, 1000);

  // ─── Debug logs ────────────────────────────────────────────────────────

  function renderLogs(logs) {
    clear(debugLogs);
    var meta = el("div", "bp-log-meta", "SSE: " + (connected ? "live" : "offline" + (problem ? " (" + problem + ")" : "")) + " · agents: " + agents.length + " · server: 127.0.0.1:" + PORT);
    debugLogs.appendChild(meta);
    if (logs.length === 0) {
      debugLogs.appendChild(el("div", "bp-log-line", "No log entries" + (logsSince ? " since last clear" : "") + "."));
      return;
    }
    for (var i = logs.length - 1; i >= 0; i--) {
      var entry = logs[i];
      if (!entry || typeof entry !== "object") continue;
      var line = el("div", "bp-log-line");
      var d = new Date(entry.timestamp);
      line.appendChild(el("span", "bp-log-time", isNaN(d.getTime()) ? "" : d.toLocaleTimeString()));
      line.appendChild(document.createTextNode(" " + str(entry.message)));
      debugLogs.appendChild(line);
    }
  }

  function renderDebugError(text) {
    clear(debugLogs);
    debugLogs.appendChild(el("div", "bp-log-error", "Error: " + text));
  }

  function fetchLogs() {
    var path = "/logs" + (logsSince ? "?since=" + encodeURIComponent(logsSince) : "");
    Api.request("GET", path).then(function(r) {
      if (!r.ok) {
        renderDebugError(Api.errorText(r));
        return;
      }
      renderLogs(r.data && Array.isArray(r.data.logs) ? r.data.logs : []);
    });
  }

  debugToggle.addEventListener("click", function() {
    debugVisible = !debugVisible;
    if (debugVisible) {
      debugSection.classList.remove("hidden");
      debugSection.classList.add("flex");
      debugToggle.textContent = "Hide Debug Logs";
      fetchLogs();
      debugPollTimer = setInterval(fetchLogs, 2000);
    } else {
      debugSection.classList.add("hidden");
      debugSection.classList.remove("flex");
      debugToggle.textContent = "Show Debug Logs";
      if (debugPollTimer) {
        clearInterval(debugPollTimer);
        debugPollTimer = null;
      }
    }
  });

  debugClear.addEventListener("click", function() {
    logsSince = new Date().toISOString();
    clear(debugLogs);
  });

  // ─── Start ─────────────────────────────────────────────────────────────

  if (!Api.hasToken) log("No token in env.js — nothing will be sent to the server (env.js is written by the launcher)");
  render();
  reconnect();
})();
