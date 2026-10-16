"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../src/content.js");

const A = "a".repeat(40);
const B = "b".repeat(40);
const D = "d".repeat(40);

test("orderSelected uses the list order, not the click order", () => {
  const commits = [{ sha: A }, { sha: B }, { sha: D }];
  assert.deepEqual(C.orderSelected(commits, [D, A]), [A, D]);
  assert.deepEqual(C.orderSelected(commits, new Set(["bbbbbbb"])), [B]);
  assert.deepEqual(C.orderSelected(commits, ["ccccccc"]), []);
  assert.deepEqual(C.orderSelected(commits, []), []);
});

test("subjectFromTitle", () => {
  assert.equal(C.subjectFromTitle("Fix the bug · me/repo@abc1234 · GitHub"), "Fix the bug");
  assert.equal(C.subjectFromTitle("Fix · it · me/repo@abc1234 · GitHub"), null);
  assert.equal(C.subjectFromTitle("GitHub"), null);
  assert.equal(C.subjectFromTitle(""), null);
});

test("formatTarget", () => {
  assert.equal(C.formatTarget({ owner: "o", repo: "r", branch: "main" }), "o/r:main");
  assert.equal(C.formatTarget({ owner: "o", repo: "r", branch: null }), "o/r:");
});

test("conflictCommands", () => {
  const base = { host: "ghe.example", target: { owner: "o", repo: "r", branch: "rel" }, branch: "cp/x", shas: [A, B] };
  const same = C.conflictCommands(Object.assign({ source: { owner: "O", repo: "R" } }, base));
  assert.match(same, /^git fetch origin rel$/m);
  assert.match(same, /^git switch -c cp\/x origin\/rel$/m);
  assert.match(same, new RegExp(`^git cherry-pick -x ${A} ${B}$`, "m"));
  assert.doesNotMatch(same, /https:/);
  const fork = C.conflictCommands(Object.assign({ source: { owner: "f", repo: "r" } }, base));
  assert.match(fork, /^git fetch https:\/\/ghe\.example\/f\/r\.git$/m);
  const pull = C.conflictCommands(Object.assign({ source: { owner: "o", repo: "r" }, pullNumber: 7 }, base));
  assert.match(pull, /^git fetch https:\/\/ghe\.example\/o\/r\.git pull\/7\/head$/m);
});
