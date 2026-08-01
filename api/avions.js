// Position en direct des avions de la Sécurité civile, pour la carte.
//
// Voir lib/avionsFeu.js pour l'origine des données (OpenSky Network) et les
// réserves sur l'identification des avions — best-effort, non vérifiée en
// direct depuis cet environnement.
//
// La réponse est mise en cache brièvement et partagée entre tous les
// visiteurs (une visite ne doit pas coûter un appel OpenSky à elle seule :
// l'accès anonyme y est limité). Si OpenSky ne répond pas, la dernière
// position connue est resservie avec `perime: true` plutôt que de laisser la
// carte vide — un avion qui volait il y a une minute vole probablement
// encore.

const { getClient } = require('../lib/redis');
const { recupererAvions } = require('../lib/avionsFeu');

const CLE_CACHE = 'avions:etat:v1';
const CLE_SECOURS = 'avions:secours:v1';
const DUREE_CACHE_S = 25;
const DUREE_SECOURS_S = 3600;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');

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
      if (brut) {
        res.setHeader('X-Cache', 'chaud');
        res.status(200).json(JSON.parse(brut));
        return;
      }
    } catch (e) { /* on recalcule */ }
  }

  let donnees;
  try {
    donnees = await recupererAvions();
  } catch (e) {
    // OpenSky ne répond pas : la dernière position connue vaut mieux que rien.
    if (redis) {
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
    res.status(200).json({ ok: false, raison: e.message || 'OpenSky injoignable' });
    return;
  }

  const etat = { ok: true, instant: donnees.instant, avions: donnees.avions, perime: false };

  if (redis) {
    try { await redis.set(CLE_CACHE, JSON.stringify(etat), { EX: DUREE_CACHE_S }); } catch (e) { /* tant pis */ }
    try { await redis.set(CLE_SECOURS, JSON.stringify(etat), { EX: DUREE_SECOURS_S }); } catch (e) { /* tant pis */ }
  }

  res.setHeader('X-Cache', 'calcul');
  res.status(200).json(etat);
};
