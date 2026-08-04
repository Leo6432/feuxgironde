// Backfill ponctuel de lib/sourcesRecurrentes.js sur l'hiver dernier, à
// partir de l'archive FIRMS « Standard Processing » (SP) — pas le NRT
// utilisé partout ailleurs sur le site.
//
// Pourquoi : distinguer une source industrielle récurrente d'un feu de forêt
// exceptionnellement long demande de voir une cellule encore chaude hors
// saison des feux — l'hiver est la preuve la plus solide qui soit, un feu de
// forêt y étant quasiment impossible en France. Attendre l'hiver PROCHAIN
// aurait pris des mois. Mais le NRT ne remonte pas au-delà d'une fenêtre
// glissante (voir JOURS_FIRMS_MAX dans lib/etatFeux.js) : décembre 2025 n'y
// est plus. Le produit SP — les mêmes données, retraitées en qualité
// « science », disponibles avec un délai d'environ 5 mois — donne ce même
// signal dès maintenant, sur l'hiver DERNIER plutôt que le prochain.
//
// SP n'existe que pour trois capteurs (voir la doc « Data Availability » de
// FIRMS) : ni LANDSAT ni VIIRS_NOAA21 n'ont ce produit.
//
// Ponctuel et déclenché à la main, pas de cron : une fois le recul obtenu,
// il n'y a plus besoin de le refaire. Reprend là où il s'est arrêté (même
// principe que api/perimetre-precalcul.js) si l'hiver entier ne tient pas
// dans une seule invocation.

const { getClient } = require('../lib/redis');
const etatFeux = require('../lib/etatFeux');
const sourcesRecurrentes = require('../lib/sourcesRecurrentes');

const CAPTEURS_SP = ['MODIS_SP', 'VIIRS_SNPP_SP', 'VIIRS_NOAA20_SP'];

// Dernier hiver météorologique complet (déc.-fév.), par défaut. Ajustable
// via ?debut=AAAA-MM-JJ&fin=AAAA-MM-JJ pour couvrir une autre période.
const DEBUT_DEFAUT = '2025-12-01';
const FIN_DEFAUT = '2026-02-28';

// Borne haute par requête, cohérente avec JOURS_FIRMS_MAX ailleurs dans le
// code — pas de raison de croire l'archive SP moins limitée que le NRT sur
// ce point précis.
const PAS_JOURS = 10;
const JOUR_MS = 86400000;

const BUDGET_MS = 240000;
const CLE_PROGRES = 'feux:sources:backfillProgres:v1';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const depart = Date.now();

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
  if (!redis) {
    res.status(200).json({ ok: false, raison: 'archive indisponible (Redis non configuré)' });
    return;
  }

  const params = new URL(req.url, 'http://x').searchParams;
  const debut = Date.parse((params.get('debut') || DEBUT_DEFAUT) + 'T00:00:00Z');
  const fin = Date.parse((params.get('fin') || FIN_DEFAUT) + 'T00:00:00Z');
  // Reprend après le dernier jour déjà traité, sauf ?force=1 qui repart du
  // début de la période demandée.
  const force = params.get('force') === '1';

  let curseur = debut;
  if (!force) {
    let dernierFait = null;
    try { dernierFait = await redis.get(CLE_PROGRES); } catch (e) { /* on repart du début */ }
    if (dernierFait) {
      const suite = Date.parse(dernierFait) + JOUR_MS;
      if (suite > debut) curseur = suite;
    }
  }

  const geometrieFrance = await etatFeux.frontiereFrance(redis).catch(() => null);

  let chunks = 0, joursTraites = 0, cellulesVues = 0;
  const erreurs = [];

  while (curseur <= fin) {
    if (Date.now() - depart > BUDGET_MS) break;

    const nJours = Math.min(PAS_JOURS, Math.round((fin - curseur) / JOUR_MS) + 1);
    const dateChunk = new Date(curseur).toISOString().slice(0, 10);

    let points = [];
    for (const capteur of CAPTEURS_SP) {
      try {
        const pts = await etatFeux.recuperer(capteur, cle, nJours, dateChunk);
        points = points.concat(pts);
      } catch (e) {
        erreurs.push(capteur + ' ' + dateChunk + ' (' + nJours + 'j) : ' + e.message);
      }
    }

    const retenus = geometrieFrance
      ? points.filter((p) => etatFeux.dansGeometrie(p.lon, p.lat, geometrieFrance))
      : points;

    const resultat = await sourcesRecurrentes.enregistrerJours(redis, retenus).catch(() => null);
    if (resultat) cellulesVues += resultat.cellulesVues;

    curseur += nJours * JOUR_MS;
    chunks++;
    joursTraites += nJours;
    try {
      await redis.set(CLE_PROGRES, new Date(curseur - JOUR_MS).toISOString().slice(0, 10));
    } catch (e) { /* la prochaine invocation revérifiera depuis Redis, tant pis pour cette fois */ }
  }

  const termine = curseur > fin;
  const stats = await sourcesRecurrentes.statistiques(redis).catch(() => null);

  res.status(200).json({
    ok: true,
    periode: { debut: new Date(debut).toISOString().slice(0, 10), fin: new Date(fin).toISOString().slice(0, 10) },
    chunks,
    joursTraites,
    cellulesVues,
    erreurs,
    termine,
    sourcesRecurrentes: stats,
    dureeMs: Date.now() - depart,
    note: termine
      ? 'période entièrement traitée'
      : 'pas terminé faute de temps — relancer cet appel (sans ?force) reprendra la suite',
  });
};
