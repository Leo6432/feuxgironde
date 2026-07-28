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

  // Une détection reste comptée « active » pendant ce laps de temps après
  // son relevé. Au-delà, elle bascule dans la zone déjà parcourue.
  var FENETRE_ACTIVE_H = 6;

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

  // Un pixel VIIRS couvre environ 375 m au sol. On dessine donc chaque
  // détection à cette échelle, en mètres et non en pixels d'écran : les
  // détections voisines se recouvrent et forment une zone continue, comme
  // sur les cartes d'incendie habituelles, au lieu d'un semis de points.
  // Le rayon ne varie pas avec la puissance : la surface couverte par une
  // détection est la même quelle que soit son intensité, seule la couleur
  // change.
  var RAYON_M = 320;

  // Les heures FIRMS sont en UTC : on garde cette référence de bout en bout
  // plutôt que de convertir, pour que l'étiquette du curseur corresponde
  // exactement à l'horodatage affiché dans les info-bulles.
  function horodatage(p) {
    var hm = (p.heure || '00h00').split('h');
    return Date.UTC(
      +p.date.slice(0, 4), +p.date.slice(5, 7) - 1, +p.date.slice(8, 10),
      +hm[0] || 0, +hm[1] || 0
    );
  }

  function heureFr(ms) {
    var d = new Date(ms);
    var jour = d.toLocaleDateString('fr-FR', {
      weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
    });
    return jour + ' · ' + String(d.getUTCHours()).padStart(2, '0') + 'h';
  }

  function attendreLeaflet(essais, suite) {
    if (window.L) { suite(); return; }
    if (essais <= 0) { echec('La carte n’a pas pu être chargée.'); return; }
    setTimeout(function () { attendreLeaflet(essais - 1, suite); }, 100);
  }

  attendreLeaflet(40, function () {
    // Rendu canvas : plusieurs milliers de cercles redessinés à chaque cran du
    // curseur seraient injouables en SVG, un élément DOM par point.
    var carte = L.map(conteneur, { scrollWheelZoom: false, preferCanvas: true })
      .setView(SAUMOS, 11);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '© OpenStreetMap',
    }).addTo(carte);

    // Repère fixe : sans lui, une carte sans détection n'a aucun point d'ancrage.
    L.marker(SAUMOS).addTo(carte).bindPopup('<strong>Saumos</strong><br>Départ du feu, 22 juillet');

    // Les polices web arrivent après le premier rendu et font glisser la mise
    // en page : Leaflet garde alors la position qu'avait le conteneur au
    // moment de l'initialisation, et le calque canvas se retrouve décalé de
    // la hauteur gagnée. invalidateSize le recale sur la position réelle.
    function recaler() { carte.invalidateSize({ animate: false }); }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(recaler);
    window.addEventListener('resize', recaler);
    setTimeout(recaler, 400);

    // Deux calques distincts : la trace cumulée du feu (tout ce qui a brûlé
    // depuis le départ) en dessous, et les foyers encore chauds au moment
    // choisi par-dessus. Le second est toujours dessiné en dernier.
    var calqueBrule = L.layerGroup().addTo(carte);
    var calqueActif = L.layerGroup().addTo(carte);

    function bulle(p) {
      return '<strong>' + (p.frp ? Math.round(p.frp) + ' MW' : 'puissance inconnue') + '</strong><br>' +
        p.date + ' à ' + p.heure + ' UTC<br>' +
        'à ' + p.distanceKm + ' km de Saumos';
    }

    function dessiner(brules, actifs, recadrer) {
      calqueBrule.clearLayers();
      calqueActif.clearLayers();
      var coords = [];

      // Zone parcourue : gris sombre, sans contour. Les disques se recouvrent
      // et se lisent comme une surface, pas comme une alerte — ces foyers-là
      // sont éteints.
      brules.forEach(function (p) {
        if (!isFinite(p.lat) || !isFinite(p.lon)) return;
        L.circle([p.lat, p.lon], {
          radius: RAYON_M, color: '#3A3A44', fillColor: '#3A3A44',
          fillOpacity: 0.28, weight: 0,
        }).bindPopup(bulle(p) + '<br><em>déjà parcouru</em>').addTo(calqueBrule);
        coords.push([p.lat, p.lon]);
      });

      actifs.forEach(function (p) {
        if (!isFinite(p.lat) || !isFinite(p.lon)) return;
        L.circle([p.lat, p.lon], {
          radius: RAYON_M,
          color: couleur(p.frp),
          fillColor: couleur(p.frp),
          fillOpacity: 0.55,
          weight: 1,
        }).bindPopup(bulle(p)).addTo(calqueActif);
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

    fetch('/api/firms?jours=max')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) {
          echec('Détections satellite indisponibles pour le moment.');
          return;
        }

        var pts = (d.points || []).filter(function (p) {
          return isFinite(p.lat) && isFinite(p.lon);
        });
        pts.forEach(function (p) { p.t = horodatage(p); });
        pts.sort(function (a, b) { return a.t - b.t; });

        if (note) {
          note.classList.remove('stale');
          note.textContent = d.total
            ? d.total + ' détection' + (d.total > 1 ? 's' : '') + ' sur ' + d.fenetre + ' — ' + d.source + '.'
            : 'Aucune détection par ' + d.source + ' sur ' + d.fenetre + '.';
        }

        chiffres(d.total, d.frpMax, d.derniereDetection);
        dessiner([], pts, true);

        var curseur = document.getElementById('fg-time-range');
        var bloc = document.getElementById('fg-time');
        if (!curseur || !bloc || pts.length < 2) return;

        // Un cran par heure, du premier relevé au dernier. Les heures sans
        // survol ne sont pas vides pour autant : la trace cumulée y reste
        // visible, seuls les foyers actifs disparaissent.
        var HEURE = 3600000;
        var debut = Math.floor(pts[0].t / HEURE) * HEURE;
        var fin = Math.ceil(pts[pts.length - 1].t / HEURE) * HEURE;
        var crans = Math.max(1, Math.round((fin - debut) / HEURE));

        curseur.max = String(crans);
        curseur.value = String(crans);
        bloc.removeAttribute('hidden');

        var minLab = document.getElementById('fg-time-min');
        var maxLab = document.getElementById('fg-time-max');
        if (minLab) minLab.textContent = heureFr(debut);
        if (maxLab) maxLab.textContent = heureFr(fin);

        var etiquette = document.getElementById('fg-time-label');

        function afficher() {
          var instant = debut + parseInt(curseur.value, 10) * HEURE;
          var limite = instant - FENETRE_ACTIVE_H * HEURE;

          var brules = [];
          var actifs = [];
          for (var i = 0; i < pts.length; i++) {
            if (pts[i].t > instant) break;          // pts est trié
            (pts[i].t >= limite ? actifs : brules).push(pts[i]);
          }

          var frpActif = actifs.reduce(function (s, p) { return s + (p.frp || 0); }, 0);
          if (etiquette) {
            etiquette.textContent = heureFr(instant) + ' — ' +
              (actifs.length ? actifs.length + ' foyer' + (actifs.length > 1 ? 's' : '') + ' actif' +
                (actifs.length > 1 ? 's' : '') + ', ' + Math.round(frpActif) + ' MW'
                : 'aucun foyer actif') +
              ' · ' + (brules.length + actifs.length) + ' détections cumulées';
          }

          dessiner(brules, actifs, false);
          chiffres(
            actifs.length,
            actifs.length ? Math.max.apply(null, actifs.map(function (p) { return p.frp || 0; })) : 0,
            actifs.length ? heureFr(actifs[actifs.length - 1].t) : '—'
          );
        }

        // Le glissement déclenche un événement par pixel parcouru : sans ce
        // filtrage, on redessinerait la carte bien plus souvent que l'écran
        // ne se rafraîchit.
        var enAttente = false;
        curseur.addEventListener('input', function () {
          if (enAttente) return;
          enAttente = true;
          requestAnimationFrame(function () { enAttente = false; afficher(); });
        });
        afficher();
      })
      .catch(function () {
        echec('Détections satellite indisponibles pour le moment.');
      });
  });
})();
