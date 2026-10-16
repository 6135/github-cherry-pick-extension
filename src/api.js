// Small GitHub REST client. Used only by background scripts (it holds the token).
(function (root) {
  "use strict";

  class GitHubError extends Error {
    constructor(status, message, details) {
      super(message);
      this.name = "GitHubError";
      this.status = status;
      Object.assign(this, details || {});
    }
  }

  // apiBase: "https://api.github.com" or "https://<ghes>/api/v3".
  // fetchImpl and sleep can be replaced in tests.
  function createClient({ apiBase, token, fetchImpl, sleep }) {
    const doFetch = fetchImpl || ((...a) => fetch(...a));
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

    async function request(method, path, body, opts) {
      opts = opts || {};
      const headers = {
        Accept: opts.accept || "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const url = /^https:\/\//.test(path) ? path : apiBase + path;
      // Send the token only to the API host. Link headers give absolute URLs.
      if (new URL(url).origin !== new URL(apiBase).origin) {
        throw new GitHubError(0, `Refused to send the token to ${new URL(url).origin}.`, { code: "bad_url" });
      }

      for (let attempt = 0; ; attempt++) {
        const res = await doFetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: "no-store"
        });
        const delay = retryDelay(res);
        if (delay !== null && attempt < 2) {
          await wait(delay);
          continue;
        }
        const text = await res.text();
        let data = null;
        if (text) {
          try { data = JSON.parse(text); } catch (_) { data = text; }
        }
        if (res.ok) return { status: res.status, data, headers: res.headers };
        throw toError(res, data);
      }
    }

    // Follows "Link: rel=next" up to maxPages. Returns all items.
    // pick(data) returns the item array from a page (default: the page itself).
    async function paginate(path, opts) {
      opts = opts || {};
      const maxPages = opts.maxPages || 10;
      const pick = opts.pick || ((d) => d);
      const out = [];
      let next = path;
      for (let i = 0; next && i < maxPages; i++) {
        const res = await request("GET", next);
        out.push(...(pick(res.data) || []));
        next = nextLink(res.headers.get("link"));
      }
      return out;
    }

    return {
      apiBase,
      request,
      paginate,
      get: (path, opts) => request("GET", path, undefined, opts).then((r) => r.data),
      post: (path, body) => request("POST", path, body).then((r) => r.data),
      patch: (path, body) => request("PATCH", path, body).then((r) => r.data),
      del: (path) => request("DELETE", path).then((r) => r.data)
    };
  }

  // Milliseconds to wait for a rate limit, or null when the response is not rate limited.
  // Waits only up to 60 s. A longer limit becomes an error.
  function retryDelay(res) {
    if (res.status !== 403 && res.status !== 429) return null;
    const after = Number(res.headers.get("retry-after"));
    if (after > 0) return after <= 60 ? after * 1000 : null;
    if (res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      const ms = reset - Date.now();
      return ms > 0 && ms <= 60000 ? ms + 1000 : null;
    }
    return null;
  }

  function nextLink(header) {
    if (!header) return null;
    for (const part of header.split(",")) {
      const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
      if (m) return m[1];
    }
    return null;
  }

  function toError(res, data) {
    const apiMessage = data && typeof data === "object" && data.message ? data.message : `HTTP ${res.status}`;
    const sso = res.headers.get("x-github-sso");
    const ssoMatch = sso && /url=(\S+)/.exec(sso);
    const ssoUrl = ssoMatch && /^https:\/\//i.test(ssoMatch[1]) ? ssoMatch[1] : null;
    return new GitHubError(res.status, apiMessage, {
      apiMessage,
      errors: data && data.errors,
      ssoUrl,
      oauthScopes: res.headers.get("x-oauth-scopes"),
      acceptedScopes: res.headers.get("x-accepted-oauth-scopes"),
      rateLimited: (res.status === 403 || res.status === 429) &&
        (res.headers.get("x-ratelimit-remaining") === "0" || !!res.headers.get("retry-after"))
    });
  }

  const api = { createClient, GitHubError, nextLink, retryDelay };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CpApi = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
