(function () {
  'use strict';

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

    // Dégradé vertical léger : la barre s'éclaircit vers son sommet, ce qui la
    // détache du fond sans ajouter d'encre. L'écart reste faible — un dégradé
    // marqué ferait croire à une information supplémentaire qui n'existe pas.
    svg.push('<defs>'
      + '<linearGradient id="degradeBarre" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0%" stop-color="#b0633a"/><stop offset="100%" stop-color="#96502f"/>'
      + '</linearGradient>'
      + '<linearGradient id="degradeAccent" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0%" stop-color="#ff8a4d"/><stop offset="100%" stop-color="#e8632f"/>'
      + '</linearGradient>'
      + '</defs>');

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

  // ── Bandeaux chiffre-clé ────────────────────────────────────────────
  // Même langage que le graphique juste en dessous : mini-courbe, pas de
  // second axe, pas de graduation — un bandeau résume, il ne redouble pas
  // l'information détaillée qui suit.
  //
  // Rang 1 à 10 du classement des brasiers (voir la liste dans
  // classement.html) : seules les magnitudes sont reprises ici, pour la
  // mini-courbe du bandeau — le texte de chaque événement reste dans le HTML,
  // il n'y a pas de raison de le dupliquer en JS.
  var BRASIERS = [52000, 42000, 12500, 12500, 7100, 7000, 6600, 5700, 5600, 4900];

  function sparkline(valeurs) {
    var L = 160, H = 54, m = 4;
    var max = Math.max.apply(null, valeurs);
    var min = Math.min.apply(null, valeurs);
    var x = function (i) { return m + i * (L - 2 * m) / (valeurs.length - 1); };
    var y = function (v) { return H - m - (v - min) / ((max - min) || 1) * (H - 2 * m); };

    var d = valeurs.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join('');
    var derniereI = valeurs.length - 1;
    var points = valeurs.map(function (v, i) {
      // Le dernier point porte l'accent : c'est lui que le nombre du bandeau
      // commente, les précédents ne servent qu'à situer la tendance.
      var accent = i === derniereI;
      return '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="' + (accent ? 2.6 : 1.8)
        + '" fill="' + (accent ? '#ff8a4d' : '#e8632f') + '"/>';
    }).join('');

    return '<svg viewBox="0 0 ' + L + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">'
      + '<path d="' + d + '" fill="none" stroke="#e8632f" stroke-width="1.6" '
      + 'stroke-linejoin="round" stroke-linecap="round"/>' + points + '</svg>';
  }

  function bandeau(id, kicker, nombre, statut, valeurs) {
    var hote = document.getElementById(id);
    if (!hote) return;
    hote.innerHTML = '<div class="bandeau-texte">'
      + '<div class="bandeau-kicker">' + kicker + '</div>'
      + '<div class="bandeau-nombre">' + nombre + '</div>'
      + '<div class="bandeau-statut">' + statut + '</div>'
      + '</div>'
      + '<div class="bandeau-spark">' + sparkline(valeurs)
      + '<div class="bandeau-plage">' + fr(valeurs[0]) + ' → ' + fr(valeurs[valeurs.length - 1]) + ' ha</div></div>';
  }

  var derniereAnnee = ANNEES[ANNEES.length - 1];
  bandeau('bandeau-annee', 'France · bilan ' + derniereAnnee[0],
    fr(derniereAnnee[1]) + ' hectares', 'Pire année de la série',
    ANNEES.map(function (a) { return a[1]; }));

  bandeau('bandeau-record', 'France · record historique',
    fr(BRASIERS[0]) + ' hectares', 'Forêt des Landes, 1949',
    BRASIERS);

  dessinerGraphique();
})();
