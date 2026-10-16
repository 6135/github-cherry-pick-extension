// Pure logic. No DOM, no extension APIs. Shared by all scripts and the Node tests.
(function (root) {
  "use strict";

  // OAuth App client ID for github.com. Public value, not a secret.
  // Users can override it per host in the settings. Empty means "not set".
  const DEFAULT_CLIENT_ID = "";

  const SCOPES = { public: "public_repo", private: "repo" };

  // Files the extension injects on GitHub pages. hosts.js uses this for GHES hosts.
  const CONTENT_SCRIPT = { js: ["src/lib.js", "src/content.js"], css: ["src/content.css"] };

  const DEFAULT_MAX_FILES = 100;

  // First path segments that are GitHub pages, not repository owners.
  const RESERVED_OWNERS = new Set([
    "about", "account", "apps", "codespaces", "collections", "contact", "copilot",
    "dashboard", "enterprise", "enterprises", "explore", "features", "issues",
    "login", "logout", "marketplace", "new", "notifications", "orgs", "organizations",
    "pricing", "pulls", "search", "security", "settings", "signup", "sponsors",
    "topics", "trending", "users"
  ]);

  // Returns a lowercase host name ("github.example.com"), or null when not valid.
  // Accepts "host", "https://host", "https://host/path".
  function normalizeHost(input) {
    let s = String(input || "").trim().toLowerCase();
    if (!s) return null;
    if (!/^[a-z]+:\/\//.test(s)) s = "https://" + s;
    let url;
    try { url = new URL(s); } catch (_) { return null; }
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
    if (host === "api.github.com" || host === "www.github.com") return "github.com";
    return host;
  }

  function isDotCom(host) {
    return host === "github.com";
  }

  function webBase(host) {
    return `https://${host}`;
  }

  function apiBase(host) {
    return isDotCom(host) ? "https://api.github.com" : `https://${host}/api/v3`;
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (_) { return s; }
  }

  function repoParts(pathname) {
    const parts = String(pathname || "").split("/").filter(Boolean).map(safeDecode);
    if (parts.length < 2 || RESERVED_OWNERS.has(parts[0].toLowerCase())) return null;
    return parts;
  }

  const SHA_RE = /^[0-9a-f]{7,40}$/i;

  // "/o/r/commit/<sha>" or "/o/r/pull/<n>/commits/<sha>" → { owner, repo, sha }, else null.
  function parseCommitPage(pathname) {
    const p = repoParts(pathname);
    if (!p) return null;
    const [owner, repo] = p;
    if (p[2] === "commit" && p.length === 4 && SHA_RE.test(p[3])) return { owner, repo, sha: p[3].toLowerCase() };
    if (p[2] === "pull" && /^\d+$/.test(p[3] || "") && p[4] === "commits" && p.length === 6 && SHA_RE.test(p[5])) {
      return { owner, repo, sha: p[5].toLowerCase() };
    }
    return null;
  }

  // "/o/r/pull/<n>/commits" → { owner, repo, number }, else null.
  function parsePullCommitsPage(pathname) {
    const p = repoParts(pathname);
    if (!p || p.length !== 5) return null;
    const [owner, repo] = p;
    if (p[2] === "pull" && /^\d+$/.test(p[3]) && p[4] === "commits") return { owner, repo, number: Number(p[3]) };
    return null;
  }

  // Parses "owner/repo:branch", "owner/repo" or ":branch".
  // Missing parts are null. Returns null when the text is not valid.
  function parseTarget(text) {
    const s = String(text || "").trim();
    if (!s) return null;
    const colon = s.indexOf(":");
    const repoPart = colon === -1 ? s : s.slice(0, colon);
    const branch = colon === -1 ? null : s.slice(colon + 1).trim() || null;
    if (!repoPart) return branch ? { owner: null, repo: null, branch } : null;
    const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(repoPart.trim());
    if (!m) return null;
    return { owner: m[1], repo: m[2], branch };
  }

  function sameRepo(a, b) {
    return !!a && !!b && String(a.owner).toLowerCase() === String(b.owner).toLowerCase() &&
      String(a.repo).toLowerCase() === String(b.repo).toLowerCase();
  }

  // Git ref name rules (git check-ref-format), for a branch name.
  function isValidBranchName(name) {
    const s = String(name || "");
    if (!s || s.length > 250) return false;
    if (s.startsWith("/") || s.endsWith("/") || s.endsWith(".") || s.startsWith("-")) return false;
    if (s.includes("..") || s.includes("//") || s.includes("@{") || s === "@") return false;
    if (/[\x00-\x20\x7f~^:?*[\\]/.test(s)) return false;
    return s.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
  }

  // Replaces characters that are not valid in a branch name.
  function sanitizeBranchPart(s) {
    return String(s || "")
      .replace(/[\x00-\x20\x7f~^:?*[\\]+/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/@\{/g, "-")
      .replace(/\/{2,}/g, "/")
      .replace(/^[-./]+|[./]+$/g, "")
      .replace(/\.lock(\/|$)/g, "-lock$1");
  }

  // "cherry-pick/abc1234-to-main" or "cherry-pick/abc1234+2-to-release-1.0".
  function defaultBranchName(shas, targetBranch) {
    const first = String((shas && shas[0]) || "").slice(0, 7);
    const more = shas && shas.length > 1 ? `+${shas.length - 1}` : "";
    const target = sanitizeBranchPart(String(targetBranch || "").replace(/\//g, "-")) || "target";
    return `cherry-pick/${first}${more}-to-${target}`;
  }

  // Adds "(cherry picked from commit <sha>)" like `git cherry-pick -x`.
  function appendTrailer(message, sha) {
    const trailer = `(cherry picked from commit ${sha})`;
    const msg = String(message || "").replace(/\s+$/, "");
    if (msg.includes(trailer)) return msg + "\n";
    return `${msg}\n\n${trailer}\n`;
  }

  function isWorkflowPath(path) {
    return /^\.github\/workflows\//.test(String(path || ""));
  }

  // URL of GitHub's "Open a pull request" form, with fields filled in.
  // base: { owner, repo, branch } (PR target). head: { owner, repo, branch } (new branch).
  function compareUrl(host, base, head, fields) {
    const enc = (s) => String(s).split("/").map(encodeURIComponent).join("/");
    const headRef = sameRepo(base, head)
      ? enc(head.branch)
      : `${encodeURIComponent(head.owner)}:${encodeURIComponent(head.repo)}:${enc(head.branch)}`;
    const path = `/${encodeURIComponent(base.owner)}/${encodeURIComponent(base.repo)}/compare/${enc(base.branch)}...${headRef}`;
    const params = new URLSearchParams({ quick_pull: "1" });
    if (fields && fields.title) params.set("title", fields.title);
    if (fields && fields.body) params.set("body", fields.body);
    return `${webBase(host)}${path}?${params}`;
  }

  // Default PR title and body for a list of picked commits.
  // commits: [{ sha, message }] in apply order.
  function defaultPrText(commits, targetBranch) {
    const subject = (m) => String(m || "").split("\n")[0].trim();
    const title = commits.length === 1
      ? `[${targetBranch}] ${subject(commits[0].message)}`
      : `[${targetBranch}] Cherry-pick ${commits.length} commits`;
    const body = "Cherry-picked commits:\n\n" + commits.map((c) => `- ${c.sha}: ${subject(c.message)}`).join("\n");
    return { title, body };
  }

  const api = {
    DEFAULT_CLIENT_ID, SCOPES, CONTENT_SCRIPT, DEFAULT_MAX_FILES,
    normalizeHost, isDotCom, webBase, apiBase,
    parseCommitPage, parsePullCommitsPage, parseTarget, sameRepo,
    isValidBranchName, sanitizeBranchPart, defaultBranchName, appendTrailer, isWorkflowPath,
    compareUrl, defaultPrText
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CpLib = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
