// Surface brûlée en France sur la saison en cours, d'après Copernicus EFFIS.
//
// EFFIS expose ses zones brûlées via un service WFS (GeoServer), couche
// EFFIS:BurntAreasAll — "All" = toute la saison en cours, donc pas besoin de
// filtrer par année tant que la saison ne change pas.
//
// Ni le nom exact des champs (pays, surface) ni la forme précise de la
// réponse ne sont vérifiables depuis ici — cet environnement ne peut pas
// atteindre maps.effis.emergency.copernicus.eu pour les observer avant
// déploiement. Le code cherche donc le champ de surface parmi plusieurs
// variantes usuelles plutôt que d'en supposer un précis, et répond une
// erreur explicite s'il ne trouve rien — jamais un chiffre qui pourrait
// être faux. Voir `diagnostic` dans la réponse si le total semble suspect.
//
// Filtrage France : un polygone est compté dès qu'un de ses sommets tombe
// dans le contour précis du pays (même logique, même module que pour les
// détections FIRMS) si aucun champ pays exploitable n'est trouvé — plus
// fiable qu'une boîte englobante près des frontières.

const { getClient } = require('../lib/redis');
const { frontiereFrance, dansGeometrie } = require('../lib/france');

const ENDPOINT = 'https://maps.effis.emergency.copernicus.eu/effis';
const COUCHE = 'EFFIS:BurntAreasAll';
const DELAI_MS = 20000;
const CLE_CACHE = 'effis:france:v1';
// EFFIS ne republie pas cette couche en continu : inutile de la retélécharger
// aussi souvent que FIRMS.
const DUREE_CACHE_S = 3600;

// Europe de l'Ouest : assez large pour n'écarter aucun feu français proche
// d'une frontière, assez étroit pour ne pas télécharger toute la couche
// mondiale à chaque appel.
const BBOX = '-6,40,12,52';

const CHAMPS_SURFACE = ['area_ha', 'areaha', 'ha', 'area', 'burnt_area', 'shape_area'];
const CHAMPS_PAYS = ['country', 'iso2', 'iso_a2', 'cntr_code'];
const CHAMPS_DATE = ['firedate', 'initialdate', 'lastupdate', 'date'];

function trouverChamp(props, candidats) {
  const cles = Object.keys(props || {});
  for (const c of candidats) {
    const trouve = cles.find((k) => k.toLowerCase() === c);
    if (trouve) return trouve;
  }
  return null;
}

// Un sommet suffit : un polygone est compté français dès qu'un de ses points
// est en France, sans calculer une intersection polygone-polygone complète —
// inutile pour un simple compte, et bien plus coûteux.
function unSommetEnFrance(geometrie, contour) {
  if (!geometrie) return false;
  const polygones = geometrie.type === 'Polygon' ? [geometrie.coordinates]
    : geometrie.type === 'MultiPolygon' ? geometrie.coordinates : [];
  for (const anneaux of polygones) {
    for (const anneau of (anneaux || [])) {
      for (const pt of (anneau || [])) {
        if (pt && dansGeometrie(pt[0], pt[1], contour)) return true;
      }
    }
  }
  return false;
}

async function telecharger() {
  const url = ENDPOINT
    + '?service=WFS&version=2.0.0&request=GetFeature'
    + '&typeNames=' + encodeURIComponent(COUCHE)
    + '&outputFormat=application/json'
    + '&srsName=EPSG:4326'
    + '&bbox=' + BBOX + ',EPSG:4326';

  const stop = new AbortController();
  const minuteur = setTimeout(() => stop.abort(), DELAI_MS);
  let texte;
  try {
    const r = await fetch(url, { signal: stop.signal });
    texte = await r.text();
    if (!r.ok) throw new Error('EFFIS a répondu HTTP ' + r.status + ' : ' + texte.slice(0, 200));
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'EFFIS : délai dépassé' : e.message);
  } finally {
    clearTimeout(minuteur);
  }

  let json;
  try {
    json = JSON.parse(texte);
  } catch (e) {
    // Un service WFS en erreur répond souvent en XML avec le même code 200 :
    // le dire clairement plutôt que planter sur un JSON.parse muet.
    throw new Error('réponse EFFIS non-JSON, probablement une erreur WFS : ' + texte.slice(0, 300));
  }
  if (!json || !Array.isArray(json.features)) throw new Error('réponse EFFIS sans "features"');
  return json.features;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');

  let redis = null;
  try {
    const p = getClient();
    redis = p ? await p : null;
  } catch (e) {
    redis = null;
  }

  if (redis) {
    try {
      const brut = await redis.get(CLE_CACHE);
      if (brut) { res.status(200).json(JSON.parse(brut)); return; }
    } catch (e) { /* on retélécharge */ }
  }

  let features;
  try {
    features = await telecharger();
  } catch (e) {
    res.status(200).json({ ok: false, raison: 'EFFIS injoignable : ' + (e.message || 'erreur inconnue') });
    return;
  }

  if (!features.length) {
    res.status(200).json({ ok: false, raison: 'aucune zone brûlée renvoyée par EFFIS sur cette zone' });
    return;
  }

  const champSurface = trouverChamp(features[0].properties, CHAMPS_SURFACE);
  if (!champSurface) {
    res.status(200).json({
      ok: false,
      raison: 'champ de surface introuvable dans la réponse EFFIS — schéma probablement différent de celui attendu',
      champsDisponibles: Object.keys(features[0].properties || {}),
    });
    return;
  }
  const champPays = trouverChamp(features[0].properties, CHAMPS_PAYS);
  const champDate = trouverChamp(features[0].properties, CHAMPS_DATE);

  const geometrieFrance = champPays ? null : await frontiereFrance(redis).catch(() => null);

  let total = 0;
  let compte = 0;
  let derniereDate = null;
  features.forEach((f) => {
    const p = f.properties || {};
    const enFrance = champPays
      ? ['FR', 'FRA'].includes(String(p[champPays]).toUpperCase())
      : (geometrieFrance ? unSommetEnFrance(f.geometry, geometrieFrance) : false);
    if (!enFrance) return;

    const ha = Number(p[champSurface]);
    if (isFinite(ha)) { total += ha; compte++; }

    if (champDate && p[champDate]) {
      const d = String(p[champDate]);
      if (!derniereDate || d > derniereDate) derniereDate = d;
    }
  });

  const sortie = {
    ok: true,
    source: 'Copernicus EFFIS (' + COUCHE + ')',
    hectares: Math.round(total),
    zones: compte,
    derniereDate,
    // Sert à diagnostiquer un total qui semblerait faux, sans retélécharger
    // toute la réponse EFFIS.
    diagnostic: { champSurface, champPays, champDate, featuresRecues: features.length },
  };

  if (redis && compte) {
    try { await redis.set(CLE_CACHE, JSON.stringify(sortie), { EX: DUREE_CACHE_S }); } catch (e) { /* tant pis */ }
  }

  res.status(200).json(sortie);
};
