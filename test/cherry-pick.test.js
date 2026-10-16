"use strict";
// Tests for the cherry-pick engine. A fake GitHub API runs on real git repositories.
// Oracle: each success case is compared with a real `git cherry-pick` in a temp clone.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createClient } = require("../src/api.js");
const { runPick } = require("../src/cherry-pick.js");
const { createFakeGitHub, git, gitRaw, API } = require("./fake-github.js");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cp-test-"));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let counter = 0;
function tmpDir(name) {
  const dir = path.join(ROOT, `${name}-${++counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const ALICE = { name: "Alice Example", email: "alice@example.com", date: "2021-03-04T05:06:07Z" };

// A work repository with simple helpers.
function work(name) {
  const dir = tmpDir(name);
  git(dir, ["init", "-q", "-b", "main"]);
  const file = (p) => path.join(dir, p);
  return {
    dir,
    git: (...args) => git(dir, args),
    write(p, content, exec) {
      fs.mkdirSync(path.dirname(file(p)), { recursive: true });
      fs.writeFileSync(file(p), content);
      if (exec) fs.chmodSync(file(p), 0o755);
    },
    chmod(p, mode) { fs.chmodSync(file(p), mode); },
    symlink(p, to) {
      fs.rmSync(file(p), { force: true });
      fs.mkdirSync(path.dirname(file(p)), { recursive: true });
      fs.symlinkSync(to, file(p));
    },
    rm(p) { fs.rmSync(file(p), { force: true }); },
    mv(a, b) {
      fs.mkdirSync(path.dirname(file(b)), { recursive: true });
      fs.renameSync(file(a), file(b));
    },
    // Commits all changes. Index-only changes (gitlinks) need noAdd.
    commit(msg, opts) {
      opts = opts || {};
      if (!opts.noAdd) git(dir, ["add", "-A"]);
      const args = ["commit", "-q", "--allow-empty", "-m", msg];
      if (opts.body) args.push("-m", opts.body);
      const a = opts.author;
      const env = a ? { GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_AUTHOR_DATE: a.date } : {};
      git(dir, args, { env });
      return git(dir, ["rev-parse", "HEAD"]);
    }
  };
}

function bare(workDir, name) {
  const dir = path.join(tmpDir(name), "repo.git");
  git(ROOT, ["clone", "-q", "--bare", "--no-local", workDir, dir]);
  return dir;
}

// A fork shares the object store of its parent (objects/info/alternates), like a GitHub fork network.
function forkOf(parentDir, name) {
  const dir = path.join(tmpDir(name), "repo.git");
  git(ROOT, ["clone", "-q", "--bare", "--shared", parentDir, dir]);
  assert.ok(fs.existsSync(path.join(dir, "objects", "info", "alternates")));
  return dir;
}

const lines = (n, edits) => Array.from({ length: n }, (_, i) => (edits && edits[i + 1]) || `line ${i + 1}`).join("\n") + "\n";

function refs(dir) {
  return git(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]);
}

function has(dir, sha) {
  return gitRaw(dir, ["cat-file", "-e", sha]).status === 0;
}

// Same-repository fixture: "octo/proj" with branches main, feature, side, wf, many.
function sameRepoFixture() {
  const w = work("same");
  w.write("a.txt", lines(10));
  w.write("b.txt", "b\n");
  const c0 = w.commit("Initial");

  w.git("checkout", "-q", "-b", "feature");
  w.write("a.txt", lines(10, { 2: "two" }));
  const f1 = w.commit("Change line two", { body: "Longer text.\nSecond line.", author: ALICE });
  w.write("a.txt", lines(10, { 2: "TWO" }));
  const f2 = w.commit("Shout line two");
  w.write("c/d/c.txt", "c\n");
  const f3 = w.commit("Add c");
  w.write("dup.txt", "same\n");
  const dup = w.commit("Add dup");
  const fEmpty = w.commit("Empty commit");
  w.write("b.txt", "feature b\n");
  const fConf = w.commit("Edit b on feature");

  w.git("checkout", "-q", "-b", "side", c0);
  w.write("e.txt", "e\n");
  w.commit("Side work");
  w.git("checkout", "-q", "feature");
  w.git("merge", "-q", "--no-ff", "-m", "Merge side", "side");
  const fMerge = w.git("rev-parse", "HEAD");

  w.git("checkout", "-q", "-b", "wf", c0);
  w.write(".github/workflows/ci.yml", "on: push\n");
  const fWf = w.commit("Add CI");

  w.git("checkout", "-q", "-b", "many", c0);
  for (let i = 0; i < 150; i++) w.write(`many/f${String(i).padStart(3, "0")}.txt`, `file ${i}\n`);
  const fMany = w.commit("Add 150 files");

  w.git("checkout", "-q", "main");
  w.write("b.txt", "main b\n");
  w.commit("Edit b on main");
  w.write("dup.txt", "same\n");
  w.write("main-only.txt", "m\n");
  const mainTip = w.commit("Add dup on main");

  const dir = bare(w.dir, "same-bare");
  git(dir, ["branch", "release/1.0", c0]);
  return { dir, c0, f1, f2, f3, dup, fEmpty, fConf, fMerge, fWf, fMany, mainTip };
}

function fakeFor(repos) {
  const fake = createFakeGitHub({ repos });
  const client = createClient({ apiBase: API, token: "t", fetchImpl: fake, sleep: async () => {} });
  return { fake, client };
}

async function pick(client, req, events) {
  return runPick(client, Object.assign({ host: "github.com", login: "alice" }, req), (e) => events && events.push(e));
}

// Real git cherry-pick of shas onto targetDir:branch. sourceDir is fetched first when given.
function oracle(targetDir, branch, shas, opts) {
  opts = opts || {};
  const dir = path.join(tmpDir("oracle"), "w");
  git(ROOT, ["clone", "-q", targetDir, dir]);
  git(dir, ["checkout", "-q", "-B", "oracle", `origin/${branch}`]);
  if (opts.sourceDir) git(dir, ["fetch", "-q", opts.sourceDir, "+refs/heads/*:refs/remotes/src/*"]);
  const commits = [];
  for (const sha of shas) {
    const before = git(dir, ["rev-parse", "HEAD^{tree}"]);
    const args = ["cherry-pick", "--allow-empty", "--keep-redundant-commits"];
    if (opts.x) args.push("-x");
    const r = gitRaw(dir, args.concat(sha));
    if (r.status !== 0) return { conflict: sha, commits };
    const tree = git(dir, ["rev-parse", "HEAD^{tree}"]);
    commits.push({ sha, tree, empty: tree === before, message: git(dir, ["log", "-1", "--format=%B"]) });
  }
  return { tree: git(dir, ["rev-parse", "HEAD^{tree}"]), commits };
}

// Checks the new branch against the oracle: final tree, one commit per applied pick, same skips.
function checkAgainstOracle(headDir, baseSha, result, orc) {
  assert.equal(orc.conflict, undefined, "oracle must not conflict");
  const tip = git(headDir, ["rev-parse", `refs/heads/${result.branch}`]);
  assert.equal(git(headDir, ["rev-parse", `${tip}^{tree}`]), orc.tree, "final tree equals git cherry-pick");
  const chain = git(headDir, ["rev-list", "--reverse", "--parents", `${baseSha}..${tip}`]).split("\n").filter(Boolean);
  assert.equal(chain.length, result.applied.length, "one commit per applied pick");
  chain.forEach((line) => assert.equal(line.split(" ").length, 2, "linear history, no temporary merges"));
  assert.deepEqual(chain.map((l) => l.split(" ")[0]), result.applied.map((a) => a.newSha));
  const real = orc.commits.filter((c) => !c.empty);
  assert.deepEqual(result.applied.map((a) => a.sha), real.map((c) => c.sha));
  assert.deepEqual(result.skipped, orc.commits.filter((c) => c.empty).map((c) => ({ sha: c.sha, reason: "empty" })));
  result.applied.forEach((a, i) => assert.equal(git(headDir, ["rev-parse", `${a.newSha}^{tree}`]), real[i].tree));
}

function messageOf(dir, sha) {
  return git(dir, ["log", "-1", "--format=%B", sha]).replace(/\s+$/, "");
}

function authorOf(dir, sha) {
  const [name, email, date] = git(dir, ["log", "-1", "--format=%an%x00%ae%x00%aI", sha]).split("\0");
  return { name, email, date: new Date(date).toISOString().replace(/\.\d{3}Z$/, "Z") };
}

const proj = { owner: "octo", repo: "proj" };

// ---------------------------------------------------------------- same repository

test("single clean pick", async () => {
  const fx = sameRepoFixture();
  const { client, fake } = fakeFor({ "octo/proj": { dir: fx.dir, push: true } });
  const before = refs(fx.dir);
  const events = [];
  const result = await pick(client, { source: proj, shas: [fx.f1], target: { ...proj, branch: "main" } }, events);

  assert.equal(result.status, "opened");
  assert.deepEqual(result.headRepo, proj);
  assert.equal(result.branch, `cherry-pick/${fx.f1.slice(0, 7)}-to-main`);
  checkAgainstOracle(fx.dir, fx.mainTip, result, oracle(fx.dir, "main", [fx.f1]));
  const newSha = result.applied[0].newSha;
  assert.equal(messageOf(fx.dir, newSha), "Change line two\n\nLonger text.\nSecond line.");
  assert.deepEqual(authorOf(fx.dir, newSha), ALICE);
  assert.equal(result.compareUrl,
    `https://github.com/octo/proj/compare/main...cherry-pick/${fx.f1.slice(0, 7)}-to-main?quick_pull=1&` +
    new URLSearchParams({ title: "[main] Change line two", body: `Cherry-picked commits:\n\n- ${fx.f1}: Change line two` }));
  // Only the new branch was added. No temporary refs remain.
  const added = refs(fx.dir).split("\n").filter((l) => !before.split("\n").includes(l));
  assert.deepEqual(added, [`refs/heads/${result.branch} ${newSha}`]);
  // Same repository: no blob copies.
  assert.equal(fake.writes().filter((c) => c.path.endsWith("/git/blobs")).length, 0);
  assert.deepEqual([...new Set(events.map((e) => e.step))], ["check", "apply", "finish"]);
});

test("multi pick applies in order", async () => {
  const fx = sameRepoFixture();
  const { client } = fakeFor({ "octo/proj": { dir: fx.dir, push: true } });
  const shas = [fx.f1, fx.f2, fx.f3];
  const result = await pick(client, { source: proj, shas, target: { ...proj, branch: "main" } });
  assert.equal(result.branch, `cherry-pick/${fx.f1.slice(0, 7)}+2-to-main`);
  assert.equal(result.applied.length, 3);
  checkAgainstOracle(fx.dir, fx.mainTip, result, oracle(fx.dir, "main", shas));
  assert.match(result.compareUrl, /title=%5Bmain%5D\+Cherry-pick\+3\+commits/);
});

test("trailer on: message equals git cherry-pick -x", async () => {
  const fx = sameRepoFixture();
  const { client } = fakeFor({ "octo/proj": { dir: fx.dir, push: true } });
  const shas = [fx.f1, fx.f2];
  const result = await pick(client, { source: proj, shas, target: { ...proj, branch: "main" }, trailer: true });
  const orc = oracle(fx.dir, "main", shas, { x: true });
  checkAgainstOracle(fx.dir, fx.mainTip, result, orc);
  result.applied.forEach((a, i) => {
    assert.equal(messageOf(fx.dir, a.newSha), orc.commits[i].message.replace(/\s+$/, ""));
    assert.match(messageOf(fx.dir, a.newSha), new RegExp(`\\(cherry picked from commit ${a.sha}\\)$`));
  });
});

test("trailer off: message is the original message", async () => {
  const fx = sameRepoFixture();
  const { client } = fakeFor({ "octo/proj": { dir: fx.dir, push: true } });
  const result = await pick(client, { source: proj, shas: [fx.f3], target: { ...proj, branch: "main" }, trailer: false });
  assert.equal(messageOf(fx.dir, result.applied[0].newSha), "Add c");
});

test("empty picks are skipped", async () => {
  const fx = sameRepoFixture();
  const { client } = fakeFor({ "octo/proj": { dir: fx.dir, push: true } });
  const shas = [fx.f1, fx.dup, fx.fEmpty, fx.f3];
  const result = await pick(client, { source: proj, shas, target: { ...proj, branch: "main" } });
  assert.equal(result.status, "opened");
  assert.deepEqual(result.skipped, [{ sha: fx.dup, reason: "empty" }, { sha: fx.fEmpty, reason: "empty" }]);
  checkAgainstOracle(fx.dir, fx.mainTip, result, oracle(fx.dir, "main", shas));
  // PR text lists only the applied commits.
  assert.equal(new URL(result.compareUrl).searchParams.get("title"), "[main] Cherry-pick 2 commits");
});

test("all empty → nothing_to_pick and no branch left", async () => {
  const fx = sameRepoFixture();
  const { client } = fakeFor({ "octo/proj": { dir: fx.dir, push: true } });
  const before = refs(fx.dir);
  const result = await pick(client, { source: proj, shas: [fx.dup, fx.fEmpty], target: { ...proj, branch: "main" } });
  assert.equal(result.status, "nothing_to_pick");
  assert.equal(result.compareUrl, null);
  assert.deepEqual(result.applied, []);
  assert.equal(result.skipped.length, 2);
  assert.equal(refs(fx.dir), before);
});

test("conflict → error and branch deleted", async () => {
  const fx = sameRepoFixture();
  const { client } = fakeFor({ "octo/proj": { dir: fx.dir, push: true } });
  const before = refs(fx.dir);
  assert.ok(oracle(fx.dir, "main", [fx.fConf]).conflict, "git also conflicts");
  await assert.rejects(pick(client, { source: proj, shas: [fx.fConf], target: { ...proj, branch: "main" } }),
    (e) => e.code === "conflict" && e.details.sha === fx.fConf);
  assert.equal(refs(fx.dir), before);
});

test("conflict on a later commit deletes the branch", async () => {
  const fx = sameRepoFixture();
  const { client } = fakeFor({ "octo/proj": { dir: fx.dir, push: true } });
  const before = refs(fx.dir);
  await assert.rejects(pick(client, { source: proj, shas: [fx.f1, fx.f3, fx.fConf], target: { ...proj, branch: "main" } }),
    (e) => e.code === "conflict" && e.details.sha === fx.fConf);
  assert.equal(refs(fx.dir), before);
});

test("merge commit is rejected before any write", async () => {
  const fx = sameRepoFixture();
  const { client, fake } = fakeFor({ "octo/proj": { dir: fx.dir, push: true } });
  await assert.rejects(pick(client, { source: proj, shas: [fx.f1, fx.fMerge], target: { ...proj, branch: "main" } }),
    (e) => e.code === "merge_commit" && e.details.sha === fx.fMerge);
  assert.deepEqual(fake.writes(), []);
});

test("workflow file is rejected before any write", async () => {
  const fx = sameRepoFixture();
  const { client, fake } = fakeFor({ "octo/proj": { dir: fx.dir, push: true } });
  await assert.rejects(pick(client, { source: proj, shas: [fx.f1, fx.fWf], target: { ...proj, branch: "main" } }),
    (e) => e.code === "workflow_file" && e.details.sha === fx.fWf && e.details.path === ".github/workflows/ci.yml");
  assert.deepEqual(fake.writes(), []);
});

test("workflow file as rename source is rejected", async () => {
  const w = work("wfren");
  w.write(".github/workflows/old.yml", "on: push\n");
  w.commit("Initial");
  w.mv(".github/workflows/old.yml", "ci/old.yml");
  const sha = w.commit("Move workflow out");
  const dir = bare(w.dir, "wfren-bare");
  const { client, fake } = fakeFor({ "octo/proj": { dir, push: true } });
  await assert.rejects(pick(client, { source: proj, shas: [sha], target: { ...proj, branch: "main" } }),
    (e) => e.code === "workflow_file" && e.details.path === ".github/workflows/old.yml");
  assert.deepEqual(fake.writes(), []);
});

test("too_many_files is rejected before any write", async () => {
  const fx = sameRepoFixture();
  const { client, fake } = fakeFor({ "octo/proj": { dir: fx.dir, push: true } });
  await assert.rejects(pick(client, { source: proj, shas: [fx.fMany], target: { ...proj, branch: "main" } }),
    (e) => e.code === "too_many_files" && e.details.sha === fx.fMany && e.details.count === 150);
  assert.deepEqual(fake.writes(), []);
  await assert.rejects(pick(client, { source: proj, shas: [fx.fMany], target: { ...proj, branch: "main" }, maxFiles: 149 }),
    (e) => e.code === "too_many_files" && e.details.count === 150);
});

test("maxFiles above the file count allows the pick (files are paged)", async () => {
  const fx = sameRepoFixture();
  const { client, fake } = fakeFor({ "octo/proj": { dir: fx.dir, push: true } });
  const result = await pick(client, { source: proj, shas: [fx.fMany], target: { ...proj, branch: "main" }, maxFiles: 150 });
  checkAgainstOracle(fx.dir, fx.mainTip, result, oracle(fx.dir, "main", [fx.fMany]));
  assert.ok(fake.calls.some((c) => c.path.includes(`/commits/${fx.fMany}?per_page=100&page=2`)));
});

test("branch name taken → -2 suffix", async () => {
  const fx = sameRepoFixture();
  const name = `cherry-pick/${fx.f1.slice(0, 7)}-to-main`;
  git(fx.dir, ["branch", name, fx.c0]);
  const { client } = fakeFor({ "octo/proj": { dir: fx.dir, push: true } });
  const result = await pick(client, { source: proj, shas: [fx.f1], target: { ...proj, branch: "main" } });
  assert.equal(result.branch, `${name}-2`);
  assert.equal(git(fx.dir, ["rev-parse", name]), fx.c0, "old branch is not changed");
  assert.match(result.compareUrl, new RegExp(`main\\.\\.\\.${name}-2\\?`));
  checkAgainstOracle(fx.dir, fx.mainTip, result, oracle(fx.dir, "main", [fx.f1]));
});

test("all suffixes taken → branch_exists", async () => {
  const fx = sameRepoFixture();
  git(fx.dir, ["branch", "fix", fx.c0]);
  for (let i = 2; i <= 9; i++) git(fx.dir, ["branch", `fix-${i}`, fx.c0]);
  const { client, fake } = fakeFor({ "octo/proj": { dir: fx.dir, push: true } });
  await assert.rejects(pick(client, { source: proj, shas: [fx.f1], target: { ...proj, branch: "main" }, branch: "fix" }),
    (e) => e.code === "branch_exists");
  assert.deepEqual(fake.writes(), []);
});

test("bad branch name, missing target branch, unknown commit", async () => {
  const fx = sameRepoFixture();
  const { client, fake } = fakeFor({ "octo/proj": { dir: fx.dir, push: true } });
  await assert.rejects(pick(client, { source: proj, shas: [fx.f1], target: { ...proj, branch: "main" }, branch: "bad..name" }),
    (e) => e.code === "bad_branch_name");
  await assert.rejects(pick(client, { source: proj, shas: [fx.f1], target: { ...proj, branch: "nope" } }),
    (e) => e.code === "target_branch_missing");
  await assert.rejects(pick(client, { source: proj, shas: ["0".repeat(40)], target: { ...proj, branch: "main" } }),
    (e) => e.code === "not_found");
  await assert.rejects(pick(client, { source: proj, shas: [], target: { ...proj, branch: "main" } }),
    (e) => e.code === "no_commits");
  // Unknown target repository: the GitHubError passes through.
  await assert.rejects(pick(client, { source: proj, shas: [fx.f1], target: { owner: "x", repo: "y", branch: "main" } }),
    (e) => e.name === "GitHubError" && e.status === 404);
  assert.deepEqual(fake.writes(), []);
});

test("branch names with slashes are encoded per segment", async () => {
  const fx = sameRepoFixture();
  const { client, fake } = fakeFor({ "octo/proj": { dir: fx.dir, push: true } });
  const result = await pick(client, { source: proj, shas: [fx.f1], target: { ...proj, branch: "release/1.0" },
    branch: "fix/one", title: "My title", body: "My body" });
  assert.equal(result.branch, "fix/one");
  assert.equal(result.compareUrl, "https://github.com/octo/proj/compare/release/1.0...fix/one?quick_pull=1&title=My+title&body=My+body");
  assert.ok(fake.calls.some((c) => c.path === "/repos/octo/proj/git/ref/heads/release/1.0"));
  checkAgainstOracle(fx.dir, fx.c0, result, oracle(fx.dir, "release/1.0", [fx.f1]));
});

// ---------------------------------------------------------------- forks

test("no push and no fork → no_writable_repo", async () => {
  const fx = sameRepoFixture();
  const w = work("unrelated");
  w.write("x", "x\n");
  w.commit("x");
  const { client, fake } = fakeFor({
    "octo/proj": { dir: fx.dir, push: false },
    // Same name as the target, but not a fork.
    "alice/proj": { dir: bare(w.dir, "alice-proj"), push: true }
  });
  await assert.rejects(pick(client, { source: proj, shas: [fx.f1], target: { ...proj, branch: "main" } }),
    (e) => e.code === "no_writable_repo" && e.details.forkUrl === "https://github.com/octo/proj/fork");
  assert.deepEqual(fake.writes(), []);
});

test("no push + fork → branch in the fork, compareUrl uses owner:repo:branch", async () => {
  const fx = sameRepoFixture();
  const forkDir = forkOf(fx.dir, "fork");
  const upstreamBefore = refs(fx.dir);
  const { client } = fakeFor({
    "octo/proj": { dir: fx.dir, push: false },
    "alice/proj": { dir: forkDir, push: true, fork_of: "octo/proj" }
  });
  const shas = [fx.f1, fx.f2];
  const result = await pick(client, { source: proj, shas, target: { ...proj, branch: "main" } });
  assert.deepEqual(result.headRepo, { owner: "alice", repo: "proj" });
  const branch = `cherry-pick/${fx.f1.slice(0, 7)}%2B1-to-main`;
  assert.ok(result.compareUrl.startsWith(`https://github.com/octo/proj/compare/main...alice:proj:${branch}?`));
  checkAgainstOracle(forkDir, fx.mainTip, result, oracle(fx.dir, "main", shas));
  assert.equal(refs(fx.dir), upstreamBefore, "upstream is not changed");
});

test("fork with another name is found in the forks list", async () => {
  const fx = sameRepoFixture();
  const forkDir = forkOf(fx.dir, "fork2");
  const { client } = fakeFor({
    "octo/proj": { dir: fx.dir, push: false },
    "bob/proj": { dir: forkOf(fx.dir, "bobfork"), push: false, fork_of: "octo/proj" },
    "Alice/my-proj": { dir: forkDir, push: true, fork_of: "octo/proj" }
  });
  const result = await pick(client, { source: proj, shas: [fx.f3], target: { ...proj, branch: "main" } });
  assert.deepEqual(result.headRepo, { owner: "Alice", repo: "my-proj" });
  assert.match(result.compareUrl, /main\.\.\.Alice:my-proj:cherry-pick\//);
  checkAgainstOracle(forkDir, fx.mainTip, result, oracle(fx.dir, "main", [fx.f3]));
});

// ---------------------------------------------------------------- transplant between unrelated repositories

const BIN1 = Buffer.from([0, 1, 2, 3, 255, 254, 0, 10, 13, 0, 128]);
const BIN2 = Buffer.from([0, 9, 8, 7, 255, 0, 0, 200, 10, 13, 10]);

function writeBase(w) {
  w.write("old.txt", "old\n");
  w.write("ren-src.txt", lines(20));
  w.write("script.sh", "#!/bin/sh\necho hi\n");
  w.write("bin.dat", BIN1);
  w.write("shared.txt", lines(10));
}

function transplantFixture() {
  const s = work("src");
  writeBase(s);
  s.write("src-only.txt", "only in source\n");
  s.commit("Source initial");

  s.write("shared.txt", lines(10, { 2: "two from source" }));
  s.rm("old.txt");
  s.mv("ren-src.txt", "dir/ren-dst.txt");
  s.write("dir/ren-dst.txt", lines(20, { 1: "first line changed" }));
  s.chmod("script.sh", 0o755);
  s.write("bin.dat", BIN2);
  s.symlink("link", "shared.txt");
  s.write("a/b/c/new.txt", "brand new nested file\n");
  const s1 = s.commit("Big change", { author: ALICE, body: "Many kinds of change." });

  s.write("a/b/c/new.txt", "brand new nested file\nsecond line\n");
  s.symlink("link", "dir/ren-dst.txt");
  s.write("a/b/c/new.txt", "brand new nested file\nsecond line\n");
  const s2 = s.commit("Follow up");

  s.git("update-index", "--add", "--cacheinfo", `160000,${s1},vendor/sub`);
  const s3 = s.commit("Add submodule pointer", { noAdd: true });

  s.write("shared.txt", lines(10, { 2: "two from source", 9: "nine in target" }));
  const sDup = s.commit("Same as target");

  s.git("checkout", "-q", "-b", "other", s3);
  s.write("shared.txt", lines(10, { 2: "two from source", 9: "nine from source" }));
  const sConf = s.commit("Conflicting nine");

  s.write("dir/ren-dst.txt", lines(20, { 1: "first line changed", 20: "x" }));
  s.git("rm", "-q", "--cached", "vendor/sub");
  const sRmSub = s.commit("Remove submodule pointer", { noAdd: true });
  s.git("checkout", "-q", "main");

  const t = work("dst");
  writeBase(t);
  t.write("target-only.txt", "only in target\n");
  t.commit("Target initial, other history");
  t.write("shared.txt", lines(10, { 9: "nine in target" }));
  t.write("old-dir/keep.txt", "keep\n");
  t.commit("Target change");

  const srcDir = bare(s.dir, "src-bare");
  const dstDir = bare(t.dir, "dst-bare");
  const dstTip = git(dstDir, ["rev-parse", "main"]);
  const repos = {
    "src/lib": { dir: srcDir, push: false },
    "dst/app": { dir: dstDir, push: true }
  };
  return { srcDir, dstDir, dstTip, repos, s1, s2, s3, sDup, sConf, sRmSub };
}

const src = { owner: "src", repo: "lib" };
const dst = { owner: "dst", repo: "app" };

test("transplant between unrelated repos: add, delete, rename, mode, binary, symlink, nested dir, gitlink", async () => {
  const fx = transplantFixture();
  // The repositories do not share objects, so blobs must be copied.
  const newBlob = git(fx.srcDir, ["rev-parse", `${fx.s1}:a/b/c/new.txt`]);
  assert.equal(has(fx.dstDir, fx.s1), false);
  assert.equal(has(fx.dstDir, newBlob), false);

  const { client, fake } = fakeFor(fx.repos);
  const shas = [fx.s1, fx.s2, fx.s3];
  const result = await pick(client, { source: src, shas, target: { ...dst, branch: "main" } });
  assert.equal(result.status, "opened");
  assert.deepEqual(result.headRepo, dst);
  checkAgainstOracle(fx.dstDir, fx.dstTip, result, oracle(fx.dstDir, "main", shas, { sourceDir: fx.srcDir }));
  assert.equal(has(fx.dstDir, newBlob), true);
  assert.ok(fake.writes().some((c) => c.path === "/repos/dst/app/git/blobs"));

  const tip = git(fx.dstDir, ["rev-parse", `refs/heads/${result.branch}`]);
  const ls = git(fx.dstDir, ["ls-tree", "-r", tip]);
  assert.match(ls, /^100755 blob \S+\tscript\.sh$/m);
  assert.match(ls, /^120000 blob \S+\tlink$/m);
  assert.match(ls, /^160000 commit \S+\tvendor\/sub$/m);
  assert.match(ls, /\ta\/b\/c\/new\.txt$/m);
  assert.match(ls, /\ttarget-only\.txt$/m);
  assert.doesNotMatch(ls, /\told\.txt$/m);
  assert.doesNotMatch(ls, /\tren-src\.txt$/m);
  assert.doesNotMatch(ls, /src-only\.txt/);
  assert.deepEqual(gitRaw(fx.dstDir, ["cat-file", "blob", `${tip}:bin.dat`]).stdout, BIN2);
  assert.equal(git(fx.dstDir, ["show", `${tip}:shared.txt`]) + "\n", lines(10, { 2: "two from source", 9: "nine in target" }));
  assert.deepEqual(authorOf(fx.dstDir, result.applied[0].newSha), ALICE);
  assert.equal(messageOf(fx.dstDir, result.applied[0].newSha), "Big change\n\nMany kinds of change.");
});

test("transplant with trailer, empty skip and gitlink delete", async () => {
  const fx = transplantFixture();
  const { client } = fakeFor(fx.repos);
  // sRmSub depends on s1..s3 (on branch "other"); sDup is already in the target.
  const shas = [fx.s1, fx.s2, fx.sDup, fx.s3, fx.sRmSub];
  const result = await pick(client, { source: src, shas, target: { ...dst, branch: "main" }, trailer: true });
  const orc = oracle(fx.dstDir, "main", shas, { sourceDir: fx.srcDir, x: true });
  checkAgainstOracle(fx.dstDir, fx.dstTip, result, orc);
  assert.deepEqual(result.skipped, [{ sha: fx.sDup, reason: "empty" }]);
  const real = orc.commits.filter((c) => !c.empty);
  result.applied.forEach((a, i) => assert.equal(messageOf(fx.dstDir, a.newSha), real[i].message.replace(/\s+$/, "")));
});

test("transplant conflict deletes the branch", async () => {
  const fx = transplantFixture();
  const { client } = fakeFor(fx.repos);
  const before = refs(fx.dstDir);
  const shas = [fx.s1, fx.sConf];
  assert.ok(oracle(fx.dstDir, "main", shas, { sourceDir: fx.srcDir }).conflict === fx.sConf, "git also conflicts");
  await assert.rejects(pick(client, { source: src, shas, target: { ...dst, branch: "main" } }),
    (e) => e.code === "conflict" && e.details.sha === fx.sConf);
  assert.equal(refs(fx.dstDir), before);
});

test("transplant only empty picks → nothing_to_pick", async () => {
  const fx = transplantFixture();
  // Pick sDup alone: its parent (s3) differs from target, but its own change (line 9) is already there.
  const { client } = fakeFor(fx.repos);
  const before = refs(fx.dstDir);
  const result = await pick(client, { source: src, shas: [fx.sDup], target: { ...dst, branch: "main" } });
  assert.equal(result.status, "nothing_to_pick");
  assert.equal(result.compareUrl, null);
  assert.equal(refs(fx.dstDir), before);
  assert.ok(oracle(fx.dstDir, "main", [fx.sDup], { sourceDir: fx.srcDir }).commits[0].empty);
});

// ---------------------------------------------------------------- fake sanity

test("fake GitHub returns 404 JSON for unknown paths and objects", async () => {
  const fx = sameRepoFixture();
  const fake = createFakeGitHub({ repos: { "octo/proj": { dir: fx.dir, push: true } } });
  for (const p of ["/nope", "/repos/octo/proj/nope", "/repos/a/b", `/repos/octo/proj/git/blobs/${"1".repeat(40)}`]) {
    const res = await fake(API + p);
    assert.equal(res.status, 404, p);
    assert.deepEqual(await res.json(), { message: "Not Found" });
  }
  const files = await (await fake(`${API}/repos/octo/proj/commits/${fx.f1}`)).json();
  assert.deepEqual(files.files.map((f) => [f.filename, f.status]), [["a.txt", "modified"]]);
});
