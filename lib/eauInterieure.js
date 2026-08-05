// Emprise de l'eau intérieure (lacs, étangs, larges rivières) — pour exclure
// ces cellules d'une zone « brûlée » (voir zonesDepuisFoyers dans etatFeux.js).
//
// À la différence de lib/france.js (un seul contour, téléchargé une fois pour
// tout le pays), l'eau intérieure est trop nombreuse et trop détaillée pour
// tenir dans un fichier unique — ne serait-ce que les étangs du littoral
// aquitain (Lacanau, Cazaux, Hourtin) en plus des grands lacs alpins. On
// interroge donc Overpass (OpenStreetMap) par petites tuiles géographiques
// fixes, uniquement pour les foyers qui en ont besoin, et chaque tuile est
// mise en cache durablement — l'eau ne bouge pas plus que les frontières.
//
// Le dépôt de référence (voir handoff) masque avec ESA WorldCover, un raster
// 10 m : pour toute la France ça représente des gigaoctets, hors de portée
// d'une fonction Vercel. Des polygones vectoriels déjà simplifiés à la
// géométrie des voies/relations OSM restent, eux, de taille raisonnable par
// tuile.

const { dansGeometrie } = require('./france');

// ~22 km à cette latitude : assez grand pour qu'un foyer tienne dans une
// poignée de tuiles, assez petit pour qu'une requête Overpass reste rapide et
// ne heurte pas les limites de la source (voir MAX_TUILES_PAR_FOYER plus bas).
const TAILLE_TUILE_DEG = 0.2;

// Au-delà, un foyer couvrirait trop de tuiles à interroger d'un coup — un feu
// aussi étendu n'existe pas en pratique ; mieux vaut renoncer au masque eau
// pour ce foyer que de multiplier les requêtes réseau.
const MAX_TUILES_PAR_FOYER = 64;

const CLE_TUILE_PREFIXE = 'eau:tuile:v1:';
// Un plan d'eau ne se déplace pas : le cache peut être bien plus long que
// celui du contour France (30 j), sans jamais risquer d'être périmé.
const DUREE_CACHE_S = 60 * 86400;
const DELAI_MS = 8000;

// Deux façades de la même infrastructure Overpass (voir plus bas : elles
// tombent souvent ensemble sous charge, d'où la relance complète en cas
// d'échec plutôt qu'une simple bascule).
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];

// Cache mémoire du process : les tuiles déjà vues pendant que l'instance
// serverless reste chaude ne redemandent ni Redis ni Overpass.
const memoire = new Map();

// Les deux façades ci-dessus partagent la même infrastructure Overpass : sous
// charge, elles tombent souvent ensemble (429/503/504), ce n'est pas une
// vraie redondance. Overpass est un service public gratuit dont la charge
// varie sur quelques secondes — on rejoue donc la liste complète des façades
// à quelques reprises, avec un court repli, plutôt que d'abandonner le masque
// eau d'un foyer sur un simple pic de charge passager.
const REESSAIS = 1;
const BACKOFF_MS = [1200];

async function interrogerUneFois(requete) {
  let derniereErreur = null;
  for (const url of ENDPOINTS) {
    const stop = new AbortController();
    const minuteur = setTimeout(() => stop.abort(), DELAI_MS);
    try {
      const r = await fetch(url, {
        method: 'POST',
        // Sans Accept explicite, la façade Overpass répond 406 (négociation de
        // contenu) — fetch(), à la différence de curl, n'en envoie pas par
        // défaut. User-Agent identifiable : politique d'usage d'Overpass.
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: '*/*',
          'User-Agent': 'feuxgironde/1.0 (+https://feux-france.vercel.app; masque eau interieure)',
        },
        body: requete,
        signal: stop.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      derniereErreur = e;
    } finally {
      clearTimeout(minuteur);
    }
  }
  throw derniereErreur || new Error('aucune source Overpass disponible');
}

async function interroger(requete) {
  let derniereErreur = null;
  for (let tentative = 0; tentative <= REESSAIS; tentative++) {
    try {
      return await interrogerUneFois(requete);
    } catch (e) {
      derniereErreur = e;
      if (tentative < REESSAIS) await new Promise((r) => setTimeout(r, BACKOFF_MS[tentative]));
    }
  }
  throw derniereErreur;
}

// Un anneau OSM est déjà fermé (premier nœud == dernier) pour la quasi-
// totalité des lacs/étangs, qui sont une seule way. Une way qui ne se
// referme pas ne peut pas être une géométrie de polygone à elle seule — les
// grands plans d'eau découpés en plusieurs segments passent par
// chainerAnneaux ci-dessous (relations « multipolygon »).
function anneauFerme(points) {
  if (!points || points.length < 4) return null;
  const premier = points[0], dernier = points[points.length - 1];
  if (premier.lat !== dernier.lat || premier.lon !== dernier.lon) return null;
  return points.map((p) => [p.lon, p.lat]);
}

// Rechaîne les segments « outer » d'une relation multipolygon en anneaux
// fermés, en recollant les segments par leurs extrémités partagées (mêmes
// coordonnées, puisque ce sont les mêmes nœuds OSM). Un segment qui ne
// referme jamais sa chaîne est abandonné plutôt que de produire un polygone
// invalide — un grand lac mal découpé perd alors son masque, mais ça ne fait
// pas planter le reste.
function chainerAnneaux(segments) {
  const anneaux = [];
  const restants = segments.filter((s) => s && s.length > 1).map((s) => s.slice());

  while (restants.length) {
    let chaine = restants.shift();
    let ferme = false;
    let securite = restants.length + 1;

    while (securite-- > 0) {
      const debut = chaine[0], fin = chaine[chaine.length - 1];
      if (chaine.length >= 4 && debut.lat === fin.lat && debut.lon === fin.lon) { ferme = true; break; }
      const idx = restants.findIndex((s) =>
        (s[0].lat === fin.lat && s[0].lon === fin.lon) ||
        (s[s.length - 1].lat === fin.lat && s[s.length - 1].lon === fin.lon));
      if (idx === -1) break;
      let suite = restants.splice(idx, 1)[0];
      if (suite[0].lat !== fin.lat || suite[0].lon !== fin.lon) suite = suite.slice().reverse();
      chaine = chaine.concat(suite.slice(1));
    }

    if (ferme) anneaux.push(chaine.map((p) => [p.lon, p.lat]));
  }
  return anneaux;
}

// Ways fermées directement, et relations « multipolygon » rechaînées. Les
// trous (îles, role=inner) ne sont pas retirés : une île se retrouve donc
// elle aussi classée « eau » — imprécision mineure et sans risque (au pire on
// sous-compte un peu de terre brûlée sur une île, jamais l'inverse), qui évite
// la complexité d'un appariement anneau extérieur / trous.
function polygonesDepuisReponse(json) {
  const polygones = [];
  const elements = (json && json.elements) || [];
  const estEau = (tags) => !!tags && (tags.natural === 'water' || tags.waterway === 'riverbank');

  elements.forEach((e) => {
    if (e.type !== 'way' || !e.geometry || !estEau(e.tags)) return;
    const anneau = anneauFerme(e.geometry);
    if (anneau) polygones.push(anneau);
  });

  elements.forEach((e) => {
    if (e.type !== 'relation' || !e.tags || e.tags.type !== 'multipolygon' || !estEau(e.tags)) return;
    const segments = (e.members || [])
      .filter((m) => m.role === 'outer' && m.geometry)
      .map((m) => m.geometry);
    chainerAnneaux(segments).forEach((a) => polygones.push(a));
  });

  return polygones;
}

function tuileDe(lat, lon) {
  return { ti: Math.floor(lat / TAILLE_TUILE_DEG), tj: Math.floor(lon / TAILLE_TUILE_DEG) };
}

function tuilesCouvrant(latMin, lonMin, latMax, lonMax) {
  const a = tuileDe(latMin, lonMin);
  const b = tuileDe(latMax, lonMax);
  const tuiles = [];
  for (let ti = a.ti; ti <= b.ti; ti++) {
    for (let tj = a.tj; tj <= b.tj; tj++) tuiles.push({ ti, tj });
  }
  return tuiles;
}

// Récupère (ou télécharge puis met en cache) l'eau d'une tuile. `null`
// signifie « pas d'eau ici », mis en cache au même titre qu'un résultat non
// vide — sans quoi une zone sans lac serait réinterrogée à chaque appel.
// `undefined` en cas d'échec réseau : jamais mis en cache, pour que le
// prochain appel retente plutôt que de rester bloqué sur un échec transitoire.
async function tuileEau(ti, tj, redis) {
  const cle = CLE_TUILE_PREFIXE + ti + ':' + tj;
  if (memoire.has(cle)) return memoire.get(cle);

  if (redis) {
    try {
      const brut = await redis.get(cle);
      if (brut !== null && brut !== undefined) {
        const g = brut === '' ? null : JSON.parse(brut);
        memoire.set(cle, g);
        return g;
      }
    } catch (e) { /* on retélécharge */ }
  }

  const sud = ti * TAILLE_TUILE_DEG;
  const nord = sud + TAILLE_TUILE_DEG;
  const ouest = tj * TAILLE_TUILE_DEG;
  const est = ouest + TAILLE_TUILE_DEG;
  const bbox = `${sud},${ouest},${nord},${est}`;
  const requete = `[out:json][timeout:20];(` +
    `way["natural"="water"](${bbox});` +
    `way["waterway"="riverbank"](${bbox});` +
    `relation["natural"="water"](${bbox});` +
    `relation["waterway"="riverbank"](${bbox});` +
    `);out geom;`;

  let geometrie;
  try {
    const json = await interroger(requete);
    const polygones = polygonesDepuisReponse(json);
    geometrie = polygones.length ? { type: 'MultiPolygon', coordinates: polygones.map((a) => [a]) } : null;
  } catch (e) {
    return undefined;
  }

  memoire.set(cle, geometrie);
  if (redis) {
    try {
      await redis.set(cle, geometrie ? JSON.stringify(geometrie) : '', { EX: DUREE_CACHE_S });
    } catch (e) { /* tant pis, on retélécharge la prochaine fois */ }
  }
  return geometrie;
}

// Géométrie de l'eau intérieure couvrant une emprise lat/lon (celle d'un
// foyer, marge de fermeture des trous comprise) — ou `null` si aucune tuile
// n'a pu être servie ou si aucune n'en contient. Jamais d'exception : un échec
// dégrade juste vers « pas de masque eau » pour ce foyer, comme frontiereFrance
// dégrade vers la boîte englobante.
async function eauPourEmprise(latMin, lonMin, latMax, lonMax, redis) {
  // Marge de 0,01° (~1 km) : une rive tout juste hors de l'emprise calculée
  // ne doit pas être ignorée si la fermeture des trous peut y déborder.
  const marge = 0.01;
  const tuiles = tuilesCouvrant(latMin - marge, lonMin - marge, latMax + marge, lonMax + marge);
  if (!tuiles.length || tuiles.length > MAX_TUILES_PAR_FOYER) return null;

  const resultats = await Promise.all(tuiles.map((t) => tuileEau(t.ti, t.tj, redis)));
  const polygones = [];
  resultats.forEach((g) => { if (g) polygones.push(...g.coordinates); });
  return polygones.length ? { type: 'MultiPolygon', coordinates: polygones } : null;
}

// Boîtes englobantes de chaque polygone d'une géométrie eau, calculées une
// fois et mémorisées sur la géométrie elle-même (voir dansEau) : la campagne
// française compte énormément de petites mares, et une géométrie couvrant
// l'emprise d'un gros foyer peut rassembler plusieurs centaines de polygones.
// Sans ce filtre, tester chaque cellule marquée reviendrait à parcourir tous
// leurs sommets à chaque fois — le poste dominant sur un grand feu — alors
// qu'une simple boîte élimine en une comparaison l'immense majorité des
// polygones, très loin de la cellule testée.
const bboxParGeometrie = new WeakMap();

function bboxAnneau(anneau) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const [x, y] of anneau) {
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  return [xmin, ymin, xmax, ymax];
}

function bboxesDe(geometrieEau) {
  let bboxes = bboxParGeometrie.get(geometrieEau);
  if (!bboxes) {
    bboxes = geometrieEau.coordinates.map((polygone) => bboxAnneau(polygone[0]));
    bboxParGeometrie.set(geometrieEau, bboxes);
  }
  return bboxes;
}

function dansEau(lon, lat, geometrieEau) {
  if (!geometrieEau) return false;
  const bboxes = bboxesDe(geometrieEau);
  const polygones = geometrieEau.coordinates;
  for (let i = 0; i < polygones.length; i++) {
    const [xmin, ymin, xmax, ymax] = bboxes[i];
    if (lon < xmin || lon > xmax || lat < ymin || lat > ymax) continue;
    if (dansGeometrie(lon, lat, { type: 'Polygon', coordinates: polygones[i] })) return true;
  }
  return false;
}

module.exports = { eauPourEmprise, dansEau };
