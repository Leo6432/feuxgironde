// Carte du feu (page /carte.html) : rejoue l'incendie heure par heure.
//
// L'API agrège les détections VIIRS en cellules d'environ 375 m — l'empreinte
// d'un pixel du capteur — portant chacune sa première (t0) et sa dernière (t1)
// détection. À une heure T donnée :
//   — T avant t0 : la cellule n'a pas encore brûlé, rien à dessiner ;
//   — T entre t0 et t1 + 6 h : foyer actif, coloré selon la puissance ;
//   — au-delà : zone brûlée, teinte sable, comme sur les cartes d'incendie
//     habituelles.
// Les couches sont créées une seule fois puis restylées : en glissant le
// curseur d'une heure, seules les cellules qui changent d'état sont touchées.

(function () {
  var conteneur = document.getElementById('fg-map');
  if (!conteneur) return;

  var note = document.getElementById('fg-carte-note');
  var SAUMOS = [44.98, -1.02];
  var HEURE = 3600000;
  var FENETRE_ACTIVE_H = 6;
  var DEMI = 0.002;              // demi-côté d'une cellule (grille de 0,004°)

  var COULEUR_BRULE = '#E8DDB0';

  function echec(message) {
    if (note) note.textContent = message;
  }

  function couleur(frp) {
    if (frp >= 30) return '#D8232E';
    if (frp >= 10) return '#EE8A17';
    return '#F0C441';
  }

  // FIRMS horodate en UTC ; on affiche dans ce même référentiel pour que le
  // curseur corresponde aux info-bulles.
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
    // Rendu canvas : des milliers de cellules seraient injouables en SVG.
    var carte = L.map(conteneur, { scrollWheelZoom: false, preferCanvas: true })
      .setView(SAUMOS, 11);

    // Fond satellite : les teintes sable et rouge se lisent dessus comme sur
    // la carte FIRMS, là où un fond routier clair les noyait.
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 17,
      attribution: 'Tiles © Esri — Maxar, Earthstar Geographics',
    }).addTo(carte);

    L.marker(SAUMOS).addTo(carte).bindPopup('<strong>Saumos</strong><br>Départ du feu, 22 juillet');

    // Les polices web arrivent après le premier rendu et font glisser la mise
    // en page : Leaflet garde alors la position qu'avait le conteneur au
    // moment de l'initialisation. invalidateSize le recale.
    function recaler() { carte.invalidateSize({ animate: false }); }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(recaler);
    window.addEventListener('resize', recaler);
    setTimeout(recaler, 400);

    var calque = L.layerGroup().addTo(carte);

    function chiffres(actifs, frpMax, derniere) {
      var t = document.getElementById('fg-carte-total');
      if (t) t.textContent = actifs;
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

        var cellules = (d.cellules || []).filter(function (c) {
          return isFinite(c.lat) && isFinite(c.lon) && isFinite(c.t0) && isFinite(c.t1);
        });

        if (note) {
          var texte = cellules.length
            ? d.total + ' détections sur ' + d.fenetre + ' — ' + d.source + '.'
            : 'Aucune détection par ' + d.source + ' sur ' + d.fenetre + '.';
          // Une fenêtre incomplète reste signalée en ambre : un bandeau vert
          // laisserait croire que l'historique affiché est le vrai total.
          if (d.avertissement) texte += ' ' + d.avertissement + '.';
          else note.classList.remove('stale');
          note.textContent = texte;
        }

        if (!cellules.length) {
          chiffres(0, 0, d.derniereDetection);
          return;
        }

        cellules.forEach(function (c) {
          c.fin = c.t1 + FENETRE_ACTIVE_H * HEURE;
          c.etat = 'absent';
          c.layer = L.rectangle(
            [[c.lat - DEMI, c.lon - DEMI], [c.lat + DEMI, c.lon + DEMI]],
            { weight: 0, fillOpacity: 0 }
          ).bindPopup(
            '<strong>' + (c.frp ? '≈ ' + Math.round(c.frp) + ' MW au plus fort' : 'puissance inconnue') + '</strong><br>' +
            'détecté du ' + heureFr(c.t0) + ' au ' + heureFr(c.t1) + ' (UTC)<br>' +
            'à ' + c.distanceKm + ' km de Saumos'
          );
        });

        var bornes = L.latLngBounds(cellules.map(function (c) { return [c.lat, c.lon]; }))
          .extend(SAUMOS);
        carte.fitBounds(bornes.pad(0.15));

        var debut = Infinity, fin = -Infinity;
        cellules.forEach(function (c) {
          if (c.t0 < debut) debut = c.t0;
          if (c.t1 > fin) fin = c.t1;
        });
        debut = Math.floor(debut / HEURE) * HEURE;
        fin = Math.ceil(fin / HEURE) * HEURE;
        var crans = Math.max(1, Math.round((fin - debut) / HEURE));

        var etiquette = document.getElementById('fg-time-label');

        function rendre(T) {
          var actifs = 0, frpMax = 0, frpActif = 0, derniere = 0;
          cellules.forEach(function (c) {
            var etat = T < c.t0 ? 'absent' : (T <= c.fin ? 'actif' : 'brule');
            if (etat !== c.etat) {
              if (etat === 'absent') {
                calque.removeLayer(c.layer);
              } else {
                if (c.etat === 'absent') c.layer.addTo(calque);
                c.layer.setStyle(etat === 'actif'
                  ? { fillColor: couleur(c.frp), fillOpacity: 0.8, weight: 0 }
                  : { fillColor: COULEUR_BRULE, fillOpacity: 0.62, weight: 0 });
              }
              c.etat = etat;
            }
            if (etat === 'actif') {
              actifs++;
              frpActif += c.frp;
              if (c.frp > frpMax) frpMax = c.frp;
            }
            if (etat !== 'absent') {
              var vu = Math.min(c.t1, T);
              if (vu > derniere) derniere = vu;
            }
          });
          if (etiquette) {
            etiquette.textContent = heureFr(T) + ' — ' +
              (actifs
                ? actifs + ' foyer' + (actifs > 1 ? 's' : '') + ' actif' + (actifs > 1 ? 's' : '') + ', ≈ ' + Math.round(frpActif) + ' MW'
                : 'aucun foyer actif');
          }
          chiffres(actifs, frpMax, derniere ? heureFr(derniere) : '—');
        }

        var curseur = document.getElementById('fg-time-range');
        var bloc = document.getElementById('fg-time');
        if (curseur && bloc && crans > 1) {
          curseur.max = String(crans);
          curseur.value = String(crans);
          bloc.removeAttribute('hidden');

          var minLab = document.getElementById('fg-time-min');
          var maxLab = document.getElementById('fg-time-max');
          if (minLab) minLab.textContent = heureFr(debut);
          if (maxLab) maxLab.textContent = heureFr(fin);

          // Le glissement déclenche un événement par pixel parcouru : sans ce
          // filtrage, on redessinerait bien plus souvent que l'écran ne se
          // rafraîchit.
          var enAttente = false;
          curseur.addEventListener('input', function () {
            if (enAttente) return;
            enAttente = true;
            requestAnimationFrame(function () {
              enAttente = false;
              rendre(debut + parseInt(curseur.value, 10) * HEURE);
            });
          });
        }

        rendre(fin);
      })
      .catch(function () {
        echec('Détections satellite indisponibles pour le moment.');
      });
  });
})();
