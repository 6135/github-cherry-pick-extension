// Dynamic content scripts for GitHub Enterprise Server hosts.
// github.com uses the static content script in manifest.json.
(function (root) {
  "use strict";

  const L = root.CpLib || (typeof require === "function" ? require("./lib.js") : null);
  const A = root.CpAuth || (typeof require === "function" ? require("./auth.js") : null);

  const PREFIX = "ghes-";

  // Host names have only [a-z0-9.-]. Chrome and Firefox accept dots in IDs.
  // The only rule is: the ID must not start with "_".
  function scriptId(host) {
    return PREFIX + host;
  }

  function originPattern(host) {
    return `https://${host}/*`;
  }

  function scriptFor(host) {
    return {
      id: scriptId(host),
      matches: [originPattern(host)],
      js: L.CONTENT_SCRIPT.js.slice(),
      css: L.CONTENT_SCRIPT.css.slice(),
      runAt: "document_idle",
      allFrames: false
    };
  }

  function hasOrigin(host) {
    return root.chrome.permissions.contains({ origins: [originPattern(host)] });
  }

  function samePaths(a, b) {
    const clean = (list) => (list || []).map((p) => String(p).replace(/^\//, ""));
    return JSON.stringify(clean(a)) === JSON.stringify(clean(b));
  }

  function sameScript(reg, want) {
    return samePaths(reg.matches, want.matches) && samePaths(reg.js, want.js) &&
      samePaths(reg.css, want.css) && (reg.runAt || "document_idle") === want.runAt;
  }

  // null: not known yet. false: the browser rejected the key.
  let persistSupported = null;

  async function register(scripts) {
    const S = root.chrome.scripting;
    if (persistSupported !== false) {
      try {
        await S.registerContentScripts(scripts.map((s) => Object.assign({ persistAcrossSessions: true }, s)));
        persistSupported = true;
        return;
      } catch (err) {
        if (persistSupported === true || !/persist/i.test(String(err && err.message))) throw err;
        persistSupported = false;
      }
    }
    await S.registerContentScripts(scripts);
  }

  async function syncOnce() {
    const S = root.chrome.scripting;
    const hosts = (await A.listHosts()).filter((h) => !L.isDotCom(h));
    const wanted = new Map();
    for (const host of hosts) {
      let granted = false;
      try { granted = await hasOrigin(host); } catch (_) { granted = false; }
      if (granted) wanted.set(scriptId(host), scriptFor(host));
    }

    const ours = (await S.getRegisteredContentScripts()).filter((s) => s.id.startsWith(PREFIX));
    const removed = ours.filter((s) => !wanted.has(s.id) || !sameScript(s, wanted.get(s.id))).map((s) => s.id);
    if (removed.length) await S.unregisterContentScripts({ ids: removed });

    const kept = new Set(ours.map((s) => s.id).filter((id) => !removed.includes(id)));
    const toAdd = [...wanted.values()].filter((s) => !kept.has(s.id));
    if (toAdd.length) {
      try {
        await register(toAdd);
      } catch (err) {
        // Another page can register the same ID at the same time. Check what is there now.
        const now = new Set((await S.getRegisteredContentScripts()).map((s) => s.id));
        const missing = toAdd.filter((s) => !now.has(s.id));
        if (missing.length === toAdd.length) throw err;
        if (missing.length) await register(missing);
      }
    }
    return { registered: [...wanted.keys()].sort(), added: toAdd.map((s) => s.id), removed };
  }

  // Calls run one after the other, so two calls cannot register the same ID.
  let queue = Promise.resolve();

  // Makes the registered scripts match the stored hosts and the granted permissions.
  // Safe to call many times. Returns { registered, added, removed } (script IDs).
  function syncContentScripts() {
    const run = queue.then(syncOnce, syncOnce);
    queue = run.catch(() => {});
    return run;
  }

  const api = { syncContentScripts, scriptId, originPattern };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CpHosts = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
