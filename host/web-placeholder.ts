/**
 * The placeholder shell page and its tiny client script for `1667 web`, step
 * 1 of the web UI (#409). The shell carries no project data of its own — the
 * client script proves it holds the token before it asks `/api/status` for
 * that. Step 3 replaces both with a Vite-built app; keeping them apart from
 * the HTTP transport in `host/web-server.ts` means that step can delete this
 * file wholesale.
 */

export const WEB_SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>1667</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 3rem auto;
    max-width: 34rem;
    padding: 0 1rem;
    font-family: system-ui, sans-serif;
    line-height: 1.5;
    color: #1a1a1a;
    background: #ffffff;
  }
  code { font-family: ui-monospace, monospace; }
  @media (prefers-color-scheme: dark) {
    body { color: #e8e8e8; background: #14161a; }
  }
</style>
</head>
<body>
<div id="status">Loading…</div>
<script src="/app.js"></script>
</body>
</html>
`;

export const WEB_APP_JS = `"use strict";
(function () {
  var statusEl = document.getElementById("status");

  function showLocked() {
    statusEl.textContent =
      "Open the address that 1667 web printed in the terminal.";
  }

  function showStatus(body) {
    statusEl.textContent = "";
    var heading = document.createElement("h1");
    heading.textContent = "1667 web";
    var project = document.createElement("p");
    project.textContent = "Project: " + body.project;
    var version = document.createElement("p");
    version.textContent = "Version: " + body.version;
    statusEl.appendChild(heading);
    statusEl.appendChild(project);
    statusEl.appendChild(version);
  }

  function readToken() {
    var fromHash = new URLSearchParams(location.hash.replace(/^#/, "")).get("token");
    if (fromHash !== null) {
      try { sessionStorage.setItem("1667.web.token", fromHash); } catch (error) {}
      history.replaceState(null, "", location.pathname + location.search);
      return fromHash;
    }
    try { return sessionStorage.getItem("1667.web.token"); } catch (error) { return null; }
  }

  var token = readToken();
  if (token === null) {
    showLocked();
  } else {
    fetch("/api/status", { headers: { authorization: "Bearer " + token } })
      .then(function (response) {
        if (response.status === 401) { showLocked(); return null; }
        if (!response.ok) throw new Error("1667 web: status " + response.status);
        return response.json();
      })
      .then(function (body) { if (body !== null) showStatus(body); })
      .catch(showLocked);
  }
})();
`;
