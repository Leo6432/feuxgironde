// Courbe de la surface brûlée, cran par cran, lue dans l'archive.
//
// Sert à vérifier que la progression dans le temps est plausible. Une surface
// ne peut que croître d'un cran au suivant : une cellule vue chaude une fois
// le reste pour toujours, seule sa couleur vieillit. Un bond brutal, ou pire
// un recul, trahit donc des crans calculés à des moments différents avec des
// jeux de détections différents — et pas un feu qui aurait vraiment doublé en
// six heures.
//
// Lecture seule : rien n'est calculé ici, uniquement ce qui est déjà archivé.
// Un cran absent est signalé tel quel plutôt que recalculé, justement pour
// montrer les trous.

const { getClient } = require('../lib/redis');
const etatFeux = require('../lib/etatFeux');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  let redis = null;
  try {
    const p = getClient();
    redis = p ? await p : null;
  } catch (e) {
    redis = null;
  }
  if (!redis) {
    res.status(200).json({ ok: false, raison: 'archive indisponible (Redis non configuré)' });
    return;
  }

  const instants = etatFeux.instantsDisponibles(Date.now());
  const etats = await Promise.all(instants.map((t) => etatFeux.lireEtat(redis, t)));

  let precedente = null;
  let reculs = 0;
  let plusGrosBond = { facteur: 0, quand: null };

  const crans = instants.map((t, n) => {
    const e = etats[n];
    if (!e) return { quand: new Date(t).toISOString().slice(0, 16).replace('T', ' '), archive: false };

    const km2 = Math.round((e.zones || []).reduce((s, z) => s + (z.surfaceKm2 || 0), 0) * 10) / 10;
    const ligne = {
      quand: new Date(t).toISOString().slice(0, 16).replace('T', ' '),
      km2,
      foyers: e.foyers,
      complet: e.complet !== false,
    };

    if (precedente !== null) {
      // Écart avec le cran précédent : c'est lui qui parle, pas la valeur.
      ligne.ecartKm2 = Math.round((km2 - precedente) * 10) / 10;
      if (ligne.ecartKm2 < -0.5) { ligne.recul = true; reculs++; }
      if (precedente > 1) {
        const facteur = km2 / precedente;
        if (facteur > plusGrosBond.facteur) plusGrosBond = { facteur: Math.round(facteur * 100) / 100, quand: ligne.quand };
      }
    }
    precedente = km2;
    return ligne;
  });

  const archives = crans.filter((c) => c.archive !== false).length;
  const incomplets = crans.filter((c) => c.complet === false).length;

  res.status(200).json({
    ok: true,
    crans: crans.length,
    archives,
    manquants: crans.length - archives,
    incomplets,
    reculs,
    plusGrosBond,
    // Le verdict tient en une phrase : c'est ce qu'on veut lire d'abord.
    verdict: reculs
      ? reculs + ' cran(s) où la surface RECULE — impossible, des crans ont été '
        + 'calculés avec des jeux de détections différents'
      : (plusGrosBond.facteur > 2
        ? 'la surface plus que double en six heures le ' + plusGrosBond.quand
          + ' (x' + plusGrosBond.facteur + ') — à vérifier'
        : 'progression régulière, rien d’anormal'),
    courbe: crans,
  });
};
