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
// airplanes.live ne republie une position que toutes les ~60 s environ (le
// rythme réel des sources ADS-B communautaires) : au-delà, mettre en cache
// plus longtemps ne coûte rien de plus en fraîcheur. En revanche, un cache
// plus long que le sondage du client (20 s, voir emprise.js) lui faisait
// recevoir plusieurs fois de suite la même position — et donc aucun nouveau
// point de sillage, puisque poserOuDeplacer n'en ajoute qu'au mouvement.
const DUREE_CACHE_S = 15;
const DUREE_SECOURS_S = 3600;

module.exports = async (req, res) => {
  let diag = false;
  try { diag = new URL(req.url, 'http://x').searchParams.get('diag') === '1'; } catch (e) { /* pas de diag */ }

  // Même raisonnement pour le cache d'arête Vercel, devant le cache Redis :
  // au pire 30 s de retard cumulé (10 + 20), toujours sous le rythme de la
  // source, plutôt que les 75 s (15 + 60) d'avant qui pouvaient à eux seuls
  // couvrir plus d'un sondage client sans rien de neuf à afficher.
  //
  // `max-age=0` en plus : `s-maxage` seul ne s'adresse qu'aux caches
  // partagés (CDN) et le navigateur, lui, pouvait réutiliser sa PROPRE copie
  // sans jamais revalider — un sondage client toutes les 20 s ne servait
  // alors à rien si le navigateur répondait depuis son cache local. Ce
  // n'est pas confirmé en direct (outils de déploiement indisponibles au
  // moment d'écrire ceci), mais c'est correct dans tous les cas : ce
  // réglage ne peut pas aggraver la fraîcheur, seulement l'améliorer.
  res.setHeader('Cache-Control',
    diag ? 'no-store' : 's-maxage=10, max-age=0, stale-while-revalidate=20');

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
