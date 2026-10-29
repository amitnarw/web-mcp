(function() {
  "use strict";

  // Agent UI for tabs owned by an agent. No network access and no token: all
  // state comes from the service worker ({type:"TAB_STATE"} / GET_TAB_STATE).
  // Tab claiming lives in claim.js (document_start).

  // ─── Constants & state ────────────────────────────────────────────────

  var HTML_NS = "http://www.w3.org/1999/xhtml";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var IS_HTML = !!document.documentElement && document.documentElement.namespaceURI === HTML_NS;
  var POPOVER = typeof HTMLElement === "function" && typeof HTMLElement.prototype.showPopover === "function";
  var POLL_MS = 5000;
  var REPAIR_LIMIT = 20;          // re-attachments allowed per window before giving up
  var REPAIR_WINDOW_MS = 10000;
  var DEFAULT_RGB = [75, 142, 255];
  var VERBS = { navigate: "navigating", click: "clicking", type: "typing", keypress: "pressing key", fill: "filling", scroll: "scrolling", screenshot: "capturing screenshot", snapshot: "reading page", wait: "waiting", evaluate: "evaluating", tab: "switching tab", hover: "hovering", drag: "dragging", "default": "working" };
  var OWN_UI = ".bp-overlay, .bp-overlay *, .bp-dialog-overlay, .bp-dialog-overlay *, .bp-badge, .bp-badge *";

  var view = null;          // TabView for this tab, or null when no agent owns it
  var viewJson = "null";
  var mode = "none";        // "none" | "active" | "idle" | "halted"
  var blocking = false;     // block human input (agent active on this tab)
  var lastBoot = null;
  var lastSeq = -1;
  var pollTimer = null;

  var styleEl = null;
  var overlay = null;
  var refs = {};            // overlay parts
  var badge = null;
  var badgeRefs = {};
  var dialogEl = null;
  var statusFadeTimer = null;

  var observer = null;
  var observing = false;
  var observedBody = null;
  var repairScheduled = false;
  var repairTimes = [];
  var repairDisabled = false;

  function log(msg) {
    console.log("[Web MCP] " + msg);
  }

  log("Content script loaded on " + window.location.href);

  function contextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function sendToWorker(msg, cb) {
    try {
      if (!contextAlive()) { if (cb) cb(null); return; }
      chrome.runtime.sendMessage(msg, function(resp) {
        if (chrome.runtime.lastError) { if (cb) cb(null); return; }
        if (cb) cb(resp);
      });
    } catch (err) {
      if (cb) cb(null);
    }
  }

  // The wrapper sets data-bp-ai-acting on <html> around each CDP action:
  //   "mouse"    pointer input passes (our UI is pointer-transparent), keys blocked
  //   "keyboard" key input passes (plus keyboard-generated clicks), mouse blocked
  //   "true"     everything passes
  //   "capture"  like "mouse", and our UI is invisible (screenshots)
  function actingFlag() {
    var root = document.documentElement;
    return root ? root.getAttribute("data-bp-ai-acting") : null;
  }

  // Our own buttons only react to real user clicks, never while an agent acts.
  function userEvent(e) {
    return !!e.isTrusted && actingFlag() === null;
  }

  // ─── Styles (injected only once this tab is owned by an agent) ────────

  var STYLE_TEXT = [
    "@keyframes bp-spin { from { transform: rotate(0turn); } to { transform: rotate(-1turn); } }",
    ".bp-overlay, .bp-dialog-overlay, .bp-badge { --bp-agent-rgb: 75, 142, 255; --bp-agent-light-rgb: 173, 198, 255; line-height: normal; text-align: left; letter-spacing: normal; text-transform: none; }",
    ".bp-overlay *, .bp-dialog-overlay *, .bp-badge * { box-sizing: border-box; }",
    ".bp-overlay button, .bp-dialog-overlay button { font-family: inherit; line-height: normal; text-transform: none; letter-spacing: normal; margin: 0; min-width: 0; min-height: 0; box-shadow: none; }",
    ".bp-overlay {",
    "  position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;",
    "  background: rgba(0, 0, 0, 0.35); z-index: 2147483647;",
    "  display: flex; align-items: flex-end; justify-content: center;",
    "  pointer-events: auto; cursor: not-allowed;",
    "  font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;",
    "}",
    // Top layer (popover="manual"): undo the UA popover box styles.
    ".bp-overlay[popover], .bp-dialog-overlay[popover] { inset: 0; margin: 0; border: 0; padding: 0; width: 100vw; height: 100vh; max-width: none; max-height: none; overflow: visible; color: inherit; }",
    ".bp-overlay::backdrop, .bp-dialog-overlay::backdrop { display: none; background: transparent; pointer-events: none; }",
    // While the agent acts with the mouse (or captures), all our UI is pointer-transparent.
    "html[data-bp-ai-acting='mouse'] :is(" + OWN_UI + "), html[data-bp-ai-acting='true'] :is(" + OWN_UI + "), html[data-bp-ai-acting='capture'] :is(" + OWN_UI + ") { pointer-events: none !important; }",
    // Screenshots must not show our UI.
    "html[data-bp-ai-acting='capture'] :is(" + OWN_UI + ") { opacity: 0 !important; visibility: hidden !important; transition: none !important; }",
    ".bp-glow-container {",
    "  position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;",
    "  z-index: 2147483646; pointer-events: none;",
    "  opacity: 1;",
    "}",
    ".bp-sharp-container {",
    "  position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;",
    "  z-index: 2147483646; pointer-events: none;",
    "}",
    ".bp-glow-mask {",
    "  position: absolute; top: 0; left: 0; right: 0; bottom: 0;",
    "  -webkit-mask-image: radial-gradient(ellipse at center, transparent 40%, black 75%);",
    "  mask-image: radial-gradient(ellipse at center, transparent 40%, black 75%);",
    "  overflow: hidden;",
    "}",
    ".bp-sharp-mask {",
    "  position: absolute; top: 0; left: 0; right: 0; bottom: 0;",
    "  padding: 2px; box-sizing: border-box;",
    "  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);",
    "  -webkit-mask-composite: xor;",
    "  mask-composite: exclude;",
    "  overflow: hidden;",
    "}",
    ".bp-gradient-spin {",
    "  position: absolute; top: 50%; left: 50%; width: 200vmax; height: 200vmax;",
    "  margin-top: -100vmax; margin-left: -100vmax;",
    "  animation: bp-spin 4s linear infinite;",
    "  transform-origin: center;",
    "}",
    ".bp-glow-spin {",
    "  background-image: conic-gradient(from 0turn, rgba(var(--bp-agent-light-rgb), 1) 0%, rgba(var(--bp-agent-rgb), 0.7) 10%, rgba(var(--bp-agent-rgb), 0.3) 25%, transparent 40%, transparent 100%);",
    "  filter: blur(60px);",
    "  opacity: 0.7;",
    "}",
    ".bp-sharp-spin {",
    "  background-image: conic-gradient(from 0turn, rgba(var(--bp-agent-light-rgb), 1) 0%, rgba(var(--bp-agent-rgb), 0.9) 5%, rgba(var(--bp-agent-rgb), 0.5) 15%, transparent 25%, transparent 100%);",
    "}",
    ".bp-action-bar-root, .bp-dialog-overlay {",
    "  --bp-font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif;",
    "  --bp-bg-glass: rgba(31, 31, 33, 0.7);",
    "  --bp-border-glass: rgba(255, 255, 255, 0.1);",
    "  --bp-shadow-primary: 0 12px 40px rgba(0, 0, 0, 0.3), inset 0 1px 1px rgba(255, 255, 255, 0.1);",
    "}",
    ".bp-action-bar-root {",
    "  position: fixed; bottom: 48px; left: 50%; transform: translateX(-50%) translateY(0);",
    "  z-index: 2147483647; display: flex; align-items: center; padding: 10px 16px 10px 12px; gap: 14px;",
    "  background: var(--bp-bg-glass); backdrop-filter: blur(40px) saturate(180%); -webkit-backdrop-filter: blur(40px) saturate(180%);",
    "  border: 1px solid rgba(var(--bp-agent-rgb), 0.35); border-radius: 9999px;",
    "  box-shadow: var(--bp-shadow-primary), 0 0 24px rgba(var(--bp-agent-rgb), 0.18);",
    "  animation: bp-slide-up 0.6s cubic-bezier(0.2, 0.8, 0.2, 1); user-select: none; transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);",
    "  font-family: var(--bp-font-family); pointer-events: auto; cursor: default;",
    "}",
    "@keyframes bp-slide-up { from { transform: translateX(-50%) translateY(100px); opacity: 0; } to { transform: translateX(-50%) translateY(0); opacity: 1; } }",
    "/* --- standard ORB CSS --- */",
    "@keyframes orb-blink { 0%, 96%, 98% { transform: scaleY(1); } 97% { transform: scaleY(0.1); } }",
    "@keyframes mesh-flow { 0% { background-position: 0% 0%; } 50% { background-position: 100% 100%; } 100% { background-position: 0% 0%; } }",
    ".bp-standard-wrapper { position: relative; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }",
    ".bp-standard-orb { position: relative; width: 100%; height: 100%; border-radius: 50%; overflow: hidden; display: flex; align-items: center; justify-content: center; background-color: #131315; background-image: radial-gradient(circle at 0% 0%, rgba(var(--bp-agent-rgb), 0.6) 0px, transparent 70%), radial-gradient(circle at 100% 100%, rgba(var(--bp-agent-light-rgb), 0.6) 0px, transparent 70%), linear-gradient(135deg, rgba(var(--bp-agent-rgb), 0.3) 0%, rgba(var(--bp-agent-rgb), 0.4) 100%); background-size: 200% 200%; animation: mesh-flow 4s ease-in-out infinite; border: none; }",
    ".bp-orb-eyes { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 3px; z-index: 2; transition: transform 0.1s ease-out; transform: translate(var(--eye-x, 0px), var(--eye-y, 0px)); }",
    ".bp-orb-eye { width: 4px; height: 4px; background: rgb(var(--bp-agent-light-rgb)); border-radius: 50%; animation: orb-blink 4s infinite; box-shadow: 0 0 4px rgba(var(--bp-agent-light-rgb), 0.5); }",
    ".bp-orb-eyes.orb-typing { animation: orb-eyes-dart 1s infinite alternate; }",
    "@keyframes orb-eyes-dart { 0% { transform: translate(calc(var(--eye-x, 0px) - 2px), var(--eye-y, 0px)); } 100% { transform: translate(calc(var(--eye-x, 0px) + 2px), var(--eye-y, 0px)); } }",
    ".bp-status-container { max-width: 380px; min-width: 0; overflow: hidden; display: flex; align-items: center; gap: 8px; }",
    ".bp-agent-name { font-size: 12px; font-weight: 600; color: rgb(var(--bp-agent-light-rgb)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; flex-shrink: 0; letter-spacing: -0.01em; font-family: 'Inter', sans-serif; }",
    ".bp-status-text { font-size: 14px; font-weight: 500; color: #e4e2e4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; letter-spacing: -0.01em; transition: opacity 0.2s ease; font-family: 'Inter', sans-serif; }",
    ".bp-divider { width: 1px; height: 20px; background: rgba(255,255,255,0.1); border-radius: 1px; flex-shrink: 0; }",
    ".bp-button-group { display: flex; gap: 4px; flex-shrink: 0; }",
    ".bp-action-btn { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background-color 0.2s ease, color 0.2s ease; color: #c1c6d7; background: transparent; border: none; padding: 0; }",
    ".bp-action-btn:hover { background: rgba(255, 255, 255, 0.05); color: #e4e2e4; }",
    ".bp-action-btn:active { background: rgba(255, 255, 255, 0.1); }",
    ".bp-action-btn svg { width: 16px; height: 16px; stroke-width: 2; }",
    ".bp-btn-stop:hover { color: #ffb4ab; background: rgba(147, 0, 10, 0.2); }",
    ".bp-dialog-overlay {",
    "  position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 2147483647;",
    "  display: flex; align-items: center; justify-content: center; pointer-events: auto;",
    "  background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);",
    "  animation: bp-fade-in-fast 0.2s ease-out; font-family: 'Inter', sans-serif;",
    "}",
    "@keyframes bp-fade-in-fast { from { opacity: 0; } to { opacity: 1; } }",
    ".bp-dialog {",
    "  background: #131315; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; box-shadow: 0 20px 40px rgba(0,0,0,0.6);",
    "  padding: 24px; width: 300px; display: flex; flex-direction: column; gap: 12px;",
    "  transform: scale(0.95); animation: bp-pop-in 0.2s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;",
    "}",
    "@keyframes bp-pop-in { to { transform: scale(1); } }",
    ".bp-dialog-title { font-size: 16px; font-weight: 600; color: rgb(var(--bp-agent-light-rgb)); margin: 0; display: flex; align-items: center; gap: 8px; word-break: break-word; }",
    ".bp-dialog-title svg { flex-shrink: 0; }",
    ".bp-dialog-desc { font-size: 14px; color: #c1c6d7; margin: 0; line-height: 1.5; }",
    ".bp-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }",
    ".bp-dialog-btn { padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; transition: background-color 0.2s, color 0.2s; border: none; }",
    ".bp-dialog-btn-cancel { background: rgba(255,255,255,0.1); color: #c1c6d7; }",
    ".bp-dialog-btn-cancel:hover { background: rgba(255,255,255,0.15); color: #e4e2e4; }",
    ".bp-dialog-btn-stop { background: rgba(147,0,10,0.3); color: #ffb4ab; }",
    ".bp-dialog-btn-stop:hover { background: rgba(147,0,10,0.4); }",
    ".bp-badge {",
    "  position: fixed; bottom: 16px; right: 16px; z-index: 2147483646;",
    "  background: rgba(19, 19, 21, 0.85); backdrop-filter: blur(24px) saturate(180%); -webkit-backdrop-filter: blur(24px) saturate(180%);",
    "  border: 1px solid rgba(var(--bp-agent-rgb), 0.3); border-radius: 9999px;",
    "  padding: 4px 12px 4px 5px; display: flex; align-items: center; gap: 8px; max-width: 260px;",
    "  cursor: pointer; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;",
    "  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), inset 0 1px 1px rgba(255, 255, 255, 0.05);",
    "  transition: background-color 0.3s, border-color 0.3s, box-shadow 0.3s, transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1); opacity: 0.9;",
    "  user-select: none; pointer-events: auto;",
    "}",
    ".bp-badge:hover {",
    "  background: rgba(25, 25, 28, 0.95); opacity: 1;",
    "  border-color: rgba(var(--bp-agent-rgb), 0.6);",
    "  transform: translateY(-2px);",
    "  box-shadow: 0 12px 35px rgba(var(--bp-agent-rgb), 0.2), inset 0 1px 1px rgba(255, 255, 255, 0.05);",
    "}",
    ".bp-badge:active { transform: translateY(0); }",
    ".bp-badge .bp-standard-wrapper { width: 16px; height: 16px; }",
    ".bp-badge .bp-orb-eyes { gap: 2px; }",
    ".bp-badge .bp-orb-eye { width: 3px; height: 3px; }",
    ".bp-badge-title { font-weight: 600; font-size: 12px; color: #e4e2e4; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
    ".bp-badge.bp-badge-halted { border-color: rgba(255, 180, 171, 0.35); }",
    ".bp-badge.bp-badge-halted .bp-badge-title { color: #ffb4ab; }",
    ".bp-chat-bubble {",
    "  position: absolute; bottom: 130%; left: 23px; transform: translateX(-50%) translateY(10px);",
    "  background: #2a2a2c;",
    "  padding: 8px 12px; border-radius: 8px;",
    "  color: #e4e2e4; font-size: 11px; font-weight: 500; font-family: var(--bp-font-family);",
    "  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255,255,255,0.05);",
    "  opacity: 0; pointer-events: none;",
    "  transition: opacity 0.3s cubic-bezier(0.2, 0.8, 0.2, 1), transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1); white-space: nowrap;",
    "  display: flex; gap: 12px; align-items: center;",
    "}",
    ".bp-chat-bubble.visible { opacity: 1; transform: translateX(-50%) translateY(0); pointer-events: auto; }",
    ".bp-chat-bubble::after {",
    "  content: ''; position: absolute; bottom: -4px; left: 50%; width: 10px; height: 10px;",
    "  margin-left: -5px; background: #2a2a2c;",
    "  box-shadow: 1px 1px 0 rgba(255,255,255,0.05);",
    "  transform: rotate(45deg);",
    "}",
    ".bp-bubble-stop-btn { background: rgba(147,0,10,0.3); color: #ffb4ab; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 10px; font-weight: 600; font-family: var(--bp-font-family); transition: background-color 0.2s; }",
    ".bp-bubble-stop-btn:hover { background: rgba(147,0,10,0.5); }"
  ].join("\n");

  function ensureStyles() {
    if (styleEl && styleEl.isConnected) return false;
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.setAttribute("data-web-mcp", "");
      styleEl.textContent = STYLE_TEXT;
    }
    (document.head || document.documentElement).appendChild(styleEl);
    return true;
  }

  function mountPoint() {
    return document.body || document.documentElement;
  }

  // ─── Small DOM helpers (no innerHTML anywhere) ────────────────────────

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function svgIcon(size, parts) {
    var s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    if (size) {
      s.setAttribute("width", String(size));
      s.setAttribute("height", String(size));
    }
    parts.forEach(function(p) {
      var child = document.createElementNS(SVG_NS, p[0]);
      Object.keys(p[1]).forEach(function(k) { child.setAttribute(k, p[1][k]); });
      s.appendChild(child);
    });
    return s;
  }

  function panelIcon() {
    return svgIcon(0, [["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }], ["line", { x1: "15", y1: "3", x2: "15", y2: "21" }]]);
  }

  function stopIcon() {
    return svgIcon(0, [["circle", { cx: "12", cy: "12", r: "10" }], ["rect", { x: "9", y: "9", width: "6", height: "6", fill: "currentColor" }]]);
  }

  function alertIcon() {
    return svgIcon(18, [["circle", { cx: "12", cy: "12", r: "10" }], ["line", { x1: "12", y1: "8", x2: "12", y2: "12" }], ["line", { x1: "12", y1: "16", x2: "12.01", y2: "16" }]]);
  }

  function buildOrb() {
    var wrapper = el("div", "bp-standard-wrapper");
    var orb = el("div", "bp-standard-orb");
    var eyes = el("div", "bp-orb-eyes");
    eyes.appendChild(el("div", "bp-orb-eye"));
    eyes.appendChild(el("div", "bp-orb-eye"));
    orb.appendChild(eyes);
    wrapper.appendChild(orb);
    return { wrapper: wrapper, eyes: eyes };
  }

  function parseHex(color) {
    var m = /^#([0-9a-fA-F]{6})$/.exec(typeof color === "string" ? color : "");
    if (!m) return DEFAULT_RGB.slice();
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function applyTint(node, color) {
    if (!node) return;
    var rgb = parseHex(color);
    var light = rgb.map(function(v) { return Math.round(v + (255 - v) * 0.55); });
    node.style.setProperty("--bp-agent-rgb", rgb.join(", "));
    node.style.setProperty("--bp-agent-light-rgb", light.join(", "));
  }

  function clip(text, max) {
    text = String(text || "");
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }

  // ─── Top layer (popover) ──────────────────────────────────────────────
  // A manual popover renders above every page element regardless of z-index,
  // stacking contexts or transformed ancestors. Fallback: max z-index.

  function isOpen(node) {
    try {
      return node.matches(":popover-open");
    } catch (e) {
      return false;
    }
  }

  function makePopover(node) {
    if (POPOVER) node.setAttribute("popover", "manual");
    node.addEventListener("toggle", function(e) {
      if (e.newState === "closed") scheduleRepair("popover closed");
    });
  }

  // Shows `node` in the top layer if it isn't already. Returns true if it had to.
  function raise(node) {
    if (!POPOVER || !node || !node.isConnected) return false;
    if (node.getAttribute("popover") !== "manual") node.setAttribute("popover", "manual");
    if (isOpen(node)) return false;
    try {
      node.showPopover();
      return true;
    } catch (e) {
      return false;
    }
  }

  function lower(node) {
    if (!POPOVER || !node || !isOpen(node)) return;
    try { node.hidePopover(); } catch (e) { /* ignore */ }
  }

  // ─── Human-input blocking ─────────────────────────────────────────────
  // The overlay blocks the pointer by covering the page; these capture listeners
  // (on window, the first stop of every event) also stop real input that would
  // otherwise slip past it. Only trusted events are touched: page-script and
  // agent-evaluate synthetic events pass. CDP input passes per data-bp-ai-acting.
  var MOUSE_EVENTS = ["click", "mousedown", "mouseup", "dblclick", "auxclick", "contextmenu", "pointerdown", "pointerup", "touchstart", "touchend", "wheel"];
  var KEY_EVENTS = ["keydown", "keypress", "keyup"];
  // Events on our own UI that must keep working (buttons). wheel/contextmenu/auxclick are always blocked.
  var OWN_UI_EXEMPT = { click: true, mousedown: true, mouseup: true, dblclick: true, pointerdown: true, pointerup: true, touchstart: true, touchend: true, keydown: true, keypress: true, keyup: true };
  var OWN_UI_ROOTS = ".bp-action-bar-root, .bp-dialog-overlay, .bp-badge, .bp-overlay";

  function letThrough(e, acting) {
    if (acting === "true") return true;
    var isMouse = MOUSE_EVENTS.indexOf(e.type) !== -1;
    if (acting === "mouse" || acting === "capture") return isMouse;
    // Enter/Space on a focused control produces a click with detail 0.
    if (acting === "keyboard") return !isMouse || (e.type === "click" && e.detail === 0);
    return false;
  }

  function blocker(e) {
    if (!blocking || !e.isTrusted) return;
    if (letThrough(e, actingFlag())) return;
    if (OWN_UI_EXEMPT[e.type]) {
      var t = e.target;
      if (t && t.closest && t.closest(OWN_UI_ROOTS)) return;
    }
    e.stopImmediatePropagation();
    e.preventDefault();
  }

  // Scroll-blocking listeners (must be non-passive to preventDefault) are only
  // registered while blocking, so unowned pages keep fast, passive scrolling.
  var SCROLL_EVENTS = ["wheel", "touchstart", "touchend"];
  var scrollBlockersOn = false;

  MOUSE_EVENTS.concat(KEY_EVENTS).forEach(function(type) {
    if (SCROLL_EVENTS.indexOf(type) === -1) window.addEventListener(type, blocker, true);
  });

  function setScrollBlockers(on) {
    if (on === scrollBlockersOn) return;
    scrollBlockersOn = on;
    SCROLL_EVENTS.forEach(function(type) {
      if (on) window.addEventListener(type, blocker, { capture: true, passive: false });
      else window.removeEventListener(type, blocker, { capture: true });
    });
  }

  // ─── Overlay (agent active on this tab) ───────────────────────────────

  function createGradientAnimation(parent) {
    var container = el("div");
    container.id = "bp-gradient-anim-container";

    var glow = el("div", "bp-glow-container");
    var glowMask = el("div", "bp-glow-mask");
    glowMask.appendChild(el("div", "bp-gradient-spin bp-glow-spin"));
    glow.appendChild(glowMask);

    var sharp = el("div", "bp-sharp-container");
    var sharpMask = el("div", "bp-sharp-mask");
    sharpMask.appendChild(el("div", "bp-gradient-spin bp-sharp-spin"));
    sharp.appendChild(sharpMask);

    container.appendChild(glow);
    container.appendChild(sharp);
    parent.insertBefore(container, parent.firstChild);
  }

  function createOverlay() {
    overlay = el("div", "bp-overlay");
    overlay.setAttribute("aria-hidden", "true"); // keep it out of the agent's a11y snapshot
    makePopover(overlay);
    createGradientAnimation(overlay);

    var bar = el("div", "bp-action-bar-root");

    var orb = buildOrb();
    refs.eyes = orb.eyes;
    bar.appendChild(orb.wrapper);

    var statusContainer = el("div", "bp-status-container");
    refs.label = el("span", "bp-agent-name");
    refs.status = el("span", "bp-status-text");
    refs.status.textContent = "working...";
    refs.statusText = "working...";
    statusContainer.appendChild(refs.label);
    statusContainer.appendChild(refs.status);
    bar.appendChild(statusContainer);

    bar.appendChild(el("div", "bp-divider"));

    var group = el("div", "bp-button-group");

    var openBtn = el("button", "bp-action-btn");
    openBtn.type = "button";
    openBtn.title = "Open Web MCP side panel";
    openBtn.appendChild(panelIcon());
    openBtn.addEventListener("click", function(e) {
      if (!userEvent(e)) return;
      e.stopPropagation();
      sendToWorker({ type: "OPEN_SIDEBAR" });
    });

    var haltBtn = el("button", "bp-action-btn bp-btn-stop");
    haltBtn.type = "button";
    haltBtn.title = "Halt this agent";
    haltBtn.appendChild(stopIcon());
    haltBtn.addEventListener("click", function(e) {
      if (!userEvent(e)) return;
      e.stopPropagation();
      showHaltDialog();
    });

    group.appendChild(openBtn);
    group.appendChild(haltBtn);
    bar.appendChild(group);

    var bubble = el("div", "bp-chat-bubble");
    var bubbleText = el("span", "bp-bubble-text");
    var bubbleHalt = el("button", "bp-bubble-stop-btn");
    bubbleHalt.type = "button";
    bubbleHalt.textContent = "Halt";
    bubbleHalt.style.display = "none";
    bubbleHalt.addEventListener("click", function(e) {
      if (!userEvent(e)) return;
      e.stopPropagation();
      showHaltDialog();
    });
    bubble.appendChild(bubbleText);
    bubble.appendChild(bubbleHalt);
    bar.appendChild(bubble);
    refs.bubble = bubble;
    refs.bubbleText = bubbleText;
    refs.bubbleHalt = bubbleHalt;

    overlay.appendChild(bar);

    overlay.addEventListener("click", function(e) {
      if (!userEvent(e)) return;
      if (e.target === overlay) {
        showBubble((view ? clip(view.label, 60) : "The agent") + " is working. Click Halt to regain control.", true, 3000);
      }
    });
  }

  function showBubble(text, withHalt, ms) {
    if (!refs.bubble) return;
    refs.bubbleText.textContent = clip(text, 160);
    refs.bubbleHalt.style.display = withHalt ? "inline-block" : "none";
    refs.bubble.classList.add("visible");
    if (refs.bubble._hideTimer) clearTimeout(refs.bubble._hideTimer);
    var bubble = refs.bubble;
    bubble._hideTimer = setTimeout(function() { bubble.classList.remove("visible"); }, ms);
  }

  function setStatus(text) {
    if (refs.statusText === text) return;
    refs.statusText = text;
    var se = refs.status;
    se.style.opacity = "0";
    if (statusFadeTimer) clearTimeout(statusFadeTimer);
    statusFadeTimer = setTimeout(function() {
      se.textContent = text;
      se.style.opacity = "1";
    }, 200);
  }

  // Only the agent label and a verb derived from the action type are shown:
  // the page can read this DOM.
  function statusFor(v) {
    if (!v.current) return "working in another tab";
    var type = v.lastActionType;
    var verb = type && Object.prototype.hasOwnProperty.call(VERBS, type) ? VERBS[type] : VERBS["default"];
    return verb + "...";
  }

  function showOverlay() {
    ensureStyles();
    if (!overlay) createOverlay();
    applyTint(overlay, view.color);
    refs.label.textContent = clip(view.label, 60);
    setStatus(statusFor(view));
    if (refs.eyes) {
      var t = view.current ? view.lastActionType : null;
      refs.eyes.classList.toggle("orb-typing", t === "type" || t === "keypress" || t === "fill");
    }
    attachUI();
  }

  function removeOverlay() {
    if (!overlay) return;
    if (statusFadeTimer) { clearTimeout(statusFadeTimer); statusFadeTimer = null; }
    if (refs.bubble && refs.bubble._hideTimer) clearTimeout(refs.bubble._hideTimer);
    var node = overlay;
    overlay = null;
    refs = {};
    if (node.parentNode) node.parentNode.removeChild(node);
  }

  // ─── Halt confirmation ────────────────────────────────────────────────

  function showHaltDialog() {
    if (dialogEl && dialogEl.isConnected) return;
    var label = view ? clip(view.label, 60) : "this agent";

    dialogEl = el("div", "bp-dialog-overlay");
    dialogEl.setAttribute("aria-hidden", "true");
    makePopover(dialogEl);
    applyTint(dialogEl, view && view.color);
    dialogEl.addEventListener("click", function(e) {
      if (!userEvent(e)) return;
      if (e.target === dialogEl) removeDialog();
    });

    var dialog = el("div", "bp-dialog");

    var title = el("h3", "bp-dialog-title");
    title.appendChild(alertIcon());
    var titleText = el("span");
    titleText.textContent = "Halt " + label + "?";
    title.appendChild(titleText);

    var desc = el("p", "bp-dialog-desc");
    desc.textContent = label + " will stop controlling its tabs until you press Resume in the Web MCP side panel. Other agents keep running.";

    var actions = el("div", "bp-dialog-actions");

    var cancelBtn = el("button", "bp-dialog-btn bp-dialog-btn-cancel");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", function(e) {
      if (!userEvent(e)) return;
      e.stopPropagation();
      removeDialog();
    });

    var stopBtn = el("button", "bp-dialog-btn bp-dialog-btn-stop");
    stopBtn.type = "button";
    stopBtn.textContent = "Halt agent";
    stopBtn.addEventListener("click", function(e) {
      if (!userEvent(e)) return;
      e.stopPropagation();
      removeDialog();
      haltThisTab();
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(stopBtn);
    dialog.appendChild(title);
    dialog.appendChild(desc);
    dialog.appendChild(actions);
    dialogEl.appendChild(dialog);
    attachUI();
  }

  function removeDialog() {
    var node = dialogEl;
    dialogEl = null;
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  function haltThisTab() {
    log("Halt confirmed by user");
    sendToWorker({ type: "HALT_TAB" }, function(resp) {
      if (resp && resp.success) {
        log("Halt accepted");
        requestState();
        return;
      }
      var reason = (resp && typeof resp.error === "string" && resp.error) || "extension not responding";
      log("Halt failed: " + reason);
      showBubble("Could not halt (" + clip(reason, 60) + "). Use the side panel.", false, 6000);
    });
  }

  // ─── Badge (agent owns this tab but is idle or halted) ────────────────

  function showBadge() {
    ensureStyles();
    if (!badge) {
      badge = el("div", "bp-badge");
      badge.setAttribute("aria-hidden", "true");
      badge.title = "Open the Web MCP side panel";
      var orb = buildOrb();
      badgeRefs.eyes = orb.eyes;
      badge.appendChild(orb.wrapper);
      badgeRefs.text = el("span", "bp-badge-title");
      badge.appendChild(badgeRefs.text);
      badge.addEventListener("click", function(e) {
        if (!userEvent(e)) return;
        e.stopPropagation();
        sendToWorker({ type: "OPEN_SIDEBAR" });
      });
    }
    applyTint(badge, view.color);
    badge.classList.toggle("bp-badge-halted", mode === "halted");
    badgeRefs.text.textContent = clip(view.label, 60) + " · " + (mode === "halted" ? "halted" : "idle");
    attachUI();
  }

  function removeBadge() {
    var node = badge;
    badge = null;
    badgeRefs = {};
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  // ─── Keep the UI attached ─────────────────────────────────────────────
  // Pages (SPA re-renders, body.innerHTML = …) may remove our nodes or close
  // the popover; put them back. Idempotent; returns true if anything changed.

  function attachUI() {
    if (!IS_HTML || mode === "none") return false;
    var changed = ensureStyles();
    var parent = mountPoint();
    if (overlay) {
      if (!overlay.isConnected) { parent.appendChild(overlay); changed = true; }
      var raised = raise(overlay);
      if (raised) changed = true;
      if (dialogEl) {
        if (!dialogEl.isConnected) { parent.appendChild(dialogEl); changed = true; }
        if (raised) lower(dialogEl); // re-show so the dialog stays above the overlay
        if (raise(dialogEl)) changed = true;
      }
    }
    if (badge && !badge.isConnected) { parent.appendChild(badge); changed = true; }
    watchDom();
    return changed;
  }

  function watchDom() {
    if (typeof MutationObserver !== "function") return;
    if (observing && observedBody === document.body) return;
    if (!observer) observer = new MutationObserver(function() { scheduleRepair("page removed Web MCP UI"); });
    observer.disconnect();
    // childList only (no subtree): our nodes are direct children of <body>/<html>/<head>.
    [document.documentElement, document.head, document.body].forEach(function(node) {
      if (node) observer.observe(node, { childList: true });
    });
    observedBody = document.body;
    observing = true;
  }

  function unwatchDom() {
    if (observer) observer.disconnect();
    observing = false;
    observedBody = null;
  }

  function scheduleRepair(reason) {
    if (repairScheduled || mode === "none" || repairDisabled) return;
    repairScheduled = true;
    // A task, not a microtask: a page fighting us can't spin the event loop.
    setTimeout(function() {
      repairScheduled = false;
      if (mode === "none" || repairDisabled) return;
      if (!attachUI()) return;
      var now = Date.now();
      repairTimes = repairTimes.filter(function(t) { return now - t < REPAIR_WINDOW_MS; });
      repairTimes.push(now);
      log("Re-attached Web MCP UI (" + reason + ")");
      if (repairTimes.length >= REPAIR_LIMIT) {
        repairDisabled = true;
        log("Page keeps removing the Web MCP UI — not re-attaching until the agent state changes (input stays blocked)");
      }
    }, 0);
  }

  // A fullscreen element enters the top layer above us: move back on top.
  document.addEventListener("fullscreenchange", function() {
    if (mode !== "active" || !overlay) return;
    lower(overlay);
    attachUI();
  });

  // ─── Eyes follow the mouse ────────────────────────────────────────────

  function moveEyes(eyes, e) {
    var rect = eyes.getBoundingClientRect();
    var dx = e.clientX - (rect.left + rect.width / 2);
    var dy = e.clientY - (rect.top + rect.height / 2);
    var dist = Math.sqrt(dx * dx + dy * dy);
    var maxDist = 3;
    if (dist > maxDist) { dx = (dx / dist) * maxDist; dy = (dy / dist) * maxDist; }
    eyes.style.setProperty("--eye-x", dx + "px");
    eyes.style.setProperty("--eye-y", dy + "px");
  }

  window.addEventListener("mousemove", function(e) {
    if (overlay && refs.eyes) moveEyes(refs.eyes, e);
    if (badge && badgeRefs.eyes) moveEyes(badgeRefs.eyes, e);
  }, { passive: true });

  // ─── State handling ───────────────────────────────────────────────────

  function sanitizeView(s) {
    if (!s || typeof s !== "object" || typeof s.agentId !== "string") return null;
    return {
      agentId: s.agentId,
      label: typeof s.label === "string" && s.label ? s.label : "Agent",
      color: typeof s.color === "string" ? s.color : "",
      status: s.status === "active" ? "active" : "idle",
      halted: s.halted === true,
      lastActionType: typeof s.lastActionType === "string" ? s.lastActionType : null,
      current: s.current === true
    };
  }

  function computeMode(v) {
    if (!v) return "none";
    if (v.halted) return "halted";
    return v.status === "active" ? "active" : "idle";
  }

  function acceptState(state, boot, seq) {
    if (typeof boot === "string" && typeof seq === "number") {
      if (boot === lastBoot && seq < lastSeq) return; // older than what we applied
      lastBoot = boot;
      lastSeq = seq;
    }
    var next = sanitizeView(state);
    var json = JSON.stringify(next);
    if (json === viewJson) return;
    viewJson = json;
    view = next;
    render();
  }

  function render() {
    var nextMode = computeMode(view);
    if (nextMode !== mode) {
      log("Tab state: " + mode + " -> " + nextMode + (view ? " (" + view.label + ", agent " + view.agentId + ")" : ""));
      repairTimes = [];
      repairDisabled = false;
    }
    mode = nextMode;
    blocking = IS_HTML && mode === "active";
    setScrollBlockers(blocking);

    if (IS_HTML) {
      if (mode === "active") {
        removeBadge();
        showOverlay();
      } else {
        removeOverlay();
        removeDialog();
        if (mode === "none") {
          removeBadge();
          unwatchDom();
        } else {
          showBadge();
        }
      }
    }
    updatePolling();
  }

  // While this tab shows agent UI, re-check every few seconds so a missed push
  // can never leave a stale overlay blocking the user.
  function updatePolling() {
    var want = mode !== "none";
    if (want && !pollTimer) {
      pollTimer = setInterval(requestState, POLL_MS);
    } else if (!want && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function teardown(reason) {
    log("Removing Web MCP UI: " + reason);
    view = null;
    viewJson = "null";
    render();
  }

  function requestState(attempt) {
    if (!contextAlive()) {
      if (mode !== "none") teardown("extension context invalidated");
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      return;
    }
    sendToWorker({ type: "GET_TAB_STATE" }, function(resp) {
      if (resp && typeof resp === "object" && "state" in resp) {
        acceptState(resp.state, resp.boot, resp.seq);
      } else if (typeof attempt === "number" && attempt < 3) {
        setTimeout(function() { requestState(attempt + 1); }, 1000 * attempt);
      }
    });
  }

  chrome.runtime.onMessage.addListener(function(msg, sender) {
    if (!msg || msg.type !== "TAB_STATE") return;
    if (sender && sender.id && sender.id !== chrome.runtime.id) return;
    acceptState(msg.state === undefined ? null : msg.state, msg.boot, msg.seq);
  });

  // Restored from the back/forward cache: our view may be stale.
  window.addEventListener("pageshow", function(e) {
    if (e.persisted) requestState(1);
  });

  if (!IS_HTML) log("Not an HTML document — Web MCP UI disabled on this page");
  requestState(1);
})();
