(function() {
  "use strict";

  // Extension page: env.js (port + token) and server_api.js are loaded by popup.html.
  var Api = globalThis.WebMcpApi;
  var REFRESH_MS = 2000;

  var statusDot = document.getElementById("status-dot");
  var statusText = document.getElementById("status-text");
  var summary = document.getElementById("agent-summary");
  var sub = document.getElementById("agent-sub");
  var versionDisplay = document.getElementById("version-display");
  var openSidebarBtn = document.getElementById("open-sidebar");
  var haltAllBtn = document.getElementById("halt-all");
  var debugToggle = document.getElementById("debug-toggle");
  var debugSection = document.getElementById("debug-section");
  var debugPanel = document.getElementById("debug-panel");
  var debugVisible = false;
  var debugPollTimer = null;
  var windowId = null;

  // A one-off notice ("All agents halted") stays until the state changes after it was shown.
  var notice = "";
  var noticeBaseline = null;   // state JSON when the notice was first displayed
  var lastStateJson = null;

  function log(msg) {
    console.log("[Web MCP] " + msg);
  }

  try {
    versionDisplay.textContent = "v" + chrome.runtime.getManifest().version;
  } catch (e) { /* ignore */ }

  // Resolve the window now so "Open side panel" can call sidePanel.open
  // synchronously inside the click (the user gesture is lost after an await).
  try {
    chrome.windows.getCurrent(function(win) {
      if (!chrome.runtime.lastError && win && typeof win.id === "number") windowId = win.id;
    });
  } catch (e) { /* ignore */ }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setNotice(text) {
    notice = text;
    noticeBaseline = null;
  }

  // Clears the notice once the state differs from the one it was shown with.
  function trackNotice(stateJson) {
    if (!notice) return;
    if (noticeBaseline === null) noticeBaseline = stateJson;
    else if (stateJson !== noticeBaseline) {
      notice = "";
      noticeBaseline = null;
    }
  }

  // ─── Status ────────────────────────────────────────────────────────────

  var STATUS_LABELS = { token_mismatch: "Unauthorized", no_token: "No token", not_web_mcp: "Unverified", timeout: "Not responding" };

  function renderDisconnected(reason) {
    statusDot.classList.remove("bp-on");
    statusText.textContent = STATUS_LABELS[reason] || "Disconnected";
    summary.textContent = reason === "token_mismatch" ? "Token mismatch" : (reason === "not_web_mcp" ? "Unexpected server" : "Server not reachable");
    sub.textContent = notice || Api.describe(reason);
    haltAllBtn.disabled = true;
  }

  function renderConnected(agents) {
    statusDot.classList.add("bp-on");
    statusText.textContent = "Connected";

    var total = agents.length;
    var active = 0;
    var halted = 0;
    var haltable = 0;
    agents.forEach(function(a) {
      if (a.halted) halted++;
      else haltable++;
      if (a.status === "active" && !a.halted) active++;
    });

    summary.textContent = total === 0 ? "No agents connected" : total + (total === 1 ? " agent" : " agents") + " · " + active + " active";
    sub.textContent = notice || (halted > 0 ? halted + " halted" : "");
    haltAllBtn.disabled = haltable === 0;
  }

  function fetchState() {
    Api.request("GET", "/state").then(function(r) {
      if (r.ok && r.data && Array.isArray(r.data.agents)) {
        var agents = r.data.agents.filter(function(a) { return a && typeof a === "object"; });
        lastStateJson = JSON.stringify(agents);
        trackNotice(lastStateJson);
        renderConnected(agents);
      } else {
        var reason = r.reason || "http";
        trackNotice("disconnected:" + reason);
        renderDisconnected(reason);
      }
    });
  }

  // ─── Buttons ───────────────────────────────────────────────────────────

  function openSidePanel(id) {
    chrome.sidePanel.open({ windowId: id }).then(function() {
      window.close();
    }, function(err) {
      log("Could not open side panel: " + err.message);
      setNotice("Could not open the side panel");
      fetchState();
    });
  }

  openSidebarBtn.addEventListener("click", function() {
    try {
      if (windowId !== null) {
        openSidePanel(windowId);
        return;
      }
      chrome.windows.getCurrent(function(win) {
        if (chrome.runtime.lastError || !win) {
          log("Could not resolve the current window");
          return;
        }
        openSidePanel(win.id);
      });
    } catch (err) {
      log("Could not open side panel: " + err.message);
    }
  });

  haltAllBtn.addEventListener("click", function() {
    if (haltAllBtn.disabled) return;
    var dOverlay = el("div", "bp-dialog-overlay");
    dOverlay.addEventListener("click", function(e) {
      if (e.target === dOverlay) dOverlay.remove();
    });

    var dialog = el("div", "bp-dialog");
    var title = el("h3", "bp-dialog-title");
    var ic = el("span", "material-symbols-outlined", "error");
    ic.style.fontSize = "18px";
    title.appendChild(ic);
    title.appendChild(el("span", null, "Halt all agents?"));

    var desc = el("p", "bp-dialog-desc", "Every agent stops controlling the browser until you press Resume in the side panel.");

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
        setNotice(r.ok ? "All agents halted" : "Halt all failed: " + Api.errorText(r));
        fetchState();
      });
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(stopBtn);
    dialog.appendChild(title);
    dialog.appendChild(desc);
    dialog.appendChild(actions);
    dOverlay.appendChild(dialog);
    document.body.appendChild(dOverlay);
  });

  // ─── Debug logs ────────────────────────────────────────────────────────

  function fetchLogs() {
    Api.request("GET", "/logs").then(function(r) {
      clear(debugPanel);
      if (!r.ok) {
        debugPanel.appendChild(el("div", "bp-log-error", "Error: " + Api.errorText(r)));
        return;
      }
      var logs = r.data && Array.isArray(r.data.logs) ? r.data.logs : [];
      if (logs.length === 0) debugPanel.appendChild(el("div", "bp-log-line", "No log entries."));
      for (var i = logs.length - 1; i >= 0; i--) {
        var entry = logs[i];
        if (!entry || typeof entry !== "object") continue;
        var line = el("div", "bp-log-line");
        var d = new Date(entry.timestamp);
        line.appendChild(el("span", "bp-log-time", isNaN(d.getTime()) ? "" : d.toLocaleTimeString()));
        line.appendChild(document.createTextNode(" " + (typeof entry.message === "string" ? entry.message : "")));
        debugPanel.appendChild(line);
      }
    });
  }

  debugToggle.addEventListener("click", function() {
    debugVisible = !debugVisible;
    if (debugVisible) {
      debugSection.classList.remove("bp-hidden");
      debugSection.classList.add("flex");
      debugToggle.textContent = "Hide Debug Logs";
      fetchLogs();
      debugPollTimer = setInterval(fetchLogs, REFRESH_MS);
    } else {
      debugSection.classList.add("bp-hidden");
      debugSection.classList.remove("flex");
      debugToggle.textContent = "Debug Logs";
      if (debugPollTimer) {
        clearInterval(debugPollTimer);
        debugPollTimer = null;
      }
    }
  });

  // ─── Start ─────────────────────────────────────────────────────────────

  fetchState();
  setInterval(fetchState, REFRESH_MS);
})();
