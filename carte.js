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

    fetch('/api/firms')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) {
          echec('Détections satellite indisponibles pour le moment.');
          return;
        }

        if (note) {
          note.classList.remove('stale');
          note.textContent = d.total
            ? d.total + ' foyer' + (d.total > 1 ? 's' : '') + ' détecté' + (d.total > 1 ? 's' : '') + ' — ' + d.source + ', ' + d.fenetre + '.'
            : 'Aucun foyer détecté par ' + d.source + ' sur ' + d.fenetre + '.';
        }

        var total = document.getElementById('fg-carte-total');
        if (total) total.textContent = d.total;
        var frp = document.getElementById('fg-carte-frp');
        if (frp) frp.textContent = d.frpMax ? Math.round(d.frpMax) + ' MW' : '—';
        var derniere = document.getElementById('fg-carte-derniere');
        if (derniere) derniere.textContent = d.derniereDetection || '—';

        if (!d.points || !d.points.length) return;

        var groupe = [];
        d.points.forEach(function (p) {
          if (!isFinite(p.lat) || !isFinite(p.lon)) return;
          var cercle = L.circleMarker([p.lat, p.lon], {
            radius: rayon(p.frp),
            color: couleur(p.frp),
            fillColor: couleur(p.frp),
            fillOpacity: 0.45,
            weight: 2,
          }).addTo(carte);
          cercle.bindPopup(
            '<strong>' + (p.frp ? Math.round(p.frp) + ' MW' : 'puissance inconnue') + '</strong><br>' +
            p.date + ' à ' + p.heure + ' UTC<br>' +
            'à ' + p.distanceKm + ' km de Saumos'
          );
          groupe.push([p.lat, p.lon]);
        });

        // Recadre sur les foyers réels, en gardant Saumos dans le champ.
        if (groupe.length) {
          groupe.push(SAUMOS);
          carte.fitBounds(L.latLngBounds(groupe).pad(0.2));
        }
      })
      .catch(function () {
        echec('Détections satellite indisponibles pour le moment.');
      });
  });
})();
