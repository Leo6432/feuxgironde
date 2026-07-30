// Carte du feu (page /carte.html) : contour net de l'emprise cumulée
// (voir /api/perimetre), par cliché figé toutes les 6h — même principe que
// le pipeline (hors ligne) du site nicolaslecorvec.github.io/fumees-
// nouvelle_aquitaine : chaque détection FIRMS devient un petit cercle,
// tous ces cercles sont fusionnés en une vraie forme géométrique (union de
// polygones), calculée côté serveur. Choisir un autre cliché dans la liste
// recalcule le contour jusqu'à cet instant — ce n'est plus une animation
// continue minute par minute, mais un vrai contour vectoriel à chaque fois.

(function () {
  var conteneur = document.getElementById('fg-map');
  if (!conteneur) return;

  var note = document.getElementById('fg-carte-note');
  var SAUMOS = [44.98, -1.02];
  var MINUTE = 60000;
  var HEURE = 3600000;

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
    var carte = L.map(conteneur, { scrollWheelZoom: true }).setView(SAUMOS, 11);

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

    // L'heure du prochain passage est calculée et figée côté serveur (voir
    // prochainPassageFige dans /api/firms) : elle ne doit pas changer tant
    // que ce passage n'a pas réellement eu lieu, même si les données
    // sous-jacentes bougent légèrement entre deux rafraîchissements de page.
    // Le client se contente d'afficher un compte à rebours vers cette cible
    // fixe — jamais de recalcul local.
    function afficherPassage(cible) {
      var valeur = document.getElementById('fg-carte-passe');
      var detail = document.getElementById('fg-carte-passe-detail');
      if (!valeur) return;
      if (!cible) { valeur.textContent = '—'; return; }
      function maj() {
        var attente = cible - Date.now();
        if (attente <= 0) { valeur.textContent = 'en cours'; return; }
        var h = Math.floor(attente / HEURE);
        var mn = Math.round((attente % HEURE) / MINUTE);
        valeur.textContent = h
          ? 'dans ≈ ' + h + ' h' + (mn ? ' ' + String(mn).padStart(2, '0') : '')
          : 'dans ≈ ' + mn + ' min';
        if (detail) {
          var opts = { day: 'numeric', timeZone: FUSEAU };
          var libJour = partie(cible, opts, 'day') === partie(Date.now(), opts, 'day')
            ? 'aujourd’hui' : 'demain';
          detail.textContent = libJour + ' vers ' + heureMinFr(cible) +
            ' (heure française) — estimé d’après les horaires des passages précédents';
        }
      }
      maj();
      setInterval(maj, 60 * 1000);
    }

    // Tableau des horaires de passage réellement observés (voir
    // planningPassages, calculé côté API séparément pour chaque satellite à
    // partir des détections des derniers jours) — répond à « combien de fois
    // par jour ça se met à jour, et par quel satellite ».
    function afficherPlanning(passages) {
      var bloc = document.getElementById('fg-planning');
      var corps = document.getElementById('fg-planning-corps');
      if (!bloc || !corps || !passages || !passages.length) return;
      var minuit = Math.floor(Date.now() / (24 * HEURE)) * 24 * HEURE;
      corps.innerHTML = passages.map(function (p) {
        var t = minuit + p.minute * MINUTE;
        return '<tr><td>' + heureMinFr(t) + '</td><td>' + (p.satellite || '—') + '</td></tr>';
      }).join('');
      bloc.removeAttribute('hidden');
    }

    // Les autres feux de France (hors du rayon Saumos, dernières 24h) : même
    // technique de disques fondus que Saumos (canvas + ImageOverlay, même
    // grille de 275 m), mais UN CANEVAS PAR FOYER plutôt qu'un seul canevas
    // pour toute la France. Un canevas unique national doit répartir sa
    // résolution sur ~1000 km : chaque point y devient minuscule, et
    // plusieurs détections proches (un vrai gros feu) fusionnent en une
    // tache floue sans détail — exactement le défaut remarqué sur le feu
    // des Alpes. En regroupant d'abord les points proches (un foyer =
    // un groupe), chaque groupe a son propre petit canevas local, à la
    // même résolution fine que Saumos : un point isolé reste un point net,
    // et un vrai gros feu retrouve le même luxe de détail que Saumos.
    var CalqueCanvas = L.ImageOverlay.extend({
      _initImage: function () {
        var el = this._image = this._url;
        L.DomUtil.addClass(el, 'leaflet-image-layer');
        if (this._zoomAnimated) L.DomUtil.addClass(el, 'leaflet-zoom-animated');
        el.onselectstart = L.Util.falseFn;
        el.onmousemove = L.Util.falseFn;
      },
    });

    // Regroupement simple par proximité (chaînage) : un point rejoint un
    // groupe dès qu'il est à moins de seuilDeg d'un point déjà dedans.
    function grouperParProximite(pts, seuilDeg) {
      var groupes = [];
      var visites = new Array(pts.length).fill(false);
      for (var i = 0; i < pts.length; i++) {
        if (visites[i]) continue;
        var groupe = [];
        var file = [i];
        visites[i] = true;
        while (file.length) {
          var k = file.pop();
          groupe.push(pts[k]);
          for (var j = 0; j < pts.length; j++) {
            if (visites[j]) continue;
            var dLat = pts[k].lat - pts[j].lat, dLon = pts[k].lon - pts[j].lon;
            if (Math.sqrt(dLat * dLat + dLon * dLon) <= seuilDeg) {
              visites[j] = true;
              file.push(j);
            }
          }
        }
        groupes.push(groupe);
      }
      return groupes;
    }

    function dessinerGroupeAutres(pts) {
      var GRILLE = 0.0025;   // même grille que Saumos : même niveau de détail.
      var latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
      pts.forEach(function (p) {
        if (p.lat < latMin) latMin = p.lat;
        if (p.lat > latMax) latMax = p.lat;
        if (p.lon < lonMin) lonMin = p.lon;
        if (p.lon > lonMax) lonMax = p.lon;
      });
      var marge = GRILLE * 6;
      var sud = latMin - marge, nord = latMax + marge;
      var ouest = lonMin - marge, est = lonMax + marge;

      var cosLat = Math.cos(((sud + nord) / 2) * Math.PI / 180);
      var largeur = Math.max(48, Math.min(900, Math.round((est - ouest) / GRILLE * 13)));
      var echelleX = largeur / (est - ouest);
      var hauteur = Math.max(48, Math.min(900, Math.round((nord - sud) * echelleX / cosLat)));
      var echelleY = hauteur / (nord - sud);

      var cv = document.createElement('canvas');
      cv.width = largeur;
      cv.height = hauteur;
      var ctx = cv.getContext('2d');

      var rx = GRILLE * echelleX * 0.85, ry = GRILLE * echelleY * 0.85;
      var flou = Math.max(1, rx * 0.25);
      var TAU = Math.PI * 2;
      var parClasse = [[], [], []];
      pts.forEach(function (p) {
        p.px = (p.lon - ouest) * echelleX;
        p.py = (nord - p.lat) * echelleY;
        parClasse[classeFrp(p.frp)].push(p);
      });

      ctx.filter = 'blur(' + flou + 'px)';
      ctx.globalAlpha = 0.88;
      parClasse.forEach(function (liste, i) {
        if (!liste.length) return;
        ctx.fillStyle = COULEURS_ACTIF[i];
        ctx.beginPath();
        liste.forEach(function (p) {
          ctx.moveTo(p.px + rx, p.py);
          ctx.ellipse(p.px, p.py, rx, ry, 0, 0, TAU);
        });
        ctx.fill();
      });
      ctx.filter = 'none';
      ctx.globalAlpha = 1;

      new CalqueCanvas(cv, [[sud, ouest], [nord, est]], { interactive: false }).addTo(carte);
    }

    function afficherAutres(autres) {
      var pts = (autres || [])
        .map(function (a) { return { lat: +a[0], lon: +a[1], frp: +a[2] || 0, ts: +a[3] }; })
        .filter(function (p) { return isFinite(p.lat) && isFinite(p.lon); });
      if (!pts.length) return;

      // Seuil de regroupement : assez large pour recoller les détections
      // d'un même foyer vues par des passages satellite légèrement décalés,
      // assez petit pour ne pas fusionner deux feux vraiment distincts.
      var groupes = grouperParProximite(pts, 0.03);
      groupes.forEach(dessinerGroupeAutres);

      // Clic : même principe que pour Saumos, on ouvre le détail du point
      // le plus proche. Les deux jeux de points ne se chevauchent jamais
      // (« autres » exclut déjà le rayon Saumos côté serveur), donc les deux
      // gestionnaires de clic ne se marchent jamais dessus.
      var cosLatClic = Math.cos(SAUMOS[0] * Math.PI / 180);
      carte.on('click', function (ev) {
        var meilleur = null, d2min = Infinity;
        pts.forEach(function (p) {
          var dLat = ev.latlng.lat - p.lat;
          var dLon = (ev.latlng.lng - p.lon) * cosLatClic;
          var d2 = dLat * dLat + dLon * dLon;
          if (d2 < d2min) { d2min = d2; meilleur = p; }
        });
        if (!meilleur || Math.sqrt(d2min) > 0.015) return;
        L.popup()
          .setLatLng([meilleur.lat, meilleur.lon])
          .setContent(
            '<strong>' + (meilleur.frp ? '≈ ' + Math.round(meilleur.frp) + ' MW' : 'puissance inconnue') + '</strong><br>' +
            (isFinite(meilleur.ts) ? 'détecté ' + heureFr(meilleur.ts) : '') +
            '<br><span style="opacity:.75">Autre feu, hors du suivi détaillé de Saumos</span>'
          )
          .openOn(carte);
      });
    }

    // Contour net par cliché figé (voir /api/perimetre) : un vrai polygone
    // Leaflet, recalculé côté serveur pour l'instant choisi — pas une
    // animation continue minute par minute.
    var calqueContour = null;
    var marqueursActifs = [];

    function viderCliche() {
      if (calqueContour) { carte.removeLayer(calqueContour); calqueContour = null; }
      marqueursActifs.forEach(function (m) { carte.removeLayer(m); });
      marqueursActifs = [];
    }

    function afficherCliche(d, recentrer) {
      viderCliche();
      if (d.contour) {
        calqueContour = L.geoJSON(d.contour, {
          style: { color: '#B89E3F', weight: 1.5, fillColor: '#E8DDB0', fillOpacity: 0.55 },
          interactive: false,
        }).addTo(carte);
        if (recentrer) {
          try { carte.fitBounds(calqueContour.getBounds().pad(0.15)); } catch (e) { /* forme vide, tant pis */ }
        }
      }

      var frpMax = 0, derniereTs = 0, frpActif = 0;
      (d.actifs || []).forEach(function (a) {
        var lat = +a[0], lon = +a[1], frp = +a[2] || 0, ts = +a[3];
        if (!isFinite(lat) || !isFinite(lon)) return;
        if (frp > frpMax) frpMax = frp;
        frpActif += frp;
        if (ts > derniereTs) derniereTs = ts;
        var m = L.circleMarker([lat, lon], {
          radius: 5, weight: 1, color: '#7a4a12',
          fillColor: COULEURS_ACTIF[classeFrp(frp)], fillOpacity: 0.9,
        })
          .bindPopup(
            '<strong>' + (frp ? '≈ ' + Math.round(frp) + ' MW' : 'puissance inconnue') + '</strong><br>' +
            (isFinite(ts) ? 'détecté ' + heureFr(ts) : '')
          )
          .addTo(carte);
        marqueursActifs.push(m);
      });

      var nbActifs = (d.actifs || []).length;
      var etiquette = document.getElementById('fg-time-label');
      if (etiquette) {
        etiquette.textContent = heureFr(d.instant) + ' — ' +
          (nbActifs
            ? nbActifs + ' foyer' + (nbActifs > 1 ? 's' : '') + ' actif' + (nbActifs > 1 ? 's' : '') + ', ≈ ' + Math.round(frpActif) + ' MW'
            : 'aucun foyer actif');
      }
      chiffres(nbActifs, frpMax, derniereTs ? heureFr(derniereTs) : '—');
    }

    function chargerCliche(instant, recentrer) {
      var url = '/api/perimetre' + (instant ? ('?instant=' + instant) : '');
      return fetch(url)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.ok) afficherCliche(d, recentrer);
          return d;
        });
    }

    var selectTemps = document.getElementById('fg-time-select');
    var blocTemps = document.getElementById('fg-time');

    chargerCliche(null, true)
      .then(function (d) {
        if (!d || !d.ok) { echec('Contour du feu indisponible pour le moment.'); return; }
        if (selectTemps && blocTemps && d.snapshots && d.snapshots.length) {
          selectTemps.innerHTML = d.snapshots.map(function (t, i) {
            var dernier = i === d.snapshots.length - 1;
            var libelle = heureFr(t) + (dernier ? ' (le plus récent)' : '');
            return '<option value="' + t + '"' + (dernier ? ' selected' : '') + '>' + libelle + '</option>';
          }).join('');
          blocTemps.removeAttribute('hidden');
          selectTemps.addEventListener('change', function () {
            chargerCliche(+selectTemps.value, false)
              .catch(function () { echec('Contour du feu indisponible pour le moment.'); });
          });
        }
      })
      .catch(function (e) {
        if (window.console && console.error) console.error(e);
        echec('Contour du feu indisponible pour le moment.');
      });

    // Note générale, prochain passage, planning des passages et autres
    // feux : viennent toujours de /api/firms, indépendamment du cliché
    // choisi ci-dessus.
    fetch('/api/firms?jours=max')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) return;

        if (note) {
          var texte = d.total + ' détections sur ' + d.fenetre + ' — ' + d.source + '.';
          if (d.avertissement) texte += ' ' + d.avertissement + '.';
          else note.classList.remove('stale');
          note.textContent = texte;
        }

        afficherPassage(isFinite(d.prochainPasse) ? d.prochainPasse : null);
        afficherPlanning(d.planningPassages);
        afficherAutres(d.autres);
      })
      .catch(function () { /* la carte reste utilisable sans ces compléments */ });
  });
})();
