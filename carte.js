// Carte des foyers actifs (page /carte.html).
//
// Leaflet est chargé en `defer` juste avant ce fichier, mais rien ne garantit
// qu'il ait fini de s'exécuter : on attend explicitement `window.L` plutôt que
// de supposer l'ordre. Si Leaflet ne vient jamais (CDN bloqué, hors ligne), la
// page garde son message d'attente et les compteurs restent lisibles.

(function () {
  var conteneur = document.getElementById('fg-map');
  if (!conteneur) return;

  var note = document.getElementById('fg-carte-note');
  var SAUMOS = [44.98, -1.02];
  var JOURS = 7;

  function echec(message) {
    if (note) note.textContent = message;
  }

  // Rouge vif pour un foyer puissant, ambre pour un foyer faible : la même
  // échelle que la légende affichée sous la carte.
  function couleur(frp) {
    if (frp >= 30) return '#CE1B26';
    if (frp >= 10) return '#E8761B';
    return '#EBA92B';
  }

  function rayon(frp) {
    return Math.max(6, Math.min(20, 6 + Math.sqrt(frp || 0) * 2));
  }

  function jourFr(iso) {
    var d = new Date(iso + 'T12:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function attendreLeaflet(essais, suite) {
    if (window.L) { suite(); return; }
    if (essais <= 0) { echec('La carte n’a pas pu être chargée.'); return; }
    setTimeout(function () { attendreLeaflet(essais - 1, suite); }, 100);
  }

  attendreLeaflet(40, function () {
    var carte = L.map(conteneur, { scrollWheelZoom: false }).setView(SAUMOS, 11);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '© OpenStreetMap',
    }).addTo(carte);

    // Repère fixe : sans lui, une carte sans détection n'a aucun point d'ancrage.
    L.marker(SAUMOS).addTo(carte).bindPopup('<strong>Saumos</strong><br>Départ du feu, 22 juillet');

    // Les foyers vivent dans leur propre calque : changer de jour se résume
    // à le vider et le re-remplir, sans toucher au fond de carte.
    var calque = L.layerGroup().addTo(carte);

    function dessiner(points, recadrer) {
      calque.clearLayers();
      var coords = [];
      points.forEach(function (p) {
        if (!isFinite(p.lat) || !isFinite(p.lon)) return;
        L.circleMarker([p.lat, p.lon], {
          radius: rayon(p.frp),
          color: couleur(p.frp),
          fillColor: couleur(p.frp),
          fillOpacity: 0.45,
          weight: 2,
        }).bindPopup(
          '<strong>' + (p.frp ? Math.round(p.frp) + ' MW' : 'puissance inconnue') + '</strong><br>' +
          p.date + ' à ' + p.heure + ' UTC<br>' +
          'à ' + p.distanceKm + ' km de Saumos'
        ).addTo(calque);
        coords.push([p.lat, p.lon]);
      });
      if (recadrer && coords.length) {
        coords.push(SAUMOS);
        carte.fitBounds(L.latLngBounds(coords).pad(0.2));
      }
    }

    function chiffres(total, frpMax, derniere) {
      var t = document.getElementById('fg-carte-total');
      if (t) t.textContent = total;
      var f = document.getElementById('fg-carte-frp');
      if (f) f.textContent = frpMax ? Math.round(frpMax) + ' MW' : '—';
      var d = document.getElementById('fg-carte-derniere');
      if (d) d.textContent = derniere || '—';
    }

    fetch('/api/firms?jours=' + JOURS)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) {
          echec('Détections satellite indisponibles pour le moment.');
          return;
        }

        if (note) {
          note.classList.remove('stale');
          note.textContent = d.total
            ? d.total + ' détection' + (d.total > 1 ? 's' : '') + ' sur ' + d.fenetre + ' — ' + d.source + '.'
            : 'Aucune détection par ' + d.source + ' sur ' + d.fenetre + '.';
        }

        chiffres(d.total, d.frpMax, d.derniereDetection);
        dessiner(d.points || [], true);

        var jours = d.parJour || [];
        var curseur = document.getElementById('fg-time-range');
        var bloc = document.getElementById('fg-time');
        // Un seul jour de données ne mérite pas un curseur.
        if (!curseur || !bloc || jours.length < 2) return;

        // Le dernier cran affiche la période entière plutôt qu'une journée :
        // c'est l'état par défaut de la carte, et ça évite d'avoir à revenir
        // en arrière pour retrouver la vue d'ensemble.
        var crans = jours.length;
        curseur.max = String(crans);
        curseur.value = String(crans);
        bloc.removeAttribute('hidden');

        var minLab = document.getElementById('fg-time-min');
        var maxLab = document.getElementById('fg-time-max');
        if (minLab) minLab.textContent = jourFr(jours[0].date);
        if (maxLab) maxLab.textContent = 'Tout';

        var etiquette = document.getElementById('fg-time-label');

        function afficher() {
          var i = parseInt(curseur.value, 10);
          if (i >= crans) {
            if (etiquette) etiquette.textContent = 'Période entière — ' + d.total + ' détections';
            dessiner(d.points || [], false);
            chiffres(d.total, d.frpMax, d.derniereDetection);
            return;
          }
          var jour = jours[i];
          var pts = (d.points || []).filter(function (p) { return p.date === jour.date; });
          if (etiquette) {
            etiquette.textContent = jourFr(jour.date) + ' — ' + jour.total +
              ' détection' + (jour.total > 1 ? 's' : '') + ', ' + jour.frpTotal + ' MW cumulés';
          }
          dessiner(pts, false);
          chiffres(jour.total, jour.frpMax, pts[0] ? jour.date + ' ' + pts[0].heure : '—');
        }

        curseur.addEventListener('input', afficher);
        afficher();
      })
      .catch(function () {
        echec('Détections satellite indisponibles pour le moment.');
      });
  });
})();
