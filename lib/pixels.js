// Union de cellules carrées sur une grille régulière, rendue en contours.
//
// C'est la forme qu'ont réellement les emprises du site de référence
// (github.com/nicolaslecorvec/fumees-nouvelle_aquitaine) : leurs polygones
// sont quantifiés sur une grille d'environ 250 m — les pas entre sommets
// consécutifs valent 0,002248° en latitude et 0,003163° en longitude, soit
// 250 m dans les deux sens à cette latitude. D'où les bords « en escalier »,
// en pixels carrés, et non des arrondis.
//
// Plutôt que de fusionner des milliers de disques (coûteux, et qui donne des
// bords arrondis puis des interstices), on marque les cellules touchées puis
// on extrait la frontière de l'ensemble : chaque côté de cellule qui n'est
// pas partagé avec une autre cellule occupée appartient au contour. Les côtés
// restants se chaînent en anneaux fermés. C'est exact, sans approximation, et
// linéaire en nombre de cellules.

const METRES_PAR_DEGRE_LAT = 111320;

// Pas de grille au sol, en mètres. 250 m reproduit leur quantification.
const PAS_M = 250;

function pasEnDegres(latReference) {
  const dLat = PAS_M / METRES_PAR_DEGRE_LAT;
  const cos = Math.max(Math.cos(latReference * Math.PI / 180), 0.2);
  const dLon = PAS_M / (METRES_PAR_DEGRE_LAT * cos);
  return { dLat, dLon };
}

// Indices entiers de la cellule contenant un point.
function celluleDe(lat, lon, origine, pas) {
  return {
    i: Math.floor((lat - origine.lat) / pas.dLat),
    j: Math.floor((lon - origine.lon) / pas.dLon),
  };
}

function cleCellule(i, j) { return i + ':' + j; }

// Frontière de l'ensemble de cellules occupées, sous forme d'anneaux fermés.
// `occupees` est un Set de clés "i:j".
function anneauxFrontiere(occupees) {
  // Chaque côté est orienté pour que l'intérieur reste à gauche : les
  // anneaux extérieurs et les trous sortent alors avec des sens opposés,
  // ce qui les rend distinguables sans test supplémentaire.
  const cotes = new Map();   // "ci:cj" du départ -> liste d'arrivées

  function ajouter(ai, aj, bi, bj) {
    const k = ai + ':' + aj;
    const liste = cotes.get(k);
    if (liste) liste.push([bi, bj]);
    else cotes.set(k, [[bi, bj]]);
  }

  occupees.forEach((k) => {
    const [i, j] = k.split(':').map(Number);
    // Un côté n'appartient au contour que si la cellule voisine de l'autre
    // côté est vide : sinon il est intérieur à la forme.
    if (!occupees.has(cleCellule(i - 1, j))) ajouter(i, j, i, j + 1);         // bas
    if (!occupees.has(cleCellule(i, j + 1))) ajouter(i, j + 1, i + 1, j + 1); // droite
    if (!occupees.has(cleCellule(i + 1, j))) ajouter(i + 1, j + 1, i + 1, j); // haut
    if (!occupees.has(cleCellule(i, j - 1))) ajouter(i + 1, j, i, j);         // gauche
  });

  const anneaux = [];
  cotes.forEach((liste, depart) => {
    while (liste.length) {
      // Chaînage : on suit les côtés bout à bout jusqu'à revenir au départ.
      const debut = depart.split(':').map(Number);
      const anneau = [debut];
      let courant = liste.pop();
      anneau.push(courant);

      let securite = 0;
      while (securite++ < 200000) {
        const k = courant[0] + ':' + courant[1];
        const suite = cotes.get(k);
        if (!suite || !suite.length) break;
        courant = suite.pop();
        anneau.push(courant);
        if (courant[0] === debut[0] && courant[1] === debut[1]) break;
      }

      if (anneau.length >= 4) anneaux.push(anneau);
    }
  });

  return anneaux;
}

// Supprime les sommets alignés : une longue arête droite n'a pas besoin d'un
// point par cellule traversée. La forme en escalier est conservée à
// l'identique, seuls les points redondants disparaissent.
function retirerPointsAlignes(anneau) {
  if (anneau.length < 3) return anneau;
  const out = [];
  for (let n = 0; n < anneau.length; n++) {
    const a = anneau[(n - 1 + anneau.length) % anneau.length];
    const b = anneau[n];
    const c = anneau[(n + 1) % anneau.length];
    const alignes = (a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]);
    if (!alignes) out.push(b);
  }
  return out.length >= 3 ? out : anneau;
}

// Convertit les anneaux (en indices de coins) en coordonnées géographiques.
function enCoordonnees(anneaux, origine, pas, decimales) {
  const f = Math.pow(10, decimales);
  return anneaux.map((anneauBrut) => {
    // Le chaînage revient à son point de départ : ce doublon final doit
    // partir avant la détection des alignements, qui raisonne en cyclique et
    // le compterait deux fois.
    let anneau = anneauBrut;
    const p = anneau[0], d = anneau[anneau.length - 1];
    if (anneau.length > 1 && p[0] === d[0] && p[1] === d[1]) anneau = anneau.slice(0, -1);

    const simple = retirerPointsAlignes(anneau);
    const points = simple.map(([i, j]) => [
      Math.round((origine.lon + j * pas.dLon) * f) / f,
      Math.round((origine.lat + i * pas.dLat) * f) / f,
    ]);
    // Anneau explicitement refermé, comme l'exige GeoJSON.
    const p0 = points[0];
    const pn = points[points.length - 1];
    if (p0[0] !== pn[0] || p0[1] !== pn[1]) points.push([p0[0], p0[1]]);
    return points;
  });
}

/**
 * Contour d'un ensemble de cellules, en LineString / MultiLineString.
 * `occupees` : Set de clés "i:j" ; `origine` et `pas` : repère de la grille.
 */
function contourDeCellules(occupees, origine, pas, decimales) {
  if (!occupees.size) return null;
  const anneaux = enCoordonnees(anneauxFrontiere(occupees), origine, pas, decimales == null ? 5 : decimales);
  if (!anneaux.length) return null;
  if (anneaux.length === 1) return { type: 'LineString', coordinates: anneaux[0] };
  return { type: 'MultiLineString', coordinates: anneaux };
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
 * Surfaces pleines d'un ensemble de cellules, en MultiPolygon — contours
 * extérieurs et trous correctement appariés, pour un remplissage exact.
 */
function polygonesDeCellules(occupees, origine, pas, decimales) {
  if (!occupees.size) return null;
  const anneaux = enCoordonnees(anneauxFrontiere(occupees), origine, pas, decimales == null ? 5 : decimales);
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
  pasEnDegres, celluleDe, cleCellule, contourDeCellules, polygonesDeCellules, PAS_M,
};
