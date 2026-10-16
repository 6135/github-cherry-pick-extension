"use strict";

// Settings page: hosts, client IDs, scopes, login state, and cherry-pick settings.
const L = globalThis.CpLib;
const A = globalThis.CpAuth;
const H = globalThis.CpHosts;
const $ = (id) => document.getElementById(id);

// Unsaved edits per host: { clientId, scope }. A new render keeps them.
const drafts = {};
// Host sections by host name. A new render updates them in place, so the focus stays.
const sections = new Map();
let renderSeq = 0;

function setStatus(el, text, kind) {
  el.textContent = text;
  el.classList.toggle("error", kind === "error");
  el.classList.toggle("ok", kind === "ok");
}

function errText(err) {
  return String((err && err.message) || err);
}

function sync() {
  return H.syncContentScripts().catch((err) => console.error(err));
}

function hasOriginAccess(host) {
  return chrome.permissions.contains({ origins: [H.originPattern(host)] }).catch(() => false);
}

// ---- Hosts ----

async function render() {
  const seq = ++renderSeq;
  const hosts = await A.listHosts();
  const configs = await Promise.all(hosts.map((h) => A.getHostConfig(h)));
  const access = await Promise.all(hosts.map((h) => (L.isDotCom(h) ? true : hasOriginAccess(h))));
  if (seq !== renderSeq) return; // A newer render started.

  const box = $("hosts");
  for (const [host, el] of sections) {
    if (!hosts.includes(host)) {
      el.remove();
      sections.delete(host);
      delete drafts[host];
    }
  }
  configs.forEach((cfg, i) => {
    if (!cfg) return;
    let el = sections.get(cfg.host);
    if (!el) {
      el = createSection(cfg.host);
      sections.set(cfg.host, el);
    }
    box.appendChild(el); // Keeps the list order.
    updateSection(el, cfg, access[i]);
  });
}

function createSection(host) {
  const el = $("hostTemplate").content.firstElementChild.cloneNode(true);
  el.dataset.host = host;
  const q = (sel) => el.querySelector(sel);
  const dotcom = L.isDotCom(host);
  const web = L.webBase(host);

  q(".name").textContent = host;
  q(".remove").hidden = dotcom;
  q(".reset").hidden = !dotcom;
  q(".revoke").href = `${web}/settings/applications`;
  q(".newApp").href = `${web}/settings/applications/new`;
  q(".clientId").placeholder = dotcom ? "Client ID" : "Required. Example: Ov23li…";
  el.querySelectorAll(".scope").forEach((r) => { r.name = `scope-${host}`; });

  // Shows a "Grant access" line for a GHES host without permission.
  const grant = document.createElement("p");
  grant.className = "warn grant";
  grant.hidden = true;
  grant.append(`The extension has no access to ${host}. `);
  const grantBtn = document.createElement("button");
  grantBtn.type = "button";
  grantBtn.textContent = "Grant access";
  grant.appendChild(grantBtn);
  q(".host-head").after(grant);

  q(".clientId").addEventListener("input", () => onEdit(el));
  el.querySelectorAll(".scope").forEach((r) => r.addEventListener("change", () => onEdit(el)));
  q(".reset").addEventListener("click", () => {
    q(".clientId").value = el._cfg.defaultClientId;
    onEdit(el);
  });
  q(".save").addEventListener("click", () => onSave(el));
  q(".login").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`src/login.html?host=${encodeURIComponent(host)}`) });
  });
  q(".logout").addEventListener("click", async () => {
    try {
      await A.clearSession(host);
      setStatus(q(".saveStatus"), "Logged out. The token is deleted from this browser.", "ok");
    } catch (err) {
      setStatus(q(".saveStatus"), errText(err), "error");
    }
  });
  grantBtn.addEventListener("click", () => {
    // Call request() first, with no await before it. Firefox needs a direct user action.
    chrome.permissions.request({ origins: [H.originPattern(host)] }).then(async (ok) => {
      if (ok) await sync();
      await render();
    }, (err) => setStatus(q(".saveStatus"), errText(err), "error"));
  });
  q(".remove").addEventListener("click", (e) => onRemove(el, e.currentTarget));
  return el;
}

function readForm(el) {
  const checked = el.querySelector(".scope:checked");
  return { clientId: el.querySelector(".clientId").value.trim(), scope: checked ? checked.value : L.SCOPES.public };
}

function isDirty(cfg, form) {
  return form.clientId !== cfg.clientId || form.scope !== cfg.scope;
}

function onEdit(el) {
  const form = readForm(el);
  if (isDirty(el._cfg, form)) drafts[el._cfg.host] = form;
  else delete drafts[el._cfg.host];
  setStatus(el.querySelector(".saveStatus"), "", "");
  updateSection(el, el._cfg, el._access);
}

function updateSection(el, cfg, access) {
  el._cfg = cfg;
  el._access = access;
  const q = (sel) => el.querySelector(sel);
  const draft = drafts[cfg.host];
  const form = draft || { clientId: cfg.clientId, scope: cfg.scope };
  const dotcom = L.isDotCom(cfg.host);

  const input = q(".clientId");
  if (input.value !== form.clientId && document.activeElement !== input) input.value = form.clientId;
  el.querySelectorAll(".scope").forEach((r) => { r.checked = r.value === form.scope; });
  q(".repoWarn").hidden = form.scope !== L.SCOPES.private;
  q(".grant").hidden = access;

  const clientIdChanged = form.clientId !== cfg.clientId;
  const missing = !form.clientId && !(dotcom && cfg.defaultClientId);
  input.setAttribute("aria-invalid", String(!dotcom && missing));
  q(".reset").disabled = form.clientId === cfg.defaultClientId;
  q(".clientHint").textContent = dotcom
    ? (cfg.defaultClientId
      ? "The extension has a default OAuth App for github.com. You can use your own app instead."
      : "This version of the extension has no default OAuth App. Add the client ID of your own app.")
    : "Required. Register an OAuth App on this host (see \"Use your own OAuth App\" below).";

  q(".save").disabled = !draft;
  q(".saveHint").textContent = clientIdChanged && cfg.loggedIn
    ? "A new client ID logs you out of this host."
    : draft && form.scope !== cfg.scope && cfg.loggedIn ? "After you save, log in again to get the new access." : "";

  const session = q(".session");
  session.replaceChildren();
  if (cfg.loggedIn) {
    const strong = document.createElement("strong");
    strong.textContent = cfg.login || "unknown user";
    const scopes = cfg.scopes && cfg.scopes.length ? cfg.scopes.join(", ") : "none";
    session.append("Logged in as ", strong, `. Token access: ${scopes}.`);
    if (!hasScope(cfg.scopes, cfg.scope)) {
      const w = document.createElement("span");
      w.className = "error";
      w.textContent = " The token does not have the access you selected. Log in again.";
      session.appendChild(w);
    }
  } else {
    session.textContent = "Not logged in.";
  }
  q(".login").textContent = cfg.loggedIn ? "Log in again" : "Log in";
  q(".login").disabled = !cfg.clientId || !access;
  q(".login").title = !cfg.clientId ? "Save a client ID first." : !access ? "Grant access to the host first." : "";
  q(".logout").disabled = !cfg.loggedIn;
}

// "repo" includes "public_repo".
function hasScope(scopes, want) {
  const list = scopes || [];
  return list.includes(want) || (want === L.SCOPES.public && list.includes(L.SCOPES.private));
}

async function onSave(el) {
  const cfg = el._cfg;
  const form = readForm(el);
  const status = el.querySelector(".saveStatus");
  if (!form.clientId && !L.isDotCom(cfg.host)) {
    setStatus(status, "Enter a client ID.", "error");
    return;
  }
  try {
    const { loggedOut } = await A.saveHostConfig(cfg.host, form);
    delete drafts[cfg.host];
    setStatus(status, loggedOut ? "Saved. You are logged out, because the client ID changed." : "Saved.", "ok");
  } catch (err) {
    setStatus(status, errText(err), "error");
  }
  await render();
}

async function onRemove(el, btn) {
  // Two clicks to remove. confirm() is not reliable in all extension pages.
  if (!btn.dataset.armed) {
    btn.dataset.armed = "1";
    btn.textContent = "Click again to remove";
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = "Remove host"; }, 4000);
    return;
  }
  const host = el._cfg.host;
  try {
    await A.removeHost(host);
    await chrome.permissions.remove({ origins: [H.originPattern(host)] }).catch(() => false);
    await sync();
    setStatus($("addStatus"), `Removed ${host}.`, "ok");
  } catch (err) {
    setStatus($("addStatus"), errText(err), "error");
  }
  await render();
}

$("addHost").addEventListener("click", () => {
  const status = $("addStatus");
  const host = L.normalizeHost($("newHost").value);
  if (!host) return setStatus(status, "Enter a valid host name, for example github.example.com.", "error");
  if (L.isDotCom(host)) return setStatus(status, "github.com is already in the list.", "error");
  // Call request() first, with no await before it. Firefox needs a direct user action.
  chrome.permissions.request({ origins: [H.originPattern(host)] }).then(async (granted) => {
    if (!granted) {
      setStatus(status, `Access to ${host} was not granted. The host was not added.`, "error");
      return;
    }
    await A.addHost(host);
    await sync();
    $("newHost").value = "";
    setStatus(status, `Added ${host}. Now add the client ID of an OAuth App on that host, and save.`, "ok");
    await render();
    const el = sections.get(host);
    if (el) el.querySelector(".clientId").focus();
  }).catch((err) => setStatus(status, errText(err), "error"));
});

$("newHost").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("addHost").click();
});

// ---- Cherry-pick settings ----

async function renderSettings() {
  const s = await A.getSettings();
  $("trailer").checked = s.trailer;
  if (document.activeElement !== $("maxFiles")) $("maxFiles").value = String(s.maxFiles);
}

$("trailer").addEventListener("change", () => saveSettings({ trailer: $("trailer").checked }));
$("maxFiles").addEventListener("change", () => {
  const n = Number($("maxFiles").value);
  if (!Number.isInteger(n) || n < 1 || n > 3000) {
    setStatus($("settingsStatus"), "Enter a whole number from 1 to 3000.", "error");
    return;
  }
  saveSettings({ maxFiles: n });
});

async function saveSettings(partial) {
  try {
    await A.saveSettings(partial);
    setStatus($("settingsStatus"), "Saved.", "ok");
  } catch (err) {
    setStatus($("settingsStatus"), errText(err), "error");
  }
}

// ---- Start ----

// A login in another tab changes storage. Show it here.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.hosts) render().catch(console.error);
  if (changes.settings) renderSettings().catch(console.error);
});
if (chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(() => render().catch(console.error));
if (chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(() => render().catch(console.error));

render().catch((err) => setStatus($("addStatus"), errText(err), "error"));
renderSettings().catch((err) => setStatus($("settingsStatus"), errText(err), "error"));
