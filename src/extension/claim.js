// Tab claiming (see CONTRACT: tab claiming). Runs at document_start, before any
// page script, so this capture listener is the first one on window: valid claim
// messages are consumed here and never reach the page's own listeners (which
// could otherwise relay the nonce to another tab). The nonce is never logged.
(function() {
  "use strict";

  var CLAIM_RE = /^[0-9a-f]{32}$/;
  var sentAt = [];

  window.addEventListener("message", function(e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || typeof d !== "object") return;
    var nonce = d.__webMcpClaim;
    if (typeof nonce !== "string" || !CLAIM_RE.test(nonce)) return;
    e.stopImmediatePropagation();

    // A hostile page could spam fake nonces; cap how many we forward per document.
    var now = Date.now();
    sentAt = sentAt.filter(function(t) { return now - t < 10000; });
    if (sentAt.length >= 10) return;
    sentAt.push(now);

    try {
      chrome.runtime.sendMessage({ type: "CLAIM_TAB", nonce: nonce }, function(resp) {
        var ok = !chrome.runtime.lastError && !!(resp && resp.success);
        console.log("[Web MCP] Tab claim " + (ok ? "accepted" : "not accepted"));
      });
    } catch (err) {
      // extension reloaded / context invalidated
    }
  }, true);
})();
