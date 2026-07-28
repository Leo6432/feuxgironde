// Points chauds détectés par satellite autour de Saumos, via NASA FIRMS.
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

const LAT = 44.98;   // Saumos, Gironde
const LON = -1.02;

// Resserrée sur le seul corridor Saumos–Lacanau : à la taille précédente,
// la boîte englobait Bordeaux et le bassin d'Arcachon, deux zones sans
// rapport avec ce feu où d'autres sources de chaleur (urbaines, agricoles,
// un autre feu de forêt) auraient pu se glisser dans les détections.
const BBOX = '-1.35,44.80,-0.85,45.20';

// FIRMS plafonne la profondeur d'historique à 10 jours en temps quasi réel.
const JOURS_DEFAUT = 1;
const JOURS_MAX = 10;

// Deux satellites VIIRS : leurs passages ne sont pas synchronisés, les
// combiner réduit les trous de couverture.
const CAPTEURS = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT'];

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

async function recuperer(capteur, cle, jours) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${cle}/${capteur}/${BBOX}/${jours}`;
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
    confiance: l.confidence,
    frp: parseFloat(l.frp) || 0,
  }));
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');

  const cle = process.env.FIRMS_MAP_KEY;
  if (!cle) {
    res.status(200).json({ ok: false, raison: 'clé FIRMS non configurée' });
    return;
  }

  const demande = parseInt((req.query && req.query.jours) || '', 10);
  const jours = Math.min(JOURS_MAX, Math.max(1, demande || JOURS_DEFAUT));

  async function essayer(n) {
    const resultats = await Promise.allSettled(CAPTEURS.map((c) => recuperer(c, cle, n)));
    const ok = resultats.filter((r) => r.status === 'fulfilled');
    return {
      points: ok.flatMap((r) => r.value),
      reussi: ok.length > 0,
      erreurs: resultats
        .filter((r) => r.status === 'rejected')
        .map((r) => sansCle(r.reason && r.reason.message, cle)),
    };
  }

  let tentative = await essayer(jours);
  let joursObtenus = jours;

  // Une longue fenêtre est bien plus lourde côté FIRMS : si elle échoue,
  // une journée vaut mieux que rien du tout.
  if (!tentative.reussi && jours > 1) {
    const repli = await essayer(1);
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

  const points = tentative.points;

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

  res.status(200).json({
    ok: true,
    source: 'NASA FIRMS · VIIRS (SNPP + NOAA-20)',
    fenetre: joursObtenus === 1 ? 'dernières 24h' : `derniers ${joursObtenus} jours`,
    jours: joursObtenus,
    // Signalé quand la fenêtre demandée n'a pas pu être servie en entier.
    replique: joursObtenus !== jours ? `fenêtre réduite de ${jours} à ${joursObtenus} jour(s)` : undefined,
    total: enrichis.length,
    frpMax: enrichis.length ? Math.max(...enrichis.map((p) => p.frp)) : 0,
    // Somme des puissances : c'est l'énergie dégagée par l'ensemble du front,
    // et non par un seul pixel — c'est elle qui pondère le risque d'orage de feu.
    frpTotal: Math.round(frpTotal),
    derniereDetection: enrichis[0] ? `${enrichis[0].date} ${enrichis[0].heure}` : null,
    parJour: joursListe,
    points: enrichis.slice(0, 600),
  });
};
