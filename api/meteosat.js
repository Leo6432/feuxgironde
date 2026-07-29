// EXPÉRIMENTAL — étape 1 seulement : prouver qu'on peut s'authentifier
// auprès d'EUMETSAT et voir la fraîcheur du produit FRP (Fire Radiative
// Power) dérivé de Meteosat, avant de tenter l'extraction des pixels sur
// Saumos (qui demande de décoder la projection géostationnaire du satellite
// — une étape à part, plus lourde, pas encore écrite).
//
// Contrairement à FIRMS (CSV en clair, clé gratuite par simple email),
// EUMETSAT distribue ses données via une API OAuth2 (jeton d'accès à partir
// d'un couple clé/secret), et les fichiers eux-mêmes sont en NetCDF — un
// format binaire de grille satellite, pas un tableau lat/lon direct.
//
// Non testé en conditions réelles : écrit à partir de la documentation
// connue de l'API EUMETSAT Data Store, sans accès réseau pour vérifier ici.
// Variables d'environnement nécessaires (à créer sur https://api.eumetsat.int
// après inscription gratuite, jamais dans le code) :
//   EUMETSAT_CONSUMER_KEY, EUMETSAT_CONSUMER_SECRET

const TOKEN_URL = 'https://api.eumetsat.int/token';
// Identifiant de collection du produit FRP-PIXEL (Meteosat) — motif de
// nommage EUMETSAT habituel, à confirmer sur le portail une fois les
// identifiants disponibles : peut nécessiter un ajustement.
const COLLECTION_FRP = 'EO:EUM:DAT:MSG:FRP-PIXEL';
const RECHERCHE_URL = 'https://api.eumetsat.int/data/search-products/1.0.0/os';

function sansSecret(message, valeurs) {
  let m = String(message || 'erreur inconnue');
  valeurs.forEach((v) => { if (v) m = m.split(v).join('SECRET'); });
  return m.slice(0, 200);
}

async function obtenirJeton(cle, secret) {
  const identifiants = Buffer.from(`${cle}:${secret}`).toString('base64');
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${identifiants}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const texte = await r.text();
  if (!r.ok) throw new Error(`jeton refusé (HTTP ${r.status}): ${sansSecret(texte, [cle, secret])}`);
  let json;
  try { json = JSON.parse(texte); } catch (e) { throw new Error('jeton : réponse illisible'); }
  if (!json.access_token) throw new Error('jeton : access_token absent de la réponse');
  return json.access_token;
}

async function dernierProduit(jeton) {
  // Recherche les produits les plus récents de la collection, triés du plus
  // récent au plus ancien — on ne demande que les métadonnées (pas le
  // fichier lui-même) pour cette première étape.
  const u = new URL(RECHERCHE_URL);
  u.searchParams.set('format', 'json');
  u.searchParams.set('pi', COLLECTION_FRP);
  u.searchParams.set('si', '0');
  u.searchParams.set('c', '5');
  u.searchParams.set('sort', 'desc,start,time');

  const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${jeton}` } });
  const texte = await r.text();
  if (!r.ok) throw new Error(`recherche produits échouée (HTTP ${r.status}): ${sansSecret(texte, [jeton])}`);
  let json;
  try { json = JSON.parse(texte); } catch (e) { throw new Error('recherche : réponse illisible'); }
  return json;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const cle = process.env.EUMETSAT_CONSUMER_KEY;
  const secret = process.env.EUMETSAT_CONSUMER_SECRET;
  if (!cle || !secret) {
    res.status(200).json({
      ok: false,
      etape: 'configuration',
      raison: 'identifiants EUMETSAT non configurés (EUMETSAT_CONSUMER_KEY / EUMETSAT_CONSUMER_SECRET)',
      aFaire: 'Créer un compte gratuit sur https://api.eumetsat.int, générer un couple clé/secret (onglet « API key »), les ajouter comme variables d’environnement Vercel — jamais dans le code.',
    });
    return;
  }

  let jeton;
  try {
    jeton = await obtenirJeton(cle, secret);
  } catch (e) {
    res.status(200).json({
      ok: false,
      etape: 'authentification',
      raison: sansSecret(e.message, [cle, secret]),
    });
    return;
  }

  try {
    const resultat = await dernierProduit(jeton);
    res.status(200).json({
      ok: true,
      etape: 'connecte',
      collection: COLLECTION_FRP,
      // Renvoyé tel quel pour l'instant : cette étape sert à voir la forme
      // réelle de la réponse EUMETSAT (dates, identifiants de fichiers)
      // avant d'écrire l'extraction des pixels sur Saumos.
      brut: resultat,
    });
  } catch (e) {
    res.status(200).json({
      ok: false,
      etape: 'recherche_produits',
      raison: sansSecret(e.message, [cle, secret, jeton]),
    });
  }
};
