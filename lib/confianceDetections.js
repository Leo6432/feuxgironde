// Confiance des détections FIRMS par corroboration spatiale et temporelle,
// reprise de 02_build_spatiotemporal_support.py et 05_build_causal_support.py
// du dépôt nicolaslecorvec/fumees-nouvelle_aquitaine (voir aussi
// lib/sourcesRecurrentes.js pour l'autre volet du filtrage, les sources
// industrielles récurrentes).
//
// Un pixel thermique isolé — jamais revu par une détection voisine, ni au
// même passage satellite, ni à un passage antérieur proche — est plus souvent
// du bruit (reflet, pixel aberrant) qu'un feu réel. Sans aller jusqu'à
// l'écarter — un tout nouveau feu commence forcément par une détection
// isolée, et l'écarter reviendrait à ne jamais montrer un départ de feu tant
// qu'il n'a pas grandi — son empreinte au sol est réduite : elle retrouve sa
// taille normale dès qu'une détection voisine vient la corroborer.
//
// Trois classes, comme le dépôt de référence :
//   - même passage : une autre détection au même instant, à proximité —
//     la meilleure confirmation possible (deux pixels chauds voisins vus par
//     le même passage satellite) ;
//   - confirmé antérieurement : pas de voisin au même passage, mais une
//     détection PLUS ANCIENNE à proximité dans les 90 minutes — strictement
//     dans le passé, jamais dans le futur (support_class_causal du dépôt de
//     référence : une détection ne peut pas être confirmée par quelque chose
//     qui n'a pas encore eu lieu) ;
//   - isolée : aucun des deux — la seule classe qui réduit l'empreinte.

const METRES_PAR_DEGRE_LAT = 111320;

// Taille de cellule de l'index spatial : au-delà du plus grand seuil de
// corroboration (1750 m), avec marge, pour qu'un voisinage 3×3 de cellules
// couvre toujours entièrement le rayon de recherche autour d'un point, quelle
// que soit sa position dans sa propre cellule.
const TAILLE_CELLULE_KM = 2.5;

const MEME_PASSAGE_M = { VIIRS: 750, MODIS: 1500 };
const MEME_PASSAGE_M_DEFAUT = 750;
const TEMPOREL_M = { VIIRS: 1000, MODIS: 1750 };
const TEMPOREL_M_DEFAUT = 1000;
const FENETRE_TEMPORELLE_MIN = 90;

// Poids observationnel par classe — repris tel quel d'observation_weight /
// observation_weight_causal du dépôt de référence.
const POIDS = { meme_passage: 1.00, confirme_anterieur: 0.75, isole: 0.25 };

function instrumentDe(capteur) {
  // LANDSAT et tout capteur imprévu retombent sur les seuils VIIRS, comme le
  // faisait le repli `.get(instrument, 750.0)` du dépôt de référence — lui
  // n'avait de seuils dédiés que pour VIIRS et MODIS.
  return capteur.indexOf('MODIS') === 0 ? 'MODIS' : 'VIIRS';
}

function distanceM(latA, lonA, latB, lonB) {
  const dLat = (latB - latA) * METRES_PAR_DEGRE_LAT;
  const dLon = (lonB - lonA) * METRES_PAR_DEGRE_LAT * Math.cos(((latA + latB) / 2) * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

function pasLonDe(lat) {
  return TAILLE_CELLULE_KM / (111.32 * Math.max(Math.cos(lat * Math.PI / 180), 0.2));
}

function construireIndex(points) {
  const pasLat = TAILLE_CELLULE_KM / 111.32;
  const index = new Map();
  points.forEach((p, n) => {
    const gi = Math.floor(p.lat / pasLat);
    const gj = Math.floor(p.lon / pasLonDe(p.lat));
    const cle = gi + ':' + gj;
    let liste = index.get(cle);
    if (!liste) { liste = []; index.set(cle, liste); }
    liste.push(n);
  });
  return { index, pasLat };
}

function candidatsAutourDe(p, indexInfo) {
  const gi = Math.floor(p.lat / indexInfo.pasLat);
  const gj = Math.floor(p.lon / pasLonDe(p.lat));
  const out = [];
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const liste = indexInfo.index.get((gi + di) + ':' + (gj + dj));
      if (liste) out.push(...liste);
    }
  }
  return out;
}

// Ajoute `poids` (0.25 à 1) et `classeSupport` à chaque point, sans modifier
// les points d'origine. Coûte un parcours de l'index spatial par point — le
// même ordre de grandeur que le regroupement en foyers déjà fait ailleurs.
function classifier(points) {
  if (!points.length) return points;
  const indexInfo = construireIndex(points);

  return points.map((p, n) => {
    const instrument = instrumentDe(p.capteur);
    const seuilPassage = MEME_PASSAGE_M[instrument] || MEME_PASSAGE_M_DEFAUT;
    const seuilTemporel = TEMPOREL_M[instrument] || TEMPOREL_M_DEFAUT;
    const candidats = candidatsAutourDe(p, indexInfo);

    let memePassage = false;
    let confirmeAnterieur = false;
    for (let k = 0; k < candidats.length; k++) {
      const c = candidats[k];
      if (c === n) continue;
      const q = points[c];
      if (q.ts === p.ts) {
        if (distanceM(p.lat, p.lon, q.lat, q.lon) <= seuilPassage) { memePassage = true; break; }
        continue;
      }
      if (q.ts < p.ts
        && (p.ts - q.ts) / 60000 <= FENETRE_TEMPORELLE_MIN
        && distanceM(p.lat, p.lon, q.lat, q.lon) <= seuilTemporel) {
        confirmeAnterieur = true;
      }
    }

    const classe = memePassage ? 'meme_passage' : (confirmeAnterieur ? 'confirme_anterieur' : 'isole');
    return Object.assign({}, p, { poids: POIDS[classe], classeSupport: classe });
  });
}

// Facteur appliqué au rayon d'empreinte (voir marquer() dans etatFeux.js) :
// une détection isolée occupe moins de terrain qu'une détection corroborée,
// sans jamais disparaître — un vrai départ de feu, forcément isolé au tout
// premier passage, doit rester visible.
function facteurRayon(poids) {
  return poids == null ? 1 : 0.5 + 0.5 * poids;
}

module.exports = {
  classifier, facteurRayon, instrumentDe, distanceM,
  MEME_PASSAGE_M, TEMPOREL_M, FENETRE_TEMPORELLE_MIN, POIDS,
};
