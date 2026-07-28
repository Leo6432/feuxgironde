// Récupère les prévisions Open-Meteo pour le secteur de Saumos et calcule
// l'indice de difficulté heure par heure.
//
// Open-Meteo est gratuit et sans clé. On demande explicitement les modèles
// Météo-France (AROME en courte échéance, ARPEGE au-delà), qui sont ceux
// que le site cite comme sources.
//
// Nouveauté par rapport au calcul statique : l'instabilité vient de la CAPE
// réelle, et non plus de la chute de pression de surface, qui n'en est qu'un
// indicateur indirect et se trompe de sens quand un front amène de la pluie.

const LAT = 44.98;   // Saumos, Gironde
const LON = -1.02;

const VARIABLES = [
  'temperature_2m',
  'relative_humidity_2m',
  'wind_speed_10m',
  'wind_gusts_10m',
  'precipitation',
  'surface_pressure',
  'cape',
].join(',');

const URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
  `&hourly=${VARIABLES}&models=meteofrance_seamless&wind_speed_unit=kmh` +
  `&timezone=Europe%2FParis&forecast_days=5`;

const POIDS = { temp: 0.25, hum: 0.30, rafales: 0.20, vent: 0.10, instab: 0.15 };

const norm = (v, lo, hi) =>
  Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));

const PERIODES = [
  ['Matin', 6, 11],
  ['Midi', 11, 14],
  ['Après-midi', 14, 18],
  ['Soir', 18, 23],
];

/** Instabilité 0-100. CAPE si disponible, sinon repli sur la pression. */
function instabilite(cape, pressions, i, pluie6h) {
  // Une baisse de pression sous la pluie signale un front humide, qui calme
  // le feu : dans ce cas l'instabilité ne doit pas compter.
  if (pluie6h > 0.2) return 0;
  if (Number.isFinite(cape)) return norm(cape, 0, 800);
  const j = Math.max(0, i - 6);
  const chute = (pressions[j] ?? 0) - (pressions[i] ?? 0);
  return norm(chute, 0, 5);
}

function coefSecheresse(joursSansPluie) {
  if (joursSansPluie <= 1) return 0.90;
  if (joursSansPluie <= 3) return 1.00;
  if (joursSansPluie <= 6) return 1.08;
  return 1.15;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');

  let data;
  try {
    const r = await fetch(URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json();
  } catch (e) {
    res.status(200).json({ ok: false, raison: 'API injoignable' });
    return;
  }

  const h = data && data.hourly;
  if (!h || !Array.isArray(h.time) || !h.time.length) {
    res.status(200).json({ ok: false, raison: 'réponse inattendue' });
    return;
  }

  const T = h.temperature_2m || [];
  const H = h.relative_humidity_2m || [];
  const V = h.wind_speed_10m || [];
  const G = h.wind_gusts_10m || [];
  const P = h.precipitation || [];
  const PR = h.surface_pressure || [];
  const CA = h.cape || [];
  const capeDispo = CA.some((v) => Number.isFinite(v));

  // Regroupe les heures par journée civile.
  const jours = new Map();
  h.time.forEach((iso, i) => {
    const [date, hm] = iso.split('T');
    if (!jours.has(date)) jours.set(date, []);
    jours.get(date).push({ i, heure: parseInt(hm, 10) });
  });

  // Jours écoulés depuis la dernière pluie, en remontant la série.
  let dernierePluie = null;
  h.time.forEach((iso, i) => {
    if ((P[i] || 0) > 0.2) dernierePluie = iso.split('T')[0];
  });

  const sortie = [];
  for (const [date, heures] of jours) {
    const scores = heures.map(({ i }) => {
      const pluie6h = P.slice(Math.max(0, i - 6), i + 1)
        .reduce((a, b) => a + (b || 0), 0);
      const c = {
        temp: norm(T[i], 15, 42),
        hum: norm(80 - H[i], 0, 65),
        rafales: norm(G[i], 0, 60),
        vent: norm(V[i], 0, 30),
        instab: instabilite(CA[i], PR, i, pluie6h),
      };
      return Object.keys(POIDS).reduce((s, k) => s + POIDS[k] * c[k], 0);
    });

    // Sécheresse : nombre de jours depuis la dernière pluie relevée.
    const jsp = dernierePluie
      ? Math.round((new Date(date) - new Date(dernierePluie)) / 86400000)
      : 4;
    const cs = coefSecheresse(jsp);

    const nuit = heures.filter(({ heure }) => heure >= 22 || heure <= 6);
    const humNuit = nuit.map(({ i }) => H[i]).filter(Number.isFinite);
    const cn = humNuit.length && Math.max(...humNuit) < 60 ? 1.05 : 1.00;

    const pire = scores.indexOf(Math.max(...scores));
    const periodes = PERIODES.map(([label, a, b]) => {
      const idx = heures
        .map((x, k) => ({ ...x, k }))
        .filter(({ heure }) => heure >= a && heure < b);
      if (!idx.length) return null;
      const meilleur = idx.reduce((m, x) => (scores[x.k] > scores[m.k] ? x : m));
      return {
        label,
        score: Math.min(100, Math.round(scores[meilleur.k] * cs * cn)),
        heure: meilleur.heure,
        t: Math.max(...idx.map(({ i }) => T[i])),
        hum: Math.min(...idx.map(({ i }) => H[i])),
        raf: Math.max(...idx.map(({ i }) => G[i])),
      };
    }).filter(Boolean);

    sortie.push({
      date,
      score: Math.min(100, Math.round(scores[pire] * cs * cn)),
      pireHeure: heures[pire].heure,
      secheresse: cs,
      nuit: cn,
      periodes,
    });
  }

  res.status(200).json({
    ok: true,
    source: 'Open-Meteo · modèles Météo-France AROME et ARPEGE',
    instabilite: capeDispo ? 'CAPE mesurée' : 'repli sur la pression de surface',
    jours: sortie,
  });
};
