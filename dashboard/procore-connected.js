// The last page of the Procore connect popup. Tells the app's tab how it went,
// then closes. A file rather than inline script because the CSP allows none.
(function () {
  const ok = document.body.dataset.ok === 'true';
  const message = document.body.dataset.message || '';
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage({ type: 'procore-connect', ok, message }, location.origin);
    if (ok) window.close();
  } else if (ok) {
    // Opened without a popup (blocked, or a direct link): go back to the app.
    setTimeout(() => location.replace('/'), 1200);
  }
})();
