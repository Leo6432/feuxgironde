// État d'activité des feux de France à une date donnée, pour la carte.
//
// Toute la logique de calcul vit dans lib/etatFeux.js, partagée avec le
// précalcul (api/perimetre-precalcul.js). Cet endpoint ne fait que servir un
// état : d'abord depuis l'archive, et seulement à défaut en le calculant.
//
// ?instant=<epoch ms> : la date à rejouer. Sans paramètre, l'état actuel.
// ?page=<n> : une page de zones (voir lib/etatFeux.js:paginerZones), au lieu
// des métadonnées. Le client lit `pages` dans la réponse sans page pour
// savoir combien il lui en faut, et les demande toutes en parallèle.

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

  let page = null;
  // L'instant demandé est recalé sur le cran le plus proche : deux positions
  // voisines du curseur partagent ainsi la même entrée d'archive, au lieu
  // d'en créer une par pixel parcouru.
  let instant = instants[instants.length - 1];
  try {
    const params = new URL(req.url, 'http://x').searchParams;
    const brut = Number(params.get('instant'));
    if (isFinite(brut) && brut > 0) {
      instant = instants.reduce((meilleur, t) =>
        Math.abs(t - brut) < Math.abs(meilleur - brut) ? t : meilleur, instants[0]);
    }
    // Une page se demande sur l'instant exact renvoyé par la réponse sans
    // page (voir emprise.js) : pas de recalage ici, sous peine de viser un
    // cran différent de celui que ses métadonnées décrivent.
    if (params.has('page')) page = Math.max(0, parseInt(params.get('page'), 10) || 0);
  } catch (e) { /* on reste sur l'instant le plus récent, sans page */ }

  const dernier = instants[instants.length - 1];
  const estDernier = instant === dernier;

  // Archive d'abord : c'est le chemin normal une fois le précalcul passé.
  if (page !== null) {
    const fragments = await etatFeux.lirePage(redis, instant, page);
    if (fragments) {
      res.setHeader('X-Cache', 'archive');
      res.status(200).json({ ok: true, instant, page, fragments });
      return;
    }
  } else {
    const archive = await etatFeux.lireEtat(redis, instant);
    if (archive) {
      res.setHeader('X-Cache', 'archive');
      // La liste des crans évolue avec le temps, alors que l'archive est
      // figée : on la rafraîchit, sinon la barre resterait bloquée sur les
      // positions qu'elle avait au moment du calcul.
      archive.instants = instants;
      res.status(200).json(archive);
      return;
    }
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
    if (page !== null) {
      res.status(200).json({ ok: true, instant, page, fragments: [] });
      return;
    }
    res.status(200).json({
      ok: true,
      instant,
      instants,
      zonesMeta: [],
      pages: 0,
      actifs: [],
      paliers: etatFeux.PALIERS_AGE.map((p) => ({ id: p.id, libelle: p.libelle, couleur: p.couleur })),
      horsArchive: true,
      avertissement: 'aucune donnée pour cette date : les détections conservées ne '
        + 'commencent qu’au ' + new Date(plusAncienne).toISOString().slice(0, 10),
    });
    return;
  }

  let etat;
  try {
    const prepare = etatFeux.preparerFoyers(points);
    await etatFeux.chargerEauFoyers(prepare.foyers, prepare.origine, redis).catch(() => 0);
    etatFeux.avancerJusqua(prepare.foyers, instant, prepare.origine, prepare.pasGrille);
    const comblage = await etatFeux.chargerComblage(redis);
    const nouveauxComblage = new Map();
    const { zones, cellulesTotal } = etatFeux.zonesDepuisFoyers(
      prepare.foyers, instant, prepare.origine, prepare.pasGrille, comblage, nouveauxComblage
    );
    await etatFeux.enregistrerComblage(redis, nouveauxComblage);
    // Seulement au cran le plus récent : une projection « +1 h » n'a de sens
    // qu'au tout dernier état connu (voir calculerFrontsPlausibles).
    const frontsPlausibles = estDernier
      ? etatFeux.calculerFrontsPlausibles(prepare.foyers, prepare.origine)
      : undefined;
    etat = etatFeux.sortie(
      instant, instants, zones, cellulesTotal, prepare.foyers.length,
      etatFeux.foyersActifs(points, instant), geometrieFrance, prepare, detections,
      frontsPlausibles
    );
  } catch (e) {
    res.status(200).json({ ok: false, raison: 'calcul des zones échoué : ' + e.message, instants });
    return;
  }

  const { meta, pages } = await etatFeux.enregistrerEtat(redis, instant, etat, estDernier);

  res.setHeader('X-Cache', 'calcul');
  if (page !== null) {
    res.status(200).json({ ok: true, instant, page, fragments: pages[page] || [] });
    return;
  }
  const enveloppe = Object.assign({}, etat, { zones: undefined, zonesMeta: meta, pages: pages.length, instants });
  delete enveloppe.zones;
  res.status(200).json(enveloppe);
};
