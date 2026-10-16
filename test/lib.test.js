"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/lib.js");

test("normalizeHost", () => {
  assert.equal(L.normalizeHost("GitHub.com"), "github.com");
  assert.equal(L.normalizeHost("https://api.github.com/x"), "github.com");
  assert.equal(L.normalizeHost("https://ghe.corp.example/foo"), "ghe.corp.example");
  assert.equal(L.normalizeHost("http://ghe.corp.example"), null);
  assert.equal(L.normalizeHost("ghe.corp.example:8443"), null);
  assert.equal(L.normalizeHost("localhost"), null);
  assert.equal(L.normalizeHost(""), null);
});

test("apiBase", () => {
  assert.equal(L.apiBase("github.com"), "https://api.github.com");
  assert.equal(L.apiBase("ghe.corp.example"), "https://ghe.corp.example/api/v3");
});

test("parseCommitPage", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(L.parseCommitPage(`/me/repo/commit/${sha}`), { owner: "me", repo: "repo", sha });
  assert.deepEqual(L.parseCommitPage(`/me/repo/pull/12/commits/${sha.toUpperCase()}`), { owner: "me", repo: "repo", sha });
  assert.equal(L.parseCommitPage("/me/repo/commit/main"), null);
  assert.equal(L.parseCommitPage(`/settings/repo/commit/${sha}`), null);
  assert.equal(L.parseCommitPage(`/me/repo/commits/${sha}`), null);
});

test("parsePullCommitsPage", () => {
  assert.deepEqual(L.parsePullCommitsPage("/me/repo/pull/7/commits"), { owner: "me", repo: "repo", number: 7 });
  assert.equal(L.parsePullCommitsPage("/me/repo/pull/7"), null);
  assert.equal(L.parsePullCommitsPage("/me/repo/pull/x/commits"), null);
});

test("parseTarget", () => {
  assert.deepEqual(L.parseTarget("up/proj:feature/x"), { owner: "up", repo: "proj", branch: "feature/x" });
  assert.deepEqual(L.parseTarget(":dev"), { owner: null, repo: null, branch: "dev" });
  assert.equal(L.parseTarget("nope"), null);
});

test("isValidBranchName", () => {
  for (const ok of ["main", "cherry-pick/abc1234-to-main", "release/1.0", "a+b"]) assert.ok(L.isValidBranchName(ok), ok);
  for (const bad of ["", "/a", "a/", "a..b", "a b", "a:b", "a.lock", "a/.b", "a@{1", "-a", "a//b", "a."]) {
    assert.ok(!L.isValidBranchName(bad), bad);
  }
});

test("defaultBranchName", () => {
  assert.equal(L.defaultBranchName(["abcdef0123"], "main"), "cherry-pick/abcdef0-to-main");
  assert.equal(L.defaultBranchName(["abcdef0123", "1", "2"], "release/1.0"), "cherry-pick/abcdef0+2-to-release-1.0");
  assert.ok(L.isValidBranchName(L.defaultBranchName(["abcdef0"], "we:ird..name")));
});

test("appendTrailer", () => {
  assert.equal(L.appendTrailer("Fix bug\n\nBody\n", "abc"), "Fix bug\n\nBody\n\n(cherry picked from commit abc)\n");
  assert.equal(L.appendTrailer("x\n\n(cherry picked from commit abc)", "abc"), "x\n\n(cherry picked from commit abc)\n");
});

test("isWorkflowPath", () => {
  assert.ok(L.isWorkflowPath(".github/workflows/ci.yml"));
  assert.ok(!L.isWorkflowPath(".github/dependabot.yml"));
  assert.ok(!L.isWorkflowPath("docs/.github/workflows/x.yml"));
});

test("compareUrl same repo and cross repo", () => {
  const base = { owner: "up", repo: "proj", branch: "release/1.0" };
  assert.equal(
    L.compareUrl("github.com", base, { owner: "up", repo: "proj", branch: "cherry-pick/a" }, { title: "T" }),
    "https://github.com/up/proj/compare/release/1.0...cherry-pick/a?quick_pull=1&title=T");
  assert.equal(
    L.compareUrl("ghe.x.com", base, { owner: "me", repo: "proj-fork", branch: "b" }),
    "https://ghe.x.com/up/proj/compare/release/1.0...me:proj-fork:b?quick_pull=1");
});

test("defaultPrText", () => {
  const one = L.defaultPrText([{ sha: "a1", message: "Fix x\n\nbody" }], "main");
  assert.equal(one.title, "[main] Fix x");
  assert.match(one.body, /- a1: Fix x/);
  assert.equal(L.defaultPrText([{ sha: "a", message: "1" }, { sha: "b", message: "2" }], "main").title, "[main] Cherry-pick 2 commits");
});
