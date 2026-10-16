"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/lib.js");

// Fake chrome with storage, permissions and scripting.
function installChrome({ hosts, granted, rejectPersist }) {
  const data = { hosts: structuredClone(hosts || {}) };
  const registered = new Map();
  const calls = { register: 0, unregister: 0 };
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
        async set(obj) { Object.assign(data, structuredClone(obj)); }
      }
    },
    permissions: {
      async contains({ origins }) { return origins.every((o) => granted.includes(o)); }
    },
    scripting: {
      async getRegisteredContentScripts() { return [...registered.values()].map((s) => structuredClone(s)); },
      async registerContentScripts(list) {
        calls.register++;
        for (const s of list) {
          if (rejectPersist && "persistAcrossSessions" in s) throw new Error("Unexpected property \"persistAcrossSessions\"");
          if (registered.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
        }
        for (const s of list) registered.set(s.id, structuredClone(s));
      },
      async unregisterContentScripts({ ids }) {
        calls.unregister++;
        for (const id of ids) registered.delete(id);
      }
    }
  };
  return { registered, calls, data };
}

function freshHosts() {
  for (const m of ["../src/hosts.js", "../src/auth.js"]) delete require.cache[require.resolve(m)];
  return require("../src/hosts.js");
}

test("registers granted GHES hosts only, and is idempotent", async () => {
  const env = installChrome({
    hosts: { "github.com": {}, "a.example.com": {}, "b.example.com": {} },
    granted: ["https://a.example.com/*"]
  });
  const H = freshHosts();
  const r1 = await H.syncContentScripts();
  assert.deepEqual(r1.registered, ["ghes-a.example.com"]);
  const s = env.registered.get("ghes-a.example.com");
  assert.deepEqual(s.matches, ["https://a.example.com/*"]);
  assert.deepEqual(s.js, L.CONTENT_SCRIPT.js);
  assert.deepEqual(s.css, L.CONTENT_SCRIPT.css);
  assert.equal(s.runAt, "document_idle");
  assert.equal(s.persistAcrossSessions, true);

  const r2 = await H.syncContentScripts();
  assert.deepEqual(r2.added, []);
  assert.deepEqual(r2.removed, []);
  assert.equal(env.calls.register, 1);
});

test("unregisters removed and revoked hosts", async () => {
  const granted = ["https://a.example.com/*", "https://b.example.com/*"];
  const env = installChrome({ hosts: { "a.example.com": {}, "b.example.com": {} }, granted });
  const H = freshHosts();
  await H.syncContentScripts();
  assert.equal(env.registered.size, 2);
  delete env.data.hosts["a.example.com"];
  granted.pop();
  const r = await H.syncContentScripts();
  assert.deepEqual(r.removed.sort(), ["ghes-a.example.com", "ghes-b.example.com"]);
  assert.equal(env.registered.size, 0);
});

test("leaves scripts that are not ours", async () => {
  const env = installChrome({ hosts: {}, granted: [] });
  env.registered.set("other", { id: "other", matches: ["https://x/*"], js: ["a.js"] });
  await freshHosts().syncContentScripts();
  assert.ok(env.registered.has("other"));
});

test("retries without persistAcrossSessions when the browser rejects it", async () => {
  const env = installChrome({ hosts: { "a.example.com": {} }, granted: ["https://a.example.com/*"], rejectPersist: true });
  const H = freshHosts();
  await H.syncContentScripts();
  const s = env.registered.get("ghes-a.example.com");
  assert.ok(s);
  assert.equal("persistAcrossSessions" in s, false);
});

test("parallel calls do not register twice", async () => {
  const env = installChrome({ hosts: { "a.example.com": {} }, granted: ["https://a.example.com/*"] });
  const H = freshHosts();
  await Promise.all([H.syncContentScripts(), H.syncContentScripts(), H.syncContentScripts()]);
  assert.equal(env.calls.register, 1);
  assert.equal(env.registered.size, 1);
});

test("updates a script whose files changed", async () => {
  const env = installChrome({ hosts: { "a.example.com": {} }, granted: ["https://a.example.com/*"] });
  env.registered.set("ghes-a.example.com", { id: "ghes-a.example.com", matches: ["https://a.example.com/*"], js: ["old.js"], css: [], runAt: "document_idle" });
  const r = await freshHosts().syncContentScripts();
  assert.deepEqual(r.removed, ["ghes-a.example.com"]);
  assert.deepEqual(env.registered.get("ghes-a.example.com").js, L.CONTENT_SCRIPT.js);
});
