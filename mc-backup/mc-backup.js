// mc-backup.js
// Run this from moneycontrol.com's own console (or via the "Backup MC Layout" bookmarklet,
// which is this exact script minified into a javascript: link).
//
// What it does:
// 1. Reads ALL of moneycontrol.com's localStorage (not just guessed key names — safer than
//    trying to filter for "the chart layout keys" specifically, since we don't know their
//    exact naming and missing one would silently produce an incomplete backup).
// 2. Downloads it as a local .json file (always — independent of GitHub, a safety net on
//    its own even if the GitHub push below fails for any reason).
// 3. Pushes the same data to a GitHub repo, using a personal access token.
//
// GitHub config (token / repo / path) is asked for once via prompt(), then cached in
// moneycontrol.com's own localStorage under a clearly private key so you're not retyping
// your token every single time — only asked again if that saved config is ever missing.

(function () {
  var CONFIG_KEY = '__portfolioTool_mcBackup_ghConfig';

  function loadConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveConfig(cfg) {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) {}
  }
  function ensureConfig() {
    var cfg = loadConfig();
    if (cfg.token && cfg.repo && cfg.path) return cfg; // fast path — no prompts needed
    var token = prompt('GitHub personal access token:', cfg.token || '');
    if (token === null) return null;
    var repo = prompt('Repo (owner/name), e.g. yourname/live-charts:', cfg.repo || '');
    if (repo === null) return null;
    var path = prompt('File path in repo:', cfg.path || 'mc-backup/mc-layout-backup.json');
    if (path === null) return null;
    cfg = { token: token.trim(), repo: repo.trim(), path: (path.trim() || 'mc-backup/mc-layout-backup.json') };
    saveConfig(cfg);
    return cfg;
  }

  var cfg = ensureConfig();
  if (!cfg) return; // user cancelled

  // 1. Snapshot everything in localStorage except our own private config key.
  var snapshot = {};
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k === CONFIG_KEY) continue;
    snapshot[k] = localStorage.getItem(k);
  }
  var payload = JSON.stringify({
    savedAt: new Date().toISOString(),
    origin: location.origin,
    data: snapshot
  }, null, 2);

  // 2. Always download a local copy too — belt and braces, works even if GitHub is unreachable.
  var blob = new Blob([payload], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'mc-backup-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  // 3. Push to GitHub (create or update the file — needs the current sha if it already exists).
  var apiUrl = 'https://api.github.com/repos/' + cfg.repo + '/contents/' + cfg.path;
  fetch(apiUrl, { headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/vnd.github+json' } })
    .then(function (r) { return r.status === 200 ? r.json() : null; })
    .then(function (existing) {
      var body = {
        message: 'MC layout backup ' + new Date().toISOString(),
        content: btoa(unescape(encodeURIComponent(payload)))
      };
      if (existing && existing.sha) body.sha = existing.sha;
      return fetch(apiUrl, {
        method: 'PUT',
        headers: {
          'Authorization': 'Bearer ' + cfg.token,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
    })
    .then(function (res) {
      if (res.ok) {
        alert('Backed up: pushed to GitHub and downloaded locally.');
      } else {
        return res.text().then(function (t) {
          alert('Local file downloaded OK, but GitHub push failed (' + res.status + '). ' + t);
        });
      }
    })
    .catch(function (e) {
      alert('Local file downloaded OK, but GitHub push errored: ' + e.message);
    });
})();
