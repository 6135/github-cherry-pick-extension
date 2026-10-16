// In-page UI. Adds "Cherry-pick" to commit pages and PR commit lists.
// All GitHub API work happens in the background script.
"use strict";

(function () {
  // All GitHub DOM selectors. Update here when GitHub changes its markup.
  const SELECTORS = {
    // Links or buttons in the commit header. The button goes before the first match.
    commitAnchors: [
      '[data-testid="browse-at-time-link"]',
      'a[aria-label="Browse the repository at this point in the history"]',
      ".commit .btn.float-right"
    ],
    // Text of the "Browse files" link (used when the selectors above find nothing).
    commitAnchorText: /^browse files$/i,
    commitAnchorTextScope: "main, #js-repo-pjax-container, body",
    // Commit header, to find "2 parents" text for merge commits.
    commitHeader: '[data-testid="commit-header"], .commit.full-commit, main',
    // Container of the commit rows on a PR "Commits" tab.
    pullCommitsContainer: '[data-testid="commits-list"], #commits_bucket, .js-commits-list, main, body',
    // Element that holds one commit. The checkbox goes first in it.
    commitRow: '[data-testid="commit-row-item"], li.js-commits-list-item, li.Box-row, [role="listitem"], li',
    // Commit subject inside a row.
    rowTitle: '[data-testid="list-row-title"] a, .markdown-title a, a.Link--primary, h4 a, p a'
  };

  const IDS = { button: "cp-button", dialog: "cp-dialog", bar: "cp-bar" };
  const FLOAT_DELAY_MS = 1500;
  const BRANCH_DEBOUNCE_MS = 400;

  // ---- Pure helpers (exported for Node tests) ----

  // Returns the shas of `commits` (authoritative order) that match `selected`.
  // Matches by prefix, so short shas from the page also work.
  function orderSelected(commits, selected) {
    const sel = Array.from(selected || [], (s) => String(s).toLowerCase());
    return commits
      .filter((c) => sel.some((s) => c.sha.toLowerCase().startsWith(s) || s.startsWith(c.sha.toLowerCase())))
      .map((c) => c.sha);
  }

  // "Fix the bug · owner/repo@abc1234 · GitHub" → "Fix the bug". Null when no match.
  function subjectFromTitle(title) {
    const parts = String(title || "").split(" · ");
    if (parts.length >= 2 && /^[^/\s]+\/[^@\s]+@[0-9a-f]{7,40}$/i.test(parts[1].trim())) return parts[0].trim() || null;
    return null;
  }

  function subject(message) {
    return String(message || "").split("\n")[0].trim();
  }

  function formatTarget(t) {
    return `${t.owner}/${t.repo}:${t.branch || ""}`;
  }

  // Local git commands for a pick that GitHub cannot do (conflict).
  // o: { host, source, target, branch, shas, pullNumber }
  function conflictCommands(o) {
    const tb = o.target.branch;
    const lines = [`# "origin" must point to ${o.target.owner}/${o.target.repo}.`, `git fetch origin ${tb}`];
    const srcUrl = `https://${o.host}/${o.source.owner}/${o.source.repo}.git`;
    if (o.pullNumber) lines.push(`git fetch ${srcUrl} pull/${o.pullNumber}/head`);
    else if (!sameRepoPlain(o.source, o.target)) lines.push(`git fetch ${srcUrl}`);
    lines.push(`git switch -c ${o.branch} origin/${tb}`);
    lines.push(`git cherry-pick -x ${o.shas.join(" ")}`);
    return lines.join("\n");
  }

  function sameRepoPlain(a, b) {
    return String(a.owner).toLowerCase() === String(b.owner).toLowerCase() &&
      String(a.repo).toLowerCase() === String(b.repo).toLowerCase();
  }

  const helpers = { orderSelected, subjectFromTitle, subject, formatTarget, conflictCommands, SELECTORS };
  if (typeof module === "object" && module.exports) {
    module.exports = helpers;
    return;
  }

  // ---- Page integration ----

  const L = globalThis.CpLib;
  const HOST = location.hostname;

  let scheduled = false;
  let pathSeen = { path: "", since: 0 };
  // Page selection on the PR commits tab: { key, shas: Set }.
  let pageSel = { key: "", shas: new Set() };

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try { ensureUi(); } catch (err) { console.error("[cherry-pick]", err); }
    }, 150);
  }

  function ensureUi() {
    if (pathSeen.path !== location.pathname) pathSeen = { path: location.pathname, since: Date.now() };
    const commit = L.parseCommitPage(location.pathname);
    const pull = L.parsePullCommitsPage(location.pathname);
    ensureCommitButton(commit);
    ensurePullUi(pull);
  }

  // ---- Commit page ----

  function ensureCommitButton(ctx) {
    const existing = document.getElementById(IDS.button);
    if (!ctx) {
      if (existing) existing.remove();
      return;
    }
    const anchor = findCommitAnchor();
    if (existing && existing.isConnected) {
      // Move from the floating place to the header when the header shows up late.
      if (!(anchor && existing.classList.contains("cp-floating"))) return;
      existing.remove();
    }
    if (anchor) {
      anchor.insertAdjacentElement("beforebegin", createCommitButton(false));
      return;
    }
    // No anchor yet. Wait a little for the React view, then use the floating button.
    const wait = pathSeen.since + FLOAT_DELAY_MS - Date.now();
    if (wait > 0) {
      setTimeout(schedule, wait + 10);
      return;
    }
    document.body.appendChild(createCommitButton(true));
  }

  function findCommitAnchor() {
    for (const sel of SELECTORS.commitAnchors) {
      const el = document.querySelector(sel);
      if (el && !isOurs(el)) return el;
    }
    const scope = document.querySelector(SELECTORS.commitAnchorTextScope) || document.body;
    return Array.from(scope.querySelectorAll("a, button"))
      .find((el) => SELECTORS.commitAnchorText.test(el.textContent.trim()) && !isOurs(el)) || null;
  }

  function isOurs(el) {
    return !!el.closest(`#${IDS.dialog}, #${IDS.bar}, #${IDS.button}`);
  }

  function createCommitButton(floating) {
    const btn = document.createElement("button");
    btn.id = IDS.button;
    btn.type = "button";
    btn.className = floating ? "cp-btn cp-floating" : "cp-btn cp-inline";
    btn.textContent = "Cherry-pick";
    btn.title = "Cherry-pick this commit to another branch";
    btn.addEventListener("click", () => {
      const ctx = L.parseCommitPage(location.pathname);
      if (ctx) openDialog({ mode: "commit", owner: ctx.owner, repo: ctx.repo, sha: ctx.sha, number: pullNumberFromPath() });
    });
    return btn;
  }

  function pullNumberFromPath() {
    const m = /\/pull\/(\d+)\/commits\//.exec(location.pathname);
    return m ? Number(m[1]) : null;
  }

  // Subject and parent count from the page. Used only when the API call fails.
  function commitFromDom(sha) {
    const header = document.querySelector(SELECTORS.commitHeader);
    const m = header && /\b(\d+)\s+parents\b/i.exec(header.textContent || "");
    const count = m ? Number(m[1]) : 1;
    const message = subjectFromTitle(document.title) || `Commit ${sha.slice(0, 7)}`;
    return { sha, message, parents: new Array(count).fill("") };
  }

  // ---- PR commits page ----

  function ensurePullUi(ctx) {
    const bar = document.getElementById(IDS.bar);
    if (!ctx) {
      if (bar) bar.remove();
      return;
    }
    const key = `${ctx.owner}/${ctx.repo}#${ctx.number}`.toLowerCase();
    if (pageSel.key !== key) pageSel = { key, shas: new Set() };
    addRowCheckboxes();
    if (!bar || !bar.isConnected) document.body.appendChild(getBar());
    updateBar();
  }

  function addRowCheckboxes() {
    const container = document.querySelector(SELECTORS.pullCommitsContainer) || document.body;
    const done = new Set(Array.from(document.querySelectorAll(".cp-row-check input"), (i) => i.value));
    for (const a of container.querySelectorAll('a[href*="/commit/"], a[href*="/commits/"]')) {
      if (isOurs(a)) continue;
      let path;
      try { path = new URL(a.href, location.href).pathname; } catch (_) { continue; }
      const info = L.parseCommitPage(path);
      if (!info || done.has(info.sha)) continue;
      const row = a.closest(SELECTORS.commitRow);
      if (!row || row.querySelector(".cp-row-check")) continue;
      row.classList.add("cp-row");
      row.prepend(createRowCheckbox(info.sha, rowSubject(row)));
      done.add(info.sha);
    }
  }

  function rowSubject(row) {
    const el = row.querySelector(SELECTORS.rowTitle);
    return el ? el.textContent.trim() : "";
  }

  function createRowCheckbox(sha, title) {
    const label = document.createElement("label");
    label.className = "cp-row-check";
    label.title = "Select for cherry-pick";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = sha;
    input.dataset.subject = title;
    input.checked = pageSel.shas.has(sha);
    input.setAttribute("aria-label", `Select commit ${sha.slice(0, 7)} for cherry-pick`);
    input.addEventListener("change", () => {
      if (input.checked) pageSel.shas.add(sha);
      else pageSel.shas.delete(sha);
      updateBar();
    });
    label.appendChild(input);
    return label;
  }

  function syncRowCheckboxes() {
    for (const input of document.querySelectorAll(".cp-row-check input")) {
      input.checked = pageSel.shas.has(input.value);
    }
  }

  // DOM order of the row checkboxes (GitHub lists PR commits oldest first).
  function domCommits() {
    return Array.from(document.querySelectorAll(".cp-row-check input"),
      (i) => ({ sha: i.value, message: i.dataset.subject || `Commit ${i.value.slice(0, 7)}`, parents: [] }));
  }

  let barEl = null;
  function getBar() {
    if (barEl) return barEl;
    barEl = el("div", { id: IDS.bar, className: "cp-bar", role: "region", "aria-label": "Cherry-pick" });
    barEl.innerHTML = `
      <span class="cp-bar-count" aria-live="polite"></span>
      <button type="button" class="cp-btn cp-btn-primary" data-action="pick">Cherry-pick</button>
      <button type="button" class="cp-btn" data-action="clear">Clear</button>
      <button type="button" class="cp-btn" data-action="choose">Choose commits…</button>`;
    barEl.querySelector("[data-action=pick]").addEventListener("click", () => openPullDialog());
    barEl.querySelector("[data-action=choose]").addEventListener("click", () => openPullDialog());
    barEl.querySelector("[data-action=clear]").addEventListener("click", () => {
      pageSel.shas.clear();
      syncRowCheckboxes();
      updateBar();
    });
    return barEl;
  }

  function updateBar() {
    if (!barEl) return;
    const n = pageSel.shas.size;
    const text = `${n} selected`;
    const count = barEl.querySelector(".cp-bar-count");
    if (count.textContent !== text) count.textContent = text;
    barEl.querySelector("[data-action=pick]").disabled = n === 0;
    barEl.querySelector("[data-action=clear]").disabled = n === 0;
  }

  function openPullDialog() {
    const ctx = L.parsePullCommitsPage(location.pathname);
    if (ctx) openDialog({ mode: "pull", owner: ctx.owner, repo: ctx.repo, number: ctx.number, selected: Array.from(pageSel.shas) });
  }

  // ---- Dialog ----

  // State of the dialog. Kept while a job runs, so the user can close and reopen it.
  const st = {
    seq: 0, running: false, ctx: null, commits: [], repo: null, settings: null, prBase: null,
    branchEdited: false, titleEdited: false, branchesFor: "", branchCache: new Map(), branchTimer: 0
  };

  let dlg = null;
  function getDialog() {
    if (dlg) {
      // Turbo can replace <body>. Put the same element back to keep its state.
      if (!dlg.isConnected) document.body.appendChild(dlg);
      return dlg;
    }
    dlg = el("dialog", { id: IDS.dialog, className: "cp-dialog", "aria-labelledby": "cp-heading" });
    dlg.innerHTML = `
      <form method="dialog" class="cp-form" novalidate>
        <h2 id="cp-heading" class="cp-heading">Cherry-pick</h2>
        <div class="cp-login" hidden>
          <p class="cp-login-text"></p>
          <div class="cp-actions-inline">
            <button type="button" class="cp-btn cp-btn-primary" data-action="login">Log in</button>
            <button type="button" class="cp-btn" data-action="settings">Settings</button>
          </div>
        </div>
        <div class="cp-main" hidden>
          <fieldset class="cp-fieldset">
            <legend>Commits</legend>
            <ul class="cp-commit-list"></ul>
          </fieldset>
          <div class="cp-field">
            <label for="cp-target">Target (owner/repo:branch)</label>
            <input id="cp-target" name="target" type="text" list="cp-branches" autocomplete="off" spellcheck="false" required>
            <datalist id="cp-branches"></datalist>
            <div class="cp-quick">
              <button type="button" class="cp-link-btn" data-action="this-repo">This repo</button>
              <button type="button" class="cp-link-btn" data-action="parent" hidden>Fork parent</button>
            </div>
          </div>
          <div class="cp-field">
            <label for="cp-branch">New branch</label>
            <input id="cp-branch" name="branch" type="text" autocomplete="off" spellcheck="false" required>
          </div>
          <div class="cp-field">
            <label for="cp-title">Pull request title</label>
            <input id="cp-title" name="title" type="text" autocomplete="off" required>
          </div>
          <label class="cp-check" for="cp-trailer">
            <input id="cp-trailer" name="trailer" type="checkbox">
            Add "(cherry picked from commit …)" line
          </label>
        </div>
        <div class="cp-status" role="status" aria-live="polite"></div>
        <div class="cp-result"></div>
        <div class="cp-actions">
          <button type="button" class="cp-btn" data-action="cancel">Cancel</button>
          <button type="submit" class="cp-btn cp-btn-primary" data-action="ok" hidden>Cherry-pick</button>
        </div>
      </form>`;
    const q = (s) => dlg.querySelector(s);
    q("[data-action=cancel]").addEventListener("click", () => dlg.close());
    q("[data-action=login]").addEventListener("click", () => send({ type: "openLogin", host: HOST }));
    q("[data-action=settings]").addEventListener("click", () => send({ type: "openOptions" }));
    q("[data-action=this-repo]").addEventListener("click", () => setTarget(thisRepoTarget()));
    q("[data-action=parent]").addEventListener("click", () => {
      const p = st.repo && st.repo.parent;
      if (p) setTarget({ owner: p.owner, repo: p.repo, branch: p.defaultBranch || "" });
    });
    q("#cp-target").addEventListener("input", () => { refreshDefaults(); queueBranches(); });
    q("#cp-branch").addEventListener("input", () => { st.branchEdited = true; validate(); });
    q("#cp-title").addEventListener("input", () => { st.titleEdited = true; validate(); });
    q(".cp-commit-list").addEventListener("change", onCommitToggle);
    q("form").addEventListener("submit", onSubmit);
    document.body.appendChild(dlg);
    return dlg;
  }

  function el(tag, props) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "className") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v);
    }
    return node;
  }

  function $(sel) {
    return getDialog().querySelector(sel);
  }

  async function openDialog(ctx) {
    const d = getDialog();
    if (st.running) {
      if (!d.open) d.showModal();
      return;
    }
    const seq = ++st.seq;
    Object.assign(st, { ctx, commits: [], repo: null, settings: null, branchEdited: false, titleEdited: false, branchesFor: "" });
    $(".cp-login").hidden = true;
    $(".cp-main").hidden = true;
    $("[data-action=ok]").hidden = true;
    $("[data-action=cancel]").textContent = "Cancel";
    $(".cp-result").replaceChildren();
    $("#cp-branches").replaceChildren();
    setInputsDisabled(false);
    setStatus("Loading…");
    if (!d.open) d.showModal();

    const sres = await send({ type: "session", host: HOST });
    if (seq !== st.seq) return;
    if (!sres.ok) return setStatus(sres.error.message, true);
    if (!sres.session) return showLogin(`Log in to ${HOST} to cherry-pick.`);
    st.publicOnly = !(sres.session.scopes || []).includes("repo");

    const source = { owner: ctx.owner, repo: ctx.repo };
    const [settings, rres, commits] = await Promise.all([
      loadSettings(),
      send({ type: "repoInfo", host: HOST, owner: source.owner, repo: source.repo }),
      loadCommits(ctx)
    ]);
    if (seq !== st.seq) return;
    st.settings = settings;
    st.repo = rres.ok ? rres.repo : null;
    st.commits = commits.list;
    // On a PR page, the PR's base branch is the most likely target.
    st.prBase = ctx.number ? commits.base || null : null;

    const preselected = ctx.mode === "commit" ? [ctx.sha] : ctx.selected;
    fillCommitList(orderSelected(st.commits, preselected));
    $("#cp-trailer").checked = settings.trailer;
    $("[data-action=parent]").hidden = !(st.repo && st.repo.parent);
    setTarget(st.prBase || thisRepoTarget());
    $(".cp-main").hidden = false;
    $("[data-action=ok]").hidden = false;

    const notes = [];
    if (commits.note) notes.push(commits.note);
    if (!st.repo) {
      const why = rres.error ? ` (${rres.error.code}: ${rres.error.message})` : "";
      const hint = st.publicOnly && rres.error && rres.error.code === "not_found"
        ? " If this repo is private, select \"Public and private repositories\" in the settings and log in again." : "";
      notes.push(`Could not read the repo data${why}. Type the target branch.${hint}`);
    }
    setStatus(notes.join(" "), notes.length > 0);
    validate();
    const first = $(".cp-commit-list input:not(:disabled)") || $("#cp-target");
    first.focus();
  }

  function showLogin(text) {
    $(".cp-login-text").textContent = text;
    $(".cp-login").hidden = false;
    setStatus("");
    $("[data-action=login]").focus();
  }

  async function loadCommits(ctx) {
    const number = ctx.number;
    if (number) {
      const res = await send({ type: "pullCommits", host: HOST, owner: ctx.owner, repo: ctx.repo, number });
      if (res.ok && res.commits.length) {
        const list = res.commits.map((c) => ({ sha: c.sha.toLowerCase(), message: c.message, parents: c.parents || [] }));
        if (ctx.mode === "commit" && !orderSelected(list, [ctx.sha]).length) list.push(commitFromDom(ctx.sha));
        return { list, base: res.base || null };
      }
      if (ctx.mode === "pull") {
        const list = domCommits();
        return { list, note: list.length ? "Could not load the commit list. Showing the commits on this page." : "Could not load the commit list." };
      }
    }
    return { list: [await loadOneCommit(ctx)] };
  }

  // The real message and parents from the API. Falls back to the page.
  async function loadOneCommit(ctx) {
    const res = await send({ type: "commit", host: HOST, owner: ctx.owner, repo: ctx.repo, sha: ctx.sha });
    if (res.ok && res.commit) {
      const c = res.commit;
      return { sha: c.sha.toLowerCase(), message: c.message, parents: c.parents || [] };
    }
    return commitFromDom(ctx.sha);
  }

  function fillCommitList(selectedShas) {
    const ul = $(".cp-commit-list");
    ul.replaceChildren();
    if (!st.commits.length) {
      ul.appendChild(el("li", { className: "cp-muted", text: "No commits found." }));
      return;
    }
    st.commits.forEach((c, i) => {
      const li = el("li", { className: "cp-commit" });
      const id = `cp-commit-${i}`;
      const input = el("input", { id, type: "checkbox", value: c.sha });
      const merge = c.parents.length > 1;
      input.checked = !merge && selectedShas.includes(c.sha);
      input.disabled = merge;
      const label = el("label", { for: id });
      label.append(el("code", { className: "cp-sha", text: c.sha.slice(0, 7) }), " ", el("span", { className: "cp-subject", text: subject(c.message) }));
      li.append(input, label);
      if (merge) li.appendChild(el("span", { className: "cp-chip", text: "Merge commit", title: "Merge commits cannot be cherry-picked here." }));
      ul.appendChild(li);
    });
  }

  function onCommitToggle(e) {
    const input = e.target;
    if (st.ctx && st.ctx.mode === "pull" && input.matches("input[type=checkbox]")) {
      if (input.checked) pageSel.shas.add(input.value);
      else for (const s of Array.from(pageSel.shas)) if (input.value.startsWith(s) || s.startsWith(input.value)) pageSel.shas.delete(s);
      syncRowCheckboxes();
      updateBar();
    }
    refreshDefaults();
  }

  function selectedShas() {
    const checked = Array.from(dlg.querySelectorAll(".cp-commit-list input:checked"), (i) => i.value);
    return orderSelected(st.commits, checked);
  }

  function thisRepoTarget() {
    const c = st.ctx;
    return { owner: c.owner, repo: c.repo, branch: (st.repo && st.repo.defaultBranch) || "" };
  }

  function setTarget(t) {
    $("#cp-target").value = formatTarget(t);
    refreshDefaults();
    queueBranches(true);
  }

  // Fills the branch name and title from the selection and target, until the user edits them.
  function refreshDefaults() {
    const shas = selectedShas();
    const target = L.parseTarget($("#cp-target").value);
    const tb = (target && target.branch) || "target";
    if (!st.branchEdited) $("#cp-branch").value = shas.length ? L.defaultBranchName(shas, tb) : "";
    if (!st.titleEdited) $("#cp-title").value = shas.length ? prText(shas, tb).title : "";
    validate();
  }

  function prText(shas, targetBranch) {
    const commits = shas.map((sha) => st.commits.find((c) => c.sha === sha));
    return L.defaultPrText(commits, targetBranch);
  }

  // Loads the branch list for the repo in the target field (debounced).
  function queueBranches(now) {
    clearTimeout(st.branchTimer);
    st.branchTimer = setTimeout(loadBranches, now ? 0 : BRANCH_DEBOUNCE_MS);
  }

  async function loadBranches() {
    const t = L.parseTarget($("#cp-target").value);
    if (!t || !t.owner) return;
    const key = `${t.owner}/${t.repo}`.toLowerCase();
    if (key === st.branchesFor) return;
    st.branchesFor = key;
    let names = st.branchCache.get(key);
    if (!names) {
      const res = await send({ type: "branches", host: HOST, owner: t.owner, repo: t.repo });
      names = res.ok ? res.branches : [];
      if (res.ok) st.branchCache.set(key, names);
    }
    if (st.branchesFor !== key) return;
    $("#cp-branches").replaceChildren(...names.map((b) => el("option", { value: `${t.owner}/${t.repo}:${b}` })));
  }

  // Returns an error text for the form, or "" when it is valid. Marks bad fields.
  function validate() {
    const problems = [];
    const mark = (sel, bad) => $(sel).setAttribute("aria-invalid", bad ? "true" : "false");
    const shas = selectedShas();
    if (!shas.length) problems.push("Select at least one commit.");
    const t = L.parseTarget($("#cp-target").value);
    const badTarget = !t || !t.owner || !t.branch;
    mark("#cp-target", badTarget);
    if (badTarget) problems.push("Use owner/repo:branch for the target.");
    const branch = $("#cp-branch").value.trim();
    const badBranch = !L.isValidBranchName(branch) || (t && t.branch === branch && L.sameRepo(t, st.ctx));
    mark("#cp-branch", badBranch && shas.length > 0);
    if (badBranch && shas.length) problems.push("The new branch name is not valid.");
    const badTitle = !$("#cp-title").value.trim();
    mark("#cp-title", badTitle && shas.length > 0);
    if (badTitle && shas.length) problems.push("Type a title.");
    if (!st.running) $("[data-action=ok]").disabled = problems.length > 0;
    return problems.join(" ");
  }

  function setInputsDisabled(disabled) {
    for (const node of dlg.querySelectorAll(".cp-main input, .cp-main button")) {
      if (disabled) {
        node.dataset.cpWasDisabled = node.disabled ? "1" : "";
        node.disabled = true;
      } else if (node.dataset.cpWasDisabled !== undefined) {
        node.disabled = node.dataset.cpWasDisabled === "1";
        delete node.dataset.cpWasDisabled;
      }
    }
    $("[data-action=ok]").disabled = disabled;
  }

  function onSubmit(e) {
    e.preventDefault();
    if (st.running) return;
    const problem = validate();
    if (problem) return setStatus(problem, true);
    const target = L.parseTarget($("#cp-target").value);
    const shas = selectedShas();
    const source = { owner: st.ctx.owner, repo: st.ctx.repo };
    const branch = $("#cp-branch").value.trim();
    const settings = st.settings || { maxFiles: L.DEFAULT_MAX_FILES };
    const request = {
      host: HOST,
      source,
      shas,
      target: { owner: target.owner, repo: target.repo, branch: target.branch },
      branch,
      trailer: $("#cp-trailer").checked,
      title: $("#cp-title").value.trim(),
      body: prText(shas, target.branch).body,
      maxFiles: settings.maxFiles
    };
    runPick(request);
  }

  function runPick(request) {
    let port;
    try {
      port = chrome.runtime.connect({ name: "pick" });
    } catch (err) {
      return setStatus(contextError(err), true);
    }
    st.running = true;
    let finished = false;
    setInputsDisabled(true);
    $(".cp-result").replaceChildren();
    setStatus("Starting…");
    const finish = () => {
      finished = true;
      st.running = false;
      setInputsDisabled(false);
      validate();
      try { port.disconnect(); } catch (_) { /* Already closed. */ }
    };
    port.onMessage.addListener((msg) => {
      if (!msg || finished) return;
      if (msg.type === "progress") {
        const count = msg.total ? ` (${msg.done}/${msg.total})` : "";
        setStatus(`${msg.text || "Working…"}${count}`);
      } else if (msg.type === "done") {
        finish();
        showDone(request, msg.result);
      } else if (msg.type === "error") {
        finish();
        showError(request, msg.error || {});
      }
    });
    port.onDisconnect.addListener(() => {
      if (finished) return;
      finish();
      showError(request, { code: "disconnected", message: "The extension stopped before the end. Try again." });
    });
    port.postMessage({ type: "start", request });
  }

  function showDone(request, result) {
    const box = $(".cp-result");
    box.replaceChildren();
    const target = formatTarget(request.target);
    const skipped = (result && result.skipped) || [];
    if (result && result.status === "opened") {
      // Open the tab first. A popup blocker can stop it, so also show the link.
      window.open(result.compareUrl, "_blank", "noopener");
      const n = (result.applied || []).length;
      setStatus(`Picked ${n} commit${n === 1 ? "" : "s"} to branch ${result.branch}.`);
      const p = el("p");
      p.append("Click \"Create pull request\" on GitHub: ", link(result.compareUrl, "Open the pull request form"));
      box.appendChild(p);
      $("[data-action=ok]").hidden = true;
      $("[data-action=cancel]").textContent = "Close";
    } else {
      setStatus(`All commits are already in ${target}. Nothing was created.`);
    }
    if (skipped.length) {
      box.appendChild(el("p", { className: "cp-muted", text: `Already in ${target}:` }));
      const ul = el("ul", { className: "cp-skipped" });
      for (const s of skipped) {
        const c = st.commits.find((x) => x.sha === s.sha);
        const li = el("li");
        li.append(el("code", { className: "cp-sha", text: s.sha.slice(0, 7) }), " ", c ? subject(c.message) : "");
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
    box.scrollIntoView({ block: "nearest" });
  }

  function showError(request, error) {
    const box = $(".cp-result");
    box.replaceChildren();
    const d = error.details || {};
    const short = d.sha ? String(d.sha).slice(0, 7) : "";
    const target = formatTarget(request.target);
    const actions = el("div", { className: "cp-actions-inline" });
    let text;
    switch (error.code) {
      case "not_logged_in":
        text = `Log in to ${HOST} to cherry-pick.`;
        actions.appendChild(button("Log in", () => send({ type: "openLogin", host: HOST }), true));
        break;
      case "bad_token":
        text = "Your login is not valid any more. Log in again.";
        actions.appendChild(button("Log in", () => send({ type: "openLogin", host: HOST }), true));
        break;
      case "sso_required":
        text = "This organization uses SAML single sign-on.";
        if (d.ssoUrl) actions.appendChild(link(d.ssoUrl, "Authorize the token for this organization"));
        break;
      case "no_writable_repo":
        text = `You cannot push to ${request.target.owner}/${request.target.repo}, and you have no fork of it.`;
        if (d.forkUrl) actions.appendChild(link(d.forkUrl, "Fork the repo on GitHub, then try again"));
        break;
      case "conflict": {
        text = `Commit ${short || "?"} does not apply cleanly to ${target}. Cherry-pick on your computer:`;
        const cmds = conflictCommands({
          host: HOST, source: request.source, target: request.target, branch: request.branch,
          shas: request.shas, pullNumber: st.ctx.number
        });
        const pre = el("pre", { className: "cp-pre", tabindex: "0", text: cmds });
        actions.appendChild(button("Copy commands", (ev) => copyText(cmds, ev.currentTarget)));
        box.append(pre, actions);
        setStatus(text, true);
        box.scrollIntoView({ block: "nearest" });
        return;
      }
      case "private_to_public": {
        const pub = (d.publicRepos || []).join(" and ") || "the target";
        text = `${d.source || "The source repo"} is private, but ${pub} is public. ` +
          "The picked files become public, even if you do not create the pull request.";
        actions.appendChild(button("Pick anyway (make these changes public)", () => {
          runPick(Object.assign({}, request, { allowPublic: true }));
        }));
        break;
      }
      case "merge_commit":
        text = `Commit ${short} is a merge commit. Merge commits cannot be cherry-picked here.`;
        break;
      case "workflow_file":
        text = `Commit ${short} changes ${d.path || "a workflow file"}. The token cannot change workflow files.`;
        break;
      case "too_many_files":
        text = `Commit ${short} changes ${d.count != null ? d.count : "too many"} files. The limit is ${d.max || request.maxFiles}. You can change it in Settings.`;
        actions.appendChild(button("Settings", () => send({ type: "openOptions" })));
        break;
      case "branch_exists":
        text = `Branch ${request.branch} (and its numbered variants) already exists. Use a different name.`;
        break;
      case "target_branch_missing":
        text = `Branch ${request.target.branch} does not exist in ${request.target.owner}/${request.target.repo}.`;
        break;
      case "not_found":
        text = `${error.message && d.sha ? error.message : "Repository, branch or commit not found."} Check the target and your access.`;
        // GitHub answers 404, not 403, for a private repo the token cannot read.
        if (st.publicOnly) text += " Your login has access to public repos only. For private repos, select \"Public and private repositories\" in the settings and log in again.";
        break;
      case "rate_limited":
        text = "GitHub API rate limit reached. Wait a few minutes, then try again.";
        break;
      case "bad_branch_name":
        text = "The branch name is not valid.";
        break;
      default:
        text = error.message || "Cherry-pick failed.";
    }
    setStatus(text, true);
    if (actions.childNodes.length) box.appendChild(actions);
    box.scrollIntoView({ block: "nearest" });
    if (error.code === "branch_exists" || error.code === "bad_branch_name") $("#cp-branch").focus();
  }

  // Links to anything but https pages on this GitHub host show as plain text.
  function link(href, text) {
    let ok = false;
    try {
      const u = new URL(href);
      ok = u.protocol === "https:" && u.hostname === HOST;
    } catch (_) { /* Not a URL. */ }
    if (!ok) return el("span", { text });
    return el("a", { href, target: "_blank", rel: "noopener noreferrer", className: "cp-link", text });
  }

  function button(text, onClick, primary) {
    const b = el("button", { type: "button", className: primary ? "cp-btn cp-btn-primary" : "cp-btn", text });
    b.addEventListener("click", onClick);
    return b;
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch (_) {
      // Clipboard API not allowed. Select the text so the user can copy it.
      const pre = btn.closest(".cp-result").querySelector(".cp-pre");
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      btn.textContent = "Press Ctrl+C";
    }
  }

  function setStatus(text, isError) {
    const node = $(".cp-status");
    node.textContent = text || "";
    node.classList.toggle("cp-error", !!isError);
  }

  // ---- Extension APIs ----

  async function send(msg) {
    try {
      const res = await chrome.runtime.sendMessage(msg);
      if (!res) return { ok: false, error: { code: "no_response", message: "No response from the extension." } };
      return res;
    } catch (err) {
      return { ok: false, error: { code: "context", message: contextError(err) } };
    }
  }

  function contextError(err) {
    const m = String((err && err.message) || err);
    return /context invalidated|Extension context/i.test(m)
      ? "The extension was updated. Reload the page."
      : m;
  }

  function loadSettings() {
    const defaults = { trailer: true, maxFiles: L.DEFAULT_MAX_FILES };
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get("settings", (out) => {
          const s = (out && out.settings) || {};
          resolve({
            trailer: typeof s.trailer === "boolean" ? s.trailer : defaults.trailer,
            maxFiles: Number(s.maxFiles) > 0 ? Number(s.maxFiles) : defaults.maxFiles
          });
        });
      } catch (_) {
        resolve(defaults);
      }
    });
  }

  // After the user logs in on another tab, check the session again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !dlg || !dlg.open || st.running) return;
    if (!dlg.querySelector(".cp-login").hidden && st.ctx) openDialog(st.ctx);
  });

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("turbo:load", schedule);
  window.addEventListener("popstate", schedule);
  ensureUi();
})();
