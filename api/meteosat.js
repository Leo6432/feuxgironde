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
// Identifiant réel du produit FRP (Fire Radiative Power), trouvé sur
// data.eumetsat.int — EUMETSAT catalogue ce produit sous un identifiant
// numérique, pas un nom descriptif comme espéré au départ.
const COLLECTION_FRP = 'EO:EUM:DAT:0417';
const RECHERCHE_URL = 'https://api.eumetsat.int/data/search-products/1.0.0/os';

function sansSecret(message, valeurs) {
  let m = String(message || 'erreur inconnue');
  valeurs.forEach((v) => { if (v) m = m.split(v).join('SECRET'); });
  return m.slice(0, 200);
}

// Sans limite, un appel qui ne répond jamais bloquerait la fonction jusqu'à
// ce que Vercel la tue elle-même — la page resterait sur « connexion en
// cours » sans jamais afficher d'erreur exploitable. Mieux vaut renoncer
// proprement avant. Deux appels se suivent (jeton puis recherche) : 4 s
// chacun laisse de la marge sous la limite d'exécution d'une fonction
// serverless (10 s sur le plan gratuit Vercel).
const DELAI_MS = 4000;

async function requeteAvecDelai(url, options) {
  const stop = new AbortController();
  const minuteur = setTimeout(() => stop.abort(), DELAI_MS);
  try {
    return await fetch(url, { ...options, signal: stop.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `délai dépassé (${DELAI_MS / 1000}s)` : e.message);
  } finally {
    clearTimeout(minuteur);
  }
}

async function obtenirJeton(cle, secret) {
  const identifiants = Buffer.from(`${cle}:${secret}`).toString('base64');
  const r = await requeteAvecDelai(TOKEN_URL, {
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

// L'identifiant de collection deviné (EO:EUM:DAT:MSG:FRP-PIXEL) n'existe pas
// sous ce nom : plutôt que deviner à nouveau à l'aveugle, on demande à l'API
// elle-même la liste de ses collections et on filtre celles qui parlent de
// feu. Deux chemins possibles pour cette liste (jamais vérifiés en direct) :
// le premier qui répond correctement est utilisé.
const CANDIDATS_COLLECTIONS = [
  'https://api.eumetsat.int/data/browse/1.0.0/collections',
  'https://api.eumetsat.int/data/browse/collections',
];

async function chercherCollectionsFeu(jeton) {
  for (const url of CANDIDATS_COLLECTIONS) {
    try {
      const r = await requeteAvecDelai(url, { headers: { Authorization: `Bearer ${jeton}` } });
      const texte = await r.text();
      if (!r.ok) continue;
      let json;
      try { json = JSON.parse(texte); } catch (e) { continue; }
      // Schéma exact inconnu : on prend la première liste trouvée, quelle
      // que soit la clé qui la porte.
      const liste = Array.isArray(json) ? json
        : (json.collections || json.features || json.items || []);
      if (!Array.isArray(liste) || !liste.length) {
        // Aucune des clés devinées ne correspond (ou la liste est vraiment
        // vide) : on renvoie les clés réelles de la réponse pour ne plus
        // deviner à l'aveugle la prochaine fois.
        return {
          url,
          total: Array.isArray(liste) ? liste.length : 0,
          trouvees: [],
          formeInconnue: Array.isArray(json) ? null : Object.keys(json),
          extrait: texte.slice(0, 500),
        };
      }
      const correspond = /fire|frp|radiative|incend/i;
      const trouvees = liste.filter((c) => correspond.test(JSON.stringify(c)));
      return { url, total: liste.length, trouvees: trouvees.slice(0, 10) };
    } catch (e) { /* candidat suivant */ }
  }
  return null;
}

async function dernierProduit(jeton) {
  // Recherche les produits les plus récents de la collection, triés du plus
  // récent au plus ancien — on ne demande que les métadonnées (pas le
  // fichier lui-même) pour cette première étape.
  // « sort » retiré : c'était un format inventé sans certitude, et il a
  // fait échouer la requête (InvalidParameterValue). On se limite aux
  // paramètres dont le nom est bien documenté (pi, si, c, format) et on
  // laisse l'API renvoyer son tri par défaut pour cette première étape.
  const u = new URL(RECHERCHE_URL);
  u.searchParams.set('format', 'json');
  u.searchParams.set('pi', COLLECTION_FRP);
  u.searchParams.set('si', '0');
  u.searchParams.set('c', '5');

  const r = await requeteAvecDelai(u.toString(), { headers: { Authorization: `Bearer ${jeton}` } });
  const texte = await r.text();
  if (!r.ok) throw new Error(`recherche produits échouée (HTTP ${r.status}): ${sansSecret(texte, [jeton])}`);
  let json;
  try { json = JSON.parse(texte); } catch (e) { throw new Error('recherche : réponse illisible'); }
  return json;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  // Deux façons d'obtenir un jeton : soit un couple clé/secret (échangé
  // contre un jeton à chaque appel), soit un jeton déjà en main (obtenu à la
  // main via user.eumetsat.int/cas/login) — utile pour tester tout de suite,
  // mais un jeton de session CAS expire en général vite (souvent moins d'une
  // heure) : à ne pas considérer comme une solution durable tant qu'on n'a
  // pas confirmé sa durée de vie réelle.
  const jetonDirect = process.env.EUMETSAT_ACCESS_TOKEN;
  const cle = process.env.EUMETSAT_CONSUMER_KEY;
  const secret = process.env.EUMETSAT_CONSUMER_SECRET;

  if (!jetonDirect && (!cle || !secret)) {
    res.status(200).json({
      ok: false,
      etape: 'configuration',
      raison: 'aucun accès EUMETSAT configuré (EUMETSAT_ACCESS_TOKEN, ou EUMETSAT_CONSUMER_KEY + EUMETSAT_CONSUMER_SECRET)',
      aFaire: 'Créer un compte gratuit sur https://eoportal.eumetsat.int, puis obtenir un accès (clé/secret ou jeton), à ajouter comme variable d’environnement Vercel — jamais dans le code.',
    });
    return;
  }

  let jeton = jetonDirect;
  if (!jeton) {
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
    const messagePropre = sansSecret(e.message, [cle, secret, jeton]);
    // Si la collection devinée n'existe pas, on cherche la bonne toute
    // seule plutôt que de simplement remonter l'échec.
    let suggestions = null;
    if (/collection/i.test(messagePropre)) {
      try {
        suggestions = await chercherCollectionsFeu(jeton);
        if (suggestions && suggestions.extrait) suggestions.extrait = sansSecret(suggestions.extrait, [cle, secret, jeton]);
      } catch (e2) { /* tant pis */ }
    }
    res.status(200).json({
      ok: false,
      etape: 'recherche_produits',
      raison: messagePropre,
      collectionEssayee: COLLECTION_FRP,
      suggestions,
    });
  }
};
