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

const { getClient } = require('../lib/redis');
const { recupererAvions } = require('../lib/avionsFeu');

const CLE_CACHE = 'avions:etat:v1';
const CLE_SECOURS = 'avions:secours:v1';
const DUREE_CACHE_S = 25;
const DUREE_SECOURS_S = 3600;

module.exports = async (req, res) => {
  let diag = false;
  try { diag = new URL(req.url, 'http://x').searchParams.get('diag') === '1'; } catch (e) { /* pas de diag */ }

  res.setHeader('Cache-Control', diag ? 'no-store' : 's-maxage=15, stale-while-revalidate=60');

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

  const etat = {
    ok: true, instant: donnees.instant, avions: donnees.avions, perime: false,
    parQuadrant: diag ? donnees.parQuadrant : undefined,
  };

  if (!diag && redis) {
    try { await redis.set(CLE_CACHE, JSON.stringify(etat), { EX: DUREE_CACHE_S }); } catch (e) { /* tant pis */ }
    try { await redis.set(CLE_SECOURS, JSON.stringify(etat), { EX: DUREE_SECOURS_S }); } catch (e) { /* tant pis */ }
  }

  res.setHeader('X-Cache', diag ? 'diag' : 'calcul');
  res.status(200).json(etat);
};
