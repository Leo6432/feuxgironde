(function () {
  'use strict';

  var SAUMOS = [44.98, -1.02];
  // Même palette que la carte principale : rouge pour ce qui vient d'être
  // atteint, beige pâle pour ce qui l'a été il y a plusieurs jours.
  var PALETTE = ['#fff7bc', '#fed976', '#feb24c', '#fd8d3c', '#f03b20', '#d7191c'];

  function couleurPour(t) {
    var i = Math.min(PALETTE.length - 1, Math.floor(t * PALETTE.length));
    return PALETTE[i];
  }

  var carte = L.map('map', { scrollWheelZoom: true }).setView(SAUMOS, 11);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18,
    attribution: 'Tiles © Esri — Maxar, Earthstar Geographics',
  }).addTo(carte);

  fetch('/api/progression')
    .then(function (r) { return r.json(); })
    .then(function (donnees) {
      if (!donnees.ok || !donnees.pas || !donnees.pas.length) return;

      var pas = donnees.pas;
      var n = pas.length;
      var groupe = L.featureGroup().addTo(carte);

      pas.forEach(function (p, i) {
        var t = n > 1 ? i / (n - 1) : 1;
        var c = couleurPour(t);
        L.geoJSON(p.geometrie, {
          style: { color: c, weight: 0, fillColor: c, fillOpacity: 0.55 },
        }).addTo(groupe);
      });

      if (groupe.getLayers().length) {
        carte.fitBounds(groupe.getBounds(), { padding: [20, 20] });
      }
    })
    .catch(function () { /* rien à afficher */ });
})();
