// EXPÉRIMENTAL — périmètre du feu de Saumos en contour net, plutôt qu'en
// disques flous : même principe que le pipeline (Python, hors ligne) du
// site nicolaslecorvec.github.io/fumees-nouvelle_aquitaine — transformer
// chaque détection FIRMS en petit cercle réaliste (rayon proche du pixel du
// capteur), puis fusionner tous ces cercles en une vraie forme géométrique
// (union de polygones), au lieu de peindre des points flous sur un canvas.
//
// Différence assumée avec ce site : ici, le calcul se fait à la demande
// (fonction serverless), pas dans un pipeline Python programmé à l'avance —
// donc mis en cache pour rester léger, et limité à l'état ACTUEL cumulé du
// feu (pas encore de clichés historiques par tranche de temps, qui
// demanderaient de refaire cette fusion pour chaque tranche).

const { getClient } = require('../lib/redis');

const LAT = 44.98;   // Saumos, Gironde
const LON = -1.02;
const BBOX = '-1.45,44.60,-0.55,45.35';
const RAYON_KM = 34;

const JOURS_MAX = 10;
const DEPART_FEU = '2026-07-22';

function joursDepuisDepart() {
  const debut = new Date(DEPART_FEU + 'T00:00:00Z');
  const ecoules = Math.ceil((Date.now() - debut.getTime()) / 86400000) + 1;
  return Math.min(JOURS_MAX, Math.max(1, ecoules));
}

const CAPTEURS = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT', 'LANDSAT_NRT'];

// Rayon du petit cercle posé sous chaque détection avant fusion — une
// approximation prudente de l'empreinte réelle du pixel au sol (~375 m pour
// VIIRS, ~1 km pour MODIS) : on prend une valeur unique raisonnable plutôt
// que de suivre le capteur d'origine à travers l'agrégation par grille.
const RAYON_CERCLE_KM = 0.32;

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseCsv(texte) {
  const lignes = texte.trim().split('\n');
  if (lignes.length < 2) return [];
  const entetes = lignes[0].split(',').map((c) => c.trim());
  return lignes.slice(1).map((ligne) => {
    const valeurs = ligne.split(',');
    const ligneObj = {};
    entetes.forEach((c, i) => { ligneObj[c] = valeurs[i]; });
    return ligneObj;
  });
}

function sansCle(message, cle) {
  return String(message || 'erreur inconnue').split(cle).join('CLE').slice(0, 160);
}

const DELAI_MS = 7000;

function decoupes(jours) {
  if (jours <= 3) return [{ jours, date: null }];
  const jourMs = 86400000;
  const debut = Date.now() - (jours - 1) * jourMs;
  const out = [];
  for (let fait = 0; fait < jours; fait += 3) {
    out.push({
      jours: Math.min(3, jours - fait),
      date: new Date(debut + fait * jourMs).toISOString().slice(0, 10),
    });
  }
  return out;
}

async function recuperer(capteur, cle, jours, dateDebut) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${cle}/${capteur}/${BBOX}/${jours}` +
    (dateDebut ? `/${dateDebut}` : '');
  const stop = new AbortController();
  const minuteur = setTimeout(() => stop.abort(), DELAI_MS);
  let r;
  try {
    r = await fetch(url, { signal: stop.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? `${capteur}: délai dépassé (${DELAI_MS / 1000}s)`
      : `${capteur}: ${sansCle(e.message, cle)}`);
  } finally {
    clearTimeout(minuteur);
  }
  if (!r.ok) throw new Error(`${capteur}: HTTP ${r.status}`);
  const texte = await r.text();
  if (/invalid|error|exceed/i.test(texte.slice(0, 200))) {
    throw new Error(`${capteur}: ${sansCle(texte.slice(0, 120), cle)}`);
  }
  return parseCsv(texte).map((l) => ({
    lat: parseFloat(l.latitude),
    lon: parseFloat(l.longitude),
    frp: parseFloat(l.frp) || 0,
  }));
}

// Point d'entrée ESM chargé une seule fois (turf est distribué en modules
// ESM purs — un require() classique plante au chargement, voir la même
// mésaventure rencontrée avec netcdfjs).
let turfPromise = null;
function chargerTurf() {
  if (!turfPromise) {
    turfPromise = Promise.all([
      import('@turf/helpers'),
      import('@turf/buffer'),
      import('@turf/union'),
      import('@turf/simplify'),
    ]).then(([helpers, buffer, union, simplify]) => ({
      point: helpers.point,
      featureCollection: helpers.featureCollection,
      buffer: buffer.default,
      union: union.default,
      simplify: simplify.default,
    }));
  }
  return turfPromise;
}

// Au-delà, la fusion de polygones devient trop lourde pour une fonction à la
// demande : on regroupe d'abord sur une grille plus large pour rester sous
// ce plafond, quitte à perdre un peu de détail plutôt que de risquer un
// calcul de plusieurs dizaines de secondes.
const MAX_POINTS_UNION = 2500;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=3600');

  const cle = process.env.FIRMS_MAP_KEY;
  if (!cle) {
    res.status(200).json({ ok: false, raison: 'clé FIRMS non configurée' });
    return;
  }

  const cleCache = 'perimetre:v1';
  let redis = null;
  try {
    const p = getClient();
    redis = p ? await p : null;
    if (redis) {
      const garde = await redis.get(cleCache);
      if (garde) {
        res.setHeader('X-Cache', 'redis');
        res.status(200).json(JSON.parse(garde));
        return;
      }
    }
  } catch (e) {
    redis = null;
  }

  const jours = joursDepuisDepart();
  const morceaux = decoupes(jours);
  const taches = [];
  CAPTEURS.forEach((c) => morceaux.forEach((m) => taches.push(
    recuperer(c, cle, m.jours, m.date).then(
      (pts) => ({ ok: true, pts }),
      (e) => ({ ok: false, err: sansCle(e && e.message, cle) })
    )
  )));
  const resultats = await Promise.all(taches);
  const ok = resultats.filter((r) => r.ok);

  if (!ok.length) {
    res.status(200).json({
      ok: false,
      raison: 'API FIRMS injoignable',
      details: resultats.map((r) => r.err),
    });
    return;
  }

  const points = ok.flatMap((r) => r.pts)
    .filter((p) => distanceKm(LAT, LON, p.lat, p.lon) <= RAYON_KM);

  if (!points.length) {
    res.status(200).json({ ok: true, contour: null, points: 0 });
    return;
  }

  // Regroupe sur une grille pour dédoublonner les détections répétées d'une
  // même zone (plusieurs passages successifs sur le même foyer) — la grille
  // s'élargit d'elle-même si le nombre de points dépasse le plafond de
  // sécurité, plutôt que de tenter la fusion telle quelle.
  function regrouper(grille) {
    const cellules = new Map();
    points.forEach((p) => {
      const la = Math.round(p.lat / grille) * grille;
      const lo = Math.round(p.lon / grille) * grille;
      cellules.set(la.toFixed(4) + '_' + lo.toFixed(4), { lat: +la.toFixed(4), lon: +lo.toFixed(4) });
    });
    return [...cellules.values()];
  }

  let grille = 0.0025;
  let cellules = regrouper(grille);
  while (cellules.length > MAX_POINTS_UNION && grille < 0.02) {
    grille *= 1.5;
    cellules = regrouper(grille);
  }
  if (cellules.length > MAX_POINTS_UNION) cellules = cellules.slice(0, MAX_POINTS_UNION);

  let sortie;
  try {
    const turf = await chargerTurf();
    const cercles = cellules.map((c) =>
      turf.buffer(turf.point([c.lon, c.lat]), RAYON_CERCLE_KM, { units: 'kilometers', steps: 6 })
    );
    const fusion = turf.union(turf.featureCollection(cercles));
    const simplifie = turf.simplify(fusion, { tolerance: 0.0003, highQuality: false });
    sortie = {
      ok: true,
      points: points.length,
      cellules: cellules.length,
      grille,
      contour: simplifie.geometry,
    };
  } catch (e) {
    res.status(200).json({ ok: false, raison: 'fusion des contours échouée : ' + e.message });
    return;
  }

  if (redis) {
    try { await redis.set(cleCache, JSON.stringify(sortie), { EX: 1200 }); } catch (e) { /* tant pis */ }
  }

  res.setHeader('X-Cache', redis ? 'miss' : 'none');
  res.status(200).json(sortie);
};
