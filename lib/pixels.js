// Grille de pixels au sol et extraction de ses contours.
//
// C'est la forme qu'ont réellement les emprises du site de référence
// (github.com/nicolaslecorvec/fumees-nouvelle_aquitaine) : leurs polygones
// sont quantifiés sur une grille — les pas entre sommets consécutifs valent
// 0,002248° en latitude et 0,003163° en longitude, soit 250 m dans les deux
// sens à cette latitude. D'où les bords « en escalier », en pixels carrés, et
// non des arrondis. On travaille ici à une maille bien plus fine.
//
// Plutôt que de fusionner des milliers de disques (coûteux, et qui donne des
// bords arrondis puis des interstices), on marque les cellules touchées puis
// on extrait la frontière de l'ensemble : chaque côté de cellule qui n'est
// pas partagé avec une autre cellule occupée appartient au contour. Les côtés
// restants se chaînent en anneaux fermés. C'est exact, sans approximation.
//
// La grille est un tableau typé indexé par (ligne, colonne), et non une table
// de hachage à clés textuelles : à cette finesse, une détection marque
// plusieurs centaines de cellules, et le coût des clés textuelles devenait le
// poste dominant — une quinzaine de secondes, contre moins d'une ici.

const METRES_PAR_DEGRE_LAT = 111320;

// Pas de grille au sol, en mètres. Descendre plus bas ne changerait presque
// rien à l'image : la forme est dictée par l'empreinte des capteurs (voir
// RAYON_M dans etatFeux.js), pas par cette maille — à titre de mesure, passer
// de 40 à 20 m laisse le poids de la réponse inchangé, signe que les sommets
// du contour viennent des empreintes et non des marches d'escalier.
const PAS_M = 20;

// Garde-fou mémoire : au-delà, on refuse d'allouer la grille plutôt que de
// faire tomber la fonction sur un dépassement mémoire. Les valeurs tenant
// dans un entier 32 bits (voir creerGrille), 16 M de cellules pèsent 64 Mo —
// large sous la mémoire d'une fonction Vercel.
const MAX_CELLULES_GRILLE = 16e6;

function pasEnDegres(latReference, pasM) {
  const m = pasM || PAS_M;
  const dLat = m / METRES_PAR_DEGRE_LAT;
  const cos = Math.max(Math.cos(latReference * Math.PI / 180), 0.2);
  const dLon = m / (METRES_PAR_DEGRE_LAT * cos);
  return { dLat, dLon, pasM: m };
}

// Indices entiers de la cellule contenant un point.
function celluleDe(lat, lon, origine, pas) {
  return {
    i: Math.floor((lat - origine.lat) / pas.dLat),
    j: Math.floor((lon - origine.lon) / pas.dLon),
  };
}

/**
 * Grille rectangulaire de valeurs par cellule (0 = cellule vide).
 * `i0`/`j0` sont les indices de la cellule du coin bas-gauche.
 *
 * Les valeurs sont des entiers 32 bits non signés — c'est le poste mémoire
 * dominant, et le diviser par deux par rapport à des flottants double permet
 * de couvrir un feu deux fois plus étendu à la même finesse. Les horodatages
 * y sont donc rangés en minutes et non en millisecondes (voir etatFeux.js).
 */
function creerGrille(i0, j0, hauteur, largeur) {
  const total = hauteur * largeur;
  if (!(total > 0) || total > MAX_CELLULES_GRILLE) {
    throw new Error('grille trop grande (' + total + ' cellules)');
  }
  return { i0, j0, hauteur, largeur, valeurs: new Uint32Array(total) };
}

function indexDe(grille, i, j) {
  const li = i - grille.i0;
  const co = j - grille.j0;
  if (li < 0 || co < 0 || li >= grille.hauteur || co >= grille.largeur) return -1;
  return li * grille.largeur + co;
}

// Deux entiers de grille combinés en une clé numérique : bien plus rapide
// qu'une concaténation de chaînes, sur des millions d'opérations.
//
// Le BIAIS est indispensable : les indices sont relatifs à l'origine de la
// grille et deviennent négatifs à l'ouest ou au sud de celle-ci. Sans lui, le
// reste d'une clé négative est négatif et le décodage renvoie des
// coordonnées absurdes. Avec ce biais, les deux composantes restent dans
// [0, 2^25), et leur combinaison sous 2^50 — donc exacte en flottant double.
const BIAIS = 1 << 24;
const DECALAGE = 1 << 25;

function clePoint(i, j) { return (i + BIAIS) * DECALAGE + (j + BIAIS); }

// Frontière d'un sous-ensemble de cellules, sous forme d'anneaux fermés.
// `indices` : positions dans la grille appartenant à l'ensemble ; `masque` :
// Uint8Array de travail de même taille que la grille, remis à zéro en sortie.
function anneauxFrontiere(grille, indices, masque) {
  for (let n = 0; n < indices.length; n++) masque[indices[n]] = 1;

  const largeur = grille.largeur;
  // Chaque côté est orienté pour que l'intérieur reste à gauche : les anneaux
  // extérieurs et les trous sortent alors avec des sens opposés, ce qui les
  // rend distinguables par le signe de leur aire.
  const cotes = new Map();   // coin de départ -> suite plate de coins d'arrivée

  function ajouter(ai, aj, bi, bj) {
    const k = clePoint(ai, aj);
    const liste = cotes.get(k);
    if (liste) { liste.push(bi, bj); } else { cotes.set(k, [bi, bj]); }
  }

  for (let n = 0; n < indices.length; n++) {
    const idx = indices[n];
    const li = (idx / largeur) | 0;
    const co = idx - li * largeur;
    const i = li + grille.i0;
    const j = co + grille.j0;

    // Un côté n'appartient au contour que si la cellule voisine de l'autre
    // côté est vide : sinon il est intérieur à la forme. Hors grille compte
    // comme vide.
    const bas = li > 0 ? masque[idx - largeur] : 0;
    const haut = li < grille.hauteur - 1 ? masque[idx + largeur] : 0;
    const gauche = co > 0 ? masque[idx - 1] : 0;
    const droite = co < largeur - 1 ? masque[idx + 1] : 0;

    if (!bas) ajouter(i, j, i, j + 1);
    if (!droite) ajouter(i, j + 1, i + 1, j + 1);
    if (!haut) ajouter(i + 1, j + 1, i + 1, j);
    if (!gauche) ajouter(i + 1, j, i, j);
  }

  const anneaux = [];
  cotes.forEach((liste, cle) => {
    while (liste.length) {
      const brutJ = cle % DECALAGE;
      const departJ = brutJ - BIAIS;
      const departI = (cle - brutJ) / DECALAGE - BIAIS;
      const anneau = [departI, departJ];
      let cj = liste.pop();
      let ci = liste.pop();
      anneau.push(ci, cj);

      let securite = 0;
      while (securite++ < 4000000) {
        const suite = cotes.get(clePoint(ci, cj));
        if (!suite || !suite.length) break;
        cj = suite.pop();
        ci = suite.pop();
        anneau.push(ci, cj);
        if (ci === departI && cj === departJ) break;
      }

      if (anneau.length >= 8) anneaux.push(anneau);
    }
  });

  for (let n = 0; n < indices.length; n++) masque[indices[n]] = 0;
  return anneaux;
}

// Convertit un anneau (suite plate d'indices de coins) en coordonnées
// géographiques, en supprimant les sommets alignés : une longue arête droite
// n'a pas besoin d'un point par cellule traversée. La forme en escalier est
// conservée à l'identique, seuls les points redondants disparaissent.
function anneauEnCoordonnees(plat, origine, pas, facteur) {
  // Le chaînage revient à son point de départ : ce doublon final part avant
  // la détection des alignements, qui raisonne en cyclique.
  let n = plat.length / 2;
  if (n > 1 && plat[0] === plat[(n - 1) * 2] && plat[1] === plat[(n - 1) * 2 + 1]) n -= 1;
  if (n < 3) return null;

  const points = [];
  for (let k = 0; k < n; k++) {
    const p = ((k - 1 + n) % n) * 2;
    const s = ((k + 1) % n) * 2;
    const ai = plat[p], aj = plat[p + 1];
    const bi = plat[k * 2], bj = plat[k * 2 + 1];
    const ci = plat[s], cj = plat[s + 1];
    if ((ai === bi && bi === ci) || (aj === bj && bj === cj)) continue;   // aligné
    points.push([
      Math.round((origine.lon + bj * pas.dLon) * facteur) / facteur,
      Math.round((origine.lat + bi * pas.dLat) * facteur) / facteur,
    ]);
  }
  if (points.length < 3) return null;
  points.push([points[0][0], points[0][1]]);   // GeoJSON exige un anneau refermé
  return points;
}

// Aire signée d'un anneau. Le signe distingue un contour extérieur d'un
// trou : les côtés étant orientés intérieur-à-gauche, les deux tournent en
// sens inverse l'un de l'autre.
function aireSignee(points) {
  let s = 0;
  for (let n = 0; n < points.length - 1; n++) {
    s += points[n][0] * points[n + 1][1] - points[n + 1][0] * points[n][1];
  }
  return s / 2;
}

function pointDansAnneau(x, y, anneau) {
  let dedans = false;
  for (let a = 0, b = anneau.length - 1; a < anneau.length; b = a++) {
    const xi = anneau[a][0], yi = anneau[a][1];
    const xj = anneau[b][0], yj = anneau[b][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) dedans = !dedans;
  }
  return dedans;
}

/**
 * Surfaces pleines d'un sous-ensemble de cellules, en MultiPolygon —
 * contours extérieurs et trous correctement appariés, pour un remplissage
 * exact.
 */
function polygonesDeCellules(grille, indices, masque, origine, pas, decimales) {
  if (!indices.length) return null;
  const facteur = Math.pow(10, decimales == null ? 5 : decimales);
  const anneaux = anneauxFrontiere(grille, indices, masque)
    .map((a) => anneauEnCoordonnees(a, origine, pas, facteur))
    .filter(Boolean);
  if (!anneaux.length) return null;

  const exterieurs = [];
  const trous = [];
  anneaux.forEach((a) => {
    if (aireSignee(a) >= 0) exterieurs.push({ anneau: a, trous: [] });
    else trous.push(a);
  });

  // Un trou appartient au plus petit contour extérieur qui le contient :
  // avec des formes imbriquées, le plus grand en engloberait d'autres.
  trous.forEach((t) => {
    const p = t[0];
    let choisi = null, aireChoisie = Infinity;
    exterieurs.forEach((e) => {
      if (!pointDansAnneau(p[0], p[1], e.anneau)) return;
      const aire = Math.abs(aireSignee(e.anneau));
      if (aire < aireChoisie) { aireChoisie = aire; choisi = e; }
    });
    if (choisi) choisi.trous.push(t);
  });

  const polygones = exterieurs.map((e) => [e.anneau].concat(e.trous));
  if (!polygones.length) return null;
  return { type: 'MultiPolygon', coordinates: polygones };
}

module.exports = {
  pasEnDegres, celluleDe, creerGrille, indexDe, polygonesDeCellules,
  PAS_M, MAX_CELLULES_GRILLE,
};
