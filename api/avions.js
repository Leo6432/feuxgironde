// Position en direct des avions et hélicoptères confirmés de la flotte de la
// Sécurité civile (voir lib/avionsFeu.js), pour la carte.
//
// Voir lib/avionsFeu.js pour l'origine des données (airplanes.live) et les
// réserves sur l'identification des avions — best-effort, non vérifiée en
// direct depuis l'environnement où ce fichier a été écrit (le service y est
// bloqué). ?diag=1 court-circuite le cache et renvoie le détail par quadrant
// (reçus/retenus/erreur, indicatifs vus) — c'est le seul moyen de savoir ce
// que répond réellement airplanes.live sans y avoir accès direct.
//
// Pas de filtre de proximité à un feu, ni de filtre sur la mission : un
// Canadair à 300 km de tout foyer, en transit ou à l'entraînement, reste un
// moyen de lutte, et un EC145 en évacuation sanitaire reste un moyen de la
// Sécurité civile. C'est l'appartenance à la flotte (voir PATRONS dans
// lib/avionsFeu.js) qui décide, jamais la position ou l'activité du moment —
// cohérent avec le fonctionnement observé d'un site de référence,
// github.com/rozierguillaume/flamap, qui affiche de même les hélicoptères
// polyvalents (juste distingués par une icône, jamais exclus).
//
// La réponse est mise en cache brièvement et partagée entre tous les
// visiteurs (une visite ne doit pas coûter un appel à elle seule). Si
// airplanes.live ne répond pas, la dernière position connue est resservie
// avec `perime: true` plutôt que de laisser la carte vide — un avion qui
// volait il y a une minute vole probablement encore.
//
// La réponse porte aussi `historique24h` : les avions distincts vus dans les
// dernières 24 h, du plus récent au plus ancien (voir vus24h dans
// lib/avionsFeu.js). Ça alimente le badge et la liste du panneau côté carte,
// qui restent significatifs même quand aucun avion n'est visible à l'instant.

const { getClient } = require('../lib/redis');
const { recupererAvions, enregistrerVus, vus24h } = require('../lib/avionsFeu');

const CLE_CACHE = 'avions:etat:v1';
const CLE_SECOURS = 'avions:secours:v1';
// Un relevé confirmé (flamap : « signal ADS-B reçu il y a 15 s ») situe le
// rythme réel de la source aux alentours de 12-15 s, pas 60 s comme supposé
// avant d'avoir cette donnée. Resserré en conséquence — mais pas au-delà :
// airplanes.live documente une limite de l'ordre d'1 requête par seconde, et
// chaque sondage lui envoie déjà 4 requêtes (une par quadrant, voir
// lib/avionsFeu.js). Ce cache est ce qui borne la fréquence de CES 4
// requêtes, pas le sondage de chaque visiteur (voir DUREE_SONDAGE_MS côté
// client) : à 8 s, un pic de visiteurs reste sous ~0,5 requête/s en moyenne
// vers airplanes.live, avec de la marge. Descendre plus bas rapprocherait
// dangereusement de leur limite, pour un gain de fraîcheur que la source
// elle-même ne tiendrait de toute façon pas.
const DUREE_CACHE_S = 8;
const DUREE_SECOURS_S = 3600;

module.exports = async (req, res) => {
  let diag = false;
  try { diag = new URL(req.url, 'http://x').searchParams.get('diag') === '1'; } catch (e) { /* pas de diag */ }

  // Même raisonnement pour le cache d'arête Vercel, devant le cache Redis :
  // au pire 15 s de retard cumulé (5 + 10), sous le rythme de la source.
  //
  // `max-age=0` : `s-maxage` seul ne s'adresse qu'aux caches partagés (CDN)
  // et le navigateur, lui, pouvait réutiliser sa PROPRE copie sans jamais
  // revalider — un sondage client ne servait alors à rien si le navigateur
  // répondait depuis son cache local.
  res.setHeader('Cache-Control',
    diag ? 'no-store' : 's-maxage=5, max-age=0, stale-while-revalidate=10');

  let redis = null;
  try {
    const p = getClient();
    redis = p ? await p : null;
  } catch (e) {
    redis = null;
  }

  if (!diag && redis) {
    try {
      const brut = await redis.get(CLE_CACHE);
      if (brut) {
        res.setHeader('X-Cache', 'chaud');
        res.status(200).json(JSON.parse(brut));
        return;
      }
    } catch (e) { /* on recalcule */ }
  }

  let donnees;
  try {
    donnees = await recupererAvions(diag);
  } catch (e) {
    // airplanes.live ne répond pas : la dernière position connue vaut mieux
    // que rien — sauf en diagnostic, où l'on veut voir l'échec brut.
    if (!diag && redis) {
      try {
        const secours = await redis.get(CLE_SECOURS);
        if (secours) {
          const etat = JSON.parse(secours);
          etat.perime = true;
          etat.raisonPerime = e.message;
          res.setHeader('X-Cache', 'secours');
          res.status(200).json(etat);
          return;
        }
      } catch (e2) { /* pas de secours non plus */ }
    }
    res.status(200).json({
      ok: false, raison: e.message || 'airplanes.live injoignable',
      parQuadrant: e.parQuadrant,
    });
    return;
  }

  // L'enregistrement n'a de sens qu'après une moisson fraîche : c'est le seul
  // moment où l'on sait vraiment que ces avions volaient à cet instant. Une
  // réponse servie depuis le cache ne repasse jamais ici, ce qui évite
  // d'écrire vingt fois la même observation pour une seule moisson réelle.
  await enregistrerVus(redis, donnees.avions, donnees.instant);
  const historique24h = await vus24h(redis, donnees.instant);

  const etat = {
    ok: true, instant: donnees.instant, avions: donnees.avions, perime: false,
    historique24h,
    parQuadrant: diag ? donnees.parQuadrant : undefined,
  };

  if (!diag && redis) {
    try { await redis.set(CLE_CACHE, JSON.stringify(etat), { EX: DUREE_CACHE_S }); } catch (e) { /* tant pis */ }
    try { await redis.set(CLE_SECOURS, JSON.stringify(etat), { EX: DUREE_SECOURS_S }); } catch (e) { /* tant pis */ }
  }

  res.setHeader('X-Cache', diag ? 'diag' : 'calcul');
  res.status(200).json(etat);
};
