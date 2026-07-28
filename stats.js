// Lignes de jour dépliables du tableau des prévisions.
(function () {
  var boutons = document.querySelectorAll('.day-toggle');
  Array.prototype.forEach.call(boutons, function (btn) {
    btn.addEventListener('click', function () {
      var cible = document.getElementById(btn.getAttribute('aria-controls'));
      if (!cible) return;
      var ouvert = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', ouvert ? 'false' : 'true');
      if (ouvert) { cible.setAttribute('hidden', ''); }
      else { cible.removeAttribute('hidden'); }
    });
  });
})();

// Compteur de visites : signale la présence du visiteur et affiche
// les totaux dans le petit panneau discret en bas à droite.
(function () {
  var KEY = 'fg_vid';
  var id = localStorage.getItem(KEY);
  if (!id) {
    id = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'v' + Date.now() + Math.random().toString(16).slice(2);
    localStorage.setItem(KEY, id);
  }

  function ping() {
    fetch('/api/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id }),
    }).catch(function () {});
  }
  ping();
  setInterval(ping, 40000);

  var btn = document.getElementById('fg-stats-btn');
  var panel = document.getElementById('fg-stats-panel');
  if (!btn || !panel) return;

  var poll = null;
  function fmt(n) {
    return (n === null || n === undefined) ? '—' : n.toLocaleString('fr-FR');
  }
  function refresh() {
    fetch('/api/stats')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        document.getElementById('fg-s-live').textContent = fmt(d.live);
        document.getElementById('fg-s-24h').textContent = fmt(d.last24h);
        document.getElementById('fg-s-7d').textContent = fmt(d.last7d);
        document.getElementById('fg-s-all').textContent = fmt(d.allTime);
      })
      .catch(function () {});
  }

  btn.addEventListener('click', function () {
    if (panel.hasAttribute('hidden')) {
      panel.removeAttribute('hidden');
      refresh();
      poll = setInterval(refresh, 10000);
    } else {
      panel.setAttribute('hidden', '');
      if (poll) { clearInterval(poll); poll = null; }
    }
  });
})();
