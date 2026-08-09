// Front plausible à court terme (+1 h / +3 h) — portage de
// pipeline/scripts/experiments/09_plausible_front_v2.py (et de ses
// dépendances 06_/07_) du dépôt de référence nicolaslecorvec/fumees-
// nouvelle_aquitaine (voir handoff).
//
// L'idée : entre deux passages satellite, le contour actuellement détecté
// (« observé ») s'est déplacé d'une certaine distance sur son pourtour. En
// mesurant cette distance là où elle est fiable (bord cohérent avec le
// passage précédent, pas juste un nouveau foyer disjoint) et en la
// reprojetant prudemment, on obtient une extension plausible du feu — pas
// un périmètre officiel, une estimation prudente (facteur 0,25 sur la
// vitesse mesurée, plafond 2 km).
//
// Simplification assumée par rapport au dépôt de référence : celui-ci
// utilise scipy.ndimage.distance_transform_edt, une transformée de distance
// euclidienne exacte. Ici on utilise un chanfrein à deux passes (poids 1 /
// √2), une approximation à quelques % près — largement suffisante pour une
// estimation déjà volontairement approximative, et bien plus simple à
// porter correctement qu'un algorithme d'enveloppe inférieure exact.

const { instrumentDe, distanceM } = require('./confianceDetections');

// ── Transformée de distance (chanfrein, deux passes) ───────────────────────
//
// Pour chaque cellule, distance approximative (en cellules) à la source la
// plus proche, plus les coordonnées de cette source — l'équivalent de
// scipy.ndimage.distance_transform_edt(..., return_indices=True), en O(n)
// à deux passes plutôt qu'un algorithme d'enveloppe inférieure exact.
const POIDS_ORTHO = 1;
const POIDS_DIAG = Math.SQRT2;
const INFINI = Infinity;

function creerTransformeDistance(masqueSource, largeur, hauteur) {
  const total = largeur * hauteur;
  const dist = new Float64Array(total).fill(INFINI);
  const sourceI = new Int32Array(total).fill(-1);
  const sourceJ = new Int32Array(total).fill(-1);

  for (let idx = 0; idx < total; idx++) {
    if (masqueSource[idx]) {
      dist[idx] = 0;
      const li = (idx / largeur) | 0;
      sourceI[idx] = li;
      sourceJ[idx] = idx - li * largeur;
    }
  }

  function relaxer(idx, voisinIdx, poids) {
    if (voisinIdx < 0 || dist[voisinIdx] === INFINI) return;
    const candidat = dist[voisinIdx] + poids;
    if (candidat < dist[idx]) {
      dist[idx] = candidat;
      sourceI[idx] = sourceI[voisinIdx];
      sourceJ[idx] = sourceJ[voisinIdx];
    }
  }

  // Passe avant : haut-gauche vers bas-droite.
  for (let li = 0; li < hauteur; li++) {
    const base = li * largeur;
    for (let co = 0; co < largeur; co++) {
      const idx = base + co;
      if (dist[idx] === 0) continue;
      if (li > 0) {
        relaxer(idx, idx - largeur, POIDS_ORTHO);
        if (co > 0) relaxer(idx, idx - largeur - 1, POIDS_DIAG);
        if (co < largeur - 1) relaxer(idx, idx - largeur + 1, POIDS_DIAG);
      }
      if (co > 0) relaxer(idx, idx - 1, POIDS_ORTHO);
    }
  }

  // Passe arrière : bas-droite vers haut-gauche.
  for (let li = hauteur - 1; li >= 0; li--) {
    const base = li * largeur;
    for (let co = largeur - 1; co >= 0; co--) {
      const idx = base + co;
      if (dist[idx] === 0) continue;
      if (li < hauteur - 1) {
        relaxer(idx, idx + largeur, POIDS_ORTHO);
        if (co > 0) relaxer(idx, idx + largeur - 1, POIDS_DIAG);
        if (co < largeur - 1) relaxer(idx, idx + largeur + 1, POIDS_DIAG);
      }
      if (co < largeur - 1) relaxer(idx, idx + 1, POIDS_ORTHO);
    }
  }

  return { dist, sourceI, sourceJ };
}

// ── Bord d'une forme (érosion 3×3) ──────────────────────────────────────────
//
// Une cellule appartient au bord si elle est dans le masque mais qu'au moins
// un de ses 8 voisins n'y est pas — hors grille compte comme absent (même
// convention que border_value=0 côté scipy). C'est sur ce bord, et seulement
// lui, que la vitesse apparente est mesurée : l'intérieur d'une tache n'a
// jamais bougé, il ne dit rien sur la progression.
function masqueBord(masque, largeur, hauteur) {
  const bord = new Uint8Array(largeur * hauteur);
  for (let li = 0; li < hauteur; li++) {
    const base = li * largeur;
    for (let co = 0; co < largeur; co++) {
      const idx = base + co;
      if (!masque[idx]) continue;
      let entoure = true;
      for (let di = -1; di <= 1 && entoure; di++) {
        const l2 = li + di;
        if (l2 < 0 || l2 >= hauteur) { entoure = false; break; }
        const base2 = l2 * largeur;
        for (let dj = -1; dj <= 1; dj++) {
          const c2 = co + dj;
          if (c2 < 0 || c2 >= largeur || !masque[base2 + c2]) { entoure = false; break; }
        }
      }
      if (!entoure) bord[idx] = 1;
    }
  }
  return bord;
}

// ── Lissage gaussien normalisé (séparable) ──────────────────────────────────
//
// Équivalent de scipy.ndimage.gaussian_filter(sigma=1.5) suivi d'une division
// normalisée (numerator/denominator, where=denominator>0) : on lisse à la
// fois le champ de vitesse brut et le masque de présence (0/1), puis on
// divise l'un par l'autre. Sans cette normalisation, les nombreuses cellules
// à zéro (hors du bord cohérent) tireraient la moyenne vers le bas near
// n'importe quelle cellule active isolée.
function noyauGaussien(sigma) {
  const rayon = Math.max(1, Math.ceil(3 * sigma));
  const noyau = new Float64Array(2 * rayon + 1);
  let somme = 0;
  for (let k = -rayon; k <= rayon; k++) {
    const v = Math.exp(-(k * k) / (2 * sigma * sigma));
    noyau[k + rayon] = v;
    somme += v;
  }
  for (let k = 0; k < noyau.length; k++) noyau[k] /= somme;
  return { noyau, rayon };
}

function convolueSepare(grille, largeur, hauteur, noyauInfo) {
  const { noyau, rayon } = noyauInfo;
  const tmp = new Float64Array(largeur * hauteur);
  const sortie = new Float64Array(largeur * hauteur);

  // Horizontal.
  for (let li = 0; li < hauteur; li++) {
    const base = li * largeur;
    for (let co = 0; co < largeur; co++) {
      let s = 0;
      for (let k = -rayon; k <= rayon; k++) {
        const c2 = co + k;
        if (c2 < 0 || c2 >= largeur) continue; // mode="constant" (0 hors grille)
        s += grille[base + c2] * noyau[k + rayon];
      }
      tmp[base + co] = s;
    }
  }
  // Vertical.
  for (let li = 0; li < hauteur; li++) {
    const base = li * largeur;
    for (let co = 0; co < largeur; co++) {
      let s = 0;
      for (let k = -rayon; k <= rayon; k++) {
        const l2 = li + k;
        if (l2 < 0 || l2 >= hauteur) continue;
        s += tmp[l2 * largeur + co] * noyau[k + rayon];
      }
      sortie[base + co] = s;
    }
  }
  return sortie;
}

const NOYAU_SIGMA_1_5 = noyauGaussien(1.5);

// ── Distance caractéristique d'un passage (06_/07_) ─────────────────────────
//
// Espacement typique entre détections d'un même passage satellite (percentile
// 75 de la distance au plus proche voisin), rétréci vers une valeur de
// référence par instrument quand le passage a peu de détections — un passage
// de 3 points ne dit presque rien sur l'espacement réel, un passage de 300
// points si.
const REFERENCE_M = { VIIRS: 430, MODIS: 1112 };
const BORNES_M = { VIIRS: [300, 800], MODIS: [700, 1500] };

// Distance caractéristique brute (percentile 75 du plus proche voisin) d'un
// ensemble de points d'un même passage. O(n²) : un passage tient sur une
// grille FIRMS locale, jamais plus de quelques centaines de points.
function distanceCaracteristiqueBrute(points) {
  if (points.length < 2) return NaN;
  const plusProches = points.map((p, n) => {
    let meilleure = Infinity;
    for (let k = 0; k < points.length; k++) {
      if (k === n) continue;
      const d = distanceM(p.lat, p.lon, points[k].lat, points[k].lon);
      if (d < meilleure) meilleure = d;
    }
    return meilleure;
  }).sort((a, b) => a - b);
  const rang = Math.min(plusProches.length - 1, Math.ceil(0.75 * (plusProches.length - 1)));
  return plusProches[rang];
}

// Distance caractéristique régularisée d'un passage, en mètres — jamais NaN
// (repli sur la référence instrument à poids nul, comme le dépôt de
// référence : "instrument_fallback").
function distanceCaracteristique(points, capteur) {
  const instrument = instrumentDe(capteur);
  const reference = REFERENCE_M[instrument] || REFERENCE_M.VIIRS;
  const [bas, haut] = BORNES_M[instrument] || BORNES_M.VIIRS;
  const n = points.length;

  const brute = distanceCaracteristiqueBrute(points);
  if (!isFinite(brute) || n < 2) return reference;

  const bornee = Math.min(haut, Math.max(bas, brute));
  const poids = n / (n + 30);
  return poids * bornee + (1 - poids) * reference;
}

// ── Niveau de confiance (09_, confidence_level) ─────────────────────────────
function niveauConfiance(eligible, gapH, nPrecedent, nActuel, fractionCoherente) {
  if (!eligible) return 'indisponible';
  const nMin = Math.min(nPrecedent, nActuel);
  if (gapH <= 1.5 && nMin >= 50 && fractionCoherente >= 0.60) return 'elevee';
  if (gapH <= 3.0 && nMin >= 20 && fractionCoherente >= 0.40) return 'moyenne';
  return 'faible';
}

// ── Projection (09_, cœur de l'algorithme) ──────────────────────────────────
const GAP_MAX_H = 3.0;
const OBSERVATIONS_MIN = 10;
const FRACTION_COHERENTE_MIN = 0.25;
const DISTANCE_PROJETEE_MAX_M = 2000;
const ECHELLE_VITESSE = 0.25;
const HORIZONS_H = [1, 3];

function compteVrais(masque) {
  let n = 0;
  for (let i = 0; i < masque.length; i++) if (masque[i]) n++;
  return n;
}

/**
 * Calcule le front plausible entre un état précédent et l'état actuel d'un
 * même foyer. `masquePrecedent`/`masqueActuel` : Uint8Array de même forme
 * (largeur×hauteur), `cellM` : taille de cellule en mètres, `gapH` : écart en
 * heures entre les deux passages, `nPrecedent`/`nActuel` : nombre de
 * détections FIRMS ayant contribué à chaque passage (pas le nombre de
 * cellules), `distanceCaracteristiqueM` : voir distanceCaracteristique().
 *
 * Renvoie `{ confidence, coherentFraction, plus1h, plus3h }` — `plus1h`/
 * `plus3h` valent soit `null` (rien de plausible à ajouter : pas assez de
 * bord cohérent, gap trop grand, trop peu de détections...), soit un
 * Uint8Array (masqueActuel ∪ l'extension plausible) prêt à passer à
 * polygonesDeCellules pour son propre contour.
 */
function calculerFrontPlausible({
  masquePrecedent, masqueActuel, largeur, hauteur, cellM,
  gapH, nPrecedent, nActuel, distanceCaracteristiqueM,
}) {
  const resultatVide = { confidence: 'indisponible', coherentFraction: 0, medianSpeedKmh: null, plus1h: null, plus3h: null };

  const currentBoundary = masqueBord(masqueActuel, largeur, hauteur);
  const eligibleBasique = (
    gapH > 0 && gapH <= GAP_MAX_H
    && compteVrais(masquePrecedent) > 0
    && compteVrais(masqueActuel) > 0
    && compteVrais(currentBoundary) > 0
    && nPrecedent >= OBSERVATIONS_MIN
    && nActuel >= OBSERVATIONS_MIN
  );

  if (!eligibleBasique) {
    return Object.assign({}, resultatVide, {
      confidence: niveauConfiance(false, gapH, nPrecedent, nActuel, 0),
    });
  }

  const total = largeur * hauteur;
  const distanceCorrespondanceM = Math.min(2500, Math.max(1000, 1.5 * distanceCaracteristiqueM));
  const distanceCorrespondanceCellules = distanceCorrespondanceM / cellM;

  const { dist: distAuPrecedent } = creerTransformeDistance(masquePrecedent, largeur, hauteur);

  const bordCoherent = new Uint8Array(total);
  let nBordTotal = 0, nBordCoherent = 0;
  for (let idx = 0; idx < total; idx++) {
    if (!currentBoundary[idx]) continue;
    nBordTotal++;
    if (distAuPrecedent[idx] <= distanceCorrespondanceCellules) {
      bordCoherent[idx] = 1;
      nBordCoherent++;
    }
  }
  const fractionCoherente = nBordTotal > 0 ? nBordCoherent / nBordTotal : 0;

  const vitesseBrute = new Float64Array(total);
  const masqueCoherentF = new Float64Array(total);
  for (let idx = 0; idx < total; idx++) {
    if (!bordCoherent[idx]) continue;
    masqueCoherentF[idx] = 1;
    vitesseBrute[idx] = (distAuPrecedent[idx] * cellM) / gapH; // m/h
  }

  const numerateur = convolueSepare(vitesseBrute, largeur, hauteur, NOYAU_SIGMA_1_5);
  const denominateur = convolueSepare(masqueCoherentF, largeur, hauteur, NOYAU_SIGMA_1_5);
  const vitesseBord = new Float64Array(total);
  for (let idx = 0; idx < total; idx++) {
    if (!currentBoundary[idx] || denominateur[idx] <= 0) continue;
    vitesseBord[idx] = numerateur[idx] / denominateur[idx];
  }

  const eligible = eligibleBasique && fractionCoherente >= FRACTION_COHERENTE_MIN;
  const confidence = niveauConfiance(eligible, gapH, nPrecedent, nActuel, fractionCoherente);

  const vitessesPositives = [];
  for (let idx = 0; idx < total; idx++) if (vitesseBord[idx] > 0) vitessesPositives.push(vitesseBord[idx]);

  if (!eligible || !vitessesPositives.length) {
    return Object.assign({}, resultatVide, { confidence, coherentFraction: fractionCoherente });
  }

  vitessesPositives.sort((a, b) => a - b);
  const medianeMH = vitessesPositives[Math.floor(vitessesPositives.length / 2)];

  const { dist: distAuBord, sourceI, sourceJ } = creerTransformeDistance(currentBoundary, largeur, hauteur);

  const resultat = Object.assign({}, resultatVide, {
    confidence, coherentFraction: fractionCoherente, medianSpeedKmh: medianeMH / 1000,
  });

  HORIZONS_H.forEach((horizonH) => {
    const projete = new Uint8Array(total);
    for (let idx = 0; idx < total; idx++) {
      if (masqueActuel[idx]) { projete[idx] = 1; continue; }
      const si = sourceI[idx], sj = sourceJ[idx];
      if (si < 0) continue;
      const vitesseLocale = vitesseBord[si * largeur + sj];
      if (!(vitesseLocale > 0)) continue;
      const distanceProjeteeM = Math.min(vitesseLocale * horizonH * ECHELLE_VITESSE, DISTANCE_PROJETEE_MAX_M);
      if (distAuBord[idx] * cellM <= distanceProjeteeM) projete[idx] = 1;
    }
    resultat[horizonH === 1 ? 'plus1h' : 'plus3h'] = projete;
  });

  return resultat;
}

module.exports = {
  creerTransformeDistance, masqueBord, convolueSepare, NOYAU_SIGMA_1_5,
  distanceCaracteristique, niveauConfiance, calculerFrontPlausible,
  instrumentDe, distanceM,
};
