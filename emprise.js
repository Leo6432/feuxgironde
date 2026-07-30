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

  function formateDate(ts) {
    return new Date(ts).toLocaleString('fr-FR', {
      timeZone: 'Europe/Paris',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

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
