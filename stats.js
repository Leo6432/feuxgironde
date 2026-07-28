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

// Données météo à jour : si /api/meteo répond, on remplace les scores
// figés du tableau par ceux recalculés sur le dernier run Open-Meteo,
// avec la CAPE réelle. En cas d'échec le tableau statique reste en place :
// c'est un enrichissement, jamais une dépendance.
(function () {
  // Le tableau des prévisions est le seul à porter des lignes datées.
  var table = document.querySelector('table tr[data-date]') &&
              document.querySelector('table tr[data-date]').closest('table');
  if (!table) return;

  function niveau(s) { return s >= 75 ? 'hi' : (s >= 55 ? 'mid' : 'lo'); }

  function poser(el, score) {
    if (!el) return;
    el.textContent = score;
    el.classList.remove('lvl-lo', 'lvl-mid', 'lvl-hi');
    el.classList.add('lvl-' + niveau(score));
  }

  // Un orage de feu obéit à un effet de seuil, pas à une progression
  // proportionnelle : sous un certain niveau de conditions, il ne se forme
  // tout simplement pas. Les deux journées qui en ont produit un notent
  // ~73 et ~79 sur l'échelle de difficulté ; le dimanche pluvieux, qui n'a
  // rien donné, note ~36. D'où une courbe en S centrée sur 72.
  function seuilMeteo(score) {
    return 1 / (1 + Math.exp(-(score - 72) / 6));
  }

  // Reste la seconde condition : que le feu dégage assez d'énergie pour
  // amorcer la colonne convective. FIRMS la mesure (somme des puissances
  // radiatives du front). Un front éteint ne produit pas de pyrocumulonimbus,
  // même par 41 °C. Le plafond à 0,85 laisse la part d'incertitude qu'aucune
  // de ces deux mesures ne couvre.
  function coefActivite(frpTotal) {
    var activite = Math.max(0, Math.min(100, (frpTotal / 300) * 100));
    return 0.40 + 0.0045 * activite;
  }

  function poserRisque(tr, pct) {
    var bloc = tr && tr.querySelector('.js-risk');
    if (!bloc) return;
    var barre = bloc.querySelector('.bar i');
    var texte = bloc.querySelector('span');
    var n = niveau(pct);
    if (barre) {
      barre.style.width = pct + '%';
      barre.classList.remove('lo', 'mid', 'hi');
      barre.classList.add(n);
    }
    if (texte) {
      texte.textContent = pct + ' %';
      texte.classList.remove('lvl-lo', 'lvl-mid', 'lvl-hi');
      texte.classList.add('lvl-' + n);
    }
  }

  // FIRMS est facultatif : s'il ne répond pas, les scores météo sont quand
  // même appliqués et les pourcentages de risque restent ceux du HTML.
  var activite = fetch('/api/firms')
    .then(function (r) { return r.json(); })
    .then(function (d) { return (d && d.ok && isFinite(d.frpTotal)) ? d : null; })
    .catch(function () { return null; });

  Promise.all([
    fetch('/api/meteo').then(function (r) { return r.json(); }),
    activite,
  ])
    .then(function (res) {
      var d = res[0];
      var feu = res[1];
      if (!d || !d.ok || !Array.isArray(d.jours)) return;
      var maj = 0;

      d.jours.forEach(function (j) {
        var tr = table.querySelector('tr[data-date="' + j.date + '"]');
        var ligne = tr && tr.querySelector('.js-diff');
        if (ligne) { poser(ligne, j.score); maj++; }

        // Le risque combine le score météo du jour et l'activité mesurée du
        // feu aujourd'hui. Pour les jours à venir, cela revient à supposer
        // que le front reste aussi actif qu'à la dernière mesure — c'est une
        // hypothèse, pas une prévision de l'activité du feu.
        if (tr && feu) {
          poserRisque(tr, Math.round(seuilMeteo(j.score) * coefActivite(feu.frpTotal) * 100));
        }

        // Les colonnes météo affichées suivent aussi le dernier run : sans
        // ça le tableau montrerait des relevés figés à côté d'un score frais.
        if (tr && j.periodes && j.periodes.length) {
          var tMax = Math.max.apply(null, j.periodes.map(function (p) { return p.t; }));
          var hMin = Math.min.apply(null, j.periodes.map(function (p) { return p.hum; }));
          var gMax = Math.max.apply(null, j.periodes.map(function (p) { return p.raf; }));
          var cel = tr.querySelectorAll('td');
          if (cel[1]) cel[1].textContent = Math.round(tMax) + ' °C';
          if (cel[2]) cel[2].textContent = Math.round(hMin) + ' %';
          if (cel[3]) cel[3].textContent = Math.round(gMax) + ' km/h';
        }

        var detail = table.querySelector('tr.day-detail[data-date="' + j.date + '"]');
        if (!detail || !j.periodes) return;
        var cartes = detail.querySelectorAll('.periode');
        j.periodes.forEach(function (p, k) {
          var c = cartes[k];
          if (!c) return;
          poser(c.querySelector('.p-score'), p.score);
          var meta = c.querySelector('.p-meta');
          if (meta) meta.textContent = Math.round(p.t) + ' °C · ' + Math.round(p.hum) + ' % · ' + Math.round(p.raf) + ' km/h';
          var pic = c.querySelector('.p-pic');
          if (pic) pic.textContent = 'pic à ' + p.heure + 'h';
        });
      });

      if (!maj) return;
      var marque = document.getElementById('fg-live');
      if (marque) {
        marque.classList.remove('stale');
        // Open-Meteo ne publie pas l'heure du run : l'API détecte elle-même
        // le moment où les valeurs du modèle ont changé pour la dernière fois.
        var run = '';
        if (isFinite(d.actualise) && d.actualise) {
          var quand = new Date(d.actualise);
          run = ' · nouveau run détecté ' + quand.toLocaleDateString('fr-FR', {
            weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Paris',
          }) + ' vers ' + quand.toLocaleTimeString('fr-FR', {
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
          }).replace(':', 'h');
        }
        marque.textContent = 'Scores recalculés à l’instant — ' + d.source +
          ' · instabilité : ' + d.instabilite + run +
          (feu ? ' · activité du feu : ' + feu.frpTotal + ' MW mesurés par satellite.' : '.');
      }
    })
    .catch(function () { /* le tableau statique fait foi */ });
})();

// Foyers actifs (NASA FIRMS) : présent seulement sur l'accueil. Comme pour
// la météo, un échec laisse le message d'attente en place sans rien casser.
(function () {
  var note = document.getElementById('fg-firms');
  if (!note) return;

  fetch('/api/firms')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d || !d.ok) {
        note.textContent = 'Détections satellite indisponibles pour le moment.';
        return;
      }
      note.classList.remove('stale');
      note.textContent = d.total
        ? d.total + ' foyer' + (d.total > 1 ? 's' : '') + ' détecté' + (d.total > 1 ? 's' : '') + ' par ' + d.source + ', ' + d.fenetre + '.'
        : 'Aucun foyer actif détecté par ' + d.source + ' dans les ' + d.fenetre + '.';

      var resume = document.getElementById('fg-firms-summary');
      if (resume) resume.removeAttribute('hidden');
      var total = document.getElementById('fg-firms-total');
      if (total) total.textContent = d.total;
      var frp = document.getElementById('fg-firms-frp');
      if (frp) frp.textContent = d.frpMax ? Math.round(d.frpMax) + ' MW' : '—';
      var derniere = document.getElementById('fg-firms-derniere');
      if (derniere) {
        // derniereTs permet d'afficher l'heure française ; l'ancienne chaîne
        // UTC brute reste le repli si l'API ne l'envoie pas encore.
        if (isFinite(d.derniereTs) && d.derniereTs) {
          var quand = new Date(d.derniereTs);
          derniere.textContent = quand.toLocaleDateString('fr-FR', {
            day: 'numeric', month: 'short', timeZone: 'Europe/Paris',
          }) + ' · ' + quand.toLocaleTimeString('fr-FR', {
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
          }).replace(':', 'h');
        } else {
          derniere.textContent = d.derniereDetection || '—';
        }
      }
    })
    .catch(function () {
      note.textContent = 'Détections satellite indisponibles pour le moment.';
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
