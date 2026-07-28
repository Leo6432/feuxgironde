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
const JOURS = 1;

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

async function recuperer(capteur, cle) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${cle}/${capteur}/${BBOX}/${JOURS}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const texte = await r.text();
  // FIRMS répond en 200 avec un message texte (pas du CSV) sur clé invalide
  // ou quota dépassé — on le détecte pour ne pas planter le parsing.
  if (/invalid|error|exceed/i.test(texte.slice(0, 200))) {
    throw new Error('réponse FIRMS: ' + texte.slice(0, 120));
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

  let points = [];
  try {
    const resultats = await Promise.allSettled(CAPTEURS.map((c) => recuperer(c, cle)));
    points = resultats.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
    if (!resultats.some((r) => r.status === 'fulfilled')) {
      throw new Error('tous les capteurs ont échoué');
    }
  } catch (e) {
    res.status(200).json({ ok: false, raison: 'API FIRMS injoignable' });
    return;
  }

  const enrichis = points
    .map((p) => ({ ...p, distanceKm: Math.round(distanceKm(LAT, LON, p.lat, p.lon)) }))
    .sort((a, b) => (a.date + a.heure).localeCompare(b.date + b.heure) * -1);

  res.status(200).json({
    ok: true,
    source: 'NASA FIRMS · VIIRS (SNPP + NOAA-20)',
    fenetre: JOURS === 1 ? 'dernières 24h' : `derniers ${JOURS} jours`,
    total: enrichis.length,
    frpMax: enrichis.length ? Math.max(...enrichis.map((p) => p.frp)) : 0,
    derniereDetection: enrichis[0] ? `${enrichis[0].date} ${enrichis[0].heure}` : null,
    points: enrichis.slice(0, 30),
  });
};
