// Points chauds détectés par satellite, via NASA FIRMS — le feu de Saumos en
// détail (comme avant), et les autres feux de France en simple repérage.
//
// La "surface brûlée" communiquée par la préfecture est un cumul depuis le
// départ du feu : la plupart de cette surface est déjà éteinte. FIRMS donne
// une autre lecture, complémentaire — les foyers que les satellites VIIRS
// voient encore chauds, dans les dernières 24 heures. Ce n'est pas un
// périmètre officiel, juste des détections thermiques ponctuelles.
//
// Nécessite une clé gratuite (MAP_KEY), demandée par email sur
// https://firms.modaps.eosdis.nasa.gov/api/ — stockée dans la variable
// d'environnement Vercel FIRMS_MAP_KEY, jamais dans le code.

const { getClient } = require('../lib/redis');
const { frontiereFrance, dansGeometrie } = require('../lib/france');

const LAT = 44.98;   // Saumos, Gironde
const LON = -1.02;

// Boîte de requête FIRMS : la France métropolitaine et la Corse (avec une
// petite marge). Élargie depuis la boîte serrée autour de Saumos, pour
// repérer aussi les autres feux du pays — voir plus bas, la carte détaillée
// (animation, prochain passage, etc.) reste, elle, calculée uniquement sur
// un rayon de 34 km autour de Saumos, exactement comme avant.
const BBOX = '-5.3,41.2,9.7,51.3';
const RAYON_KM = 34;

// Pas de la grille utilisée à la fois pour l'agrégation détaillée autour de
// Saumos et pour le repérage (dédoublonnage) des autres feux de France.
const GRILLE = 0.0025;

// FIRMS plafonne la profondeur d'historique à 10 jours en temps quasi réel.
const JOURS_DEFAUT = 1;
const JOURS_MAX = 10;

// Départ du feu. `jours=max` remonte jusque-là, dans la limite des 10 jours
// que FIRMS accepte en temps quasi réel : au-delà, il faudrait basculer sur
// leur API d'archive, qui utilise d'autres identifiants de capteurs.
const DEPART_FEU = '2026-07-22';

function joursDepuisDepart() {
  const debut = new Date(DEPART_FEU + 'T00:00:00Z');
  const ecoules = Math.ceil((Date.now() - debut.getTime()) / 86400000) + 1;
  return Math.min(JOURS_MAX, Math.max(1, ecoules));
}

// Trois satellites VIIRS, MODIS (Terra + Aqua, combinés par la NASA sous un
// seul identifiant NRT) et Landsat : leurs passages sont décalés de quelques
// dizaines de minutes à quelques jours les uns des autres, les combiner
// multiplie les passages couverts — c'est ce qui fait la fraîcheur de la
// « dernière détection ». MODIS a un pixel plus grossier (~1 km contre
// ~375 m pour VIIRS) ; Landsat est bien plus fin (~30 m) mais ne repasse au
// même endroit que tous les 8 à 16 jours — utile pour un contour précis
// s'il tombe juste, sans effet sur la fraîcheur au quotidien.
// Sentinel-3 n'est volontairement pas inclus : ses détections d'incendie
// sont distribuées par Copernicus/EUMETSAT, pas par cette API FIRMS — les
// ajouter demanderait une intégration séparée, pas encore vérifiée.
const CAPTEURS = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT', 'LANDSAT_NRT'];

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseCsv(texte) {
  const lignes = texte.trim().split('\n');
  if (lignes.length < 2) return [];
  const entetes = lignes[0].split(',').map((c) => c.trim());
  return lignes.slice(1).map((ligne) => {
    const valeurs = ligne.split(',');
    const ligneObj = {};
    entetes.forEach((c, i) => { ligneObj[c] = valeurs[i]; });
    return ligneObj;
  });
}

// La clé est dans l'URL : sans ce nettoyage, un message d'erreur qui cite
// l'URL la publierait dans la réponse JSON, lisible par n'importe qui.
function sansCle(message, cle) {
  return String(message || 'erreur inconnue').split(cle).join('CLE').slice(0, 160);
}

// Au-delà de quelques secondes, mieux vaut renoncer proprement que laisser
// la fonction serverless atteindre son propre délai maximal et renvoyer une
// erreur de plateforme, que la page ne saurait pas expliquer.
const DELAI_MS = 7000;

// Découpe une fenêtre longue en tranches de 3 jours au plus. Une requête de
// 8 jours sur un feu de cette taille pèse des dizaines de milliers de lignes
// et dépasse le délai ; trois tranches lancées en parallèle tiennent chacune
// largement dedans. L'API FIRMS accepte une date de départ en fin d'URL.
function decoupes(jours) {
  if (jours <= 3) return [{ jours, date: null }];
  const jourMs = 86400000;
  const debut = Date.now() - (jours - 1) * jourMs;
  const out = [];
  for (let fait = 0; fait < jours; fait += 3) {
    out.push({
      jours: Math.min(3, jours - fait),
      date: new Date(debut + fait * jourMs).toISOString().slice(0, 10),
    });
  }
  return out;
}

async function recuperer(capteur, cle, jours, dateDebut) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${cle}/${capteur}/${BBOX}/${jours}` +
    (dateDebut ? `/${dateDebut}` : '');
  const stop = new AbortController();
  const minuteur = setTimeout(() => stop.abort(), DELAI_MS);
  let r;
  try {
    r = await fetch(url, { signal: stop.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? `${capteur}: délai dépassé (${DELAI_MS / 1000}s)`
      : `${capteur}: ${sansCle(e.message, cle)}`);
  } finally {
    clearTimeout(minuteur);
  }
  if (!r.ok) throw new Error(`${capteur}: HTTP ${r.status}`);
  const texte = await r.text();
  // FIRMS répond en 200 avec un message texte (pas du CSV) sur clé invalide
  // ou quota dépassé — on le détecte pour ne pas planter le parsing.
  if (/invalid|error|exceed/i.test(texte.slice(0, 200))) {
    throw new Error(`${capteur}: ${sansCle(texte.slice(0, 120), cle)}`);
  }
  return parseCsv(texte).map((l) => ({
    lat: parseFloat(l.latitude),
    lon: parseFloat(l.longitude),
    date: l.acq_date,
    heure: (l.acq_time || '').padStart(4, '0').replace(/(\d{2})(\d{2})/, '$1h$2'),
    satellite: l.satellite,
    // Le capteur interrogé (pas la lettre FIRMS brute) : c'est lui qui dit
    // de façon fiable quel satellite a produit la détection, utilisé pour
    // le planning des passages observés.
    capteur,
    confiance: l.confidence,
    frp: parseFloat(l.frp) || 0,
  }));
}

// Noms lisibles des capteurs, pour l'affichage du planning des passages.
const NOM_CAPTEUR = {
  VIIRS_SNPP_NRT: 'VIIRS Suomi-NPP',
  VIIRS_NOAA20_NRT: 'VIIRS NOAA-20',
  VIIRS_NOAA21_NRT: 'VIIRS NOAA-21',
  MODIS_NRT: 'MODIS (Terra/Aqua)',
  LANDSAT_NRT: 'Landsat',
};

// Horodatage UTC d'une détection ("2026-07-28" + "19h12"). FIRMS publie ses
// heures en UTC : on reste dans ce référentiel de bout en bout.
function tsUtc(date, heure) {
  const hm = String(heure || '0h0').split('h');
  return Date.UTC(
    +date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10),
    +hm[0] || 0, +hm[1] || 0
  );
}

// Estimation du prochain passage satellite, à partir des horaires réels des
// passages précédents (les VIIRS sont héliosynchrones : ils repassent chaque
// jour à peu près à la même minute).
//
// Recalculer ce planning à chaque requête et le republier tel quel ferait
// bouger l'heure annoncée d'une poignée de minutes à chaque fois que les
// données sous-jacentes varient légèrement (nouvelle détection, cache FIRMS
// qui se renouvelle) — avant même que le passage annoncé ait eu lieu. La
// cible est donc figée en Redis dès qu'elle est choisie, et n'est révisée
// qu'une fois confirmée : quand une détection réelle arrive à son heure ou
// après, prouvant que ce passage a bien eu lieu.
const MINUTE = 60000;
const JOUR_MS = 86400000;

// Horaires de passage d'UN SEUL capteur — chaque satellite a son propre
// rythme, les mélanger avant de grouper aurait fondu deux passages proches
// (un VIIRS et un MODIS à quelques minutes d'écart) en un seul créneau,
// masquant qu'il s'agit bien de deux mises à jour distinctes.
function horairesUnCapteur(ts) {
  const passes = [];
  let debut = null, dernier = null;
  ts.forEach((t) => {
    if (dernier === null || t - dernier > 40 * MINUTE) {
      if (dernier !== null) passes.push((debut + dernier) / 2);
      debut = t;
    }
    dernier = t;
  });
  if (dernier !== null) passes.push((debut + dernier) / 2);
  if (passes.length < 2) return [];   // un seul passage vu : pas encore une habitude

  const minutes = passes.map((t) => {
    const d = new Date(t);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }).sort((a, b) => a - b);

  const groupes = [];
  minutes.forEach((m) => {
    const g = groupes[groupes.length - 1];
    if (!g || m - g[g.length - 1] > 90) groupes.push([m]);
    else g.push(m);
  });
  // Un passage à cheval sur minuit UTC se retrouverait coupé en deux
  // groupes, un à chaque bout de la journée : on les recolle.
  if (groupes.length > 1) {
    const premier = groupes[0], final = groupes[groupes.length - 1];
    if (premier[0] + 1440 - final[final.length - 1] <= 90) {
      groupes.pop();
      groupes[0] = final.map((x) => x - 1440).concat(premier);
    }
  }
  return groupes.map((g) => {
    const somme = g.reduce((a, b) => a + b, 0);
    return ((Math.round(somme / g.length) % 1440) + 1440) % 1440;
  });
}

// Planning complet, tous capteurs listés séparément et triés par heure —
// une entrée par satellite et par créneau qu'il fréquente vraiment.
function horairesPassages(enrichis) {
  const parCapteur = {};
  enrichis.forEach((p) => {
    const c = p.capteur || 'inconnu';
    (parCapteur[c] = parCapteur[c] || []).push(tsUtc(p.date, p.heure));
  });
  const tout = [];
  Object.keys(parCapteur).forEach((capteur) => {
    const ts = parCapteur[capteur].sort((a, b) => a - b);
    horairesUnCapteur(ts).forEach((minute) => tout.push({ minute, capteur }));
  });
  if (!tout.length) return null;
  tout.sort((a, b) => a.minute - b.minute);
  return tout;
}

function prochainCandidat(horaires, apartirDe) {
  const minuit = Math.floor(apartirDe / JOUR_MS) * JOUR_MS;
  let candidat = null;
  horaires.forEach((h) => {
    for (let j = 0; j < 2; j++) {
      const t = minuit + j * JOUR_MS + h.minute * MINUTE;
      if (t > apartirDe + 5 * MINUTE && (candidat === null || t < candidat)) candidat = t;
    }
  });
  return candidat;
}

async function prochainPassageFige(redis, horaires, derniereTs) {
  const CLE = 'firms:passage:v2';
  let etat = null;
  try {
    const brut = redis ? await redis.get(CLE) : null;
    etat = brut ? JSON.parse(brut) : null;
  } catch (e) { /* on repart d'une cible neuve */ }

  const maintenant = Date.now();
  // Confirmée : deux conditions, pas une seule. Il ne suffit pas que la
  // dernière détection connue dépasse l'heure annoncée — un décalage de
  // calcul pourrait le rendre vrai dès la première estimation, sans qu'aucun
  // nouveau passage n'ait eu lieu. Il faut aussi qu'une détection *plus
  // récente que celle vue au moment où la cible a été fixée* soit arrivée :
  // la preuve que le site a bien reçu une mise à jour depuis.
  const nouvelleDonnee = etat && isFinite(etat.vueA) && isFinite(derniereTs) && derniereTs > etat.vueA;
  const confirmee = etat && etat.cible && nouvelleDonnee && derniereTs >= etat.cible;

  // Filet de sécurité : si la cible est dépassée depuis longtemps SANS être
  // confirmée, c'est qu'elle a probablement été calculée sur un historique
  // encore incomplet au moment où elle a été fixée (un satellite dont
  // l'habitude n'était pas encore établie, par exemple) — une prédiction
  // fausse dès le départ, qu'aucune détection ne viendra jamais confirmer
  // avant le vrai prochain passage. Sans ce filet, la page resterait sur
  // « en cours » pendant tout l'écart entre la fausse cible et le vrai
  // passage suivant, parfois plusieurs heures. Passé ce délai, on abandonne
  // et on recalcule avec l'historique désormais à jour — largement au-delà
  // du délai de publication habituel de FIRMS, pour ne pas corriger une
  // cible encore simplement en attente de confirmation normale.
  const MARGE_ABANDON_MS = 90 * MINUTE;
  const perimee = etat && etat.cible && !confirmee && (maintenant - etat.cible > MARGE_ABANDON_MS);

  let cible = etat && etat.cible;
  if (!cible || confirmee || perimee) {
    cible = horaires ? prochainCandidat(horaires, confirmee ? Math.max(derniereTs, maintenant) : maintenant) : null;
    if (redis && cible) {
      try {
        await redis.set(CLE, JSON.stringify({ cible, vueA: isFinite(derniereTs) ? derniereTs : 0 }), { EX: 6 * 3600 });
      } catch (e) { /* tant pis */ }
    }
  }
  return cible || null;
}

function parametreJours(req) {
  if (req && req.query && req.query.jours) return String(req.query.jours);
  try {
    const url = new URL(req.url, 'http://x');
    return url.searchParams.get('jours') || '';
  } catch (e) {
    return '';
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');

  const cle = process.env.FIRMS_MAP_KEY;
  if (!cle) {
    res.status(200).json({ ok: false, raison: 'clé FIRMS non configurée' });
    return;
  }

  // req.query n'est pas garanti selon la façon dont la fonction est invoquée ;
  // s'y fier seul faisait retomber silencieusement sur la valeur par défaut
  // (1 jour), donc sur une carte qui n'affichait que la journée en cours.
  const brut = parametreJours(req);
  const jours = brut === 'max'
    ? joursDepuisDepart()
    : Math.min(JOURS_MAX, Math.max(1, parseInt(brut, 10) || JOURS_DEFAUT));

  // Cache serveur : le cache CDN ne couvre qu'une région et repart de zéro à
  // chaque déploiement. Une fenêtre longue coûte cher côté FIRMS (deux
  // capteurs, plusieurs milliers de lignes), donc on la garde en Redis.
  // v12 : la boîte de requête couvre toute la France (plus seulement la
  // Gironde) et la réponse inclut les autres feux du pays (voir "autres").
  const cleCache = 'firms:v12:' + jours;
  let redis = null;
  try {
    const p = getClient();
    redis = p ? await p : null;
    if (redis) {
      const garde = await redis.get(cleCache);
      if (garde) {
        res.setHeader('X-Cache', 'redis');
        res.status(200).json(JSON.parse(garde));
        return;
      }
    }
  } catch (e) {
    redis = null;   // le cache est un confort, jamais une dépendance
  }

  // Lancée en parallèle des requêtes FIRMS ci-dessous plutôt qu'après : le
  // contour de la France (télécharger + parser) ne doit pas ajouter de
  // latence en série à une réponse déjà composée de plusieurs appels réseau.
  const frontierePromise = frontiereFrance(redis).catch(() => null);

  async function essayer(n, decouper) {
    const morceaux = decouper ? decoupes(n) : [{ jours: n, date: null }];
    const taches = [];
    CAPTEURS.forEach((c) => morceaux.forEach((m) => taches.push(
      recuperer(c, cle, m.jours, m.date).then(
        (pts) => ({ ok: true, pts }),
        (e) => ({ ok: false, err: sansCle(e && e.message, cle) })
      )
    )));
    const resultats = await Promise.all(taches);
    const ok = resultats.filter((r) => r.ok);
    return {
      points: ok.flatMap((r) => r.pts),
      reussi: ok.length > 0,
      complet: ok.length === resultats.length,
      erreurs: resultats.filter((r) => !r.ok).map((r) => r.err),
    };
  }

  let tentative = await essayer(jours, true);
  let joursObtenus = jours;

  // Si le découpage échoue en bloc (date de départ refusée, par exemple),
  // on retente la fenêtre entière d'une seule pièce avant de se rabattre
  // sur une seule journée — et chaque dégradation est annoncée, jamais tue.
  if (!tentative.reussi && jours > 3) {
    const entiere = await essayer(jours, false);
    if (entiere.reussi) tentative = entiere;
  }
  if (!tentative.reussi && jours > 1) {
    const repli = await essayer(1, false);
    if (repli.reussi) {
      tentative = repli;
      joursObtenus = 1;
    }
  }

  if (!tentative.reussi) {
    res.status(200).json({
      ok: false,
      raison: 'API FIRMS injoignable',
      details: tentative.erreurs,
    });
    return;
  }

  // Le vrai filtre géographique : tout ce qui est à plus de 34 km de Saumos
  // (autres feux, chaleur urbaine, brûlages agricoles) sort des données.
  const points = tentative.points
    .filter((p) => distanceKm(LAT, LON, p.lat, p.lon) <= RAYON_KM);

  const enrichis = points
    .map((p) => ({ ...p, distanceKm: Math.round(distanceKm(LAT, LON, p.lat, p.lon)) }))
    .sort((a, b) => (b.date + b.heure).localeCompare(a.date + a.heure));

  // Découpage par journée : c'est ce qui alimente le curseur temporel de la
  // carte, et ça évite au navigateur de refaire une requête à chaque cran.
  const parJour = {};
  enrichis.forEach((p) => {
    if (!parJour[p.date]) parJour[p.date] = { date: p.date, total: 0, frpTotal: 0, frpMax: 0 };
    const j = parJour[p.date];
    j.total += 1;
    j.frpTotal += p.frp;
    j.frpMax = Math.max(j.frpMax, p.frp);
  });
  const joursListe = Object.values(parJour)
    .map((j) => ({ ...j, frpTotal: Math.round(j.frpTotal), frpMax: Math.round(j.frpMax) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const frpTotal = enrichis.reduce((s, p) => s + p.frp, 0);

  // Agrégation en cellules. Envoyer les détections brutes plafonnées coupait
  // l'historique : triées du plus récent au plus ancien, seules les dernières
  // heures passaient le plafond. Une cellule porte sa première et sa dernière
  // détection : c'est tout ce qu'il faut pour rejouer l'incendie.
  //
  // La grille (~275 m, définie plus haut) est plus fine que l'empreinte
  // VIIRS (~375 m) : d'un passage à l'autre, les centres des détections se
  // décalent, et cette dispersion dessine des contours plus fins que le
  // pixel du capteur.
  const parCellule = {};
  enrichis.forEach((p) => {
    const la = Math.round(p.lat / GRILLE) * GRILLE;
    const lo = Math.round(p.lon / GRILLE) * GRILLE;
    const k = la.toFixed(4) + '_' + lo.toFixed(4);
    const t = tsUtc(p.date, p.heure);
    let c = parCellule[k];
    if (!c) {
      c = parCellule[k] = { lat: +la.toFixed(4), lon: +lo.toFixed(4), t0: t, t1: t, frp: 0 };
    }
    if (t < c.t0) c.t0 = t;
    if (t > c.t1) c.t1 = t;
    if (p.frp > c.frp) c.frp = Math.round(p.frp);
  });
  // Encodage compact [lat, lon, t0, t1, frp, km], temps en minutes depuis le
  // départ du feu : moitié moins lourd que des objets nommés, ce qui compte
  // avec plusieurs milliers de cellules à ce pas de grille.
  const ORIGINE = new Date(DEPART_FEU + 'T00:00:00Z').getTime();
  const cellules = Object.values(parCellule)
    .sort((a, b) => a.t0 - b.t0)
    .slice(0, 15000)
    .map((c) => [
      c.lat, c.lon,
      Math.round((c.t0 - ORIGINE) / 60000),
      Math.round((c.t1 - ORIGINE) / 60000),
      c.frp,
      Math.round(distanceKm(LAT, LON, c.lat, c.lon)),
    ]);

  const derniereTs = enrichis[0] ? tsUtc(enrichis[0].date, enrichis[0].heure) : null;
  // Planning des passages observés (minutes depuis minuit UTC, triées) :
  // descriptif, donc recalculé à chaque requête sans avoir besoin d'être figé
  // comme la cible du prochain passage — plus l'historique s'accumule, plus
  // il se précise.
  const horaires = horairesPassages(enrichis);
  const prochainPasse = await prochainPassageFige(redis, horaires, derniereTs);

  // Les autres feux de France : simple repérage (pas d'animation détaillée,
  // pas de prédiction de passage — ça reste propre à Saumos, voir plus
  // haut). Uniquement les 24 dernières heures, pour ne montrer que ce qui
  // couve encore, pas des semaines de brûlages agricoles.
  const geometrieFrance = await frontierePromise;
  const dansLaFrance = (p) => (geometrieFrance ? dansGeometrie(p.lon, p.lat, geometrieFrance) : true);
  const FENETRE_AUTRES_MS = 24 * 3600000;
  const maintenant = Date.now();
  const autresBrutes = tentative.points.filter((p) => {
    if (distanceKm(LAT, LON, p.lat, p.lon) <= RAYON_KM) return false;   // déjà couvert par Saumos
    if (maintenant - tsUtc(p.date, p.heure) > FENETRE_AUTRES_MS) return false;
    return dansLaFrance(p);
  });
  // Dédoublonnage par cellule : un même foyer est vu par plusieurs
  // satellites au fil de la fenêtre, on ne garde que sa détection la plus
  // récente et sa puissance la plus forte.
  const parCelluleAutres = {};
  autresBrutes.forEach((p) => {
    const la = Math.round(p.lat / GRILLE) * GRILLE;
    const lo = Math.round(p.lon / GRILLE) * GRILLE;
    const k = la.toFixed(4) + '_' + lo.toFixed(4);
    const t = tsUtc(p.date, p.heure);
    let c = parCelluleAutres[k];
    if (!c) c = parCelluleAutres[k] = { lat: +la.toFixed(4), lon: +lo.toFixed(4), t, frp: 0 };
    if (t > c.t) c.t = t;
    if (p.frp > c.frp) c.frp = Math.round(p.frp);
  });
  // Encodage compact [lat, lon, frp, ts epoch ms], comme les cellules
  // Saumos mais sans t0/t1 : pas de rejeu temporel pour ces points-là.
  const autres = Object.values(parCelluleAutres)
    .sort((a, b) => b.t - a.t)
    .slice(0, 3000)
    .map((c) => [c.lat, c.lon, c.frp, c.t]);

  const sortie = {
    ok: true,
    source: 'NASA FIRMS · VIIRS (SNPP, NOAA-20, NOAA-21) + MODIS + Landsat',
    fenetre: joursObtenus === 1 ? 'dernières 24h' : `derniers ${joursObtenus} jours`,
    jours: joursObtenus,
    depuis: DEPART_FEU,
    // Toute dégradation est annoncée : fenêtre réduite, tranches manquantes,
    // ou frontière France approximative (repli sur la boîte englobante si le
    // contour précis n'a pas pu être téléchargé).
    avertissement: joursObtenus !== jours
      ? `historique réduit à ${joursObtenus === 1 ? '24 h' : joursObtenus + ' jours'} — FIRMS n'a pas répondu sur la période complète`
      : (!tentative.complet ? 'historique partiel — une partie des requêtes FIRMS a échoué'
        : (!geometrieFrance ? 'contour précis de la France indisponible — les « autres feux » utilisent une simple boîte englobante, qui peut inclure des points proches des frontières' : undefined)),
    total: enrichis.length,
    frpMax: enrichis.length ? Math.max(...enrichis.map((p) => p.frp)) : 0,
    // Somme des puissances : c'est l'énergie dégagée par l'ensemble du front,
    // et non par un seul pixel — c'est elle qui pondère le risque d'orage de feu.
    frpTotal: Math.round(frpTotal),
    derniereDetection: enrichis[0] ? `${enrichis[0].date} ${enrichis[0].heure}` : null,
    // Même instant en millisecondes : les pages l'affichent en heure locale,
    // là où la chaîne ci-dessus reste le libellé UTC brut de FIRMS.
    derniereTs,
    // Prochain passage estimé (ms epoch), figé jusqu'à confirmation — voir
    // prochainPassageFige(). null si l'historique est trop court pour en
    // tirer une habitude fiable.
    prochainPasse,
    // Planning des passages observés, un par satellite et par créneau qu'il
    // fréquente vraiment (minute depuis minuit UTC + nom lisible du
    // capteur). C'est ce qui répond à « combien de fois par jour ça se
    // met à jour, et lequel ».
    planningPassages: (horaires || []).map((h) => ({
      minute: h.minute,
      satellite: NOM_CAPTEUR[h.capteur] || h.capteur,
    })),
    parJour: joursListe,
    grille: GRILLE,
    origine: ORIGINE,
    cellules,
    // Autres feux de France, hors du rayon Saumos, dernières 24h : simple
    // repérage [lat, lon, frp, ts epoch ms] — pas d'animation, pas de
    // prédiction de passage, voir plus haut.
    autres,
    frontierePrecise: !!geometrieFrance,
  };

  // 20 min pour une réponse complète : sous le rythme des passages satellite,
  // on ne perd aucune détection. Une réponse dégradée, elle, ne reste que
  // 3 min — c'était le piège précédent : un seul dépassement de délai
  // collait « 24 h seulement » à tous les visiteurs pendant 20 minutes.
  if (redis) {
    const duree = sortie.avertissement ? 180 : 1200;
    try { await redis.set(cleCache, JSON.stringify(sortie), { EX: duree }); } catch (e) { /* tant pis */ }
  }

  res.setHeader('X-Cache', redis ? 'miss' : 'none');
  res.status(200).json(sortie);
};
