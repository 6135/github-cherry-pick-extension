// Host configs, tokens, settings and the OAuth device flow.
// Used by the background script and the extension pages. Content scripts must not load it.
(function (root) {
  "use strict";

  const L = root.CpLib || (typeof require === "function" ? require("./lib.js") : null);

  const DOTCOM = "github.com";
  const SCOPE_VALUES = [L.SCOPES.public, L.SCOPES.private];
  const DEFAULT_SETTINGS = { trailer: true, maxFiles: L.DEFAULT_MAX_FILES };
  const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

  // ---- Storage ----

  function storage() {
    return root.chrome.storage.local;
  }

  async function readHosts() {
    const data = await storage().get("hosts");
    const hosts = data && data.hosts && typeof data.hosts === "object" ? Object.assign({}, data.hosts) : {};
    if (!hosts[DOTCOM]) hosts[DOTCOM] = { clientId: "", scope: L.SCOPES.public };
    return hosts;
  }

  async function writeHosts(hosts) {
    await storage().set({ hosts });
  }

  function requireHost(host) {
    const h = L.normalizeHost(host);
    if (!h) throw codeError("bad_host", `"${host}" is not a valid host name.`);
    return h;
  }

  // Effective client ID. For github.com, an empty stored value means "use the default".
  function effectiveClientId(host, rec) {
    const own = String((rec && rec.clientId) || "").trim();
    if (own) return own;
    return L.isDotCom(host) ? L.DEFAULT_CLIENT_ID : "";
  }

  function validScope(scope) {
    return SCOPE_VALUES.includes(scope) ? scope : L.SCOPES.public;
  }

  // ---- Hosts ----

  // Host names: github.com first, then the others in alphabetical order.
  async function listHosts() {
    const hosts = await readHosts();
    return [DOTCOM].concat(Object.keys(hosts).filter((h) => h !== DOTCOM).sort());
  }

  // Config without the token. Returns null for an unknown host.
  async function getHostConfig(host) {
    const h = requireHost(host);
    const rec = (await readHosts())[h];
    if (!rec) return null;
    const clientId = effectiveClientId(h, rec);
    return {
      host: h,
      clientId,
      defaultClientId: L.isDotCom(h) ? L.DEFAULT_CLIENT_ID : "",
      customClientId: !!String(rec.clientId || "").trim(),
      scope: validScope(rec.scope),
      loggedIn: !!rec.token,
      login: rec.token ? rec.login || null : null,
      scopes: rec.token ? rec.scopes || [] : []
    };
  }

  // Saves the client ID and the scope. A new client ID deletes the token,
  // because a token belongs to the app that issued it.
  // Returns { loggedOut: true } when the token was deleted.
  async function saveHostConfig(host, cfg) {
    const h = requireHost(host);
    const hosts = await readHosts();
    const rec = hosts[h];
    if (!rec) throw codeError("unknown_host", `${h} is not in the host list.`);
    const next = Object.assign({}, rec);
    if (cfg && "clientId" in cfg) {
      let id = String(cfg.clientId || "").trim();
      if (id && !/^[A-Za-z0-9._-]{1,100}$/.test(id)) throw codeError("bad_client_id", "The client ID has characters that are not valid.");
      // Store "" for the github.com default, so a new default in a later version applies.
      if (L.isDotCom(h) && id === L.DEFAULT_CLIENT_ID) id = "";
      next.clientId = id;
    }
    if (cfg && "scope" in cfg) {
      if (!SCOPE_VALUES.includes(cfg.scope)) throw codeError("bad_scope", "The scope is not valid.");
      next.scope = cfg.scope;
    }
    const loggedOut = !!rec.token && effectiveClientId(h, rec) !== effectiveClientId(h, next);
    if (loggedOut) stripSession(next);
    hosts[h] = next;
    await writeHosts(hosts);
    return { loggedOut };
  }

  // Adds a GitHub Enterprise Server host. Returns the normalized host name.
  async function addHost(host) {
    const h = requireHost(host);
    if (L.isDotCom(h)) throw codeError("dotcom", "github.com is always in the list.");
    const hosts = await readHosts();
    if (!hosts[h]) {
      hosts[h] = { clientId: "", scope: L.SCOPES.public };
      await writeHosts(hosts);
    }
    return h;
  }

  async function removeHost(host) {
    const h = requireHost(host);
    if (L.isDotCom(h)) throw codeError("dotcom", "You cannot remove github.com.");
    const hosts = await readHosts();
    if (!hosts[h]) return;
    delete hosts[h];
    await writeHosts(hosts);
  }

  // ---- Sessions ----

  function stripSession(rec) {
    delete rec.token;
    delete rec.login;
    delete rec.scopes;
  }

  // { token, login, scopes } or null.
  async function getSession(host) {
    const h = L.normalizeHost(host);
    if (!h) return null;
    const rec = (await readHosts())[h];
    if (!rec || !rec.token) return null;
    return { token: rec.token, login: rec.login || null, scopes: rec.scopes || [] };
  }

  async function setSession(host, session) {
    const h = requireHost(host);
    if (!session || !session.token) throw codeError("bad_session", "The session has no token.");
    const hosts = await readHosts();
    if (!hosts[h]) throw codeError("unknown_host", `${h} is not in the host list.`);
    hosts[h] = Object.assign({}, hosts[h], {
      token: String(session.token),
      login: session.login || null,
      scopes: Array.isArray(session.scopes) ? session.scopes : parseScopes(session.scopes)
    });
    await writeHosts(hosts);
  }

  // Deletes the local token only. The user revokes it on GitHub.
  async function clearSession(host) {
    const h = requireHost(host);
    const hosts = await readHosts();
    if (!hosts[h] || !hosts[h].token) return;
    const rec = Object.assign({}, hosts[h]);
    stripSession(rec);
    hosts[h] = rec;
    await writeHosts(hosts);
  }

  // ---- Settings ----

  // The content script reads storage key "settings" directly. Keep this shape.
  async function getSettings() {
    const data = await storage().get("settings");
    return normalizeSettings(Object.assign({}, DEFAULT_SETTINGS, data && data.settings));
  }

  async function saveSettings(partial) {
    const next = normalizeSettings(Object.assign(await getSettings(), partial || {}));
    await storage().set({ settings: next });
    return next;
  }

  function normalizeSettings(s) {
    const n = Math.floor(Number(s.maxFiles));
    return {
      trailer: s.trailer !== false,
      maxFiles: Number.isFinite(n) && n >= 1 ? Math.min(n, 3000) : DEFAULT_SETTINGS.maxFiles
    };
  }

  // ---- Device flow ----

  function getFetch(fetchImpl) {
    return fetchImpl || ((...a) => root.fetch(...a));
  }

  // POST a form and parse the JSON answer. Network and HTTP errors become clear messages.
  async function postForm(fetchImpl, host, url, fields, signal) {
    let res;
    try {
      res = await getFetch(fetchImpl)(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
        cache: "no-store",
        credentials: "omit",
        signal
      });
    } catch (err) {
      if (signal && signal.aborted) throw codeError("aborted", "Login was stopped.");
      throw codeError("network", `Cannot connect to ${host}. Check your network, and that the extension has access to ${host}.`);
    }
    const text = await res.text().catch(() => "");
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    // OAuth errors have a snake_case code, for example "authorization_pending".
    // Other errors (for example 404 {"error": "Not Found"} for an unknown client ID) are HTTP errors.
    const oauth = data && typeof data === "object" && /^[a-z_]+$/.test(String(data.error || ""));
    if (oauth) return { status: res.status, data };
    if (!res.ok) throw httpError(host, res.status);
    if (!data || typeof data !== "object") {
      throw codeError("bad_response", `${host} sent an answer that is not JSON. The host may not support device flow login.`);
    }
    return { status: res.status, data };
  }

  function httpError(host, status) {
    if (status === 404) {
      return codeError("http_404", `${host} did not find the login endpoint (HTTP 404). ` +
        "The client ID may be wrong, or the host may not support device flow login.", { status });
    }
    if (status >= 500) return codeError(`http_${status}`, `${host} has a server error (HTTP ${status}). Try again later.`, { status });
    return codeError(`http_${status}`, `${host} refused the request (HTTP ${status}).`, { status });
  }

  const OAUTH_MESSAGES = {
    expired_token: "The code expired. Try again.",
    access_denied: "The login was cancelled on GitHub.",
    unsupported_grant_type: "GitHub did not accept the grant type. This is a bug in the extension.",
    incorrect_client_credentials: "GitHub does not know this client ID. Check the client ID in the settings.",
    incorrect_device_code: "The device code is not valid. Try again.",
    device_flow_disabled: "Device flow is off for this OAuth App. Turn on \"Enable Device Flow\" in the OAuth App settings on GitHub.",
    unauthorized_client: "This OAuth App cannot use device flow. Turn on \"Enable Device Flow\" in the OAuth App settings on GitHub."
  };

  function oauthError(data) {
    const code = String(data.error);
    const msg = OAUTH_MESSAGES[code] || `GitHub refused the login: ${data.error_description || code}.`;
    return codeError(code, msg, { description: data.error_description || null, uri: data.error_uri || null });
  }

  // Step 1. Returns { device_code, user_code, verification_uri, expires_in, interval }.
  async function requestDeviceCode({ fetchImpl, host, clientId, scope, signal }) {
    const h = requireHost(host);
    if (!clientId) throw codeError("no_client_id", `${h} has no client ID. Add one in the settings.`);
    const { data } = await postForm(fetchImpl, h, `${L.webBase(h)}/login/device/code`,
      { client_id: clientId, scope: validScope(scope) }, signal);
    if (data.error) throw oauthError(data);
    if (!data.device_code || !data.user_code) {
      throw codeError("bad_response", `${h} sent an answer without a device code.`);
    }
    // Use only an https URL. Else use the standard device page of the host.
    const uri = /^https:\/\//i.test(String(data.verification_uri || "")) ? data.verification_uri : `${L.webBase(h)}/login/device`;
    return {
      device_code: String(data.device_code),
      user_code: String(data.user_code),
      verification_uri: uri,
      expires_in: Number(data.expires_in) > 0 ? Number(data.expires_in) : 900,
      interval: Number(data.interval) > 0 ? Number(data.interval) : 5
    };
  }

  function defaultSleep(ms, signal) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        if (signal) signal.removeEventListener("abort", done);
        resolve();
      }
      if (signal) signal.addEventListener("abort", done);
    });
  }

  // Step 2. Polls until the user enters the code on GitHub.
  // Returns { access_token, token_type, scope }. Throws an Error with .code.
  // onWait(seconds) is optional. It is called before each wait.
  async function pollForToken({ fetchImpl, sleep, now, host, clientId, deviceCode, interval, expiresIn, signal, onWait }) {
    const h = requireHost(host);
    const wait = sleep || defaultSleep;
    const clock = now || (() => Date.now());
    const deadline = clock() + (Number(expiresIn) > 0 ? Number(expiresIn) : 900) * 1000;
    let seconds = Number(interval) > 0 ? Number(interval) : 5;
    const aborted = () => codeError("aborted", "Login was stopped.");

    for (;;) {
      if (signal && signal.aborted) throw aborted();
      if (clock() + seconds * 1000 > deadline) throw codeError("expired_token", OAUTH_MESSAGES.expired_token);
      if (onWait) onWait(seconds);
      await wait(seconds * 1000, signal);
      if (signal && signal.aborted) throw aborted();

      const { data } = await postForm(fetchImpl, h, `${L.webBase(h)}/login/oauth/access_token`,
        { client_id: clientId, device_code: deviceCode, grant_type: DEVICE_GRANT }, signal);
      if (data.access_token) {
        return { access_token: String(data.access_token), token_type: data.token_type || "bearer", scope: data.scope || "" };
      }
      if (data.error === "authorization_pending") continue;
      if (data.error === "slow_down") {
        seconds = Number(data.interval) > seconds ? Number(data.interval) : seconds + 5;
        continue;
      }
      if (data.error) throw oauthError(data);
      throw codeError("bad_response", `${h} sent an answer without a token.`);
    }
  }

  // "repo, read:org" → ["repo", "read:org"].
  function parseScopes(value) {
    return String(value || "").split(/[\s,]+/).filter(Boolean);
  }

  // Step 3. Returns { login, scopes }. scopes is null when the header is not readable.
  async function fetchUser({ fetchImpl, host, token, signal }) {
    const h = requireHost(host);
    let res;
    try {
      res = await getFetch(fetchImpl)(`${L.apiBase(h)}/user`, {
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
        cache: "no-store",
        credentials: "omit",
        signal
      });
    } catch (_) {
      throw codeError("network", `Cannot connect to the API of ${h}. Check your network.`);
    }
    if (res.status === 401) throw codeError("bad_token", `${h} did not accept the new token (HTTP 401). Try again.`, { status: 401 });
    if (!res.ok) throw httpError(h, res.status);
    const data = await res.json().catch(() => null);
    if (!data || !data.login) throw codeError("bad_response", `${h} sent a user without a login name.`);
    const header = res.headers.get("x-oauth-scopes");
    return { login: String(data.login), scopes: header === null ? null : parseScopes(header) };
  }

  function codeError(code, message, details) {
    const err = new Error(message);
    err.code = code;
    if (details) err.details = details;
    return err;
  }

  const api = {
    listHosts, getHostConfig, saveHostConfig, addHost, removeHost,
    getSession, setSession, clearSession,
    getSettings, saveSettings, DEFAULT_SETTINGS,
    requestDeviceCode, pollForToken, fetchUser, parseScopes
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CpAuth = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
