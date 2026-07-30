// Relais vers l'API FIRMS, pour que la chaîne de progression tourne sur NOTRE
// clé et non sur celle d'autrui.
//
// La chaîne amont interroge un relais plutôt que FIRMS directement, parce
// qu'une clé n'a rien à faire dans un dépôt public. Son relais par défaut
// appartient à son auteur : le laisser en place ferait tourner notre action
// toutes les 30 minutes sur son infrastructure et son quota. On expose donc
// ici la même forme d'URL, servie par notre propre clé, et l'action pointe
// dessus via sa variable FIRMS_PROXY.
//
// Forme attendue, imposée par l'amont :
//   /api/relais-firms/<jeton>/firms/<capteur>/<ouest,sud,est,nord>/<jours>
//
// Le jeton est dans le chemin et non dans un en-tête : l'appelant fait un GET
// nu, sans moyen d'ajouter quoi que ce soit. Sans lui, n'importe qui pourrait
// épuiser notre quota FIRMS depuis cette adresse publique.

const CAPTEURS = new Set([
  'VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT',
  'MODIS_NRT', 'LANDSAT_NRT',
]);

// Enveloppe France élargie : le relais ne sert qu'à ce site, rien ne justifie
// d'aller chercher des détections à l'autre bout du monde avec notre clé.
const LIMITES = { ouest: -6, sud: 40, est: 11, nord: 52 };
const JOURS_MAX = 10;
const DELAI_MS = 55000;

function refuser(res, code, raison) {
  res.setHeader('Content-Type', 'text/plain');
  res.status(code).send(raison + '\n');
}

module.exports = async (req, res) => {
  const cle = process.env.FIRMS_MAP_KEY;
  const jetonAttendu = process.env.RELAIS_FIRMS_JETON;

  if (!cle) return refuser(res, 500, 'clé FIRMS non configurée');
  // Pas de jeton configuré = relais ouvert à tous : on refuse de servir
  // plutôt que d'offrir notre quota au premier venu.
  if (!jetonAttendu) return refuser(res, 503, 'relais désactivé : RELAIS_FIRMS_JETON non configuré');

  let segments;
  try {
    const chemin = new URL(req.url, 'http://x').pathname;
    segments = chemin.split('/').filter(Boolean);
    // …/api/relais-firms/<jeton>/firms/<capteur>/<bbox>/<jours>
    const debut = segments.indexOf('relais-firms');
    segments = debut >= 0 ? segments.slice(debut + 1) : [];
  } catch (e) {
    return refuser(res, 400, 'requête illisible');
  }

  const [jeton, litteral, capteur, bbox, joursBrut] = segments;

  if (jeton !== jetonAttendu) return refuser(res, 403, 'jeton invalide');
  if (litteral !== 'firms') return refuser(res, 404, 'chemin inconnu');
  if (!CAPTEURS.has(capteur)) return refuser(res, 400, 'capteur inconnu');

  const bornes = String(bbox || '').split(',').map(Number);
  if (bornes.length !== 4 || bornes.some((n) => !isFinite(n))) {
    return refuser(res, 400, 'bbox invalide');
  }
  const [ouest, sud, est, nord] = bornes;
  if (ouest >= est || sud >= nord
    || ouest < LIMITES.ouest || est > LIMITES.est
    || sud < LIMITES.sud || nord > LIMITES.nord) {
    return refuser(res, 400, 'bbox hors de la zone autorisée');
  }

  const jours = Number(joursBrut);
  if (!Number.isInteger(jours) || jours < 1 || jours > JOURS_MAX) {
    return refuser(res, 400, 'nombre de jours invalide (1 à ' + JOURS_MAX + ')');
  }

  const url = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/'
    + `${cle}/${capteur}/${ouest},${sud},${est},${nord}/${jours}`;

  const stop = new AbortController();
  const minuteur = setTimeout(() => stop.abort(), DELAI_MS);
  let texte;
  try {
    const r = await fetch(url, { signal: stop.signal });
    if (!r.ok) return refuser(res, 502, 'FIRMS a répondu ' + r.status);
    texte = await r.text();
  } catch (e) {
    // Le message d'erreur pourrait contenir l'URL, donc la clé : on ne le
    // renvoie jamais tel quel.
    return refuser(res, 504, e.name === 'AbortError' ? 'FIRMS : délai dépassé' : 'FIRMS injoignable');
  } finally {
    clearTimeout(minuteur);
  }

  // FIRMS répond parfois en 200 avec un message d'erreur en guise de CSV.
  if (/invalid|error|exceed/i.test(texte.slice(0, 200))) {
    return refuser(res, 502, 'FIRMS a refusé la requête');
  }

  // La chaîne amont tourne toutes les 30 minutes et redemande les mêmes
  // journées : le cache épargne autant d'appels à notre quota.
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
  res.setHeader('Content-Type', 'text/csv');
  res.status(200).send(texte);
};
