// Shared server client for the extension's privileged contexts (service worker,
// side panel, popup). Never loaded by content scripts: it reads the auth token
// from env.js.
//
// Before the token is sent anywhere the server must prove it knows the token:
// GET /.identity?challenge=<64 hex> returns proof = hex(HMAC-SHA256(token, challenge)).
// Another local user squatting the port can't answer that, so it never sees the token.
(function(root) {
  "use strict";

  var PORT = parseInt(root.WEB_MCP_PORT, 10);
  if (!(PORT > 0 && PORT < 65536)) PORT = 3026;
  var TOKEN = typeof root.WEB_MCP_TOKEN === "string" ? root.WEB_MCP_TOKEN : "";
  var BASE = "http://127.0.0.1:" + PORT;
  var REQUEST_TIMEOUT_MS = 5000;
  var IDENTITY_TIMEOUT_MS = 3000;

  var verified = false;  // identity proven since the last connection problem
  var verifying = null;  // in-flight verification promise

  // fetch + read body, aborted after `ms`. Resolves {res, text}; rejects on network error/timeout.
  function fetchText(url, init, ms) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = null;
    if (controller) {
      init.signal = controller.signal;
      timer = setTimeout(function() { controller.abort(); }, ms);
    }
    var done = function() { if (timer) clearTimeout(timer); };
    return fetch(url, init).then(function(res) {
      return res.text().then(function(text) {
        done();
        return { res: res, text: text };
      });
    }).then(null, function(err) {
      done();
      throw err;
    });
  }

  function parse(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function toHex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return out;
  }

  function randomHex(byteCount) {
    var bytes = new Uint8Array(byteCount);
    crypto.getRandomValues(bytes);
    return toHex(bytes);
  }

  function hmacHex(key, message) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      .then(function(k) { return crypto.subtle.sign("HMAC", k, enc.encode(message)); })
      .then(function(sig) { return toHex(new Uint8Array(sig)); });
  }

  function sameString(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  function networkReason(err) {
    return err && err.name === "AbortError" ? "timeout" : "unreachable";
  }

  /**
   * Always performs a fresh challenge. Resolves {ok, reason}; reason is one of
   * "", "no_token", "unreachable", "timeout", "not_web_mcp", "token_mismatch", "error".
   */
  function verifyIdentity() {
    if (verifying) return verifying;
    if (!TOKEN) {
      verified = false;
      return Promise.resolve({ ok: false, reason: "no_token" });
    }
    var challenge;
    try {
      challenge = randomHex(32);
    } catch (e) {
      return Promise.resolve({ ok: false, reason: "error" });
    }
    verifying = fetchText(BASE + "/.identity?challenge=" + challenge, { cache: "no-store", credentials: "omit" }, IDENTITY_TIMEOUT_MS)
      .then(function(r) {
        var data = parse(r.text);
        if (!r.res.ok || !data || data.identity !== "web-mcp-server") return { ok: false, reason: "not_web_mcp" };
        // A web-mcp server that can't prove it knows our token: different token
        // (restarted with a new one) or an impostor. Either way: don't send it.
        if (typeof data.proof !== "string") return { ok: false, reason: "token_mismatch" };
        return hmacHex(TOKEN, challenge).then(function(expected) {
          return sameString(expected, data.proof) ? { ok: true, reason: "" } : { ok: false, reason: "token_mismatch" };
        });
      }, function(err) {
        return { ok: false, reason: networkReason(err) };
      })
      .then(function(result) {
        verified = result.ok;
        verifying = null;
        return result;
      }, function() {
        verified = false;
        verifying = null;
        return { ok: false, reason: "error" };
      });
    return verifying;
  }

  function ensureVerified() {
    return verified ? Promise.resolve({ ok: true, reason: "" }) : verifyIdentity();
  }

  function invalidate() {
    verified = false;
  }

  /**
   * Authenticated request. Never rejects; resolves {ok, status, data, reason}.
   * status 0 means the request was not answered (or not sent: identity unverified).
   */
  function request(method, path, body) {
    return ensureVerified().then(function(v) {
      if (!v.ok) return { ok: false, status: 0, data: null, reason: v.reason };
      var headers = { "Authorization": "Bearer " + TOKEN };
      var init = { method: method, headers: headers, cache: "no-store", credentials: "omit" };
      if (method !== "GET") {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body || {});
      }
      return fetchText(BASE + path, init, REQUEST_TIMEOUT_MS).then(function(r) {
        var status = r.res.status;
        if (status === 401) verified = false;
        return {
          ok: r.res.ok,
          status: status,
          data: parse(r.text),
          reason: r.res.ok ? "" : (status === 401 ? "token_mismatch" : "http")
        };
      }, function(err) {
        verified = false;
        return { ok: false, status: 0, data: null, reason: networkReason(err) };
      });
    });
  }

  /** Unauthenticated liveness probe (no token sent). Resolves true if answered with 2xx. */
  function probe(path, ms) {
    return fetchText(BASE + path, { cache: "no-store", credentials: "omit" }, ms || IDENTITY_TIMEOUT_MS)
      .then(function(r) { return r.res.ok; }, function() { return false; });
  }

  /** Only call right after a successful verifyIdentity(). */
  function eventsUrl() {
    return BASE + "/events?token=" + encodeURIComponent(TOKEN);
  }

  function errorText(r) {
    if (r && r.data && typeof r.data.error === "string") return r.data.error;
    if (r && r.reason && r.reason !== "http") return describe(r.reason);
    return "HTTP " + (r ? r.status : "?");
  }

  function describe(reason) {
    switch (reason) {
      case "token_mismatch":
        return "Extension and server tokens differ — restart the browser via the AI client or run `web-mcp stop`.";
      case "not_web_mcp":
        return "Another program is answering on 127.0.0.1:" + PORT + " and is not a Web MCP server. The token was not sent.";
      case "no_token":
        return "The extension has no token (env.js was not written by the launcher). Start the browser via the AI client.";
      case "timeout":
        return "The Web MCP server on 127.0.0.1:" + PORT + " is not responding.";
      case "unreachable":
        return "Web MCP server not reachable on 127.0.0.1:" + PORT + ".";
      default:
        return "Request failed (" + (reason || "unknown") + ").";
    }
  }

  root.WebMcpApi = {
    PORT: PORT,
    BASE: BASE,
    hasToken: !!TOKEN,
    verifyIdentity: verifyIdentity,
    ensureVerified: ensureVerified,
    invalidate: invalidate,
    request: request,
    probe: probe,
    eventsUrl: eventsUrl,
    errorText: errorText,
    describe: describe
  };
})(globalThis);
