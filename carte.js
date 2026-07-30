// Carte du feu (page /carte.html) : état d'activité zone par zone.
//
// Les données viennent de /api/perimetre, qui reprend le produit
// `last_activity_state` du site nicolaslecorvec.github.io/fumees-
// nouvelle_aquitaine : chaque cellule d'une grille de 40 m retient
// l'horodatage de sa dernière détection satellite, et les cellules sont
// réparties en paliers selon l'ancienneté de cette activité — du rouge
// (encore chaud) au beige pâle (plus rien depuis plus de 40 h).
//
// La barre temporelle rejoue cet état à une date passée : chaque cran
// interroge le serveur, qui recolore les zones selon l'ancienneté mesurée
// depuis cet instant-là.
//
// Les bords en escalier sont voulus : ce sont les pixels de la grille, à la
// résolution réelle des capteurs. Rien n'est lissé ni arrondi ici, sinon on
// effacerait précisément cette information.

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

    // ── État d'activité, cellule par cellule (voir /api/perimetre) ──────
    // Chaque zone est colorée selon l'ancienneté de sa DERNIÈRE détection :
    // rouge là où les satellites voient encore chaud, beige pâle là où plus
    // rien n'a été vu depuis plus de 40 heures. Une cellule n'appartient qu'à
    // un seul palier, donc les zones ne se recouvrent pas — la carte montre
    // vraiment l'état de chaque portion de terrain, pas un simple cumul.

    var calqueZones = null;
    var calquesActifs = [];
    var cadrageFait = false;

    function viderCalques() {
      if (calqueZones) { carte.removeLayer(calqueZones); calqueZones = null; }
      calquesActifs.forEach(function (c) { carte.removeLayer(c); });
      calquesActifs = [];
    }

    function afficherZones(d) {
      var zones = (d.zones || []).filter(function (z) { return z && z.surfaces; });
      if (!zones.length) return null;

      var groupe = L.geoJSON({
        type: 'FeatureCollection',
        features: zones.map(function (z) {
          return {
            type: 'Feature',
            geometry: z.surfaces,
            properties: {
              libelle: z.libelle,
              couleur: z.couleur,
              surfaceKm2: z.surfaceKm2,
              cellules: z.cellules,
            },
          };
        }),
      }, {
        // smoothFactor 0 : Leaflet ne simplifie pas le tracé au rendu, et les
        // jointures restent vives — les bords en escalier de la grille sont
        // le résultat voulu, les arrondir effacerait les pixels.
        smoothFactor: 0,
        style: function (f) {
          return {
            color: f.properties.couleur,
            weight: 0.65,
            opacity: 0.55,
            fillColor: f.properties.couleur,
            fillOpacity: 0.72,
            lineCap: 'butt',
            lineJoin: 'miter',
          };
        },
        onEachFeature: function (f, couche) {
          var p = f.properties;
          couche.bindTooltip(
            '<b>Dernière activité : ' + p.libelle + '</b>' +
            '<br>' + p.surfaceKm2.toLocaleString('fr-FR') + ' km² détectés' +
            '<br><small>Ni surface brûlée officielle ni front continu.</small>',
            { sticky: true, opacity: 0.96 }
          );
        },
      }).addTo(carte);
      calqueZones = groupe;

      // Cadrage une seule fois : le refaire à chaque cran de curseur ferait
      // sauter la vue sous la main de l'utilisateur, et empêcherait de zoomer
      // sur un secteur pour y suivre la progression.
      if (!cadrageFait) {
        try { carte.fitBounds(groupe.getBounds().pad(0.12)); cadrageFait = true; } catch (e) { /* forme vide */ }
      }

      // Légende : un palier par ligne, avec la surface concernée.
      var legende = document.getElementById('fg-paliers');
      if (legende) {
        legende.innerHTML = (d.paliers || []).map(function (pal) {
          var z = zones.find(function (x) { return x.palier === pal.id; });
          var surface = z ? z.surfaceKm2.toLocaleString('fr-FR') + ' km²' : '—';
          return '<span><i style="background:' + pal.couleur + '"></i> ' +
            pal.libelle + ' <b style="opacity:.7">' + surface + '</b></span>';
        }).join('');
      }

      return zones;
    }

    function majEtiquette(d, zones) {
      var etiquette = document.getElementById('fg-time-label');
      if (!etiquette) return;
      var recent = (zones || []).find(function (z) { return z.palier === 'h00_08'; });
      etiquette.textContent = heureFr(d.instant) + ' — ' + (recent
        ? 'actif sur ≈ ' + recent.surfaceKm2.toLocaleString('fr-FR') + ' km²'
        : 'aucune détection dans les 8 h précédentes');
    }

    function afficherFoyersActifs(actifs) {
      var frpMax = 0, derniereTs = 0, frpActif = 0;
      (actifs || []).forEach(function (a) {
        var lat = +a[0], lon = +a[1], frp = +a[2] || 0, ts = +a[3];
        if (!isFinite(lat) || !isFinite(lon)) return;
        if (frp > frpMax) frpMax = frp;
        frpActif += frp;
        if (ts > derniereTs) derniereTs = ts;
        calquesActifs.push(L.circleMarker([lat, lon], {
          radius: 4, weight: 1, color: '#7a2712',
          fillColor: COULEURS_ACTIF[classeFrp(frp)], fillOpacity: 0.92,
        })
          .bindPopup(
            '<strong>' + (frp ? '≈ ' + Math.round(frp) + ' MW' : 'puissance inconnue') + '</strong><br>' +
            (isFinite(ts) ? 'détecté ' + heureFr(ts) : '')
          )
          .addTo(carte));
      });
      return { nb: (actifs || []).length, frpMax: frpMax, derniereTs: derniereTs };
    }

    // ── Barre temporelle ────────────────────────────────────────────────
    // Chaque cran demande au serveur l'état du feu à cette date : les zones
    // y sont recolorées selon l'ancienneté mesurée depuis cet instant, et non
    // depuis maintenant. Les états passés ne bougeant plus, le serveur les
    // garde en cache — un cran déjà visité revient immédiatement.

    var curseur = document.getElementById('fg-time-range');
    var blocTemps = document.getElementById('fg-time');
    var boutonLecture = document.getElementById('fg-time-play');
    var instants = [];
    var chargementEnCours = null;
    var lectureTimer = null;

    function afficherEtat(d) {
      viderCalques();
      var zones = afficherZones(d);
      var bilan = afficherFoyersActifs(d.actifs);
      chiffres(bilan.nb, bilan.frpMax, bilan.derniereTs ? heureFr(bilan.derniereTs) : '—');
      majEtiquette(d, zones);
      if (blocTemps) blocTemps.removeAttribute('hidden');
    }

    function chargerInstant(instant) {
      // Une requête plus récente annule la précédente : en glissant le
      // curseur, seules les réponses de la dernière position comptent, sinon
      // une réponse tardive écraserait l'affichage courant.
      var jeton = {};
      chargementEnCours = jeton;
      var url = '/api/perimetre' + (instant ? ('?instant=' + instant) : '');
      return fetch(url)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (chargementEnCours !== jeton) return null;   // position dépassée
          if (!d || !d.ok) { echec('État du feu indisponible pour le moment.'); return null; }
          afficherEtat(d);
          return d;
        });
    }

    function arreterLecture() {
      if (lectureTimer) { clearInterval(lectureTimer); lectureTimer = null; }
      if (boutonLecture) boutonLecture.textContent = '▶ Lecture';
    }

    function demarrerLecture() {
      if (!curseur || !instants.length) return;
      if (boutonLecture) boutonLecture.textContent = '❚❚ Pause';
      // Repart du début si on est déjà au bout.
      if (+curseur.value >= instants.length - 1) curseur.value = '0';
      lectureTimer = setInterval(function () {
        var suivant = +curseur.value + 1;
        if (suivant >= instants.length) { arreterLecture(); return; }
        curseur.value = String(suivant);
        chargerInstant(instants[suivant]).catch(function () { arreterLecture(); });
      }, 900);
      chargerInstant(instants[+curseur.value]);
    }

    chargerInstant(null)
      .then(function (d) {
        if (!d) return;
        instants = Array.isArray(d.instants) ? d.instants : [];
        if (!curseur || !blocTemps || instants.length < 2) return;

        curseur.min = '0';
        curseur.max = String(instants.length - 1);
        curseur.value = String(instants.length - 1);

        var min = document.getElementById('fg-time-min');
        var max = document.getElementById('fg-time-max');
        if (min) min.textContent = heureFr(instants[0]);
        if (max) max.textContent = 'maintenant';

        // Le glissement émet un événement par pixel parcouru : sans ce
        // délai, on lancerait des dizaines de requêtes pour un seul geste.
        var attente = null;
        curseur.addEventListener('input', function () {
          arreterLecture();
          if (attente) clearTimeout(attente);
          attente = setTimeout(function () {
            chargerInstant(instants[+curseur.value])
              .catch(function () { echec('État du feu indisponible pour le moment.'); });
          }, 180);
        });

        if (boutonLecture) {
          boutonLecture.addEventListener('click', function () {
            if (lectureTimer) arreterLecture();
            else demarrerLecture();
          });
        }
      })
      .catch(function (e) {
        if (window.console && console.error) console.error(e);
        echec('État du feu indisponible pour le moment.');
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
