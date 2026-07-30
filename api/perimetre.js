// Emprises cumulées des détections FIRMS autour de Saumos, en lignes de
// contour successives — reprise fidèle du produit
// `cumulative_detection_envelopes` du dépôt
// github.com/nicolaslecorvec/fumees-nouvelle_aquitaine
// (pipeline/scripts/03_cumulative_detection_envelopes.py).
//
// Principe, tel qu'il est appliqué là-bas :
//   — un cliché toutes les 6 heures (SNAPSHOT_STEP_HOURS) ;
//   — à chaque cliché, l'union CUMULATIVE de petits cercles posés sous chaque
//     détection depuis le départ du feu (empreinte prudente du pixel) ;
//   — export non pas des surfaces pleines, mais de leurs FRONTIÈRES, en
//     LineString / MultiLineString : superposées, elles dessinent des anneaux
//     emboîtés qui retracent la progression, chaque trait étant une étape.
//
// Ce n'est ni un périmètre brûlé officiel, ni un front de flammes continu :
// juste l'étendue cumulée de ce que les satellites ont vu chaud.
//
// Différence d'exécution assumée : leur pipeline tourne hors ligne (Python,
// geopandas/shapely) et publie un fichier figé ; ici tout est calculé à la
// demande puis mis en cache, faute de pipeline programmé.

const { getClient } = require('../lib/redis');

const LAT = 44.98;   // Saumos, Gironde
const LON = -1.02;
const BBOX = '-1.45,44.60,-0.55,45.35';
const RAYON_KM = 34;

const JOURS_MAX = 10;
const DEPART_FEU = '2026-07-22';
const SNAPSHOT_HEURES = 6;      // SNAPSHOT_STEP_HOURS chez eux
const FENETRE_ACTIVE_H = 6;

// Empreinte circulaire prudente autour du centre du pixel, par instrument —
// FOOTPRINT_RADIUS_M chez eux. L'écart compte : le pixel MODIS (~1 km au sol)
// couvre bien plus large que le pixel VIIRS, et c'est lui qui relie des
// détections que VIIRS seul laisserait isolées.
const RAYON_KM_PAR_INSTRUMENT = { VIIRS: 0.3, MODIS: 0.75, LANDSAT: 0.3 };
const RAYON_KM_DEFAUT = 0.3;

// Fermeture morphologique (SMALL_GAP_CLOSING_M) : on dilate l'union puis on
// la rétracte d'autant. Les interstices plus étroits que ce rayon se
// referment, les contours extérieurs reviennent à leur place. Sans cette
// étape, une grille de détections un peu creuse ressort en bandes séparées
// au lieu d'une emprise pleine — c'était le défaut du rendu précédent.
const FERMETURE_KM = 0.1;

// Simplification purement graphique des frontières (BOUNDARY_SIMPLIFY_M,
// 30 m chez eux) : ~0,00027° de latitude.
const SIMPLIFICATION_DEG = 0.00027;

function instrumentDe(capteur) {
  if (capteur.indexOf('MODIS') === 0) return 'MODIS';
  if (capteur.indexOf('LANDSAT') === 0) return 'LANDSAT';
  return 'VIIRS';
}

const CAPTEURS = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT', 'LANDSAT_NRT'];

// Plafond de sécurité : au-delà, la grille de regroupement s'élargit plutôt
// que de laisser la fusion de polygones s'emballer.
const MAX_POINTS_UNION = 2500;

function joursDepuisDepart() {
  const debut = new Date(DEPART_FEU + 'T00:00:00Z');
  const ecoules = Math.ceil((Date.now() - debut.getTime()) / 86400000) + 1;
  return Math.min(JOURS_MAX, Math.max(1, ecoules));
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function tsUtc(date, heureBrute) {
  const hhmm = String(heureBrute || '0').padStart(4, '0');
  return Date.UTC(
    +date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10),
    +hhmm.slice(0, 2), +hhmm.slice(2, 4)
  );
}

function parseCsv(texte) {
  const lignes = texte.trim().split('\n');
  if (lignes.length < 2) return [];
  const entetes = lignes[0].split(',').map((c) => c.trim());
  return lignes.slice(1).map((ligne) => {
    const valeurs = ligne.split(',');
    const o = {};
    entetes.forEach((c, i) => { o[c] = valeurs[i]; });
    return o;
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
    ts: tsUtc(l.acq_date, l.acq_time),
    capteur,
  }));
}

// turf est distribué en modules ESM purs : un require() plante au chargement
// sur l'environnement Node de Vercel (même mésaventure qu'avec netcdfjs).
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

// Frontières d'un polygone/multipolygone → LineString ou MultiLineString.
// C'est ce que leur pipeline exporte : des lignes, pas des surfaces pleines,
// pour que les étapes successives se superposent en anneaux lisibles.
function contourEnLignes(geometrie) {
  const polygones = geometrie.type === 'Polygon'
    ? [geometrie.coordinates]
    : geometrie.coordinates;
  const lignes = [];
  polygones.forEach((anneaux) => {
    (anneaux || []).forEach((anneau) => {
      if (Array.isArray(anneau) && anneau.length >= 2) lignes.push(anneau);
    });
  });
  if (!lignes.length) return null;
  if (lignes.length === 1) return { type: 'LineString', coordinates: lignes[0] };
  return { type: 'MultiLineString', coordinates: lignes };
}

function arrondirLignes(geometrie, decimales) {
  const f = Math.pow(10, decimales);
  const arr = (c) => [Math.round(c[0] * f) / f, Math.round(c[1] * f) / f];
  if (geometrie.type === 'LineString') {
    return { type: 'LineString', coordinates: geometrie.coordinates.map(arr) };
  }
  return {
    type: 'MultiLineString',
    coordinates: geometrie.coordinates.map((l) => l.map(arr)),
  };
}

// Regroupement sur grille : dédoublonne les détections répétées d'un même
// foyer par plusieurs passages, et borne le coût de la fusion. Une cellule
// vue à la fois par VIIRS et MODIS garde le plus grand rayon des deux : le
// pixel MODIS couvre réellement cette surface.
function cellulesDe(points, grille) {
  const vues = new Map();
  points.forEach((p) => {
    const la = Math.round(p.lat / grille) * grille;
    const lo = Math.round(p.lon / grille) * grille;
    const k = la.toFixed(4) + '_' + lo.toFixed(4);
    const rayon = RAYON_KM_PAR_INSTRUMENT[instrumentDe(p.capteur)] || RAYON_KM_DEFAUT;
    const dejaVue = vues.get(k);
    if (!dejaVue) vues.set(k, { c: [+lo.toFixed(4), +la.toFixed(4)], r: rayon, k });
    else if (rayon > dejaVue.r) dejaVue.r = rayon;
  });
  return [...vues.values()];
}

function grilleAdaptee(points) {
  let grille = 0.0025;
  while (cellulesDe(points, grille).length > MAX_POINTS_UNION && grille < 0.02) {
    grille *= 1.5;
  }
  return grille;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=3600');

  const cle = process.env.FIRMS_MAP_KEY;
  if (!cle) {
    res.status(200).json({ ok: false, raison: 'clé FIRMS non configurée' });
    return;
  }

  const cleCache = 'perimetre:v4';
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

  const tous = ok.flatMap((r) => r.pts)
    .filter((p) => isFinite(p.lat) && isFinite(p.lon) && isFinite(p.ts))
    .filter((p) => distanceKm(LAT, LON, p.lat, p.lon) <= RAYON_KM)
    .sort((a, b) => a.ts - b.ts);

  if (!tous.length) {
    res.status(200).json({ ok: true, etapes: [], actifs: [] });
    return;
  }

  const HEURE = 3600000;
  const pas = SNAPSHOT_HEURES * HEURE;
  const debutFeu = new Date(DEPART_FEU + 'T00:00:00Z').getTime();
  const maintenant = Date.now();

  // Bornes des clichés : toutes les 6 h, en ne gardant que celles où quelque
  // chose a effectivement été détecté (inutile de publier une étape vide).
  const bornes = [];
  for (let t = debutFeu + pas; t <= maintenant + pas; t += pas) {
    bornes.push(Math.min(t, maintenant));
    if (t >= maintenant) break;
  }

  const grille = grilleAdaptee(tous);

  let etapes = [];
  try {
    const turf = await chargerTurf();
    let cumul = null;          // union cumulative brute, accumulée d'un cliché au suivant
    let contourPret = null;    // même union, fermée et simplifiée pour publication
    let aChange = false;       // le cumul a-t-il bougé depuis la dernière fermeture ?
    let dejaVues = new Set();  // cellules déjà intégrées au cumul
    let iPoint = 0;
    let index = 0;

    for (const borne of bornes) {
      // Points nouvellement arrivés dans cette tranche.
      const nouveaux = [];
      while (iPoint < tous.length && tous[iPoint].ts <= borne) {
        nouveaux.push(tous[iPoint]);
        iPoint++;
      }

      // Seules les cellules encore inconnues coûtent une fusion : c'est ce
      // qui rend l'accumulation abordable à la demande (sinon il faudrait
      // refondre l'intégralité des cercles à chaque cliché).
      const aAjouter = cellulesDe(nouveaux, grille)
        .filter((c) => {
          if (dejaVues.has(c.k)) return false;
          dejaVues.add(c.k);
          return true;
        });

      if (aAjouter.length) {
        const cercles = aAjouter.map((c) =>
          turf.buffer(turf.point(c.c), c.r, { units: 'kilometers', steps: 8 })
        );
        const lot = cercles.length === 1
          ? cercles[0]
          : turf.union(turf.featureCollection(cercles));
        cumul = cumul ? turf.union(turf.featureCollection([cumul, lot])) : lot;
        aChange = true;
      }

      if (!cumul) continue;   // rien encore détecté à ce stade

      // La fermeture ne s'applique qu'à la géométrie publiée, pas au cumul
      // conservé : la rétracter puis la redilater d'un cliché au suivant
      // ferait dériver le contour à chaque étape.
      if (aChange || !contourPret) {
        let ferme = turf.buffer(cumul, FERMETURE_KM, { units: 'kilometers' });
        ferme = turf.buffer(ferme, -FERMETURE_KM, { units: 'kilometers' });
        contourPret = turf.simplify(ferme || cumul, {
          tolerance: SIMPLIFICATION_DEG, highQuality: false,
        });
        aChange = false;
      }

      const lignes = contourEnLignes(contourPret.geometry);
      if (!lignes) continue;

      index += 1;
      const sourcesVues = new Set(tous.slice(0, iPoint).map((p) => p.capteur));
      etapes.push({
        snapshot_index: index,
        // Borne haute réellement observée : l'horodatage de la dernière
        // détection intégrée, pas la borne théorique de la tranche.
        observed_until_utc: new Date(tous[Math.max(0, iPoint - 1)].ts).toISOString(),
        borne,
        detections_cumulees: iPoint,
        cellules_cumulees: dejaVues.size,
        sources: [...sourcesVues].sort().join(', '),
        contour: arrondirLignes(lignes, 5),
      });
    }
  } catch (e) {
    res.status(200).json({ ok: false, raison: 'fusion des contours échouée : ' + e.message });
    return;
  }

  // Foyers encore chauds dans les dernières heures : rendus à part, en
  // points colorés par puissance, comme la couche « foyers actuels » de leur
  // carte — le contour, lui, ne dit pas ce qui brûle encore.
  const actifs = tous
    .filter((p) => maintenant - p.ts <= FENETRE_ACTIVE_H * HEURE)
    .map((p) => [+p.lat.toFixed(5), +p.lon.toFixed(5), Math.round(p.frp), p.ts]);

  const sortie = {
    ok: true,
    source: 'NASA FIRMS · VIIRS + MODIS + Landsat',
    produit: 'cumulative_active_fire_detection_extent',
    depuis: DEPART_FEU,
    pasHeures: SNAPSHOT_HEURES,
    grille,
    detections: tous.length,
    etapes,
    actifs,
  };

  if (redis) {
    try { await redis.set(cleCache, JSON.stringify(sortie), { EX: 1200 }); } catch (e) { /* tant pis */ }
  }

  res.setHeader('X-Cache', redis ? 'miss' : 'none');
  res.status(200).json(sortie);
};
