// The last page of the Procore connect popup. Tells the app's tab how it went,
// then closes. A file rather than inline script because the CSP allows none.
//
// ⚠️ It cannot rely on window.opener. Procore's login page sends a
// Cross-Origin-Opener-Policy that permanently severs the popup from the tab that
// opened it, so by the time this page loads back on our origin, window.opener is
// null. The first version depended on it: the result never reached the tab, and
// its fallback loaded the whole app INSIDE the popup instead (2026-10-14).
//
// So the result goes out on every same-origin channel there is. BroadcastChannel
// and localStorage reach any tab of this site in this browser, whatever the
// opener relationship. The tab also re-checks /api/me when it regains focus,
// which covers the case where every message is lost.
(function () {
  const ok = document.body.dataset.ok === 'true';
  const message = document.body.dataset.message || '';
  const result = { type: 'procore-connect', ok, message, at: Date.now() };

  try {
    new BroadcastChannel('procore-connect').postMessage(result);
  } catch {
    // Not supported: localStorage below still carries it.
  }
  try {
    localStorage.setItem('procore-connect-result', JSON.stringify(result));
  } catch {
    // Storage blocked: the tab's focus re-check still finds the connection.
  }
  try {
    if (window.opener && !window.opener.closed) window.opener.postMessage(result, location.origin);
  } catch {
    // Severed or cross-origin: the channels above have it.
  }

  // A full-page sign-in (the popup was blocked and there was nothing to lose)
  // has no other tab to return to, so it goes back to the app itself. The app
  // leaves this flag only on that path.
  let fullPage = false;
  try {
    fullPage = localStorage.getItem('procore-connect-mode') === 'page';
    if (fullPage) localStorage.removeItem('procore-connect-mode');
  } catch {
    // No storage: treat it as the popup it almost always is.
  }
  if (fullPage) {
    if (ok) setTimeout(() => location.replace('/'), 800);
    return;
  }

  if (ok) {
    window.close();
    // Some browsers refuse to close a window whose opener was severed. Say so
    // rather than leaving a page that looks finished but is not the app.
    setTimeout(() => {
      const p = document.createElement('p');
      p.innerHTML = '<strong>You can close this window</strong> and go back to Punch List Assistant.';
      document.body.appendChild(p);
    }, 400);
  }
})();
