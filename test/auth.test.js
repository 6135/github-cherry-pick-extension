"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/lib.js");
const A = require("../src/auth.js");

// Fake chrome.storage.local. Values are copied, like the real one.
function installChrome(initial) {
  let data = structuredClone(initial || {});
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          const out = {};
          for (const k of [].concat(key)) if (k in data) out[k] = structuredClone(data[k]);
          return out;
        },
        async set(obj) { data = Object.assign(data, structuredClone(obj)); }
      }
    }
  };
  return { dump: () => structuredClone(data) };
}

function json(status, body, headers) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ "content-type": "application/json" }, headers) });
}

test("github.com always exists with defaults", async () => {
  installChrome();
  assert.deepEqual(await A.listHosts(), ["github.com"]);
  const c = await A.getHostConfig("github.com");
  assert.equal(c.clientId, L.DEFAULT_CLIENT_ID);
  assert.equal(c.scope, "public_repo");
  assert.equal(c.loggedIn, false);
  assert.equal(await A.getSession("github.com"), null);
});

test("add, list and remove hosts", async () => {
  installChrome();
  assert.equal(await A.addHost("https://GHE.example.com/x"), "ghe.example.com");
  await A.addHost("a.example.com");
  assert.deepEqual(await A.listHosts(), ["github.com", "a.example.com", "ghe.example.com"]);
  assert.equal((await A.getHostConfig("ghe.example.com")).clientId, "");
  await assert.rejects(A.removeHost("github.com"), { code: "dotcom" });
  await assert.rejects(A.addHost("http://bad"), { code: "bad_host" });
  await A.removeHost("a.example.com");
  assert.deepEqual(await A.listHosts(), ["github.com", "ghe.example.com"]);
  assert.equal(await A.getHostConfig("a.example.com"), null);
});

test("sessions: set, get, clear; token is not in the config", async () => {
  const s = installChrome();
  await A.setSession("github.com", { token: "gho_1", login: "me", scopes: ["repo"] });
  assert.deepEqual(await A.getSession("github.com"), { token: "gho_1", login: "me", scopes: ["repo"] });
  const c = await A.getHostConfig("github.com");
  assert.equal(c.login, "me");
  assert.equal("token" in c, false);
  await A.clearSession("github.com");
  assert.equal(await A.getSession("github.com"), null);
  assert.equal(s.dump().hosts["github.com"].token, undefined);
});

test("a new client ID deletes the token; the scope does not", async () => {
  installChrome();
  await A.addHost("ghe.example.com");
  await A.saveHostConfig("ghe.example.com", { clientId: "Iv1.abc" });
  await A.setSession("ghe.example.com", { token: "t", login: "me", scopes: [] });
  assert.deepEqual(await A.saveHostConfig("ghe.example.com", { scope: "repo" }), { loggedOut: false });
  assert.ok(await A.getSession("ghe.example.com"));
  assert.deepEqual(await A.saveHostConfig("ghe.example.com", { clientId: " Iv1.abc " }), { loggedOut: false });
  assert.deepEqual(await A.saveHostConfig("ghe.example.com", { clientId: "Iv1.other" }), { loggedOut: true });
  assert.equal(await A.getSession("ghe.example.com"), null);
  const c = await A.getHostConfig("ghe.example.com");
  assert.equal(c.clientId, "Iv1.other");
  assert.equal(c.scope, "repo");
  await assert.rejects(A.saveHostConfig("ghe.example.com", { scope: "workflow" }), { code: "bad_scope" });
  await assert.rejects(A.saveHostConfig("ghe.example.com", { clientId: "a b" }), { code: "bad_client_id" });
});

test("github.com: empty client ID means the default", async () => {
  const s = installChrome();
  await A.saveHostConfig("github.com", { clientId: "custom" });
  assert.equal((await A.getHostConfig("github.com")).customClientId, true);
  await A.saveHostConfig("github.com", { clientId: "" });
  const c = await A.getHostConfig("github.com");
  assert.equal(c.clientId, L.DEFAULT_CLIENT_ID);
  assert.equal(c.customClientId, false);
  assert.equal(s.dump().hosts["github.com"].clientId, "");
});

test("settings: defaults and partial save", async () => {
  const s = installChrome();
  assert.deepEqual(await A.getSettings(), { trailer: true, maxFiles: L.DEFAULT_MAX_FILES });
  await A.saveSettings({ trailer: false });
  await A.saveSettings({ maxFiles: "250" });
  assert.deepEqual(s.dump().settings, { trailer: false, maxFiles: 250 });
  await A.saveSettings({ maxFiles: -3 });
  assert.equal((await A.getSettings()).maxFiles, L.DEFAULT_MAX_FILES);
});

test("requestDeviceCode sends a form and parses the answer", async () => {
  let seen;
  const out = await A.requestDeviceCode({
    host: "ghe.example.com", clientId: "cid", scope: "repo",
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return json(200, { device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://ghe.example.com/login/device", expires_in: 899, interval: 5 });
    }
  });
  assert.equal(seen.url, "https://ghe.example.com/login/device/code");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.Accept, "application/json");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(seen.init.body)), { client_id: "cid", scope: "repo" });
  assert.deepEqual(out, { device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://ghe.example.com/login/device", expires_in: 899, interval: 5 });
});

test("requestDeviceCode errors", async () => {
  await assert.rejects(A.requestDeviceCode({ host: "github.com", clientId: "", fetchImpl: async () => json(200, {}) }), { code: "no_client_id" });
  await assert.rejects(A.requestDeviceCode({ host: "ghe.example.com", clientId: "c", fetchImpl: async () => new Response("Not Found", { status: 404 }) }),
    (e) => e.code === "http_404" && /device flow/.test(e.message));
  // github.com answers an unknown client ID with 404 {"error":"Not Found"}.
  await assert.rejects(A.requestDeviceCode({ host: "github.com", clientId: "c", fetchImpl: async () => json(404, { error: "Not Found" }) }),
    (e) => e.code === "http_404" && /client ID/.test(e.message));
  await assert.rejects(A.requestDeviceCode({ host: "github.com", clientId: "c", fetchImpl: async () => { throw new TypeError("Failed to fetch"); } }),
    (e) => e.code === "network" && /github\.com/.test(e.message));
  await assert.rejects(A.requestDeviceCode({ host: "github.com", clientId: "c", fetchImpl: async () => json(400, { error: "device_flow_disabled" }) }),
    (e) => e.code === "device_flow_disabled" && /Enable Device Flow/.test(e.message));
  await assert.rejects(A.requestDeviceCode({ host: "github.com", clientId: "c", fetchImpl: async () => new Response("<html>", { status: 200 }) }),
    { code: "bad_response" });
});

function poller(answers) {
  const calls = [];
  const waits = [];
  let t = 0;
  return {
    calls, waits,
    opts: {
      host: "github.com", clientId: "cid", deviceCode: "dc", interval: 5, expiresIn: 900,
      now: () => t,
      sleep: async (ms) => { waits.push(ms); t += ms; },
      fetchImpl: async (url, init) => {
        calls.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) });
        const a = answers.shift();
        return typeof a === "function" ? a() : json(200, a);
      }
    }
  };
}

test("pollForToken waits on pending and slow_down, then returns the token", async () => {
  const p = poller([{ error: "authorization_pending" }, { error: "slow_down" }, { error: "slow_down", interval: 20 },
    { access_token: "gho_x", token_type: "bearer", scope: "public_repo" }]);
  const out = await A.pollForToken(p.opts);
  assert.deepEqual(out, { access_token: "gho_x", token_type: "bearer", scope: "public_repo" });
  assert.deepEqual(p.waits, [5000, 5000, 10000, 20000]);
  assert.equal(p.calls[0].url, "https://github.com/login/oauth/access_token");
  assert.deepEqual(p.calls[0].body, { client_id: "cid", device_code: "dc", grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
});

test("pollForToken maps OAuth errors", async () => {
  for (const code of ["expired_token", "access_denied", "unsupported_grant_type", "incorrect_client_credentials",
    "incorrect_device_code", "device_flow_disabled"]) {
    const p = poller([{ error: code }]);
    await assert.rejects(A.pollForToken(p.opts), (e) => e.code === code && e.message.length > 10 && !e.message.includes("undefined"));
  }
});

test("pollForToken stops at expiry", async () => {
  const answers = Array.from({ length: 100 }, () => ({ error: "authorization_pending" }));
  const p = poller(answers);
  p.opts.expiresIn = 30;
  await assert.rejects(A.pollForToken(p.opts), { code: "expired_token" });
  assert.equal(p.calls.length, 6);
});

test("pollForToken stops on abort", async () => {
  const ctrl = new AbortController();
  const p = poller([() => { ctrl.abort(); return json(200, { error: "authorization_pending" }); }]);
  await assert.rejects(A.pollForToken(Object.assign(p.opts, { signal: ctrl.signal })), { code: "aborted" });
  assert.equal(p.calls.length, 1);
});

test("pollForToken with the default sleep ends at once on abort", async () => {
  const ctrl = new AbortController();
  const run = A.pollForToken({ host: "github.com", clientId: "c", deviceCode: "d", interval: 60, expiresIn: 900,
    signal: ctrl.signal, fetchImpl: async () => { throw new Error("must not fetch"); } });
  setTimeout(() => ctrl.abort(), 5);
  await assert.rejects(run, { code: "aborted" });
});

test("fetchUser reads login and scopes", async () => {
  let seen;
  const out = await A.fetchUser({ host: "ghe.example.com", token: "t",
    fetchImpl: async (url, init) => { seen = { url, init }; return json(200, { login: "me" }, { "x-oauth-scopes": "repo, read:org" }); } });
  assert.equal(seen.url, "https://ghe.example.com/api/v3/user");
  assert.equal(seen.init.headers.Authorization, "Bearer t");
  assert.deepEqual(out, { login: "me", scopes: ["repo", "read:org"] });
  const noHeader = await A.fetchUser({ host: "github.com", token: "t", fetchImpl: async () => json(200, { login: "me" }) });
  assert.equal(noHeader.scopes, null);
  await assert.rejects(A.fetchUser({ host: "github.com", token: "t", fetchImpl: async () => json(401, { message: "Bad credentials" }) }), { code: "bad_token" });
});

test("requestDeviceCode accepts the device page only on the same host", async () => {
  const answer = (uri) => async () => json(200, { device_code: "dc", user_code: "U", verification_uri: uri, expires_in: 900, interval: 5 });
  for (const bad of ["https://evil.example/login/device", "http://github.com/login/device", "javascript:alert(1)"]) {
    const out = await A.requestDeviceCode({ host: "github.com", clientId: "c", scope: "repo", fetchImpl: answer(bad) });
    assert.equal(out.verification_uri, "https://github.com/login/device", bad);
  }
  const ok = await A.requestDeviceCode({ host: "github.com", clientId: "c", scope: "repo", fetchImpl: answer("https://github.com/login/device?x=1") });
  assert.equal(ok.verification_uri, "https://github.com/login/device?x=1");
});
