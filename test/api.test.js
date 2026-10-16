"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient, nextLink } = require("../src/api.js");

function res(status, body, headers) {
  return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: headers || {} });
}

test("request sends token and parses JSON", async () => {
  let seen;
  const c = createClient({ apiBase: "https://api.x", token: "t", fetchImpl: async (url, init) => { seen = { url, init }; return res(200, { a: 1 }); } });
  assert.deepEqual(await c.get("/repos/a/b"), { a: 1 });
  assert.equal(seen.url, "https://api.x/repos/a/b");
  assert.equal(seen.init.headers.Authorization, "Bearer t");
});

test("errors carry status and SSO url", async () => {
  const c = createClient({ apiBase: "https://api.x", token: "t",
    fetchImpl: async () => res(403, { message: "SSO" }, { "x-github-sso": "required; url=https://github.com/orgs/o/sso?x=1" }) });
  await assert.rejects(c.get("/x"), (e) => e.status === 403 && e.ssoUrl === "https://github.com/orgs/o/sso?x=1");
});

test("retries after retry-after", async () => {
  let n = 0;
  const c = createClient({ apiBase: "https://api.x", sleep: async () => {},
    fetchImpl: async () => (++n === 1 ? res(403, { message: "slow" }, { "retry-after": "2" }) : res(201, { ok: 1 })) });
  assert.deepEqual(await c.post("/x", {}), { ok: 1 });
  assert.equal(n, 2);
});

test("paginate follows next links", async () => {
  const pages = {
    "https://api.x/l": res(200, [1, 2], { link: '<https://api.x/l?page=2>; rel="next"' }),
    "https://api.x/l?page=2": res(200, [3])
  };
  const c = createClient({ apiBase: "https://api.x", fetchImpl: async (url) => pages[url] });
  assert.deepEqual(await c.paginate("/l"), [1, 2, 3]);
  assert.equal(nextLink('<a>; rel="prev", <b>; rel="next"'), "b");
});
