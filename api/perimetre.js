// État d'activité des feux de France à une date donnée, pour la carte.
//
// Toute la logique de calcul vit dans lib/etatFeux.js, partagée avec le
// précalcul (api/perimetre-precalcul.js). Cet endpoint ne fait que servir un
// état : d'abord depuis l'archive, et seulement à défaut en le calculant.
//
// ?instant=<epoch ms> : la date à rejouer. Sans paramètre, l'état actuel.

const { getClient } = require('../lib/redis');
const etatFeux = require('../lib/etatFeux');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');

  const cle = process.env.FIRMS_MAP_KEY;
  if (!cle) {
    res.status(200).json({ ok: false, raison: 'clé FIRMS non configurée' });
    return;
  }

  let redis = null;
  try {
    const p = getClient();
    redis = p ? await p : null;
  } catch (e) {
    redis = null;
  }

  const maintenant = Date.now();
  const instants = etatFeux.instantsDisponibles(maintenant);

  // L'instant demandé est recalé sur le cran le plus proche : deux positions
  // voisines du curseur partagent ainsi la même entrée d'archive, au lieu
  // d'en créer une par pixel parcouru.
  let instant = instants[instants.length - 1];
  try {
    const brut = Number(new URL(req.url, 'http://x').searchParams.get('instant'));
    if (isFinite(brut) && brut > 0) {
      instant = instants.reduce((meilleur, t) =>
        Math.abs(t - brut) < Math.abs(meilleur - brut) ? t : meilleur, instants[0]);
    }
  } catch (e) { /* on reste sur l'instant le plus récent */ }

  const dernier = instants[instants.length - 1];
  const estDernier = instant === dernier;

  // La maille est commune à toute la barre : sans elle dans la clé, un cran
  // rendu à 20 m côtoierait un cran rendu à 40 m, et la surface annoncée
  // sauterait d'un cran à l'autre sans qu'un hectare ait brûlé.
  const rangConnu = await etatFeux.lireRangMaille(redis);

  // Archive d'abord : c'est le chemin normal une fois le précalcul passé.
  const archive = rangConnu === null ? null : await etatFeux.lireEtat(redis, instant, rangConnu);
  if (archive) {
    res.setHeader('X-Cache', 'archive');
    // La liste des crans évolue avec le temps, alors que l'archive est figée :
    // on la rafraîchit, sinon la barre resterait bloquée sur les positions
    // qu'elle avait au moment du calcul.
    archive.instants = instants;
    res.status(200).json(archive);
    return;
  }

  let detections;
  try {
    detections = await etatFeux.detectionsFrance(cle, redis);
  } catch (e) {
    res.status(200).json({
      ok: false,
      raison: e.message || 'API FIRMS injoignable',
      details: e.details,
      instants,
    });
    return;
  }

  const geometrieFrance = await etatFeux.frontiereFrance(redis).catch(() => null);
  const points = detections.points
    .filter((p) => (geometrieFrance ? etatFeux.dansGeometrie(p.lon, p.lat, geometrieFrance) : true));

  // Une date antérieure à la plus ancienne détection dont on dispose ne peut
  // pas être reconstituée. Le cas normal est couvert — la barre s'arrête à la
  // portée de FIRMS — mais si leur service renvoie une fenêtre plus courte que
  // prévu, mieux vaut le dire que d'afficher une carte vide, qui laisserait
  // croire que rien ne brûlait à cette date.
  const plusAncienne = points.length ? points[0].ts : null;
  if (plusAncienne !== null && instant < plusAncienne) {
    res.status(200).json({
      ok: true,
      instant,
      instants,
      zones: [],
      actifs: [],
      paliers: etatFeux.PALIERS_AGE.map((p) => ({ id: p.id, libelle: p.libelle, couleur: p.couleur })),
      horsArchive: true,
      avertissement: 'aucune donnée pour cette date : les détections conservées ne '
        + 'commencent qu’au ' + new Date(plusAncienne).toISOString().slice(0, 10),
    });
    return;
  }

  let etat;
  let rangRetenu = rangConnu;
  try {
    // Maille encore inconnue : on la fixe sur le cran le plus récent, celui
    // qui porte le plus de contours. La décider sur le cran demandé donnerait
    // une finesse différente selon l'endroit où l'on se trouve dans la barre.
    if (rangRetenu === null) {
      rangRetenu = etatFeux.etatAuBudget(points, dernier, 0).rangMini;
      await etatFeux.enregistrerRangMaille(redis, rangRetenu);
    }

    // Le plancher est imposé, mais la maille peut encore s'élargir si ce cran
    // déborde quand même : mieux vaut des pixels plus gros qu'une réponse trop
    // lourde pour partir. Le cas échéant, la maille commune suit.
    const t = etatFeux.etatAuBudget(points, instant, rangRetenu);
    if (t.rangMini > rangRetenu) {
      rangRetenu = t.rangMini;
      await etatFeux.enregistrerRangMaille(redis, rangRetenu);
    }
    etat = etatFeux.sortie(
      instant, instants, t.zones, t.cellulesTotal, t.prepare.foyers.length,
      etatFeux.foyersActifs(points, instant), geometrieFrance, t.prepare, detections
    );
  } catch (e) {
    res.status(200).json({ ok: false, raison: 'calcul des zones échoué : ' + e.message, instants });
    return;
  }

  await etatFeux.enregistrerEtat(redis, instant, etat, estDernier, rangRetenu);

  res.setHeader('X-Cache', 'calcul');
  res.status(200).json(etat);
};
