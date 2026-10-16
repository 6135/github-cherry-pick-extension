"use strict";

// Login page: src/login.html?host=<host>. Runs the OAuth device flow.
// The page polls by itself. The MV3 background worker can stop at any time.
const L = globalThis.CpLib;
const A = globalThis.CpAuth;
const $ = (id) => document.getElementById(id);

const host = L.normalizeHost(new URLSearchParams(location.search).get("host") || "github.com");
let controller = null;
let device = null;

// Codes that the user fixes in the settings, not with "Try again".
const SETTINGS_ERRORS = new Set(["no_client_id", "incorrect_client_credentials", "device_flow_disabled",
  "unauthorized_client", "http_404", "unknown_host"]);

function setStatus(text, kind) {
  $("status").textContent = text;
  $("status").classList.toggle("error", kind === "error");
  $("status").classList.toggle("ok", kind === "ok");
}

function show(id) {
  for (const x of ["noClient", "noAccess", "flow"]) $(x).hidden = x !== id;
}

function openOptions(e) {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
}
$("openOptions").addEventListener("click", openOptions);
$("settingsLink").addEventListener("click", openOptions);

// github.com also needs api.github.com for the /user call.
function origins() {
  return L.isDotCom(host) ? ["https://github.com/*", "https://api.github.com/*"] : [`https://${host}/*`];
}

async function start() {
  if (controller) controller.abort();
  controller = new AbortController();
  const signal = controller.signal;
  device = null;
  $("retry").hidden = true;
  $("settingsLink").hidden = true;
  setStatus("", "");

  if (!host) {
    show(null);
    return fail({ message: "The host in the address is not valid." });
  }
  $("title").textContent = `Log in to ${host}`;
  document.title = `Log in to ${host} - Cherry-Pick`;

  const cfg = await A.getHostConfig(host);
  if (!cfg) {
    show(null);
    return fail({ code: "unknown_host", message: `${host} is not in the settings. Add it on the settings page first.` });
  }
  if (!cfg.clientId) {
    show("noClient");
    $("noClientText").textContent = L.isDotCom(host)
      ? "This version of the extension has no default OAuth App for github.com. Add the client ID of your own OAuth App in the settings, then log in again."
      : `${host} has no client ID. Register an OAuth App on ${host}, add its client ID in the settings, then log in again.`;
    return;
  }
  if (!(await chrome.permissions.contains({ origins: origins() }).catch(() => false))) {
    show("noAccess");
    $("noAccessText").textContent = `The extension has no access to ${host}. It needs access to log in.`;
    return;
  }

  show("flow");
  $("code").textContent = "…";
  $("copyOpen").disabled = true;
  $("uriHint").textContent = "";
  setStatus("Asking GitHub for a login code…", "");
  try {
    device = await A.requestDeviceCode({ host, clientId: cfg.clientId, scope: cfg.scope, signal });
    $("code").textContent = device.user_code;
    $("copyOpen").disabled = false;
    $("uriHint").textContent = `GitHub page: ${device.verification_uri}`;
    const until = new Date(Date.now() + device.expires_in * 1000);
    setStatus(`Waiting for you to approve on GitHub. The code works until ${until.toLocaleTimeString()}.`, "");

    const token = await A.pollForToken({
      host, clientId: cfg.clientId, deviceCode: device.device_code,
      interval: device.interval, expiresIn: device.expires_in, signal
    });
    setStatus("Approved. Getting your account name…", "");
    const user = await A.fetchUser({ host, token: token.access_token, signal });

    // The client ID can change in the settings while this page waits.
    const now = await A.getHostConfig(host);
    if (!now || now.clientId !== cfg.clientId) {
      throw Object.assign(new Error("The client ID changed in the settings during the login. Try again."), { code: "client_changed" });
    }
    await A.setSession(host, {
      token: token.access_token,
      login: user.login,
      scopes: user.scopes || A.parseScopes(token.scope)
    });
    show(null);
    setStatus(`Logged in as ${user.login}. You can close this tab.`, "ok");
  } catch (err) {
    if (signal.aborted) return;
    fail(err);
  }
}

function fail(err) {
  // Keep the code on screen only when GitHub sent one.
  if (device) $("copyOpen").disabled = true;
  else if (!$("flow").hidden) show(null);
  setStatus(String((err && err.message) || err), "error");
  $("retry").hidden = !host || (err && err.code === "unknown_host");
  $("settingsLink").hidden = !(err && SETTINGS_ERRORS.has(err.code));
}

$("copyOpen").addEventListener("click", async () => {
  if (!device) return;
  try {
    await navigator.clipboard.writeText(device.user_code);
  } catch (_) {
    // Copy failed. Select the code, so the user can copy it by hand.
    const range = document.createRange();
    range.selectNodeContents($("code"));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }
  chrome.tabs.create({ url: device.verification_uri });
});

$("retry").addEventListener("click", () => start());

$("grant").addEventListener("click", () => {
  // Call request() first, with no await before it. Firefox needs a direct user action.
  chrome.permissions.request({ origins: origins() }).then((ok) => {
    if (ok) start();
    else setStatus("Access was not granted.", "error");
  }, (err) => setStatus(String(err.message || err), "error"));
});

window.addEventListener("pagehide", () => { if (controller) controller.abort(); });

start().catch(fail);
