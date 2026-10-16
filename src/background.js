// Message router. The only place that reads tokens and calls the GitHub API.
//
// One-shot messages (chrome.runtime.sendMessage), reply is { ok: true, ... } or { ok: false, error }:
//   { type: "session", host }                         → { session: { login, scopes } | null }
//   { type: "openLogin", host }                       → opens the login tab
//   { type: "openOptions" }                           → opens the settings page
//   { type: "repoInfo", host, owner, repo }           → { repo: { fullName, fork, defaultBranch,
//                                                         parent: {owner, repo, defaultBranch} | null, canPush } }
//   { type: "branches", host, owner, repo }           → { branches: ["main", ...] } (up to 1000)
//   { type: "pullCommits", host, owner, repo, number } → { commits: [{ sha, message, parents }] } (oldest first)
//
// Long job (chrome.runtime.connect({ name: "pick" })). The open port keeps the worker alive.
//   content → { type: "start", request }   request: see CpCore.runPick in cherry-pick.js
//   bg → { type: "progress", step, done, total, text }
//   bg → { type: "done", result }          result: see CpCore.runPick
//   bg → { type: "error", error }          error: { code, message, details }
"use strict";

if (typeof importScripts === "function") {
  // Chrome service worker. Firefox loads these from manifest background.scripts.
  importScripts("lib.js", "api.js", "auth.js", "hosts.js", "cherry-pick.js");
}

const L = globalThis.CpLib;

chrome.runtime.onInstalled.addListener(() => { CpHosts.syncContentScripts().catch(logError); });
chrome.runtime.onStartup.addListener(() => { CpHosts.syncContentScripts().catch(logError); });

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && HANDLERS[msg.type];
  if (!handler) return false;
  handler(msg, sender).then(
    (out) => sendResponse(Object.assign({ ok: true }, out)),
    (err) => sendResponse({ ok: false, error: errorInfo(err) })
  );
  return true; // Keep the channel open for the async response.
});

const HANDLERS = {
  async session(msg) {
    const s = await CpAuth.getSession(hostOf(msg));
    return { session: s ? { login: s.login, scopes: s.scopes } : null };
  },

  async openLogin(msg) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`src/login.html?host=${encodeURIComponent(hostOf(msg))}`) });
    return {};
  },

  async openOptions() {
    await chrome.runtime.openOptionsPage();
    return {};
  },

  async repoInfo(msg) {
    const client = await clientFor(hostOf(msg));
    const d = await client.get(`/repos/${enc(msg.owner)}/${enc(msg.repo)}`);
    return {
      repo: {
        fullName: d.full_name,
        fork: !!d.fork,
        defaultBranch: d.default_branch || null,
        parent: d.parent ? { owner: d.parent.owner.login, repo: d.parent.name, defaultBranch: d.parent.default_branch || null } : null,
        canPush: !!(d.permissions && d.permissions.push)
      }
    };
  },

  async branches(msg) {
    const client = await clientFor(hostOf(msg));
    const list = await client.paginate(`/repos/${enc(msg.owner)}/${enc(msg.repo)}/branches?per_page=100`, { maxPages: 10 });
    return { branches: list.map((b) => b.name) };
  },

  async pullCommits(msg) {
    const client = await clientFor(hostOf(msg));
    const list = await client.paginate(
      `/repos/${enc(msg.owner)}/${enc(msg.repo)}/pulls/${Number(msg.number)}/commits?per_page=100`, { maxPages: 3 });
    return { commits: list.map((c) => ({ sha: c.sha, message: c.commit.message, parents: c.parents.map((p) => p.sha) })) };
  }
};

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "pick") return;
  let started = false;
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== "start" || started) return;
    started = true;
    const post = (m) => { try { port.postMessage(m); } catch (_) { /* Port closed. */ } };
    try {
      const host = hostOf(msg.request);
      const session = await CpAuth.getSession(host);
      if (!session) throw codeError("not_logged_in", `Log in to ${host} in the extension settings.`);
      const client = CpApi.createClient({ apiBase: L.apiBase(host), token: session.token });
      const result = await CpCore.runPick(client, Object.assign({}, msg.request, { login: session.login }),
        (p) => post(Object.assign({ type: "progress" }, p)));
      post({ type: "done", result });
    } catch (err) {
      post({ type: "error", error: errorInfo(err) });
    }
  });
});

async function clientFor(host) {
  const session = await CpAuth.getSession(host);
  if (!session) throw codeError("not_logged_in", `Log in to ${host} in the extension settings.`);
  return CpApi.createClient({ apiBase: L.apiBase(host), token: session.token });
}

function hostOf(msg) {
  const host = L.normalizeHost(msg && msg.host);
  if (!host) throw codeError("bad_host", "Host is not valid.");
  return host;
}

function enc(s) {
  return encodeURIComponent(String(s));
}

function codeError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details) err.details = details;
  return err;
}

// Converts any error to a plain object the content script can show.
function errorInfo(err) {
  if (!err) return { code: "unknown", message: "Unknown error." };
  if (err.name === "GitHubError") {
    const code = err.ssoUrl ? "sso_required"
      : err.status === 401 ? "bad_token"
      : err.rateLimited ? "rate_limited"
      : err.status === 404 ? "not_found"
      : `http_${err.status}`;
    return { code, message: err.message, details: { status: err.status, ssoUrl: err.ssoUrl || null, acceptedScopes: err.acceptedScopes || null } };
  }
  return { code: err.code || "error", message: String(err.message || err), details: err.details || null };
}

function logError(err) {
  console.error(err);
}
