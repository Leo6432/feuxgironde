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

  // ── Surface brûlée par année ──────────────────────────────────────────
  // Série unique : pas de légende (le titre dit ce qui est tracé), et pas de
  // second axe pour le nombre de feux — deux échelles y sur un même tracé
  // inventent une corrélation absente des données.
  //
  // 2025 et 2026 sont les valeurs exactes fournies ; les années antérieures
  // sont relevées sur le graphique source, donc arrondies à la centaine — la
  // note sous le graphique le dit, pour ne pas les faire passer pour exactes.
  var ANNEES = [
    [2006, 1700], [2007, 2300], [2008, 1500], [2009, 7900], [2010, 4500],
    [2011, 4700], [2012, 3200], [2013, 900], [2014, 4300], [2015, 2100],
    [2016, 10700], [2017, 20700], [2018, 2700], [2019, 43600], [2020, 14600],
    [2021, 30500], [2022, 66200], [2023, 22400], [2024, 12300], [2025, 36951],
    [2026, 91175],
  ];
  var ACCENT = 2026;

  function fr(n) { return n.toLocaleString('fr-FR'); }

  // Barre à sommet arrondi (4px) et pied carré : le pied doit rester posé net
  // sur la ligne de base, un rx global arrondirait aussi les angles du bas.
  function cheminBarre(x, y, largeur, hauteur, rayon) {
    var r = Math.min(rayon, hauteur, largeur / 2);
    return 'M' + x + ' ' + (y + hauteur)
      + 'V' + (y + r)
      + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + -r
      + 'h' + (largeur - 2 * r)
      + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r
      + 'V' + (y + hauteur) + 'Z';
  }

  function dessinerGraphique() {
    var hote = document.getElementById('viz');
    if (!hote) return;

    var L = 960, H = 380;
    var margeG = 58, margeD = 14, margeHaut = 34, margeBas = 34;
    var largeurTrace = L - margeG - margeD;
    var hauteurTrace = H - margeHaut - margeBas;

    var MAX = 100000;                       // borne ronde, au-dessus du pic
    var bande = largeurTrace / ANNEES.length;
    var largeurBarre = Math.min(24, bande - 2);   // ≤ 24px, et 2px d'air minimum
    var y = function (v) { return margeHaut + hauteurTrace * (1 - v / MAX); };

    var svg = ['<svg viewBox="0 0 ' + L + ' ' + H + '" role="img" '
      + 'aria-label="Surface brûlée en France par année, de 2006 à 2026, en hectares">'];

    // Grille horizontale + graduations, à valeurs rondes.
    svg.push('<g class="viz-grille">');
    [0, 25000, 50000, 75000, 100000].forEach(function (v) {
      var yy = y(v);
      svg.push('<line x1="' + margeG + '" y1="' + yy + '" x2="' + (L - margeD) + '" y2="' + yy + '"/>');
      svg.push('<text class="viz-tick" x="' + (margeG - 10) + '" y="' + (yy + 4)
        + '" text-anchor="end">' + fr(v) + '</text>');
    });
    svg.push('</g>');
    svg.push('<line class="viz-axe" x1="' + margeG + '" y1="' + y(0) + '" x2="' + (L - margeD) + '" y2="' + y(0) + '"/>');

    ANNEES.forEach(function (a, n) {
      var annee = a[0], valeur = a[1];
      var xBande = margeG + n * bande;
      var xBarre = xBande + (bande - largeurBarre) / 2;
      var hauteur = Math.max(2, hauteurTrace * (valeur / MAX));
      var yBarre = y(valeur);
      var accent = annee === ACCENT;

      svg.push('<g class="viz-bande" data-annee="' + annee + '" data-valeur="' + valeur + '">');
      // Zone de survol sur toute la hauteur : viser une barre de 2px de haut
      // (2013) serait sinon impossible.
      svg.push('<rect x="' + xBande + '" y="' + margeHaut + '" width="' + bande
        + '" height="' + hauteurTrace + '" fill="transparent"/>');
      svg.push('<path class="viz-barre' + (accent ? ' est-accent' : '') + '" d="'
        + cheminBarre(xBarre, yBarre, largeurBarre, hauteur, 4) + '"/>');
      svg.push('</g>');

      // Étiquettes d'années espacées : les 21 côte à côte se chevaucheraient.
      if (annee % 5 === 0 || accent) {
        svg.push('<text class="viz-annee" x="' + (xBande + bande / 2) + '" y="' + (H - 12)
          + '" text-anchor="middle">' + annee + '</text>');
      }
    });

    // Étiquette directe sur la seule année qui porte l'histoire — et non une
    // valeur sur chaque barre, qui ne se lirait plus.
    var derniere = ANNEES[ANNEES.length - 1];
    var avantDerniere = ANNEES[ANNEES.length - 2];
    // Posée à gauche de la barre, pas au-dessus : la barre monte presque au
    // sommet du tracé, une étiquette centrée dessus déborderait du cadre.
    var xAccent = margeG + (ANNEES.length - 1) * bande + bande / 2 - largeurBarre / 2 - 10;
    var facteur = (derniere[1] / avantDerniere[1]).toFixed(1).replace('.', ',');
    svg.push('<text class="viz-etiquette" x="' + xAccent + '" y="' + (y(derniere[1]) + 4)
      + '" text-anchor="end">' + fr(derniere[1]) + ' ha</text>');
    svg.push('<text class="viz-etiquette-sous" x="' + xAccent + '" y="' + (y(derniere[1]) + 20)
      + '" text-anchor="end">' + facteur + '× l’an dernier</text>');

    svg.push('</svg>');
    hote.innerHTML = svg.join('');

    // Tableau équivalent : la même donnée reste accessible sans le graphique.
    var tab = document.getElementById('viz-table');
    if (tab) {
      tab.innerHTML = '<table><thead><tr><th>Année</th><th>Hectares brûlés</th></tr></thead><tbody>'
        + ANNEES.slice().reverse().map(function (a) {
          return '<tr><td>' + a[0] + '</td><td>' + fr(a[1]) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }

    // Infobulle au survol : un graphique en HTML est interactif par nature.
    var bulle = document.getElementById('viz-infobulle');
    if (!bulle) return;
    hote.querySelectorAll('.viz-bande').forEach(function (g) {
      g.addEventListener('mouseenter', function () {
        bulle.innerHTML = '<b>' + g.dataset.annee + '</b> · '
          + fr(Number(g.dataset.valeur)) + ' ha';
        bulle.hidden = false;
      });
      g.addEventListener('mousemove', function (e) {
        bulle.style.left = (e.clientX + 14) + 'px';
        bulle.style.top = (e.clientY - 36) + 'px';
      });
      g.addEventListener('mouseleave', function () { bulle.hidden = true; });
    });
  }

  dessinerGraphique();
})();
