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

        afficherPassage(isFinite(d.prochainPasse) ? d.prochainPasse : null);
        afficherPlanning(d.planningPassages);
        afficherAutres(d.autres);

        if (!cellules.length) {
          chiffres(0, 0, d.derniereDetection);
          return;
        }

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
        // (CalqueCanvas est défini une fois plus haut, partagé avec le calque
        // « autres feux ».)
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
          function planifier() {
            if (enAttente) return;
            enAttente = true;
            requestAnimationFrame(function () {
              enAttente = false;
              rendre(debut + parseInt(curseur.value, 10) * HEURE);
            });
          }
          curseur.addEventListener('input', planifier);

          // Sur tactile, beaucoup de navigateurs transforment le doigt qui
          // glisse en défilement de page : le curseur ne bouge qu'au tap.
          // On pilote donc la valeur nous-mêmes aux événements pointer, qui
          // couvrent indifféremment souris et doigt.
          var glisse = false;
          function suivre(ev) {
            var r = curseur.getBoundingClientRect();
            if (!r.width) return;
            var part = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
            var v = String(Math.round(part * crans));
            if (v !== curseur.value) {
              curseur.value = v;
              planifier();
            }
          }
          curseur.addEventListener('pointerdown', function (ev) {
            glisse = true;
            if (curseur.setPointerCapture) {
              try { curseur.setPointerCapture(ev.pointerId); } catch (e) { /* tant pis */ }
            }
            suivre(ev);
          });
          curseur.addEventListener('pointermove', function (ev) {
            if (glisse) suivre(ev);
          });
          ['pointerup', 'pointercancel'].forEach(function (nom) {
            curseur.addEventListener(nom, function () { glisse = false; });
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
