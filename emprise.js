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

  function formateDate(ts) {
    return new Date(ts).toLocaleString('fr-FR', {
      timeZone: 'Europe/Paris',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  fetch('/api/progression')
    .then(function (r) { return r.json(); })
    .then(function (donnees) {
      if (!donnees.ok || !donnees.pas || !donnees.pas.length) return;

      var pas = donnees.pas;
      var cumul = donnees.cumulKm2 || [];
      var n = pas.length;

      // Une couche par pas, colorée une fois pour toutes ; la barre ne fait
      // qu'ajouter/retirer ces couches du fond de carte selon le curseur.
      var couches = pas.map(function (p, i) {
        var t = n > 1 ? i / (n - 1) : 1;
        var c = couleurPour(t);
        return L.geoJSON(p.geometrie, {
          style: { color: c, weight: 0, fillColor: c, fillOpacity: 0.55 },
        });
      });

      var etendue = L.featureGroup(couches);
      if (couches.length) {
        carte.fitBounds(etendue.getBounds(), { padding: [20, 20] });
      }

      var barre = document.getElementById('barre');
      var curseur = document.getElementById('curseur');
      var etiquette = document.getElementById('etiquette');
      var boutonLecture = document.getElementById('lecture');

      curseur.max = String(n - 1);
      curseur.value = String(n - 1);
      barre.hidden = false;

      var indexAffiche = -1;
      function afficherJusqua(index) {
        if (index === indexAffiche) return;
        for (var i = 0; i < n; i++) {
          var doitEtreVisible = i <= index;
          var estVisible = carte.hasLayer(couches[i]);
          if (doitEtreVisible && !estVisible) couches[i].addTo(carte);
          if (!doitEtreVisible && estVisible) carte.removeLayer(couches[i]);
        }
        indexAffiche = index;
        var p = pas[index];
        etiquette.textContent = formateDate(p.t) + ' · ' + (cumul[index] || 0) + ' km²';
      }
      afficherJusqua(n - 1);

      curseur.addEventListener('input', function () {
        afficherJusqua(Number(curseur.value));
      });

      var minuteur = null;
      boutonLecture.addEventListener('click', function () {
        if (minuteur) {
          clearInterval(minuteur);
          minuteur = null;
          boutonLecture.textContent = '▶';
          return;
        }
        if (Number(curseur.value) >= n - 1) curseur.value = '0';
        boutonLecture.textContent = '❚❚';
        minuteur = setInterval(function () {
          var suivant = Number(curseur.value) + 1;
          if (suivant > n - 1) {
            clearInterval(minuteur);
            minuteur = null;
            boutonLecture.textContent = '▶';
            return;
          }
          curseur.value = String(suivant);
          afficherJusqua(suivant);
        }, 500);
      });
    })
    .catch(function () { /* rien à afficher */ });
})();
