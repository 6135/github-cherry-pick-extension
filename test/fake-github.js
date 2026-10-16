// Fake GitHub REST API for tests. Real bare git repositories hold the data.
// createFakeGitHub(config) returns a fetch-compatible function for apiBase "https://api.test".
// config: { repos: { "owner/name": { dir, push: bool, fork_of?: "owner/name" } } }
// The function has .calls ([{ method, path, body }]) and .writes() (calls that are not GET).
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const API = "https://api.test";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Git without user or system config, so that local settings cannot change results.
const GIT_ENV = Object.assign({}, process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@test",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@test",
  GIT_TERMINAL_PROMPT: "0"
});

// Runs git. Returns { status, stdout (Buffer), stderr (string) }.
function gitRaw(cwd, args, opts) {
  opts = opts || {};
  const r = spawnSync("git", args, {
    cwd,
    input: opts.input,
    env: Object.assign({}, GIT_ENV, opts.env || {}),
    maxBuffer: 256 * 1024 * 1024
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: String(r.stderr || "") };
}

// Runs git and returns trimmed stdout. Throws when git fails.
function git(cwd, args, opts) {
  const r = gitRaw(cwd, args, opts);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
  return r.stdout.toString("utf8").replace(/\n$/, "");
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const notFound = () => new HttpError(404, "Not Found");
const invalid = (msg) => new HttpError(422, msg || "Validation Failed");

const HEX40 = /^[0-9a-f]{40}$/;
const MODES = new Set(["100644", "100755", "120000", "160000", "040000"]);

function createFakeGitHub(config) {
  const repos = new Map();
  for (const [full, r] of Object.entries((config && config.repos) || {})) {
    const [owner, name] = full.split("/");
    repos.set(full.toLowerCase(), { owner, name, full, dir: r.dir, push: !!r.push, private: !!r.private, forkOf: r.fork_of || null });
  }
  const calls = [];

  function repoOf(owner, name) {
    const r = repos.get(`${owner}/${name}`.toLowerCase());
    if (!r) throw notFound();
    return r;
  }

  function summary(r) {
    return { name: r.name, full_name: r.full, owner: { login: r.owner } };
  }

  function repoJson(r) {
    const out = summary(r);
    out.fork = !!r.forkOf;
    out.private = !!r.private;
    const head = gitRaw(r.dir, ["symbolic-ref", "--short", "HEAD"]);
    out.default_branch = head.status === 0 ? head.stdout.toString().trim() : "main";
    out.permissions = { admin: false, maintain: false, push: r.push, triage: r.push, pull: true };
    if (r.forkOf) {
      const parent = repos.get(r.forkOf.toLowerCase());
      let src = parent;
      while (src && src.forkOf && repos.get(src.forkOf.toLowerCase())) src = repos.get(src.forkOf.toLowerCase());
      if (parent) out.parent = summary(parent);
      if (src) out.source = summary(src);
    }
    return out;
  }

  // Object type ("commit", "tree", "blob"), or null when the repository cannot see it.
  function typeOf(r, sha) {
    if (!/^[0-9a-f]{4,40}$/.test(String(sha))) return null;
    const t = gitRaw(r.dir, ["cat-file", "-t", sha]);
    return t.status === 0 ? t.stdout.toString().trim() : null;
  }

  function resolveCommit(r, sha) {
    if (!/^[0-9a-f]{4,40}$/.test(String(sha))) throw notFound();
    const t = gitRaw(r.dir, ["rev-parse", "--verify", "-q", `${sha}^{commit}`]);
    if (t.status !== 0) throw notFound();
    return t.stdout.toString().trim();
  }

  function refSha(r, branch) {
    if (!validRef(`refs/heads/${branch}`)) return null;
    const t = gitRaw(r.dir, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
    return t.status === 0 ? t.stdout.toString().trim() : null;
  }

  function validRef(ref) {
    return gitRaw(process.cwd(), ["check-ref-format", ref]).status === 0;
  }

  function isoDate(d) {
    return new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  function readCommit(r, sha) {
    const raw = git(r.dir, ["show", "-s", "--format=%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B", sha]);
    const p = raw.split("\0");
    return {
      sha,
      tree: p[0],
      parents: p[1] ? p[1].split(" ") : [],
      author: { name: p[2], email: p[3], date: isoDate(p[4]) },
      committer: { name: p[5], email: p[6], date: isoDate(p[7]) },
      // GitHub returns the message without the final newline.
      message: p.slice(8).join("\0").replace(/\n+$/, "")
    };
  }

  function gitCommitJson(c) {
    return {
      sha: c.sha,
      tree: { sha: c.tree },
      parents: c.parents.map((sha) => ({ sha })),
      message: c.message,
      author: c.author,
      committer: c.committer
    };
  }

  // Changed files like GET /repos/{o}/{r}/commits/{sha}.
  function changedFiles(r, c) {
    const args = c.parents.length
      ? ["diff-tree", "-r", "-M", "-z", "--no-commit-id", c.parents[0], c.sha]
      : ["diff-tree", "-r", "-M", "-z", "--no-commit-id", "--root", c.sha];
    const tokens = git(r.dir, args).split("\0");
    const files = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (!t.startsWith(":")) continue;
      const [oldMode, newMode, oldSha, newSha, status] = t.slice(1).split(" ");
      const letter = status[0];
      const file = { sha: newSha, filename: tokens[++i], status: "modified", additions: 0, deletions: 0, changes: 0 };
      if (letter === "R" || letter === "C") {
        file.previous_filename = file.filename;
        file.filename = tokens[++i];
        file.status = letter === "R" ? "renamed" : "copied";
      } else if (letter === "A") {
        file.status = "added";
      } else if (letter === "D") {
        file.status = "removed";
        file.sha = null;
      } else if (letter === "T" || (letter === "M" && oldSha === newSha && oldMode !== newMode)) {
        file.status = "changed";
      }
      files.push(file);
    }
    return files;
  }

  function commitJson(r, sha, page, perPage) {
    const c = readCommit(r, sha);
    const all = changedFiles(r, c);
    const files = all.slice((page - 1) * perPage, page * perPage);
    return {
      sha: c.sha,
      commit: { message: c.message, author: c.author, committer: c.committer, tree: { sha: c.tree } },
      parents: c.parents.map((p) => ({ sha: p })),
      files
    };
  }

  function lsTree(r, sha, recursive) {
    const args = recursive ? ["ls-tree", "-r", "-z", "--full-tree", sha] : ["ls-tree", "-z", sha];
    const out = git(r.dir, args);
    return out.split("\0").filter(Boolean).map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, s] = line.slice(0, tab).split(" ");
      return { path: line.slice(tab + 1), mode, type, sha: s };
    });
  }

  function hashObject(r, buf) {
    return git(r.dir, ["hash-object", "-w", "--stdin"], { input: buf });
  }

  // POST /git/trees: base_tree + entries. sha null deletes the path (and all paths below it).
  function createTree(r, body) {
    const map = new Map();
    if (body.base_tree) {
      if (typeOf(r, body.base_tree) !== "tree") throw invalid("base_tree is not a valid tree");
      for (const e of lsTree(r, body.base_tree, true)) map.set(e.path, e);
    }
    const removeUnder = (p) => {
      for (const k of [...map.keys()]) if (k === p || k.startsWith(p + "/")) map.delete(k);
    };
    if (!Array.isArray(body.tree)) throw invalid("tree is required");
    for (const e of body.tree) {
      const p = String(e.path || "");
      if (!p || p.startsWith("/") || p.endsWith("/") || p.split("/").some((s) => !s || s === "." || s === "..")) {
        throw invalid(`bad path ${p}`);
      }
      if (!MODES.has(e.mode)) throw invalid(`bad mode ${e.mode}`);
      let sha = e.sha;
      if (sha === null && e.content === undefined) {
        removeUnder(p);
        continue;
      }
      if (e.content !== undefined) sha = hashObject(r, Buffer.from(String(e.content), "utf8"));
      if (!HEX40.test(String(sha))) throw invalid(`bad sha ${sha}`);
      const type = e.type || (e.mode === "040000" ? "tree" : e.mode === "160000" ? "commit" : "blob");
      if (type !== "commit" && typeOf(r, sha) !== type) throw invalid(`tree.sha ${sha} is not a valid ${type}`);
      removeUnder(p);
      // A blob on a parent path is replaced by the new directory.
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) map.delete(parts.slice(0, i).join("/"));
      if (type === "tree") {
        for (const sub of lsTree(r, sha, true)) map.set(`${p}/${sub.path}`, Object.assign({}, sub, { path: `${p}/${sub.path}` }));
      } else {
        map.set(p, { path: p, mode: e.mode, type, sha });
      }
    }
    const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fake-gh-idx-")), "index");
    try {
      const env = { GIT_INDEX_FILE: index };
      git(r.dir, ["read-tree", "--empty"], { env });
      const info = [...map.values()].map((e) => `${e.mode} ${e.sha}\t${e.path}\0`).join("");
      if (info) git(r.dir, ["update-index", "-z", "--index-info"], { env, input: info });
      return git(r.dir, ["write-tree"], { env });
    } finally {
      fs.rmSync(path.dirname(index), { recursive: true, force: true });
    }
  }

  function createCommit(r, body) {
    if (!body || typeOf(r, body.tree) !== "tree") throw invalid("tree is not a valid tree");
    const parents = body.parents || [];
    for (const p of parents) if (!HEX40.test(String(p)) || typeOf(r, p) !== "commit") throw invalid(`parent ${p} is not a commit`);
    const env = { GIT_COMMITTER_NAME: "Fake Bot", GIT_COMMITTER_EMAIL: "bot@api.test" };
    if (body.author) {
      env.GIT_AUTHOR_NAME = body.author.name;
      env.GIT_AUTHOR_EMAIL = body.author.email;
      if (body.author.date) env.GIT_AUTHOR_DATE = body.author.date;
    } else {
      env.GIT_AUTHOR_NAME = "Fake Bot";
      env.GIT_AUTHOR_EMAIL = "bot@api.test";
    }
    const args = ["commit-tree", body.tree];
    for (const p of parents) args.push("-p", p);
    return git(r.dir, args, { env, input: String(body.message || "") });
  }

  function needPush(r) {
    if (!r.push) throw new HttpError(403, "Resource not accessible by integration");
  }

  function route(method, url, body) {
    const seg = url.pathname.split("/").slice(1).map((s) => decodeURIComponent(s));
    if (seg[0] !== "repos" || seg.length < 3) throw notFound();
    const r = repoOf(seg[1], seg[2]);
    const rest = seg.slice(3);
    const q = url.searchParams;
    const isWrite = method !== "GET";
    if (isWrite) needPush(r);

    if (!rest.length && method === "GET") return [200, repoJson(r)];

    if (rest[0] === "forks" && rest.length === 1 && method === "GET") {
      const perPage = Number(q.get("per_page")) || 30;
      const page = Number(q.get("page")) || 1;
      const all = [...repos.values()].filter((x) => x.forkOf && x.forkOf.toLowerCase() === r.full.toLowerCase());
      const list = all.slice((page - 1) * perPage, page * perPage).map(repoJson);
      const headers = page * perPage < all.length
        ? { link: `<${API}/repos/${r.full}/forks?per_page=${perPage}&page=${page + 1}>; rel="next"` } : {};
      return [200, list, headers];
    }

    if (rest[0] === "commits" && rest.length === 2 && method === "GET") {
      const sha = resolveCommit(r, rest[1]);
      const perPage = Math.min(Number(q.get("per_page")) || 300, 300);
      const page = Number(q.get("page")) || 1;
      return [200, commitJson(r, sha, page, perPage)];
    }

    if (rest[0] === "merges" && rest.length === 1 && method === "POST") {
      const base = refSha(r, body.base);
      if (!base) throw new HttpError(404, "Base does not exist");
      let head = refSha(r, body.head);
      if (!head) {
        try { head = resolveCommit(r, body.head); } catch (_) { throw new HttpError(404, "Head does not exist"); }
      }
      if (gitRaw(r.dir, ["merge-base", "--is-ancestor", head, base]).status === 0) return [204, null];
      const m = gitRaw(r.dir, ["merge-tree", "--write-tree", base, head]);
      if (m.status === 1) return [409, { message: "Merge conflict" }];
      if (m.status !== 0) throw new Error(`merge-tree failed: ${m.stderr}`);
      const tree = m.stdout.toString().split("\n")[0].trim();
      const sha = createCommit(r, { tree, parents: [base, head], message: body.commit_message || `Merge ${body.head} into ${body.base}` });
      git(r.dir, ["update-ref", `refs/heads/${body.base}`, sha, base]);
      return [201, commitJson(r, sha, 1, 300)];
    }

    if (rest[0] !== "git") throw notFound();
    const kind = rest[1];
    const arg = rest.slice(2);

    if (kind === "ref" && arg[0] === "heads" && arg.length > 1 && method === "GET") {
      const branch = arg.slice(1).join("/");
      const sha = refSha(r, branch);
      if (!sha) throw notFound();
      return [200, { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } }];
    }

    if (kind === "refs" && !arg.length && method === "POST") {
      const ref = String(body.ref || "");
      if (!ref.startsWith("refs/") || !validRef(ref)) throw invalid("Reference name is not valid");
      if (!HEX40.test(String(body.sha)) || typeOf(r, body.sha) !== "commit") throw invalid("Object does not exist");
      if (gitRaw(r.dir, ["rev-parse", "--verify", "-q", ref]).status === 0) throw invalid("Reference already exists");
      const u = gitRaw(r.dir, ["update-ref", ref, body.sha, ""]);
      if (u.status !== 0) throw invalid("Reference cannot be created");
      return [201, { ref, object: { sha: body.sha, type: "commit" } }];
    }

    if (kind === "refs" && arg[0] === "heads" && arg.length > 1 && (method === "PATCH" || method === "DELETE")) {
      const branch = arg.slice(1).join("/");
      const old = refSha(r, branch);
      if (!old) throw invalid("Reference does not exist");
      if (method === "DELETE") {
        git(r.dir, ["update-ref", "-d", `refs/heads/${branch}`, old]);
        return [204, null];
      }
      if (!HEX40.test(String(body.sha)) || typeOf(r, body.sha) !== "commit") throw invalid("Object does not exist");
      if (!body.force && gitRaw(r.dir, ["merge-base", "--is-ancestor", old, body.sha]).status !== 0) {
        throw invalid("Update is not a fast forward");
      }
      git(r.dir, ["update-ref", `refs/heads/${branch}`, body.sha, old]);
      return [200, { ref: `refs/heads/${branch}`, object: { sha: body.sha, type: "commit" } }];
    }

    if (kind === "commits" && arg.length === 1 && method === "GET") {
      if (!HEX40.test(arg[0]) || typeOf(r, arg[0]) !== "commit") throw notFound();
      return [200, gitCommitJson(readCommit(r, arg[0]))];
    }

    if (kind === "commits" && !arg.length && method === "POST") {
      const sha = createCommit(r, body);
      return [201, gitCommitJson(readCommit(r, sha))];
    }

    if (kind === "trees" && arg.length === 1 && method === "GET") {
      if (typeOf(r, arg[0]) !== "tree") throw notFound();
      const sha = git(r.dir, ["rev-parse", arg[0]]);
      return [200, { sha, tree: lsTree(r, sha, false), truncated: false }];
    }

    if (kind === "trees" && !arg.length && method === "POST") {
      const sha = createTree(r, body || {});
      return [201, { sha, tree: lsTree(r, sha, false), truncated: false }];
    }

    if (kind === "blobs" && arg.length === 1 && method === "GET") {
      if (!HEX40.test(arg[0]) || typeOf(r, arg[0]) !== "blob") throw notFound();
      const buf = gitRaw(r.dir, ["cat-file", "blob", arg[0]]).stdout;
      // GitHub wraps base64 content at 60 characters.
      const content = (buf.toString("base64").match(/.{1,60}/g) || []).join("\n") + "\n";
      return [200, { sha: arg[0], size: buf.length, content, encoding: "base64" }];
    }

    if (kind === "blobs" && !arg.length && method === "POST") {
      const enc = body.encoding || "utf-8";
      if (enc !== "utf-8" && enc !== "base64") throw invalid("encoding is not valid");
      const buf = Buffer.from(String(body.content || ""), enc === "base64" ? "base64" : "utf8");
      return [201, { sha: hashObject(r, buf) }];
    }

    throw notFound();
  }

  async function fetchImpl(input, init) {
    init = init || {};
    const method = String(init.method || "GET").toUpperCase();
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    let status, data, headers;
    if (url.origin !== API) {
      [status, data] = [404, { message: "Not Found" }];
    } else {
      try {
        [status, data, headers] = route(method, url, body);
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        [status, data] = [err.status, { message: err.message }];
      }
    }
    const h = Object.assign({ "content-type": "application/json" }, headers || {});
    return new Response(status === 204 || data === null ? null : JSON.stringify(data), { status, headers: h });
  }

  fetchImpl.calls = calls;
  fetchImpl.writes = () => calls.filter((c) => c.method !== "GET");
  return fetchImpl;
}

module.exports = { createFakeGitHub, git, gitRaw, GIT_ENV, API, EMPTY_TREE };
