// Précalcule et archive l'état des feux pour tous les crans de la barre
// temporelle, afin que la carte n'ait plus qu'à lire des états déjà prêts.
//
// Sans ça, chaque cran jamais visité payait son propre calcul au moment où
// l'utilisateur y arrivait — d'où l'attente. Ici tout est calculé d'avance,
// en une seule passe.
//
// Le gain vient de l'ordre chronologique : l'état à un cran est celui du cran
// précédent, complété des détections survenues entre les deux. Les grilles
// sont donc conservées d'un cran au suivant et le marquage — de loin le plus
// coûteux — n'est fait qu'une fois au total, au lieu d'une fois par cran.
//
// Déclenché par la tâche planifiée de Vercel (voir vercel.json) et appelable
// à la main. Les crans déjà archivés sont sautés, sauf avec ?force=1.

const { getClient } = require('../lib/redis');
const etatFeux = require('../lib/etatFeux');
const sourcesRecurrentes = require('../lib/sourcesRecurrentes');

// Marge sous la limite d'exécution de la fonction : on préfère s'arrêter en
// annonçant ce qui reste à faire plutôt que d'être coupé en pleine réponse.
// Un appel suivant reprendra là où celui-ci s'est arrêté, les crans déjà
// archivés étant sautés.
const BUDGET_MS = 240000;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const depart = Date.now();

  const cle = process.env.FIRMS_MAP_KEY;
  if (!cle) {
    res.status(200).json({ ok: false, raison: 'clé FIRMS non configurée' });
    return;
  }

  let force = false;
  try {
    force = new URL(req.url, 'http://x').searchParams.get('force') === '1';
  } catch (e) { /* pas de forçage */ }

  let redis = null;
  try {
    const p = getClient();
    redis = p ? await p : null;
  } catch (e) {
    redis = null;
  }
  if (!redis) {
    res.status(200).json({
      ok: false,
      raison: 'archive indisponible (Redis non configuré) — sans elle, rien ne peut être précalculé',
    });
    return;
  }

  let detections;
  try {
    detections = await etatFeux.detectionsFrance(cle, redis);
  } catch (e) {
    res.status(200).json({ ok: false, raison: e.message || 'API FIRMS injoignable', details: e.details });
    return;
  }

  const geometrieFrance = await etatFeux.frontiereFrance(redis).catch(() => null);
  const points = detections.points
    .filter((p) => (geometrieFrance ? etatFeux.dansGeometrie(p.lon, p.lat, geometrieFrance) : true));

  // N'affecte rien de ce qui s'affiche (voir lib/sourcesRecurrentes.js) :
  // alimente juste, jour après jour, la mémoire longue durée qui permettra
  // un jour de repérer une source industrielle vue par VIIRS.
  const sources = await sourcesRecurrentes.enregistrerJours(redis, points).catch(() => null);

  const maintenant = Date.now();
  const instants = etatFeux.instantsDisponibles(maintenant);
  const dernier = instants[instants.length - 1];

  // Les zones se transmettent en pages (voir lib/etatFeux.js:paginerZones) :
  // plus besoin de sonder un plafond de poids commun à tout le pays avant de
  // démarrer. Chaque foyer prend directement la maille la plus fine qu'il
  // supporte lui-même.
  let prepare;
  try {
    prepare = etatFeux.preparerFoyers(points);
  } catch (e) {
    res.status(200).json({ ok: false, raison: 'préparation des foyers échouée : ' + e.message });
    return;
  }

  // Une seule fois pour tout le balayage chronologique (voir chargerEauFoyers) :
  // l'eau intérieure ne bouge pas d'un cran à l'autre, la requêter à chaque
  // cran serait un travail réseau perdu.
  const foyersAvecEau = await etatFeux.chargerEauFoyers(prepare.foyers, prepare.origine, redis).catch(() => 0);

  // Chargée une seule fois pour tout le balayage chronologique, et non par
  // cran : les crans d'une même invocation partagent la même mémoire en
  // place (voir lib/etatFeux.js:zonesDepuisFoyers), une seule écriture
  // suffit ensuite pour tout archiver.
  //
  // `null` signale un échec de lecture, distinct d'une mémoire vide (voir
  // chargerComblage) : on calcule quand même tous les crans (avec une
  // mémoire vide locale), mais on n'écrit rien dans Redis à la fin — sans
  // quoi une panne Redis transitoire ferait passer TOUTES les cellules
  // comblées de cette invocation pour inédites, et ces dates fraîches
  // fabriquées seraient gravées pour de bon dans une mémoire jamais purgée.
  const comblageCharge = await etatFeux.chargerComblage(redis);
  const lectureComblageEchouee = comblageCharge === null;
  const comblage = comblageCharge || new Map();
  const nouveauxComblage = new Map();

  let calcules = 0, sautes = 0, restants = 0;
  const chronologique = instants.slice().sort((a, b) => a - b);

  for (let n = 0; n < chronologique.length; n++) {
    const instant = chronologique[n];

    // Les grilles avancent dans tous les cas : sauter l'écriture d'un cran
    // déjà archivé ne doit pas sauter son marquage, sinon les crans suivants
    // seraient calculés sur des grilles incomplètes.
    etatFeux.avancerJusqua(prepare.foyers, instant, prepare.origine, prepare.pasGrille);

    if (Date.now() - depart > BUDGET_MS) { restants = chronologique.length - n; break; }

    if (!force) {
      const deja = await etatFeux.lireEtat(redis, instant);
      // Un cran n'est sauté que s'il est réellement arrêté. Le dernier reçoit
      // de nouvelles détections en continu ; les récents, le rattrapage du
      // retard de publication de FIRMS. Les sauter figeait un état incomplet
      // pour trente jours — c'est ce qui creusait des marches dans la
      // progression.
      if (deja && instant !== dernier && etatFeux.estFige(instant, maintenant)) {
        sautes++;
        continue;
      }
    }

    const { zones, cellulesTotal } = etatFeux.zonesDepuisFoyers(
      prepare.foyers, instant, prepare.origine, prepare.pasGrille, comblage, nouveauxComblage
    );
    // Seulement au cran le plus récent : une projection « +1 h » n'a de sens
    // qu'au tout dernier état connu, pas rejouée pour chaque cran archivé
    // (voir lib/etatFeux.js:calculerFrontsPlausibles).
    const frontsPlausibles = instant === dernier
      ? etatFeux.calculerFrontsPlausibles(prepare.foyers, prepare.origine)
      : undefined;
    const etat = etatFeux.sortie(
      instant, instants, zones, cellulesTotal, prepare.foyers.length,
      etatFeux.foyersActifs(points, instant), geometrieFrance, prepare, detections,
      frontsPlausibles
    );
    await etatFeux.enregistrerEtat(redis, instant, etat, instant === dernier);
    calcules++;
  }

  if (!lectureComblageEchouee) await etatFeux.enregistrerComblage(redis, nouveauxComblage);

  // Purement informatif (voir lib/sourcesRecurrentes.js) : suit
  // l'accumulation dans le temps, ne filtre encore rien sur la carte.
  const statsSources = await sourcesRecurrentes.statistiques(redis).catch(() => null);

  res.status(200).json({
    ok: true,
    crans: instants.length,
    calcules,
    sautes,
    restants,
    foyers: prepare.foyers.length,
    detections: points.length,
    mailleFineM: prepare.mailleMinM,
    detectionsDuCache: detections.duCache,
    frontierePrecise: !!geometrieFrance,
    foyersAvecMasqueEau: foyersAvecEau,
    comblageCellulesNouvelles: nouveauxComblage.size,
    comblageLectureEchouee: lectureComblageEchouee,
    sourcesRecurrentes: sources && statsSources
      ? Object.assign({ cellulesVues: sources.cellulesVues }, statsSources)
      : null,
    dureeMs: Date.now() - depart,
    // Ce qu'il reste à faire est annoncé : un appel suivant reprendra là où
    // celui-ci s'est arrêté.
    note: restants
      ? restants + ' cran(s) non traité(s) faute de temps — relancer cet appel les terminera'
      : 'tous les crans sont archivés',
  });
};
