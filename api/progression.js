// Surface brûlée cumulée, produite par la chaîne de traitement de
// nicolaslecorvec/fumees-nouvelle_aquitaine (reprise avec son accord).
//
// Sa chaîne Python tourne toutes les 30 minutes dans une action GitHub et
// publie un GeoJSON de 4 Mo. On n'en garde ici que la catégorie
// `arrival_step` — 173 ko : la surface atteinte par le feu, découpée par
// date de première détection. C'est ce qu'il faut pour la barre temporelle, et
// c'est croissant par construction : une portion de terrain atteinte le 24 le
// reste les jours suivants. La carte ne peut donc plus montrer une surface qui
// recule ou qui bondit d'un cran au suivant.
//
// Le dépôt lu est configurable : PROGRESSION_SOURCE (URL complète). Sans
// variable, on lit le fork du site, qui exécute la même chaîne sur sa propre
// clé FIRMS.

const { getClient } = require('../lib/redis');

const SOURCE_DEFAUT = 'https://raw.githubusercontent.com/Leo6432/'
  + 'fumees-nouvelle_aquitaine/main/data/fire-progression/fire_progression_arrival_v1.geojson';

const CLE_CACHE = 'feux:progression:v1';
// La chaîne amont publie toutes les 30 minutes : inutile de retélécharger
// 4 Mo plus souvent qu'elle ne produit.
const DUREE_CACHE_S = 900;
const DELAI_MS = 25000;

// Attribution : elle accompagne la donnée, et n'est pas laissée au bon vouloir
// du gabarit qui l'affiche. L'accord de l'auteur porte sur son travail, pas
// sur celui des tiers dont sa chaîne dépend.
const CREDITS = {
  traitement: 'Nicolas Le Corvec — fumees-nouvelle_aquitaine (repris avec son accord)',
  detections: 'NASA FIRMS (VIIRS, MODIS)',
  masqueTerreMer: 'ESA WorldCover 2021 v200',
};

function source() {
  return process.env.PROGRESSION_SOURCE || SOURCE_DEFAUT;
}

// Ne garde que les pas d'arrivée, et allège chaque objet de ce dont la carte
// n'a pas besoin : sur 4 Mo téléchargés, il en reste moins de 200 ko à servir.
function extraire(json) {
  const features = Array.isArray(json && json.features) ? json.features : [];
  const pas = [];
  features.forEach((f) => {
    const p = f.properties || {};
    if (p.category !== 'arrival_step') return;
    const t = Date.parse(p.first_detected_utc);
    if (!isFinite(t) || !f.geometry) return;
    pas.push({
      t,
      indice: p.arrival_snapshot_index,
      km2: p.area_km2,
      libelle: p.label,
      geometrie: f.geometry,
    });
  });
  pas.sort((a, b) => a.t - b.t);
  return pas;
}

async function telecharger() {
  const stop = new AbortController();
  const minuteur = setTimeout(() => stop.abort(), DELAI_MS);
  try {
    const r = await fetch(source(), { signal: stop.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return extraire(await r.json());
  } finally {
    clearTimeout(minuteur);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');

  let redis = null;
  try {
    const p = getClient();
    redis = p ? await p : null;
  } catch (e) {
    redis = null;
  }

  let pas = null;
  let duCache = false;
  if (redis) {
    try {
      const brut = await redis.get(CLE_CACHE);
      if (brut) { pas = JSON.parse(brut); duCache = true; }
    } catch (e) { /* on retélécharge */ }
  }

  if (!pas) {
    try {
      pas = await telecharger();
    } catch (e) {
      res.status(200).json({
        ok: false,
        raison: 'produit de progression injoignable : ' + (e.message || 'erreur inconnue'),
        source: source(),
        // Le cas « le fork n'existe pas encore » mérite d'être dit clairement
        // plutôt que de ressembler à une panne.
        indice: 'vérifier que le dépôt est bien forké, public, et que son '
          + 'action GitHub a déjà produit le fichier au moins une fois',
      });
      return;
    }
    if (redis && pas.length) {
      try { await redis.set(CLE_CACHE, JSON.stringify(pas), { EX: DUREE_CACHE_S }); } catch (e) { /* tant pis */ }
    }
  }

  if (!pas.length) {
    res.status(200).json({ ok: false, raison: 'aucun pas d’arrivée dans le produit amont', source: source() });
    return;
  }

  const cumul = [];
  let total = 0;
  pas.forEach((p) => { total += p.km2 || 0; cumul.push(Math.round(total * 100) / 100); });

  res.status(200).json({
    ok: true,
    produit: 'fire_progression_arrival_v1',
    credits: CREDITS,
    duCache,
    debut: pas[0].t,
    fin: pas[pas.length - 1].t,
    surfaceTotaleKm2: Math.round(total * 100) / 100,
    // La surface cumulée à chaque pas : la carte s'en sert pour l'étiquette du
    // curseur sans avoir à réadditionner des géométries.
    cumulKm2: cumul,
    pas,
  });
};
