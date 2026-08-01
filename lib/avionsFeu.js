// Position des avions de la Sécurité civile (bombardiers d'eau, avions de
// coordination) au-dessus de la France, via airplanes.live — gratuit, à la
// différence de FlightRadar24, et sans clé requise.
//
// (Première version de ce fichier interrogeait OpenSky Network. Son accès
// anonyme s'est révélé insuffisant en pratique — rien ne s'affichait. Repris
// sur airplanes.live, dont on sait par ailleurs qu'il fonctionne : un autre
// site de suivi des feux l'utilise et montre bien des avions.)
//
// Endpoint et format de réponse vérifiés sur la documentation publique de
// l'organisation qui héberge le service elle-même
// (github.com/airplanes-live/api-archive, « Sync with running code ») :
// airplanes.live est injoignable depuis cet environnement de développement
// (host bloqué), donc rien ci-dessous n'a pu être rejoué contre le service
// réel. Le schéma de réponse (`ac`, `hex`, `flight`, `alt_baro`, `gs`…) est
// celui, largement documenté, d'ADS-B Exchange v2 — c'est explicitement ce
// que reprend cette API.
//
// Identification des avions : le service ne dit pas « ceci est un bombardier
// d'eau ». On ne le déduit que de l'indicatif radio (`flight`) diffusé par le
// transpondeur — et de l'immatriculation, qui distingue en France les avions
// d'État (préfixe F-Z : police, douanes, gendarmerie, Sécurité civile...) des
// avions civils ordinaires (F-G).
//
// Le critère retenu : appartenir CONFIRMÉ à la flotte de la Sécurité civile —
// pas « être 100 % dédié au feu ». Ce deuxième critère, plus strict, a été
// essayé puis abandonné après lecture du code source (public, mais sans
// licence déclarée — donc rien n'en est repris ici, ni liste ni code) d'un
// site de référence indiqué par l'utilisateur, flamap
// (github.com/rozierguillaume/flamap) : sa liste d'appareils suivis n'exclut
// pas les hélicoptères polyvalents comme l'EC145, elle les distingue juste
// par une icône différente des avions. Un avion d'État reste un avion d'État
// même les jours où il ne combat rien — comme un Canadair en transit ou à
// l'entraînement reste un moyen de lutte, un EC145 en évacuation sanitaire
// reste un moyen de la Sécurité civile.
//   — « MILAN » : Dash 8 Q400 (F-ZBMK), observé DIRECTEMENT par l'utilisateur
//     sur ce site de référence. La supposition initiale, « DASH », était
//     fausse ; retirée.
//   — « MORA » : hélicoptère EC145 (F-ZBQW), vu au même moment que le Dash 8.
//   — « PELICAN » : indicatif documenté par ailleurs pour les Canadair
//     CL-415, mais encore jamais vu dans un relevé réel — gardé par
//     précaution, à confirmer ou retirer au prochain avis.
//   — « SECU » : ressorti d'un premier relevé réel (1766 avions au-dessus de
//     la France, aucun ne correspondant aux motifs devinés au départ) —
//     « SECUL » n'avait pas la forme d'un vol commercial. Le type
//     d'appareil exact n'a jamais été confirmé, mais le critère n'exige plus
//     cette confirmation : plausible pour la Sécurité civile suffit.
//   — « F-ZB » (sans tiret) : bloc d'immatriculation de la Direction
//     générale de la sécurité civile (confirmé deux fois : F-ZBMK, F-ZBQW),
//     en repli si un avion diffuse son immatriculation plutôt qu'un
//     indicatif dédié.
//
// Volontairement écarté : un AS-350 Écureuil vu au même moment (F-GZAC).
// Son immatriculation commence par F-G — l'aviation civile ordinaire, pas le
// bloc d'État — donc rien ne dit qu'il s'agit d'un hélicoptère engagé contre
// un feu plutôt que d'un vol privé, d'école ou de tourisme sans rapport.
//
// Si un relevé (voir estIndicatifInsolite) ou un nouvel avis fait ressortir
// d'autres candidats, PATRONS est l'endroit à corriger — un seul tableau.
const PATRONS = [/^SECU/, /^MILAN/, /^MORA/, /^PELICAN/, /^FZB/];

// Un indicatif de vol commercial suit presque toujours ce format : deux à
// quatre lettres (le code compagnie), puis un numéro de vol. Un indicatif qui
// s'en écarte — un mot plutôt qu'un code, pas de suite de chiffres — est plus
// probablement un avion d'État ou privé, et donc un candidat à examiner si le
// filtre ci-dessus manque quelque chose. Purement indicatif : ça ne sert qu'au
// diagnostic (?diag=1), jamais à décider quoi afficher sur la carte.
const FORME_VOL_COMMERCIAL = /^[A-Z]{2,4}\d{1,4}[A-Z]{0,2}$/;

function estIndicatifInsolite(indicatif) {
  return !!indicatif && !FORME_VOL_COMMERCIAL.test(indicatif) && !estAvionFeu(indicatif);
}

function estAvionFeu(indicatif) {
  return PATRONS.some((p) => p.test(indicatif));
}

const BASE = 'https://api.airplanes.live/v2';

// Un seul point interrogé ne peut pas couvrir la France : le rayon maximal de
// l'API est de 250 nm (≈463 km), et le pays s'étend sur plus de 1 100 km dans
// chaque sens — un seul cercle laisserait des coins du territoire hors zone.
// On découpe donc la France (les mêmes bornes que pour les feux, voir
// lib/etatFeux.js BBOX) en quatre quadrants, chacun bien couvert par un
// cercle de 250 nm centré sur son milieu : demi-diagonale d'un quadrant
// ≈ 217 nm, marge confortable sous le plafond.
const LAMIN = 41.2, LAMAX = 51.3, LOMIN = -5.3, LOMAX = 9.7;
const RAYON_NM = 250;
const CENTRES = (() => {
  const latMid = (LAMIN + LAMAX) / 2, lonMid = (LOMIN + LOMAX) / 2;
  const lats = [(LAMIN + latMid) / 2, (latMid + LAMAX) / 2];
  const lons = [(LOMIN + lonMid) / 2, (lonMid + LOMAX) / 2];
  return lats.flatMap((lat) => lons.map((lon) => [lat, lon]));
})();

const DELAI_MS = 12000;
// Les quatre requêtes partent l'une après l'autre, espacées, plutôt qu'en
// rafale : la doc annonce une limite d'ordre « 1 requête par seconde ». Un
// poll complet prend alors un peu plus d'une seconde, ce qui reste largement
// sous le cache de 25 s côté api/avions.js.
const ECART_MS = 300;

function attendre(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Convertit un avion au format ADS-B Exchange v2 (repris tel quel par
// airplanes.live) en objet compact pour le client.
function acVersAvion(a) {
  const indicatif = String(a.flight || '').trim().toUpperCase();
  if (!indicatif || !estAvionFeu(indicatif)) return null;
  // Au sol, l'API remplace le nombre par la chaîne "ground" — c'est le seul
  // signal d'immobilisation au sol de ce schéma, il n'y a pas de champ dédié.
  if (a.alt_baro === 'ground') return null;
  if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return null;

  const altPieds = Number.isFinite(a.alt_geom) ? a.alt_geom
    : (Number.isFinite(a.alt_baro) ? a.alt_baro : null);

  return {
    icao24: a.hex,
    indicatif,
    lat: Math.round(a.lat * 1e5) / 1e5,
    lon: Math.round(a.lon * 1e5) / 1e5,
    altitudeM: altPieds !== null ? Math.round(altPieds * 0.3048) : null,
    // gs (ground speed) est en nœuds.
    vitesseKmh: Number.isFinite(a.gs) ? Math.round(a.gs * 1.852) : null,
    capDeg: Number.isFinite(a.track) ? Math.round(a.track) : null,
    // baro_rate est en pieds/minute.
    verticalMs: Number.isFinite(a.baro_rate) ? Math.round(a.baro_rate * 0.00508 * 10) / 10 : null,
  };
}

// Un User-Agent explicite : beaucoup de services communautaires anti-abus
// déprécient ou bloquent purement le UA par défaut d'un client HTTP
// générique. Rien dans la doc de airplanes.live ne l'exige explicitement,
// mais c'est peu coûteux et c'est une cause plausible d'un échec silencieux —
// n'ayant pas pu tester en direct depuis cet environnement (host bloqué),
// mieux vaut l'ajouter par précaution que le découvrir après coup.
const ENTETES = {
  'User-Agent': 'feux-france.vercel.app (carte des feux de France, contact via GitHub)',
  Accept: 'application/json',
};

async function interrogerPoint(lat, lon) {
  const url = `${BASE}/point/${lat}/${lon}/${RAYON_NM}`;
  const stop = new AbortController();
  const minuteur = setTimeout(() => stop.abort(), DELAI_MS);
  let r;
  try {
    r = await fetch(url, { signal: stop.signal, headers: ENTETES });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? `airplanes.live : délai dépassé (${DELAI_MS / 1000}s)`
      : `airplanes.live : ${e.message}`);
  } finally {
    clearTimeout(minuteur);
  }
  if (!r.ok) {
    // Le corps de la réponse porte souvent la vraie raison (quota, en-tête
    // manquant...) — la perdre reviendrait à se priver du seul indice
    // disponible sans accès direct au service depuis ce poste de travail.
    const corps = await r.text().catch(() => '');
    throw new Error(`airplanes.live : HTTP ${r.status}${corps ? ' — ' + corps.slice(0, 200) : ''}`);
  }
  const d = await r.json();
  return Array.isArray(d.ac) ? d.ac : [];
}

async function recupererAvions(diagnostic) {
  const vus = new Map();   // hex -> avion, pour fusionner les zones qui se recouvrent
  const erreurs = [];
  const parQuadrant = diagnostic ? [] : null;

  for (let i = 0; i < CENTRES.length; i++) {
    if (i > 0) await attendre(ECART_MS);
    const [lat, lon] = CENTRES[i];
    try {
      const brut = await interrogerPoint(lat, lon);
      let retenus = 0;
      brut.forEach((a) => {
        const avion = acVersAvion(a);
        if (avion) { vus.set(avion.icao24, avion); retenus++; }
      });
      if (parQuadrant) {
        // Sur les 1766 avions du premier relevé, l'œil humain a dû repérer
        // « SECUL » au milieu d'une liste de 30 — ça ne passe pas à l'échelle
        // pour un prochain manque. Les insolites de l'ENSEMBLE du quadrant
        // (pas seulement l'échantillon affiché) sont donc isolés ici :
        // c'est cette liste-là qu'il faut lire en premier.
        const insolites = brut
          .map((a) => String(a.flight || '').trim().toUpperCase())
          .filter((ind) => estIndicatifInsolite(ind));
        parQuadrant.push({
          lat, lon, recus: brut.length, retenus,
          insolites: [...new Set(insolites)].slice(0, 40),
          indicatifs: brut.map((a) => String(a.flight || '').trim()).filter(Boolean).slice(0, 30),
        });
      }
    } catch (e) {
      erreurs.push(e.message);
      if (parQuadrant) parQuadrant.push({ lat, lon, erreur: e.message });
    }
  }

  // Un seul quadrant en échec sur quatre n'invalide pas les autres — un avion
  // dans les zones jointes reste affiché. Ce n'est que si TOUT échoue qu'on
  // remonte l'erreur, pour déclencher le secours côté api/avions.js.
  if (erreurs.length === CENTRES.length) {
    const err = new Error(erreurs[0]);
    err.parQuadrant = parQuadrant;
    throw err;
  }

  return { instant: Date.now(), avions: [...vus.values()], parQuadrant };
}

// ── Historique 24 h ──────────────────────────────────────────────────────
//
// La carte ne montre que l'instant présent ; pour répondre à « combien
// d'avions ont volé aujourd'hui », il faut une mémoire — les positions
// elles-mêmes ne sont pas gardées, seulement la dernière fois où chaque
// avion a été vu. Un ensemble trié Redis convient bien à ce besoin : la
// date de la dernière observation sert de score, ce qui fait à la fois
// office de déduplication (un avion vu vingt fois dans la journée n'apparaît
// qu'une fois, à sa date la plus récente) et de fenêtre glissante (il suffit
// de purger ce qui est plus vieux que 24 h).
const CLE_HISTORIQUE = 'avions:vus24h:v1';
const FENETRE_HISTORIQUE_MS = 24 * 3600000;

// Enregistre les avions vus à cet instant. Appelé uniquement après une
// moisson fraîche (jamais depuis le cache d'api/avions.js) : c'est le seul
// moment où l'on sait vraiment qu'un avion volait à cet instant précis.
async function enregistrerVus(redis, avions, maintenant) {
  if (!redis || !avions.length) return;
  try {
    await redis.zAdd(CLE_HISTORIQUE, avions.map((a) => (
      { score: maintenant, value: a.icao24 + '|' + a.indicatif }
    )));
    // Purge à chaque écriture : la clé ne grossit jamais au-delà de ce que
    // la fenêtre de 24 h justifie, pas besoin d'un nettoyage à part.
    await redis.zRemRangeByScore(CLE_HISTORIQUE, 0, maintenant - FENETRE_HISTORIQUE_MS);
    await redis.expire(CLE_HISTORIQUE, Math.ceil(FENETRE_HISTORIQUE_MS / 1000) + 3600);
  } catch (e) { /* le badge sera juste incomplet, la carte reste correcte */ }
}

// Liste des avions distincts vus dans les dernières 24 h, du plus récent au
// plus ancien. `value` est encodé "icao24|indicatif" à l'écriture pour éviter
// une deuxième clé Redis rien que pour retrouver le nom depuis l'adresse.
async function vus24h(redis, maintenant) {
  if (!redis) return [];
  try {
    const membres = await redis.zRangeByScoreWithScores(
      CLE_HISTORIQUE, maintenant - FENETRE_HISTORIQUE_MS, '+inf'
    );
    return membres
      .map((m) => {
        const sep = m.value.indexOf('|');
        if (sep === -1) return null;
        return { icao24: m.value.slice(0, sep), indicatif: m.value.slice(sep + 1), derniereVue: m.score };
      })
      .filter(Boolean)
      .sort((a, b) => b.derniereVue - a.derniereVue);
  } catch (e) {
    return [];
  }
}

module.exports = {
  recupererAvions, estAvionFeu, acVersAvion, estIndicatifInsolite, PATRONS,
  LAMIN, LAMAX, LOMIN, LOMAX, RAYON_NM, CENTRES,
  enregistrerVus, vus24h, CLE_HISTORIQUE, FENETRE_HISTORIQUE_MS,
};
