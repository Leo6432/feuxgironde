(function () {
  'use strict';

  var FUSEAU = 'Europe/Paris';
  var MINUTE = 60000;
  var HEURE = 3600000;

  function partie(ms, options, type) {
    var morceaux = new Intl.DateTimeFormat('fr-FR', options).formatToParts(new Date(ms));
    for (var i = 0; i < morceaux.length; i++) {
      if (morceaux[i].type === type) return morceaux[i].value;
    }
    return '';
  }

  function heureMinFr(ms) {
    var opts = { hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone: FUSEAU };
    return partie(ms, opts, 'hour').padStart(2, '0') + 'h' + partie(ms, opts, 'minute').padStart(2, '0');
  }

  function texte(id, valeur) {
    var el = document.getElementById(id);
    if (el) el.textContent = valeur;
  }

  // ── Foyers posés sur la silhouette du hero ────────────────────────────
  // Mêmes paramètres que ceux ayant servi à tracer le contour dans le HTML :
  // projection équirectangulaire corrigée du cosinus de la latitude moyenne,
  // sans quoi la France paraîtrait écrasée en largeur. Les changer ici sans
  // retracer le contour décalerait les points.
  var CARTE = { ouest: -4.784901, nord: 51.087541, k: 0.6917648826615689, echelle: 61.75992947839518 };
  // Au-delà, les points se recouvrent sans rien ajouter à la lecture, et le
  // DOM s'alourdit pour rien. Les plus puissants sont gardés en priorité.
  var MAX_POINTS = 260;

  function poserFoyers(actifs) {
    var groupe = document.getElementById('foyers');
    var vide = document.getElementById('carte-vide');
    if (!groupe) return;

    var points = actifs
      .slice()
      .sort(function (a, b) { return (b[2] || 0) - (a[2] || 0); })
      .slice(0, MAX_POINTS);

    if (vide) vide.hidden = points.length > 0;

    groupe.innerHTML = points.map(function (p, n) {
      var x = (p[1] - CARTE.ouest) * CARTE.k * CARTE.echelle;
      var y = (CARTE.nord - p[0]) * CARTE.echelle;
      // Le halo grandit avec la puissance radiative, sans qu'un feu isolé très
      // intense n'écrase toute la carte : racine plutôt que proportionnel.
      var r = 7 + Math.min(16, Math.sqrt(Math.max(0, p[2] || 0)) * 1.6);
      // Décalage du départ d'animation : sans lui, tous les foyers pulseraient
      // ensemble, ce qui ferait clignoter la carte entière.
      var retard = ((n * 37) % 100) / 100 * 3.4;
      return '<g class="foyer" style="animation-delay:-' + retard.toFixed(2) + 's">'
        + '<circle class="foyer-halo" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r.toFixed(1) + '"/>'
        + '<circle class="foyer-coeur" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="1.9"/>'
        + '</g>';
    }).join('');
  }

  Promise.all([
    fetch('/api/perimetre').then(function (r) { return r.json(); }).catch(function () { return null; }),
    // jours=max, et non 1 : l'horaire des passages se déduit d'au moins deux
    // passages par capteur (voir horairesUnCapteur dans api/firms.js). Sur une
    // seule journée un capteur ne repasse souvent qu'une fois, et le prochain
    // passage restait alors « historique trop court ». La réponse est mise en
    // cache côté serveur, cette fenêtre plus large ne coûte donc rien.
    fetch('/api/firms?jours=max').then(function (r) { return r.json(); }).catch(function () { return null; }),
  ]).then(function (resultats) {
    var perimetre = resultats[0];
    var firms = resultats[1];
    if ((!perimetre || !perimetre.ok) && (!firms || !firms.ok)) return;

    document.getElementById('chiffres').hidden = false;

    if (perimetre && perimetre.ok) {
      poserFoyers(perimetre.actifs || []);
      texte('v-foyers', String(perimetre.foyers || 0));
      texte('v-foyers-detail', (perimetre.detections || 0).toLocaleString('fr-FR') + ' détections actives');

      var surface = (perimetre.zones || []).reduce(function (s, z) { return s + (z.surfaceKm2 || 0); }, 0);
      texte('v-surface', (Math.round(surface * 10) / 10).toLocaleString('fr-FR') + ' km²');

      if (perimetre.avertissement) {
        var av = document.getElementById('avertissement');
        av.textContent = perimetre.avertissement;
        av.hidden = false;
      }
    }

    if (firms && firms.ok) {
      texte('v-frp', firms.frpMax ? Math.round(firms.frpMax) + ' MW' : '—');

      var cible = isFinite(firms.prochainPasse) ? firms.prochainPasse : null;
      if (cible) {
        function majPassage() {
          var attente = cible - Date.now();
          if (attente <= 0) { texte('v-passage', 'en cours'); return; }
          var h = Math.floor(attente / HEURE);
          var mn = Math.round((attente % HEURE) / MINUTE);
          texte('v-passage', h ? '≈ ' + h + ' h' + (mn ? ' ' + String(mn).padStart(2, '0') : '') : '≈ ' + mn + ' min');
          var opts = { day: 'numeric', timeZone: FUSEAU };
          var libJour = partie(cible, opts, 'day') === partie(Date.now(), opts, 'day') ? 'aujourd’hui' : 'demain';
          texte('v-passage-detail', libJour + ' vers ' + heureMinFr(cible));
        }
        majPassage();
        setInterval(majPassage, 60 * 1000);
      } else {
        texte('v-passage-detail', 'historique trop court');
      }
    }
  }).catch(function () { /* les chiffres restent masqués, le reste de la page fonctionne */ });
})();
