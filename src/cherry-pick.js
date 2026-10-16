// Cherry-pick engine. GitHub has no cherry-pick API, so we emulate it with the REST Git Data API.
// The result is always a new branch. The caller then opens GitHub's PR form (compareUrl).
//
// CpCore.runPick(client, request, onProgress) → Promise<result>
//   request: { host, source: {owner, repo}, shas: [...] (apply order), target: {owner, repo, branch},
//              branch?, trailer?, title?, body?, maxFiles?, login }
//   onProgress({ step: "check" | "apply" | "finish", done, total, text })
//   result: { status: "opened" | "nothing_to_pick", headRepo: {owner, repo}, branch,
//             applied: [{sha, newSha}], skipped: [{sha, reason: "empty"}], compareUrl }
// Errors have .code (and sometimes .details). GitHubErrors that we do not expect pass through.
(function (root) {
  "use strict";

  const L = (typeof module === "object" && module.exports) ? require("./lib.js") : root.CpLib;

  const MAX_FILE_PAGES = 30;
  const MAX_FORK_PAGES = 3;
  const MAX_SUFFIX = 9;
  const PAGE_SIZE = 100;

  function codeError(code, message, details) {
    const err = new Error(message);
    err.code = code;
    if (details) err.details = details;
    return err;
  }

  const enc = (s) => encodeURIComponent(String(s));
  // Encodes each path segment. Slashes stay.
  const encRef = (s) => String(s).split("/").map(enc).join("/");
  const repoPath = (r) => `/repos/${enc(r.owner)}/${enc(r.repo)}`;
  const short = (sha) => String(sha).slice(0, 7);
  const subject = (msg) => String(msg || "").split("\n")[0].trim();

  // GET that returns null for 404.
  async function getOrNull(client, path) {
    try {
      return await client.get(path);
    } catch (err) {
      if (err && err.status === 404) return null;
      throw err;
    }
  }

  async function runPick(client, request, onProgress) {
    const req = request || {};
    const progress = (step, done, total, text) => {
      if (typeof onProgress !== "function") return;
      try { onProgress({ step, done, total, text }); } catch (_) { /* The UI must not stop the job. */ }
    };

    const host = req.host;
    const source = { owner: req.source.owner, repo: req.source.repo };
    const target = { owner: req.target.owner, repo: req.target.repo, branch: req.target.branch };
    const shas = (req.shas || []).map((s) => String(s).trim()).filter(Boolean);
    if (!shas.length) throw codeError("no_commits", "Select at least one commit.");
    const maxFiles = Number(req.maxFiles) > 0 ? Number(req.maxFiles) : L.DEFAULT_MAX_FILES;
    const total = shas.length;

    // 1. Branch name.
    const wanted = req.branch ? String(req.branch).trim() : L.defaultBranchName(shas, target.branch);
    if (!L.isValidBranchName(wanted)) {
      throw codeError("bad_branch_name", `"${wanted}" is not a valid branch name.`, { branch: wanted });
    }

    // 2. Repository that gets the new branch.
    progress("check", 0, total, `Checking ${target.owner}/${target.repo}`);
    const targetInfo = await client.get(repoPath(target));
    const headRepo = await findHeadRepo(client, host, target, targetInfo, req.login);

    // 2b. Private code must not go to a public repo by mistake.
    // The new branch and its commits are visible even if nobody opens the PR.
    if (!L.sameRepo(source, target) || !L.sameRepo(source, headRepo)) {
      const sourceInfo = L.sameRepo(source, target) ? targetInfo : await client.get(repoPath(source));
      const headInfo = L.sameRepo(headRepo, target) ? targetInfo : await client.get(repoPath(headRepo));
      const publicRepos = [[target, targetInfo], [headRepo, headInfo]]
        .filter(([, info]) => info && info.private === false)
        .map(([r]) => `${r.owner}/${r.repo}`)
        .filter((name, i, all) => all.indexOf(name) === i);
      if (sourceInfo && sourceInfo.private && publicRepos.length && req.allowPublic !== true) {
        throw codeError("private_to_public",
          `${source.owner}/${source.repo} is private, but ${publicRepos.join(" and ")} is public.`,
          { source: `${source.owner}/${source.repo}`, publicRepos });
      }
    }

    // 3. Head of the target branch.
    const baseRef = await getOrNull(client, `${repoPath(target)}/git/ref/heads/${encRef(target.branch)}`);
    if (!baseRef || Array.isArray(baseRef) || !baseRef.object) {
      throw codeError("target_branch_missing", `Branch "${target.branch}" does not exist in ${target.owner}/${target.repo}.`,
        { branch: target.branch });
    }
    const baseSha = baseRef.object.sha;

    // 4. Free branch name in headRepo.
    const branch = await freeBranchName(client, headRepo, wanted);

    // 5. Read and check all commits before we write anything.
    const commits = [];
    for (let i = 0; i < shas.length; i++) {
      progress("check", i, total, `Reading commit ${short(shas[i])}`);
      const c = await readCommit(client, source, shas[i]);
      if (c.parents.length > 1) {
        throw codeError("merge_commit", `Commit ${short(c.sha)} is a merge commit. Merge commits are not supported.`, { sha: c.sha });
      }
      for (const f of c.files) {
        const bad = [f.filename, f.previous_filename].find((p) => p && L.isWorkflowPath(p));
        if (bad) {
          throw codeError("workflow_file", `Commit ${short(c.sha)} changes the workflow file ${bad}.`, { sha: c.sha, path: bad });
        }
      }
      if (c.files.length > maxFiles) {
        throw codeError("too_many_files", `Commit ${short(c.sha)} changes ${c.files.length} files. The limit is ${maxFiles}.`,
          { sha: c.sha, count: c.files.length, max: maxFiles });
      }
      commits.push(c);
    }
    progress("check", total, total, "Commits are ready");

    // Write phase.
    const sameRepo = L.sameRepo(source, headRepo);
    const head = repoPath(headRepo);
    const refUrl = `${head}/git/refs/heads/${encRef(branch)}`;
    const ctx = { client, source, headRepo, trees: new Map(), blobs: new Set() };
    const baseCommit = await client.get(`${repoPath(target)}/git/commits/${enc(baseSha)}`);
    let current = baseSha;
    let currentTree = baseCommit.tree.sha;
    let created = false;
    const applied = [];
    const appliedCommits = [];
    const skipped = [];

    const pointBranch = async (sha) => {
      if (!created) {
        await client.post(`${head}/git/refs`, { ref: `refs/heads/${branch}`, sha });
        created = true;
      } else {
        await client.patch(refUrl, { sha, force: true });
      }
    };
    const deleteBranch = async () => {
      if (!created) return;
      created = false;
      try { await client.del(refUrl); } catch (_) { /* Best effort. */ }
    };

    try {
      for (let i = 0; i < commits.length; i++) {
        const c = commits[i];
        progress("apply", i, total, `Applying ${short(c.sha)} ${subject(c.message)}`);
        if (!c.files.length) {
          skipped.push({ sha: c.sha, reason: "empty" });
          continue;
        }

        // a. Find a base commit and a head commit in headRepo. diff(base→head) is the change.
        let pair;
        if (sameRepo && c.parents.length) pair = { base: c.parents[0], head: c.sha };
        else pair = await transplant(ctx, c, current, currentTree);

        // b. Temporary commit: the current tree on top of base.
        const tmp = await client.post(`${head}/git/commits`, {
          message: "cherry-pick: temporary", tree: currentTree, parents: [pair.base]
        });

        // c. Point the new branch at the temporary commit.
        await pointBranch(tmp.sha);

        // d. merge-base(tmp, head) = base. So the merged tree = currentTree + diff(base→head).
        let res;
        try {
          res = await client.request("POST", `${head}/merges`, {
            base: branch, head: pair.head, commit_message: "cherry-pick: temporary merge"
          });
        } catch (err) {
          if (err && err.status === 409) {
            throw codeError("conflict", `Commit ${short(c.sha)} does not apply cleanly on ${target.branch}.`, { sha: c.sha });
          }
          throw err;
        }
        const merged = res.status === 201 && res.data && res.data.commit ? res.data.commit.tree.sha : currentTree;

        // e. Same tree means the change is already there.
        if (merged === currentTree) {
          skipped.push({ sha: c.sha, reason: "empty" });
          continue;
        }
        const body = {
          message: req.trailer ? L.appendTrailer(c.message, c.sha) : c.message,
          tree: merged,
          parents: [current]
        };
        const author = authorOf(c.author);
        if (author) body.author = author;
        const made = await client.post(`${head}/git/commits`, body);
        current = made.sha;
        currentTree = merged;
        applied.push({ sha: c.sha, newSha: made.sha });
        appliedCommits.push({ sha: c.sha, message: c.message });
      }

      progress("finish", total, total, applied.length ? `Updating ${branch}` : "Nothing to pick");
      if (!applied.length) {
        await deleteBranch();
        return { status: "nothing_to_pick", headRepo, branch, applied, skipped, compareUrl: null };
      }
      await client.patch(refUrl, { sha: current, force: true });
    } catch (err) {
      await deleteBranch();
      throw err;
    }

    const text = L.defaultPrText(appliedCommits, target.branch);
    const compareUrl = L.compareUrl(host, target, { owner: headRepo.owner, repo: headRepo.repo, branch },
      { title: req.title || text.title, body: req.body || text.body });
    return { status: "opened", headRepo, branch, applied, skipped, compareUrl };
  }

  // Target when the user can push to it. Else the user's fork of the target.
  async function findHeadRepo(client, host, target, info, login) {
    if (info && info.permissions && info.permissions.push) return { owner: target.owner, repo: target.repo };
    const full = String((info && info.full_name) || `${target.owner}/${target.repo}`).toLowerCase();
    const isFork = (d) => !!d && !!d.fork &&
      [d.parent, d.source].some((p) => p && String(p.full_name || "").toLowerCase() === full);
    const asRepo = (d) => ({ owner: d.owner.login, repo: d.name });
    if (login) {
      const own = await getOrNull(client, `/repos/${enc(login)}/${enc(target.repo)}`);
      if (isFork(own)) return asRepo(own);
      const me = String(login).toLowerCase();
      for (let page = 1; page <= MAX_FORK_PAGES; page++) {
        const list = await client.get(`${repoPath(target)}/forks?per_page=${PAGE_SIZE}&page=${page}`);
        if (!Array.isArray(list)) break;
        const hit = list.find((f) => f && f.owner && String(f.owner.login).toLowerCase() === me);
        if (hit) return asRepo(hit);
        if (list.length < PAGE_SIZE) break;
      }
    }
    throw codeError("no_writable_repo", `You cannot push to ${target.owner}/${target.repo} and you have no fork of it.`,
      { forkUrl: `${L.webBase(host)}/${target.owner}/${target.repo}/fork` });
  }

  // Returns name, or name-2 … name-9 when the name is taken.
  async function freeBranchName(client, repo, name) {
    let candidate = name;
    for (let n = 1; n <= MAX_SUFFIX; n++) {
      if (n > 1) candidate = `${name}-${n}`;
      const ref = await getOrNull(client, `${repoPath(repo)}/git/ref/heads/${encRef(candidate)}`);
      if (!ref) return candidate;
    }
    throw codeError("branch_exists", `Branch "${name}" and its "-2" to "-${MAX_SUFFIX}" variants already exist.`, { branch: name });
  }

  // Reads a commit with all its changed files.
  async function readCommit(client, repo, sha) {
    let first = null;
    const files = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      let data;
      try {
        data = await client.get(`${repoPath(repo)}/commits/${enc(sha)}?per_page=${PAGE_SIZE}&page=${page}`);
      } catch (err) {
        // GitHub sends 422 for an unknown SHA in a known repository.
        if (err && (err.status === 404 || err.status === 422)) {
          throw codeError("not_found", `Commit ${short(sha)} was not found in ${repo.owner}/${repo.repo}.`, { sha });
        }
        throw err;
      }
      if (!first) first = data;
      const list = (data && data.files) || [];
      files.push(...list);
      if (list.length < PAGE_SIZE) break;
    }
    return {
      sha: first.sha,
      message: first.commit.message,
      author: first.commit.author,
      tree: first.commit.tree.sha,
      parents: (first.parents || []).map((p) => p.sha),
      files
    };
  }

  function authorOf(a) {
    if (!a || !a.name || !a.email) return null;
    const out = { name: a.name, email: a.email };
    if (a.date) out.date = a.date;
    return out;
  }

  // Copies the change of commit c into headRepo. Returns { base: P', head: C' }.
  // P' = current tree with the touched paths as in the parent. C' = P' with the touched paths as in c.
  async function transplant(ctx, c, current, currentTree) {
    const { client, source, headRepo } = ctx;
    const head = repoPath(headRepo);
    const paths = [];
    for (const f of c.files) {
      for (const p of [f.previous_filename, f.filename]) if (p && !paths.includes(p)) paths.push(p);
    }
    let parentTree = null;
    if (c.parents.length) {
      parentTree = (await client.get(`${repoPath(source)}/git/commits/${enc(c.parents[0])}`)).tree.sha;
    }

    const pEntries = [];
    const cEntries = [];
    for (const path of paths) {
      const before = parentTree ? await findEntry(ctx, source, parentTree, path) : null;
      const after = await findEntry(ctx, source, c.tree, path);
      const now = await findEntry(ctx, headRepo, currentTree, path);
      if (before) await copyBlob(ctx, before);
      if (after) await copyBlob(ctx, after);
      if (before) {
        if (!sameEntry(before, now)) pEntries.push(treeEntry(path, before));
      } else if (now) {
        pEntries.push(deleteEntry(path, now));
      }
      if (after) {
        if (!sameEntry(after, before)) cEntries.push(treeEntry(path, after));
      } else if (before) {
        cEntries.push(deleteEntry(path, before));
      }
    }

    const pTree = pEntries.length
      ? (await client.post(`${head}/git/trees`, { base_tree: currentTree, tree: pEntries })).sha
      : currentTree;
    const cTree = cEntries.length
      ? (await client.post(`${head}/git/trees`, { base_tree: pTree, tree: cEntries })).sha
      : pTree;
    const p = await client.post(`${head}/git/commits`, { message: "cherry-pick: temporary base", tree: pTree, parents: [current] });
    const h = await client.post(`${head}/git/commits`, { message: "cherry-pick: temporary change", tree: cTree, parents: [p.sha] });
    return { base: p.sha, head: h.sha };
  }

  // Tree entry at path, or null. Walks one directory at a time. Caches each tree.
  async function findEntry(ctx, repo, rootSha, path) {
    const parts = String(path).split("/");
    let sha = rootSha;
    for (let i = 0; i < parts.length; i++) {
      const entries = await readTree(ctx, repo, sha);
      const e = entries.find((x) => x.path === parts[i]);
      if (!e) return null;
      if (i === parts.length - 1) return e;
      if (e.type !== "tree") return null;
      sha = e.sha;
    }
    return null;
  }

  function readTree(ctx, repo, sha) {
    const key = `${repo.owner}/${repo.repo}`.toLowerCase() + "@" + sha;
    if (!ctx.trees.has(key)) {
      const p = ctx.client.get(`${repoPath(repo)}/git/trees/${enc(sha)}`).then((d) => (d && d.tree) || []);
      p.catch(() => ctx.trees.delete(key));
      ctx.trees.set(key, p);
    }
    return ctx.trees.get(key);
  }

  // Copies a blob from source to headRepo. Gitlinks and trees are not copied.
  async function copyBlob(ctx, entry) {
    if (entry.type !== "blob" || ctx.blobs.has(entry.sha)) return;
    const { client, source, headRepo } = ctx;
    const blob = await client.get(`${repoPath(source)}/git/blobs/${enc(entry.sha)}`);
    const body = blob.encoding === "base64"
      ? { content: String(blob.content || "").replace(/\s+/g, ""), encoding: "base64" }
      : { content: String(blob.content || ""), encoding: "utf-8" };
    const made = await client.post(`${repoPath(headRepo)}/git/blobs`, body);
    if (made.sha !== entry.sha) {
      throw codeError("blob_mismatch", `Copy of blob ${short(entry.sha)} has a different SHA (${short(made.sha)}).`,
        { sha: entry.sha, got: made.sha });
    }
    ctx.blobs.add(entry.sha);
  }

  function sameEntry(a, b) {
    return !!a && !!b && a.mode === b.mode && a.sha === b.sha && a.type === b.type;
  }

  function treeEntry(path, e) {
    return { path, mode: e.mode, type: e.type, sha: e.sha };
  }

  function deleteEntry(path, e) {
    return { path, mode: e.mode, type: e.type, sha: null };
  }

  const api = { runPick };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CpCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
