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

  // fr-CA donne directement AAAA-MM-JJ, comparable aux data-date.
  var aujourdhui = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' })
    .format(new Date());

  // Recalcule l'intervalle de dates affiché au-dessus du tableau.
  function majKicker() {
    var restants = [];
    Array.prototype.forEach.call(
      table.querySelectorAll('tr[data-date]:not(.day-detail)'),
      function (tr) { restants.push(tr.getAttribute('data-date')); }
    );
    var kicker = document.querySelector('.page-head .kicker');
    if (!kicker || restants.length < 2) return;
    var libelle = function (date, avecMois) {
      var o = avecMois
        ? { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Paris' }
        : { weekday: 'long', day: 'numeric', timeZone: 'Europe/Paris' };
      return new Date(date + 'T12:00:00Z').toLocaleDateString('fr-FR', o);
    };
    var premier = restants[0], dernier = restants[restants.length - 1];
    var memeMois = premier.slice(0, 7) === dernier.slice(0, 7);
    kicker.textContent = 'Du ' + libelle(premier, !memeMois) + ' au ' + libelle(dernier, true);
  }

  // Déplie / replie le détail d'un jour — utilisé aussi par les lignes
  // créées dynamiquement, qui n'existaient pas au chargement.
  function brancherBascule(btn) {
    btn.addEventListener('click', function () {
      var cible = document.getElementById(btn.getAttribute('aria-controls'));
      if (!cible) return;
      var ouvert = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', ouvert ? 'false' : 'true');
      if (ouvert) { cible.setAttribute('hidden', ''); }
      else { cible.removeAttribute('hidden'); }
    });
  }

  // Bascule de journée automatique : les jours passés sortent du tableau,
  // l'étiquette « En cours » suit la date du jour et l'intervalle affiché en
  // tête se recale — sans édition manuelle à chaque minuit.
  (function () {
    Array.prototype.forEach.call(table.querySelectorAll('tr[data-date]'), function (tr) {
      if (tr.getAttribute('data-date') < aujourdhui) tr.parentNode.removeChild(tr);
    });

    Array.prototype.forEach.call(table.querySelectorAll('.tag'), function (tag) {
      if (tag.textContent === 'En cours') tag.parentNode.removeChild(tag);
    });
    majKicker();
  })();

  function niveau(s) { return s >= 75 ? 'hi' : (s >= 55 ? 'mid' : 'lo'); }

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

      // Extension automatique : toute journée entièrement couverte par un
      // modèle Météo-France (les quatre périodes présentes) et absente du
      // tableau y entre d'elle-même — le tableau suit l'horizon d'ARPEGE au
      // lieu de se vider à mesure que les jours passent.
      var tbody = table.querySelector('tbody');
      d.jours.forEach(function (j) {
        if (!tbody || j.date < aujourdhui) return;
        if (table.querySelector('tr[data-date="' + j.date + '"]')) return;
        if (j.modele !== 'AROME' && j.modele !== 'ARPEGE') return;
        if (!j.periodes || j.periodes.length < 4) return;

        var quand = new Date(j.date + 'T12:00:00Z');
        var jourCourt = quand
          .toLocaleDateString('fr-FR', { weekday: 'short', timeZone: 'Europe/Paris' })
          .replace('.', '');
        jourCourt = jourCourt.charAt(0).toUpperCase() + jourCourt.slice(1) + ' ' +
          quand.toLocaleDateString('fr-FR', { day: 'numeric', timeZone: 'Europe/Paris' });
        var idDetail = 'jour-' + j.date;

        var ligne = document.createElement('tr');
        ligne.setAttribute('data-date', j.date);
        ligne.innerHTML =
          '<td class="t-daytag" data-label="Jour">' +
            '<button class="day-toggle" type="button" aria-expanded="false" aria-controls="' + idDetail + '">' +
              '<span class="chev" aria-hidden="true"></span><b>' + jourCourt + '</b>' +
              '<span class="tag tag-blue">Prévision ' + j.modele + '</span>' +
            '</button></td>' +
          '<td class="num t-sub" data-label="T° max">—</td>' +
          '<td class="num t-sub" data-label="Humidité">—</td>' +
          '<td class="num t-sub" data-label="Rafales">—</td>' +
          '<td class="num lvl js-diff" data-label="Difficulté">—</td>' +
          '<td data-label="Risque d’orage de feu"><div class="risk js-risk"><div class="bar"><i style="width:0%"></i></div><span class="lvl">—</span></div></td>' +
          '<td class="t-note" data-label="Projection">—</td>';

        var detail = document.createElement('tr');
        detail.className = 'day-detail';
        detail.id = idDetail;
        detail.setAttribute('data-date', j.date);
        detail.setAttribute('hidden', '');
        detail.innerHTML = '<td colspan="7"><div class="periodes">' +
          j.periodes.map(function (p) {
            return '<div class="periode"><div class="p-lab">' + p.label + '</div>' +
              '<div class="p-score">—</div><div class="p-meta"></div><div class="p-pic"></div></div>';
          }).join('') + '</div></td>';

        // Insertion en ordre chronologique, le détail collé à sa journée.
        var avant = null;
        Array.prototype.forEach.call(
          tbody.querySelectorAll('tr[data-date]:not(.day-detail)'),
          function (tr) { if (!avant && tr.getAttribute('data-date') > j.date) avant = tr; }
        );
        tbody.insertBefore(ligne, avant);
        tbody.insertBefore(detail, avant);
        brancherBascule(ligne.querySelector('.day-toggle'));
      });
      majKicker();

      // Le score de difficulté (T°/humidité/rafales) est désormais saisi à
      // la main à partir des relevés Météociel : l'API Open-Meteo utilisée
      // ici a déjà affiché des valeurs qui ne correspondaient pas au run
      // réel. Seul le risque d'orage de feu reste automatique — il pondère
      // ce score manuel par l'activité du feu mesurée en direct par
      // satellite (FIRMS), qui elle ne peut pas être fournie à la main.
      var surface = parseInt(table.getAttribute('data-surface') || '', 10);
      var hauteCumulee = surface;
      var maj = 0;

      Array.prototype.forEach.call(table.querySelectorAll('tr[data-date]:not(.day-detail)'), function (tr) {
        var jDate = tr.getAttribute('data-date');
        var ligne = tr.querySelector('.js-diff');
        var score = ligne && parseInt(ligne.textContent, 10);
        if (!isFinite(score)) return;   // jour ajouté automatiquement, pas encore rempli à la main

        var pct = null;
        if (feu) {
          pct = Math.round(seuilMeteo(score) * coefActivite(feu.frpTotal) * 100);
          poserRisque(tr, pct);
          maj++;
        }

        // Projection automatique : borne basse, la surface confirmée (sans
        // nouvel orage de feu, le plateau tient) ; borne haute, le cumul —
        // jour après jour — du saut observé lors des deux orages de feu
        // (~10 000 ha) pondéré par le risque de chaque journée.
        if (isFinite(surface) && surface > 0) {
          if (pct !== null) hauteCumulee += Math.round(pct * 10000 / 100 / 1000) * 1000;
          var celProj = tr.querySelectorAll('td')[6];
          if (celProj) {
            if (jDate === aujourdhui) {
              celProj.textContent = surface.toLocaleString('fr-FR') + ' ha (dernier point préfecture)';
            } else if (pct !== null) {
              celProj.textContent = surface.toLocaleString('fr-FR') + ' – ' + hauteCumulee.toLocaleString('fr-FR') + ' ha';
            }
          }
        }
      });

      // Le run AROME/ARPEGE affiché sous le tableau est saisi à la main :
      // Open-Meteo l'a annoncé au moins une fois sans qu'il corresponde à ce
      // que montrait Météociel (03Z contre 06Z réel) — plus fiable de le
      // fixer soi-même que de le republier automatiquement.

      if (!maj) return;
      var marque = document.getElementById('fg-live');
      if (marque) {
        marque.classList.remove('stale');
        marque.textContent = 'Risque d’orage de feu recalculé à l’instant à partir de l’activité du feu mesurée par satellite. Les conditions météo restent celles du dernier relevé Météociel.';
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
