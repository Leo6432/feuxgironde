(function () {
  'use strict';

  // Vue initiale : la France entière. Pas de cadrage automatique sur les feux
  // trouvés — sinon, un jour où seule la Gironde brûle, la carte zoomerait
  // dessus et donnerait l'impression que le reste du pays n'est pas couvert.
  var FRANCE = [46.6, 2.4];
  var ZOOM_FRANCE = 6;

  // Les données viennent de /api/perimetre : notre propre moteur, qui couvre
  // la France métropolitaine et la Corse. (Le pipeline repris de
  // fumees-nouvelle_aquitaine, lui, est configuré pour le seul feu de Gironde
  // — bbox et max_clusters dans son config.yaml — il ne peut donc pas servir
  // ici.)
  var SOURCE = '/api/perimetre';

  var carte = L.map('map', { scrollWheelZoom: true }).setView(FRANCE, ZOOM_FRANCE);
  // Exposée pour que l'ouverture du panneau puisse prévenir Leaflet que la
  // zone visible a changé (invalidateSize).
  window.carteEmprise = carte;

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18,
    attribution: 'Tiles © Esri — Maxar, Earthstar Geographics · détections NASA FIRMS',
  }).addTo(carte);

  var barre = document.getElementById('barre');
  var curseur = document.getElementById('curseur');
  var etiquette = document.getElementById('etiquette');
  var boutonLecture = document.getElementById('lecture');

  var instants = [];
  var calque = null;
  var minuteur = null;
  // Jeton de course : en glissant le curseur, seule la réponse de la dernière
  // position demandée doit s'afficher, sinon une réponse tardive écraserait
  // l'état courant.
  var enCours = null;

  var FUSEAU = 'Europe/Paris';
  var MINUTE = 60000;
  var HEURE = 3600000;

  function formateDate(ts) {
    return new Date(ts).toLocaleString('fr-FR', {
      timeZone: FUSEAU,
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function partie(ms, options, type) {
    var morceaux = new Intl.DateTimeFormat('fr-FR', options).formatToParts(new Date(ms));
    for (var i = 0; i < morceaux.length; i++) {
      if (morceaux[i].type === type) return morceaux[i].value;
    }
    return '';
  }

  // FIRMS horodate en UTC ; tout est affiché en heure française, comme sur le
  // reste du site — montrer de l'UTC ferait croire à deux heures de retard.
  function heureMinFr(ms) {
    var opts = { hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone: FUSEAU };
    return partie(ms, opts, 'hour').padStart(2, '0') + 'h' + partie(ms, opts, 'minute').padStart(2, '0');
  }

  // ── Vues exclusives de la colonne ────────────────────────────────────
  // Carte, Satellite et Avions partagent un même principe : au plus un
  // panneau ouvert à la fois, puisqu'il recouvre une partie de la carte.
  // « Carte » est l'état neutre — sans panneau. Ce que chaque bouton
  // COMMANDE en dessous (la couche satellite n'existe pas, la couche avions
  // reste affichée même panneau fermé) leur est propre ; seule l'exclusivité
  // visuelle des panneaux est mise en commun ici.
  var VUES = {};
  function enregistrerVue(nom, onglet, panneau) { VUES[nom] = { onglet: onglet, panneau: panneau }; }
  function choisirVue(nom) {
    var unPanneauOuvert = false;
    Object.keys(VUES).forEach(function (cle) {
      var v = VUES[cle];
      var actif = cle === nom;
      if (v.panneau) v.panneau.hidden = !actif;
      if (v.onglet) {
        v.onglet.classList.toggle('is-actif', actif);
        v.onglet.setAttribute('aria-pressed', actif ? 'true' : 'false');
      }
      if (actif && v.panneau) unPanneauOuvert = true;
    });
    document.body.classList.toggle('panneau-ouvert', unPanneauOuvert);
    // La zone visible de la carte change quand un panneau s'ouvre ou se
    // ferme : sans cela, Leaflet garde l'ancienne taille et laisse une
    // bande grise.
    if (window.carteEmprise) window.carteEmprise.invalidateSize();
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') choisirVue('carte');
  });

  // ── Passages satellite ────────────────────────────────────────────────
  // L'heure du prochain passage est figée côté serveur (prochainPassageFige
  // dans /api/firms) : elle ne doit pas bouger tant que ce passage n'a pas eu
  // lieu. Le client n'affiche qu'un compte à rebours vers cette cible, il ne
  // recalcule jamais l'horaire lui-même.
  function afficherProchain(cible) {
    var valeur = document.getElementById('sat-prochain');
    var detail = document.getElementById('sat-detail');
    if (!valeur) return;
    if (!cible) {
      valeur.textContent = '—';
      if (detail) detail.textContent = 'historique trop court pour dégager une habitude fiable';
      return;
    }
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
        detail.textContent = libJour + ' vers ' + heureMinFr(cible) + ' (heure française)';
      }
    }
    maj();
    setInterval(maj, 60 * 1000);
  }

  function afficherPlanning(passages) {
    var bloc = document.getElementById('sat-bloc-planning');
    var corps = document.getElementById('sat-planning');
    if (!bloc || !corps || !passages || !passages.length) return;
    var minuit = Math.floor(Date.now() / (24 * HEURE)) * 24 * HEURE;
    corps.innerHTML = passages.map(function (p) {
      return '<tr><td>' + heureMinFr(minuit + p.minute * MINUTE) + '</td><td>'
        + (p.satellite || '—') + '</td></tr>';
    }).join('');
    bloc.removeAttribute('hidden');
  }

  (function passagesSatellite() {
    var ongletCarte = document.getElementById('onglet-carte');
    var ongletSat = document.getElementById('onglet-satellite');
    var panneau = document.getElementById('panneau-satellite');
    if (!ongletCarte || !ongletSat || !panneau) return;

    enregistrerVue('carte', ongletCarte, null);
    enregistrerVue('satellite', ongletSat, panneau);

    ongletSat.addEventListener('click', function () {
      choisirVue(panneau.hidden ? 'satellite' : 'carte');
    });
    ongletCarte.addEventListener('click', function () { choisirVue('carte'); });

    // Chargé une fois au démarrage : ces horaires ne dépendent pas du curseur
    // temporel, ils décrivent le rythme des satellites aujourd'hui.
    fetch('/api/firms?jours=max')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) return;
        afficherProchain(isFinite(d.prochainPasse) ? d.prochainPasse : null);
        afficherPlanning(d.planningPassages);
      })
      .catch(function () { /* la fenêtre reste sur ses tirets */ });
  })();

  function afficher(d) {
    if (calque) { carte.removeLayer(calque); calque = null; }

    var zones = (d.zones || []).filter(function (z) { return z && z.surfaces; });
    if (zones.length) {
      calque = L.geoJSON({
        type: 'FeatureCollection',
        features: zones.map(function (z) {
          return {
            type: 'Feature',
            geometry: z.surfaces,
            properties: { couleur: z.couleur, libelle: z.libelle, surfaceKm2: z.surfaceKm2 },
          };
        }),
      }, {
        // Les bords en escalier viennent de la grille des pixels satellite :
        // les laisser tels quels, les lisser effacerait cette information.
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
          couche.bindTooltip(
            '<b>' + f.properties.libelle + '</b><br>'
              + f.properties.surfaceKm2.toLocaleString('fr-FR') + ' km²',
            { sticky: true, opacity: 0.96 }
          );
        },
      }).addTo(carte);
    }

    var total = zones.reduce(function (s, z) { return s + (z.surfaceKm2 || 0); }, 0);
    etiquette.textContent = formateDate(d.instant) + ' · '
      + (Math.round(total * 10) / 10).toLocaleString('fr-FR') + ' km²';
  }

  function charger(instant) {
    var jeton = {};
    enCours = jeton;
    return fetch(SOURCE + (instant ? ('?instant=' + instant) : ''))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (enCours !== jeton) return null;      // position dépassée
        if (!d || !d.ok) return null;
        afficher(d);
        return d;
      });
  }

  // ── Avions de la Sécurité civile ─────────────────────────────────────
  // Toujours affichés sur la carte, dès le chargement de la page — pas un
  // calque qu'il faut activer : un avion près d'un feu est une information
  // aussi immédiate que le feu lui-même. Le bouton de la colonne n'ouvre
  // qu'un panneau de détail (le compte des dernières 24 h et les noms), sur
  // le même principe que Satellite ; il ne commande jamais si les avions
  // sont dessinés. Positions et identification best-effort via
  // airplanes.live, voir lib/avionsFeu.js.
  (function avionsFeu() {
    var bouton = document.getElementById('onglet-avions');
    var panneau = document.getElementById('panneau-avions');
    var info = document.getElementById('avions-info');
    var badge = document.getElementById('avions-badge');
    var compte = document.getElementById('avions-compte');
    var liste = document.getElementById('avions-liste');
    if (!bouton || !panneau) return;

    enregistrerVue('avions', bouton, panneau);
    bouton.addEventListener('click', function () {
      choisirVue(panneau.hidden ? 'avions' : 'carte');
    });

    var ICONE_AVION = '<svg viewBox="0 0 24 24" fill="#eaf2fb" aria-hidden="true">'
      + '<path d="M12 2c-.7 0-1.2.5-1.2 1.2v5.4L3.4 12.4v1.8l7.4-2.3v4.6l-2.1 1.5v1.5l2.9-.8.6-.1.6.1 '
      + '2.9.8v-1.5l-2.1-1.5v-4.6l7.4 2.3v-1.8l-7.4-3.8V3.2C13.2 2.5 12.7 2 12 2Z"/></svg>';

    var DUREE_SONDAGE_MS = 20000;
    // Sillage glissant de 30 minutes : la queue s'efface toute seule à mesure
    // que la tête s'allonge, plutôt qu'un nombre de points fixe — un avion
    // lent et un avion rapide gardent ainsi le même horizon temporel.
    var DUREE_TRACE_MS = 30 * 60000;
    var MINUTE = 60000, HEURE = 3600000;

    var couche = L.layerGroup().addTo(carte);
    var marqueurs = {};   // icao24 -> L.Marker
    var traces = {};      // icao24 -> L.Polyline
    var points = {};      // icao24 -> [[lat, lon, instant], ...], du plus vieux au plus récent

    function afficherInfo(texte) {
      if (!texte) { info.hidden = true; return; }
      info.textContent = texte;
      info.hidden = false;
    }

    function etiquette(a) {
      var morceaux = [];
      if (a.altitudeM != null) morceaux.push(a.altitudeM.toLocaleString('fr-FR') + ' m');
      if (a.vitesseKmh != null) morceaux.push(a.vitesseKmh + ' km/h');
      return '<div class="avion-etiquette"><span class="indicatif">' + a.indicatif + '</span>'
        + (morceaux.length ? '<div class="detail">' + morceaux.join(' · ') + '</div>' : '')
        + '</div>';
    }

    function supprimerAvion(icao) {
      if (marqueurs[icao]) { couche.removeLayer(marqueurs[icao]); delete marqueurs[icao]; }
      if (traces[icao]) { couche.removeLayer(traces[icao]); delete traces[icao]; }
      delete points[icao];
    }

    function poserOuDeplacer(a) {
      var latlon = [a.lat, a.lon];
      var maintenant = Date.now();

      if (!points[a.icao24]) points[a.icao24] = [];
      var suite = points[a.icao24];
      var dernier = suite[suite.length - 1];
      // Un avion au parking peut rester immobile ; ne pas empiler des points
      // identiques évite un sillage qui n'en est pas un.
      if (!dernier || dernier[0] !== latlon[0] || dernier[1] !== latlon[1]) {
        suite.push([latlon[0], latlon[1], maintenant]);
      }
      // La queue du sillage sort d'elle-même de la fenêtre de 30 min à mesure
      // que la tête avance — c'est ce qui fait "s'enlever au bout".
      while (suite.length && maintenant - suite[0][2] > DUREE_TRACE_MS) suite.shift();

      if (suite.length > 1) {
        var latlngs = suite.map(function (p) { return [p[0], p[1]]; });
        if (traces[a.icao24]) traces[a.icao24].setLatLngs(latlngs);
        else {
          traces[a.icao24] = L.polyline(latlngs, {
            color: '#2fb8e8', weight: 2, opacity: .65, dashArray: '1 6', lineCap: 'round',
          }).addTo(couche);
        }
      } else if (traces[a.icao24]) {
        // Il ne reste qu'un point dans la fenêtre : plus rien à relier.
        couche.removeLayer(traces[a.icao24]);
        delete traces[a.icao24];
      }

      if (marqueurs[a.icao24]) {
        marqueurs[a.icao24].setLatLng(latlon);
        marqueurs[a.icao24].setIcon(icone(a));
        marqueurs[a.icao24].setTooltipContent(etiquette(a));
      } else {
        marqueurs[a.icao24] = L.marker(latlon, { icon: icone(a) })
          .bindTooltip(etiquette(a), { direction: 'top', offset: [0, -12], opacity: .96 })
          .addTo(couche);
      }
    }

    function icone(a) {
      var cap = a.capDeg != null ? a.capDeg : 0;
      return L.divIcon({
        className: '', iconSize: [22, 22], iconAnchor: [11, 11],
        html: '<div class="avion-icone" style="transform:rotate(' + cap + 'deg)">' + ICONE_AVION + '</div>',
      });
    }

    // « il y a 3 min », « il y a 2 h » — assez de précision pour situer un
    // passage sans afficher une heure qu'il faudrait comparer soi-même.
    function depuis(ts) {
      var ecart = Date.now() - ts;
      if (ecart < MINUTE) return 'à l’instant';
      if (ecart < HEURE) return 'il y a ' + Math.round(ecart / MINUTE) + ' min';
      return 'il y a ' + Math.round(ecart / HEURE) + ' h';
    }

    function afficherHistorique(historique) {
      var n = (historique || []).length;
      if (badge) {
        badge.textContent = String(n);
        badge.hidden = n === 0;
      }
      if (compte) {
        compte.textContent = n
          ? n + (n > 1 ? ' avions vus' : ' avion vu')
          : 'aucun avion vu depuis 24 h';
      }
      if (liste) {
        liste.innerHTML = (historique || []).map(function (a) {
          return '<li><span class="indicatif">' + a.indicatif + '</span>'
            + '<span class="quand">' + depuis(a.derniereVue) + '</span></li>';
        }).join('');
      }
    }

    function charger() {
      fetch('/api/avions').then(function (r) { return r.json(); }).then(function (d) {
        if (!d) return;
        if (!d.ok) {
          afficherInfo('Suivi des avions indisponible' + (d.raison ? ' (' + d.raison + ')' : '') + '.');
          return;
        }

        var vus = {};
        (d.avions || []).forEach(function (a) { vus[a.icao24] = true; poserOuDeplacer(a); });
        Object.keys(marqueurs).forEach(function (icao) { if (!vus[icao]) supprimerAvion(icao); });
        afficherHistorique(d.historique24h);

        if (!(d.avions || []).length) {
          afficherInfo('Aucun avion de la Sécurité civile repéré pour le moment.');
        } else if (d.perime) {
          afficherInfo('Dernière position connue — airplanes.live ne répond plus depuis quelques instants.');
        } else {
          afficherInfo(null);
        }
      }).catch(function () { afficherInfo('Suivi des avions indisponible.'); });
    }

    charger();
    setInterval(charger, DUREE_SONDAGE_MS);
  })();

  function arreter() {
    if (minuteur) { clearInterval(minuteur); minuteur = null; }
    boutonLecture.textContent = '▶';
  }

  charger(null).then(function (d) {
    if (!d) return;
    instants = d.instants || [];
    if (instants.length < 2) return;

    curseur.max = String(instants.length - 1);
    curseur.value = String(instants.length - 1);
    barre.hidden = false;

    curseur.addEventListener('input', function () {
      arreter();
      charger(instants[Number(curseur.value)]);
    });

    boutonLecture.addEventListener('click', function () {
      if (minuteur) { arreter(); return; }
      if (Number(curseur.value) >= instants.length - 1) curseur.value = '0';
      boutonLecture.textContent = '❚❚';
      minuteur = setInterval(function () {
        var suivant = Number(curseur.value) + 1;
        if (suivant >= instants.length) { arreter(); return; }
        curseur.value = String(suivant);
        charger(instants[suivant]);
      }, 900);
      charger(instants[Number(curseur.value)]);
    });
  }).catch(function () { /* la carte reste affichée, sans données */ });
})();
