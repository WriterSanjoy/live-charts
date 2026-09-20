// mc-restore.js
// Run this from moneycontrol.com's own console (or via the "Restore MC Layout" bookmarklet).
//
// Pulls the backup JSON from GitHub and writes every key back into moneycontrol.com's
// localStorage, overwriting whatever's currently there. Reloads the page afterward so the
// restored layout actually takes effect.

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
    if (cfg.token && cfg.repo && cfg.path) return cfg;
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
  if (!cfg) return;

  if (!confirm('This will OVERWRITE your current Moneycontrol local data with the GitHub backup. Continue?')) return;

  var apiUrl = 'https://api.github.com/repos/' + cfg.repo + '/contents/' + cfg.path;
  fetch(apiUrl, { headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/vnd.github+json' } })
    .then(function (r) {
      if (!r.ok) throw new Error('GitHub responded ' + r.status);
      return r.json();
    })
    .then(function (fileObj) {
      var payload = JSON.parse(decodeURIComponent(escape(atob(fileObj.content))));
      var data = payload.data || {};
      var restored = 0;
      Object.keys(data).forEach(function (k) {
        if (k === CONFIG_KEY) return; // never overwrite our own config with backup contents
        localStorage.setItem(k, data[k]);
        restored++;
      });
      alert('Restored ' + restored + ' item(s) from backup dated ' + (payload.savedAt || 'unknown') + '.\nReloading the page now...');
      location.reload();
    })
    .catch(function (e) {
      alert('Restore failed: ' + e.message);
    });
})();
