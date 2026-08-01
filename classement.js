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
    [2026, 93490],
  ];
  var ACCENT_ANNEE = 2026;

  // ── Surface brûlée en 2026, au fil de la saison ─────────────────────────
  // Cumul depuis le 1er janvier, à quelques dates relevées au fil de l'été —
  // pas un suivi quotidien continu, la note sous le graphique le dit.
  var JOURS_2026 = [
    { date: '1er juil.', valeur: 28638 },
    { date: '8 juil.', valeur: 39282 },
    { date: '15 juil.', valeur: 43710 },
    { date: '22 juil.', valeur: 86259 },
    { date: '1er août', valeur: 93490 },
  ];

  function fr(n) { return n.toLocaleString('fr-FR'); }
  function echapper(s) {
    return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; });
  }

  // ── Bandeaux chiffre-clé ────────────────────────────────────────────
  // Juste le nombre qui résume la section : la tendance elle-même est
  // maintenant portée par le grand graphique juste en dessous, pas par le
  // bandeau (voir l'historique : une mini-courbe redondante avec le grand
  // graphique n'apportait rien, à part faire deux fois la même lecture).
  function bandeau(id, kicker, nombre, statut) {
    var hote = document.getElementById(id);
    if (!hote) return;
    hote.innerHTML = '<div class="bandeau-kicker">' + echapper(kicker) + '</div>'
      + '<div class="bandeau-nombre">' + nombre + '</div>'
      + '<div class="bandeau-statut">' + echapper(statut) + '</div>';
  }

  // ── Graphique en ligne, cliquable ───────────────────────────────────
  // Un seul rendu partagé par les deux sections : les points, l'axe, la
  // grille et l'interaction (survol ET clic — un doigt sur mobile ne
  // déclenche jamais mouseenter) sont identiques, seules les données et les
  // légendes de bulle changent.
  var bulle = document.getElementById('viz-infobulle');
  var pointEpingle = null;   // le groupe <g> actuellement épinglé par un clic, ou null

  function masquerBulle() {
    if (!bulle) return;
    bulle.hidden = true;
  }
  function afficherBulle(html, x, y) {
    if (!bulle) return;
    bulle.innerHTML = html;
    bulle.style.left = x + 'px';
    bulle.style.top = y + 'px';
    bulle.hidden = false;
  }
  // Un clic hors de tout point désépingle : sinon la bulle resterait affichée
  // indéfiniment après un clic ailleurs sur la page.
  document.addEventListener('click', function () {
    if (pointEpingle) { pointEpingle = null; masquerBulle(); }
  });

  function dessinerLigneCliquable(idHote, points, opts) {
    var hote = document.getElementById(idHote);
    if (!hote) return;

    var L = 960, H = 380;
    var margeG = 58, margeD = 14, margeHaut = 34, margeBas = 34;
    var largeurTrace = L - margeG - margeD;
    var hauteurTrace = H - margeHaut - margeBas;

    var max = opts.max;
    var pas = largeurTrace / Math.max(1, points.length - 1);
    var x = function (i) { return margeG + i * pas; };
    var y = function (v) { return margeHaut + hauteurTrace * (1 - v / max); };

    var svg = ['<svg viewBox="0 0 ' + L + ' ' + H + '" role="img" aria-label="' + echapper(opts.ariaLabelSvg) + '">'];

    svg.push('<g class="viz-grille">');
    opts.paliers.forEach(function (v) {
      var yy = y(v);
      svg.push('<line x1="' + margeG + '" y1="' + yy + '" x2="' + (L - margeD) + '" y2="' + yy + '"/>');
      svg.push('<text class="viz-tick" x="' + (margeG - 10) + '" y="' + (yy + 4) + '" text-anchor="end">' + fr(v) + '</text>');
    });
    svg.push('</g>');
    svg.push('<line class="viz-axe" x1="' + margeG + '" y1="' + y(0) + '" x2="' + (L - margeD) + '" y2="' + y(0) + '"/>');

    var d = points.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.valeur).toFixed(1); }).join('');
    svg.push('<path class="viz-ligne" d="' + d + '"/>');

    points.forEach(function (p, i) {
      var xx = x(i), yy = y(p.valeur);
      if (p.xLabel) {
        svg.push('<text class="viz-annee" x="' + xx + '" y="' + (H - 12) + '" text-anchor="middle">' + echapper(p.xLabel) + '</text>');
      }
      // Cible invisible plus large que le point : viser un rond de 3px avec
      // le doigt serait sinon illusoire.
      svg.push('<g class="viz-point-groupe" tabindex="0" role="button" aria-label="' + echapper(p.aria) + '" data-i="' + i + '">'
        + '<circle class="viz-cible" cx="' + xx + '" cy="' + yy + '" r="14"/>'
        + '<circle class="viz-point' + (p.accent ? ' est-accent' : '') + '" cx="' + xx + '" cy="' + yy + '" r="' + (p.accent ? 4.5 : 3) + '"/>'
        + '</g>');
    });

    if (opts.etiquette) {
      var dernier = points[points.length - 1];
      var xEtiq = x(points.length - 1) - 10;
      svg.push('<text class="viz-etiquette" x="' + xEtiq + '" y="' + (y(dernier.valeur) - 12) + '" text-anchor="end">' + opts.etiquette + '</text>');
      if (opts.etiquetteSous) {
        svg.push('<text class="viz-etiquette-sous" x="' + xEtiq + '" y="' + (y(dernier.valeur) + 4) + '" text-anchor="end">' + opts.etiquetteSous + '</text>');
      }
    }

    svg.push('</svg>');
    hote.innerHTML = svg.join('');

    hote.querySelectorAll('.viz-point-groupe').forEach(function (g) {
      var p = points[Number(g.dataset.i)];

      g.addEventListener('mouseenter', function (e) {
        if (!pointEpingle) afficherBulle(p.infobulle, e.clientX + 14, e.clientY - 36);
      });
      g.addEventListener('mousemove', function (e) {
        if (!pointEpingle) { bulle.style.left = (e.clientX + 14) + 'px'; bulle.style.top = (e.clientY - 36) + 'px'; }
      });
      g.addEventListener('mouseleave', function () {
        if (!pointEpingle) masquerBulle();
      });

      // Le clic épingle la bulle près du point plutôt que du curseur : au
      // clavier ou au doigt, il n'y a pas de position de souris à suivre.
      g.addEventListener('click', function (e) {
        e.stopPropagation();
        if (pointEpingle === g) { pointEpingle = null; masquerBulle(); return; }
        pointEpingle = g;
        var r = g.querySelector('.viz-cible').getBoundingClientRect();
        afficherBulle(p.infobulle, r.left + r.width / 2 + 12, r.top - 8);
      });
      g.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); g.click(); }
      });
    });
  }

  function dessinerAnnees() {
    var derniere = ANNEES[ANNEES.length - 1];
    var avantDerniere = ANNEES[ANNEES.length - 2];
    var facteur = (derniere[1] / avantDerniere[1]).toFixed(1).replace('.', ',');

    var points = ANNEES.map(function (a) {
      var annee = a[0], valeur = a[1];
      var accent = annee === ACCENT_ANNEE;
      return {
        xLabel: String(annee),
        valeur: valeur,
        accent: accent,
        aria: annee + ' : ' + fr(valeur) + ' hectares',
        infobulle: '<b>' + annee + '</b> · ' + fr(valeur) + ' ha' + (accent ? '<br>pire année de la série' : ''),
      };
    });

    dessinerLigneCliquable('viz', points, {
      max: 100000,
      paliers: [0, 25000, 50000, 75000, 100000],
      ariaLabelSvg: 'Surface brûlée en France par année, de 2006 à 2026, en hectares — cliquez un point pour le détail',
      etiquette: fr(derniere[1]) + ' ha',
      etiquetteSous: facteur + '× l’an dernier',
    });

    var tab = document.getElementById('viz-table');
    if (tab) {
      tab.innerHTML = '<table><thead><tr><th>Année</th><th>Hectares brûlés</th></tr></thead><tbody>'
        + ANNEES.slice().reverse().map(function (a) {
          return '<tr><td>' + a[0] + '</td><td>' + fr(a[1]) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
  }

  function dessinerJours() {
    var dernier = JOURS_2026[JOURS_2026.length - 1];

    var points = JOURS_2026.map(function (j, i) {
      var accent = i === JOURS_2026.length - 1;
      return {
        xLabel: j.date,
        valeur: j.valeur,
        accent: accent,
        aria: j.date + ' 2026 : ' + fr(j.valeur) + ' hectares cumulés',
        infobulle: '<b>' + j.date + ' 2026</b> · ' + fr(j.valeur) + ' ha cumulés',
      };
    });

    dessinerLigneCliquable('viz-jours', points, {
      max: 100000,
      paliers: [0, 25000, 50000, 75000, 100000],
      ariaLabelSvg: 'Surface brûlée cumulée en France en 2026, en hectares, au fil de la saison — cliquez un point pour le détail',
      etiquette: fr(dernier.valeur) + ' ha',
      etiquetteSous: 'au ' + dernier.date,
    });

    var tab = document.getElementById('viz-jours-table');
    if (tab) {
      tab.innerHTML = '<table><thead><tr><th>Date</th><th>Hectares cumulés</th></tr></thead><tbody>'
        + JOURS_2026.slice().reverse().map(function (j) {
          return '<tr><td>' + j.date + '</td><td>' + fr(j.valeur) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
  }

  var dernierJour = JOURS_2026[JOURS_2026.length - 1];
  var derniereAnnee = ANNEES[ANNEES.length - 1];
  bandeau('bandeau-jour', 'France · au ' + dernierJour.date + ' 2026', fr(dernierJour.valeur) + ' hectares', 'Pire année de la série');
  bandeau('bandeau-annee', 'France · bilan ' + derniereAnnee[0], fr(derniereAnnee[1]) + ' hectares', 'Pire année de la série');

  dessinerJours();
  dessinerAnnees();
})();
