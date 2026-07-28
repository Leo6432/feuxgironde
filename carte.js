// Carte du feu (page /carte.html) : rejoue l'incendie heure par heure.
//
// L'API agrège les détections VIIRS en cellules (~275 m) portant chacune sa
// première (t0) et sa dernière (t1) détection. À une heure T donnée :
//   — T avant t0 : la cellule n'a pas encore brûlé, rien à dessiner ;
//   — T entre t0 et t1 + 6 h : foyer actif, coloré selon la puissance ;
//   — au-delà : zone brûlée, teinte sable.
//
// Plutôt qu'un rectangle par cellule — un damier de gros pixels —, les
// cellules sont peintes sur un canvas en disques qui se recouvrent : leur
// union forme des zones aux bords arrondis, comme sur les cartes d'incendie
// habituelles. Le canvas est ensuite posé sur la carte par une ImageOverlay
// dont « l'image » est le canvas lui-même.

(function () {
  var conteneur = document.getElementById('fg-map');
  if (!conteneur) return;

  var note = document.getElementById('fg-carte-note');
  var SAUMOS = [44.98, -1.02];
  var MINUTE = 60000;
  var HEURE = 3600000;
  var JOUR = 86400000;
  var FENETRE_ACTIVE_H = 6;

  var COULEUR_BRULE = '#E8DDB0';
  var COULEURS_ACTIF = ['#F0C441', '#EE8A17', '#D8232E'];   // < 10, 10–30, ≥ 30 MW

  function classeFrp(frp) {
    return frp >= 30 ? 2 : (frp >= 10 ? 1 : 0);
  }

  function echec(message) {
    if (note) note.textContent = message;
  }

  // FIRMS horodate en UTC ; on convertit tout à l'heure française, comme les
  // autres cartes de feux qu'un visiteur peut avoir sous les yeux — afficher
  // de l'UTC lui ferait croire à deux heures de retard.
  var FUSEAU = 'Europe/Paris';

  function partie(ms, options, type) {
    var morceaux = new Intl.DateTimeFormat('fr-FR', options).formatToParts(new Date(ms));
    for (var i = 0; i < morceaux.length; i++) {
      if (morceaux[i].type === type) return morceaux[i].value;
    }
    return '';
  }

  function heureFr(ms) {
    var jour = new Date(ms).toLocaleDateString('fr-FR', {
      weekday: 'short', day: 'numeric', month: 'short', timeZone: FUSEAU,
    });
    var h = partie(ms, { hour: 'numeric', hourCycle: 'h23', timeZone: FUSEAU }, 'hour');
    return jour + ' · ' + h.padStart(2, '0') + 'h';
  }

  function heureMinFr(ms) {
    var opts = { hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone: FUSEAU };
    return partie(ms, opts, 'hour').padStart(2, '0') + 'h' + partie(ms, opts, 'minute').padStart(2, '0');
  }

  function attendreLeaflet(essais, suite) {
    if (window.L) { suite(); return; }
    if (essais <= 0) { echec('La carte n’a pas pu être chargée.'); return; }
    setTimeout(function () { attendreLeaflet(essais - 1, suite); }, 100);
  }

  attendreLeaflet(40, function () {
    var carte = L.map(conteneur, { scrollWheelZoom: false }).setView(SAUMOS, 11);

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

    function chiffres(actifs, frpMax, derniere) {
      var t = document.getElementById('fg-carte-total');
      if (t) t.textContent = actifs;
      var f = document.getElementById('fg-carte-frp');
      if (f) f.textContent = frpMax ? Math.round(frpMax) + ' MW' : '—';
      var d = document.getElementById('fg-carte-derniere');
      if (d) d.textContent = derniere || '—';
    }

    // Les satellites VIIRS sont héliosynchrones : ils repassent chaque jour
    // aux mêmes heures à quelques minutes près. Plutôt qu'un calcul d'orbite,
    // on retrouve ces horaires dans les détections elles-mêmes — les instants
    // t0/t1 se regroupent par passage — et on projette le prochain.
    function prochainPassage(cellules) {
      var ts = [];
      cellules.forEach(function (c) {
        ts.push(c.t0);
        if (c.t1 > c.t0) ts.push(c.t1);
      });
      ts.sort(function (a, b) { return a - b; });

      var passes = [], debut = null, dernier = null;
      ts.forEach(function (t) {
        if (dernier === null || t - dernier > 40 * MINUTE) {
          if (dernier !== null) passes.push((debut + dernier) / 2);
          debut = t;
        }
        dernier = t;
      });
      if (dernier !== null) passes.push((debut + dernier) / 2);
      if (passes.length < 4) return null;   // trop peu pour une habitude fiable

      var minutes = passes.map(function (t) {
        var d = new Date(t);
        return d.getUTCHours() * 60 + d.getUTCMinutes();
      }).sort(function (a, b) { return a - b; });

      var groupes = [];
      minutes.forEach(function (m) {
        var g = groupes[groupes.length - 1];
        if (!g || m - g[g.length - 1] > 90) groupes.push([m]);
        else g.push(m);
      });
      // Un passage à cheval sur minuit UTC se retrouverait coupé en deux
      // groupes, un à chaque bout de la journée : on les recolle.
      if (groupes.length > 1) {
        var premier = groupes[0], final = groupes[groupes.length - 1];
        if (premier[0] + 1440 - final[final.length - 1] <= 90) {
          groupes.pop();
          groupes[0] = final.map(function (x) { return x - 1440; }).concat(premier);
        }
      }

      var maintenant = Date.now();
      var minuit = Math.floor(maintenant / JOUR) * JOUR;
      var prochain = null;
      groupes.forEach(function (g) {
        var somme = 0;
        g.forEach(function (x) { somme += x; });
        var m = ((Math.round(somme / g.length) % 1440) + 1440) % 1440;
        for (var j = 0; j < 2; j++) {
          var t = minuit + j * JOUR + m * MINUTE;
          if (t > maintenant + 5 * MINUTE && (prochain === null || t < prochain)) prochain = t;
        }
      });
      return prochain;
    }

    function afficherPassage(cellules) {
      var valeur = document.getElementById('fg-carte-passe');
      var detail = document.getElementById('fg-carte-passe-detail');
      if (!valeur) return;
      function maj() {
        var prochain = prochainPassage(cellules);
        if (!prochain) { valeur.textContent = '—'; return; }
        var attente = prochain - Date.now();
        var h = Math.floor(attente / HEURE);
        var mn = Math.round((attente % HEURE) / MINUTE);
        valeur.textContent = h
          ? 'dans ≈ ' + h + ' h' + (mn ? ' ' + String(mn).padStart(2, '0') : '')
          : 'dans ≈ ' + mn + ' min';
        if (detail) {
          var opts = { day: 'numeric', timeZone: FUSEAU };
          var libJour = partie(prochain, opts, 'day') === partie(Date.now(), opts, 'day')
            ? 'aujourd’hui' : 'demain';
          detail.textContent = libJour + ' vers ' + heureMinFr(prochain) +
            ' (heure française) — estimé d’après les horaires des passages précédents';
        }
      }
      maj();
      setInterval(maj, 60 * 1000);
    }

    fetch('/api/firms?jours=max')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) {
          echec('Détections satellite indisponibles pour le moment.');
          return;
        }

        // Cellules compactes [lat, lon, t0, t1, frp, km], temps en minutes
        // depuis le départ du feu.
        var origine = +d.origine || 0;
        var cellules = (d.cellules || [])
          .map(function (c) {
            return {
              lat: +c[0], lon: +c[1],
              t0: origine + c[2] * MINUTE,
              t1: origine + c[3] * MINUTE,
              frp: +c[4] || 0,
              distanceKm: +c[5] || 0,
            };
          })
          .filter(function (c) {
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

        afficherPassage(cellules);

        var grille = +d.grille || 0.0025;
        var latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
        cellules.forEach(function (c) {
          if (c.lat < latMin) latMin = c.lat;
          if (c.lat > latMax) latMax = c.lat;
          if (c.lon < lonMin) lonMin = c.lon;
          if (c.lon > lonMax) lonMax = c.lon;
        });
        var marge = grille * 4;
        var sud = latMin - marge, nord = latMax + marge;
        var ouest = lonMin - marge, est = lonMax + marge;

        // Résolution du canvas : ~13 px par pas de grille pour que les disques
        // aient de quoi s'arrondir et restent nets une fois étirés au zoom,
        // plafonnée pour ménager la mémoire. La hauteur compense l'étirement
        // Mercator des latitudes, afin que les pixels du canvas restent
        // carrés à l'écran.
        var cosLat = Math.cos(SAUMOS[0] * Math.PI / 180);
        var largeur = Math.max(64, Math.min(2400, Math.round((est - ouest) / grille * 13)));
        var echelleX = largeur / (est - ouest);
        var hauteur = Math.max(64, Math.min(3200, Math.round((nord - sud) * echelleX / cosLat)));
        var echelleY = hauteur / (nord - sud);

        cellules.forEach(function (c) {
          c.fin = c.t1 + FENETRE_ACTIVE_H * HEURE;
          c.etat = 'absent';
          c.px = (c.lon - ouest) * echelleX;
          c.py = (nord - c.lat) * echelleY;
          c.classe = classeFrp(c.frp);
        });

        function calque() {
          var cv = document.createElement('canvas');
          cv.width = largeur;
          cv.height = hauteur;
          return cv;
        }
        var cnvBrule = calque(), cnvActif = calque(), cnvAffiche = calque();
        var ctxBrule = cnvBrule.getContext('2d');
        var ctxActif = cnvActif.getContext('2d');
        var ctxAffiche = cnvAffiche.getContext('2d');

        // ImageOverlay sait déjà positionner, étirer et animer une image entre
        // deux coins géographiques ; on lui donne le canvas à la place.
        var CalqueCanvas = L.ImageOverlay.extend({
          _initImage: function () {
            var el = this._image = this._url;
            L.DomUtil.addClass(el, 'leaflet-image-layer');
            if (this._zoomAnimated) L.DomUtil.addClass(el, 'leaflet-zoom-animated');
            el.onselectstart = L.Util.falseFn;
            el.onmousemove = L.Util.falseFn;
          },
        });
        new CalqueCanvas(cnvAffiche, [[sud, ouest], [nord, est]], { interactive: false }).addTo(carte);

        var bornes = L.latLngBounds([[sud, ouest], [nord, est]]).extend(SAUMOS);
        carte.fitBounds(bornes.pad(0.1));

        var TAU = Math.PI * 2;
        // Rayons à 0,72 pas de grille : deux cellules voisines se recouvrent
        // franchement, l'union est continue au lieu d'un semis de points. Un
        // rayon par axe, car un pas en latitude couvre plus de mètres qu'un
        // pas en longitude.
        var rx = grille * echelleX * 0.72, ry = grille * echelleY * 0.72;
        var rxA = rx * 1.12, ryA = ry * 1.12;   // foyers actifs un peu plus amples
        var flou = Math.max(1.2, rx * 0.22);

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
          var parClasse = [[], [], []];

          ctxBrule.clearRect(0, 0, largeur, hauteur);
          ctxActif.clearRect(0, 0, largeur, hauteur);

          ctxBrule.fillStyle = COULEUR_BRULE;
          ctxBrule.beginPath();
          cellules.forEach(function (c) {
            c.etat = T < c.t0 ? 'absent' : (T <= c.fin ? 'actif' : 'brule');
            if (c.etat === 'absent') return;
            var vu = Math.min(c.t1, T);
            if (vu > derniere) derniere = vu;
            if (c.etat === 'brule') {
              ctxBrule.moveTo(c.px + rx, c.py);
              ctxBrule.ellipse(c.px, c.py, rx, ry, 0, 0, TAU);
            } else {
              actifs++;
              frpActif += c.frp;
              if (c.frp > frpMax) frpMax = c.frp;
              parClasse[c.classe].push(c);
            }
          });
          ctxBrule.fill();

          // Du plus faible au plus fort, pour que le rouge reste au-dessus.
          parClasse.forEach(function (liste, i) {
            if (!liste.length) return;
            ctxActif.fillStyle = COULEURS_ACTIF[i];
            ctxActif.beginPath();
            liste.forEach(function (c) {
              ctxActif.moveTo(c.px + rxA, c.py);
              ctxActif.ellipse(c.px, c.py, rxA, ryA, 0, 0, TAU);
            });
            ctxActif.fill();
          });

          // Peindre opaque puis composer avec une opacité globale : deux
          // disques qui se chevauchent gardent une teinte uniforme, là où des
          // formes semi-transparentes se surimprimeraient en plus foncé. Seule
          // la zone brûlée est légèrement floutée, pour fondre les disques en
          // une nappe continue ; les foyers actifs restent nets.
          ctxAffiche.clearRect(0, 0, largeur, hauteur);
          ctxAffiche.filter = 'blur(' + flou + 'px)';
          ctxAffiche.globalAlpha = 0.66;
          ctxAffiche.drawImage(cnvBrule, 0, 0);
          ctxAffiche.filter = 'none';
          ctxAffiche.globalAlpha = 0.86;
          ctxAffiche.drawImage(cnvActif, 0, 0);
          ctxAffiche.globalAlpha = 1;

          if (etiquette) {
            etiquette.textContent = heureFr(T) + ' — ' +
              (actifs
                ? actifs + ' foyer' + (actifs > 1 ? 's' : '') + ' actif' + (actifs > 1 ? 's' : '') + ', ≈ ' + Math.round(frpActif) + ' MW'
                : 'aucun foyer actif');
          }
          chiffres(actifs, frpMax, derniere ? heureFr(derniere) : '—');
        }

        // Le canvas n'est pas cliquable cellule par cellule : au clic, on
        // retrouve la cellule la plus proche et on ouvre son détail.
        carte.on('click', function (ev) {
          var meilleur = null, d2min = Infinity;
          cellules.forEach(function (c) {
            if (c.etat === 'absent') return;
            var dLat = ev.latlng.lat - c.lat;
            var dLon = (ev.latlng.lng - c.lon) * cosLat;
            var d2 = dLat * dLat + dLon * dLon;
            if (d2 < d2min) { d2min = d2; meilleur = c; }
          });
          if (!meilleur || Math.sqrt(d2min) > grille * 2.5) return;
          L.popup()
            .setLatLng([meilleur.lat, meilleur.lon])
            .setContent(
              '<strong>' + (meilleur.frp ? '≈ ' + Math.round(meilleur.frp) + ' MW au plus fort' : 'puissance inconnue') + '</strong><br>' +
              'détecté du ' + heureFr(meilleur.t0) + ' au ' + heureFr(meilleur.t1) + '<br>' +
              'à ' + meilleur.distanceKm + ' km de Saumos'
            )
            .openOn(carte);
        });

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
      .catch(function (e) {
        if (window.console && console.error) console.error(e);
        echec('Détections satellite indisponibles pour le moment.');
      });
  });
})();
