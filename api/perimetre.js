// Contour net du feu de Saumos, par cliché figé — même principe que le
// pipeline (Python, hors ligne) du site
// nicolaslecorvec.github.io/fumees-nouvelle_aquitaine : transformer chaque
// détection FIRMS en petit cercle réaliste (rayon proche du pixel du
// capteur), puis fusionner tous ces cercles en une vraie forme géométrique
// (union de polygones), au lieu de peindre des points flous sur un canvas.
//
// Différence assumée avec ce site : ici, le calcul se fait à la demande
// (fonction serverless), pas dans un pipeline Python programmé à l'avance —
// donc mis en cache par tranche de 6h (comme leur SNAPSHOT_STEP_HOURS), avec
// un cache long pour les tranches déjà passées (elles ne changent plus) et
// court pour la tranche en cours (encore susceptible de nouvelles
// détections).
//
// ?instant=<epoch ms> : borne haute du cliché (cumul de tout ce qui a été
// détecté jusqu'à cet instant). Sans paramètre : dernière tranche connue.

const { getClient } = require('../lib/redis');

const LAT = 44.98;   // Saumos, Gironde
const LON = -1.02;
const BBOX = '-1.45,44.60,-0.55,45.35';
const RAYON_KM = 34;

const JOURS_MAX = 10;
const DEPART_FEU = '2026-07-22';
const SNAPSHOT_HEURES = 6;
const FENETRE_ACTIVE_H = 6;   // même fenêtre que carte.js, pour les foyers "encore actifs"

function joursDepuisDepart() {
  const debut = new Date(DEPART_FEU + 'T00:00:00Z');
  const ecoules = Math.ceil((Date.now() - debut.getTime()) / 86400000) + 1;
  return Math.min(JOURS_MAX, Math.max(1, ecoules));
}

// Liste des instants de cliché (toutes les 6h depuis le départ du feu,
// jusqu'à maintenant inclus) — sert à la fois à borner les requêtes et à
// fournir au client de quoi construire son sélecteur, sans dupliquer cette
// logique côté navigateur.
function snapshots() {
  const HEURE = 3600000;
  const debut = new Date(DEPART_FEU + 'T00:00:00Z').getTime();
  const pas = SNAPSHOT_HEURES * HEURE;
  const maintenant = Date.now();
  const liste = [];
  for (let t = debut + pas; t <= maintenant; t += pas) liste.push(t);
  if (!liste.length || liste[liste.length - 1] < maintenant - 5 * 60000) liste.push(maintenant);
  return liste;
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

function tsUtc(date, heure) {
  const hm = String(heure || '0h0').split('h');
  return Date.UTC(
    +date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10),
    +hm[0] || 0, +hm[1] || 0
  );
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
    ts: tsUtc(l.acq_date, (l.acq_time || '').padStart(4, '0').replace(/(\d{2})(\d{2})/, '$1h$2')),
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

function fusionner(points, turf) {
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

  const cercles = cellules.map((c) =>
    turf.buffer(turf.point([c.lon, c.lat]), RAYON_CERCLE_KM, { units: 'kilometers', steps: 6 })
  );
  const fusion = turf.union(turf.featureCollection(cercles));
  const simplifie = turf.simplify(fusion, { tolerance: 0.0003, highQuality: false });
  return { geometrie: simplifie.geometry, cellules: cellules.length, grille };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');   // le cache se gère nous-mêmes, par tranche

  const cle = process.env.FIRMS_MAP_KEY;
  if (!cle) {
    res.status(200).json({ ok: false, raison: 'clé FIRMS non configurée' });
    return;
  }

  const listeSnapshots = snapshots();
  const maintenant = Date.now();

  let instant = maintenant;
  try {
    const url = new URL(req.url, 'http://x');
    const brut = Number(url.searchParams.get('instant'));
    if (isFinite(brut) && brut > 0) instant = brut;
  } catch (e) { /* instant reste "maintenant" */ }

  // Cliché déjà entièrement passé (marge de sécurité : au-delà de la fenêtre
  // active, plus aucune nouvelle détection ne peut le faire bouger) : cache
  // longtemps. Le cliché le plus récent reste encore susceptible de
  // recevoir nos détections au fil des passages satellite : cache court.
  const estFige = instant < maintenant - (FENETRE_ACTIVE_H + 2) * 3600000;
  const cleCache = 'perimetre:v3:' + instant;

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
      snapshots: listeSnapshots,
    });
    return;
  }

  const tousLesPoints = ok.flatMap((r) => r.pts)
    .filter((p) => distanceKm(LAT, LON, p.lat, p.lon) <= RAYON_KM);

  // Cumul : tout ce qui a été détecté jusqu'à l'instant du cliché.
  const points = tousLesPoints.filter((p) => p.ts <= instant);
  // Encore "actif" à cet instant : détecté dans les FENETRE_ACTIVE_H
  // dernières heures avant le cliché — rendu à part (petits points colorés
  // par puissance), pas fondu dans le contour cumulé.
  const actifs = points
    .filter((p) => instant - p.ts <= FENETRE_ACTIVE_H * 3600000)
    .map((p) => [p.lat, p.lon, Math.round(p.frp), p.ts]);

  if (!points.length) {
    const vide = { ok: true, contour: null, points: 0, actifs: [], instant, snapshots: listeSnapshots };
    res.status(200).json(vide);
    return;
  }

  let sortie;
  try {
    const turf = await chargerTurf();
    const { geometrie, cellules, grille } = fusionner(points, turf);
    sortie = {
      ok: true,
      points: points.length,
      cellules,
      grille,
      contour: geometrie,
      actifs,
      instant,
      snapshots: listeSnapshots,
    };
  } catch (e) {
    res.status(200).json({ ok: false, raison: 'fusion des contours échouée : ' + e.message, snapshots: listeSnapshots });
    return;
  }

  if (redis) {
    const duree = estFige ? 30 * 86400 : 1200;
    try { await redis.set(cleCache, JSON.stringify(sortie), { EX: duree }); } catch (e) { /* tant pis */ }
  }

  res.setHeader('X-Cache', redis ? 'miss' : 'none');
  res.status(200).json(sortie);
};
