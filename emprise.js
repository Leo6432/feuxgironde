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

    // « Carte » et « Satellite » sont deux vues exclusives : le panneau
    // recouvrant une partie de la carte, laisser les deux actifs en même temps
    // n'aurait pas de sens.
    function choisir(vueSatellite) {
      panneau.hidden = !vueSatellite;
      document.body.classList.toggle('panneau-ouvert', vueSatellite);
      ongletSat.classList.toggle('is-actif', vueSatellite);
      ongletCarte.classList.toggle('is-actif', !vueSatellite);
      ongletSat.setAttribute('aria-pressed', vueSatellite ? 'true' : 'false');
      ongletCarte.setAttribute('aria-pressed', vueSatellite ? 'false' : 'true');
      // La zone visible de la carte change quand le panneau s'ouvre ou se
      // ferme : sans cela, Leaflet garde l'ancienne taille et laisse une
      // bande grise.
      if (window.carteEmprise) window.carteEmprise.invalidateSize();
    }

    ongletSat.addEventListener('click', function () { choisir(panneau.hidden); });
    ongletCarte.addEventListener('click', function () { choisir(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') choisir(false);
    });

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
