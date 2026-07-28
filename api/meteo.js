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

const crypto = require('crypto');
const { getClient } = require('../lib/redis');

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

// AROME couvre ~2 jours, ARPEGE ~4. Au-delà, meteofrance_seamless n'a plus
// rien à renvoyer : on complète avec best_match, qui bascule sur l'IFS du
// CEPMMT en longue échéance. Chaque journée retient la source qui l'a fournie.
const url = (modeles, jours) =>
  `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
  `&hourly=${VARIABLES}&models=${modeles}&wind_speed_unit=kmh` +
  `&timezone=Europe%2FParis&forecast_days=${jours}`;

// Composantes additives : les moteurs propres du feu (somme = 1).
const POIDS = { temp: 0.29, hum: 0.35, rafales: 0.24, vent: 0.12 };

// L'instabilité n'allume rien seule : elle amplifie un feu qui a déjà de
// l'énergie. En multiplicateur elle pèse lourd sur une journée sévère et
// presque rien sur une journée calme — ce qu'un terme additif ne fait pas.
const INSTAB_MAX = 1.15;

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

// Continu : par paliers, un jour d'écart faisait sauter le coefficient de 8 %.
function coefSecheresse(joursSansPluie) {
  return Math.min(1.15, 0.90 + 0.0333 * Math.max(0, joursSansPluie));
}

async function recuperer(modeles, jours) {
  const r = await fetch(url(modeles, jours));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  if (!d || !d.hourly || !Array.isArray(d.hourly.time) || !d.hourly.time.length) {
    throw new Error('réponse inattendue');
  }
  return d.hourly;
}

/** Une heure n'est exploitable que si les quatre moteurs du feu sont présents. */
function heureComplete(h, i) {
  return ['temperature_2m', 'relative_humidity_2m', 'wind_speed_10m', 'wind_gusts_10m']
    .every((k) => Number.isFinite((h[k] || [])[i]));
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');

  // Météo-France d'abord, puis le repli longue échéance pour les journées
  // que ni AROME ni ARPEGE ne couvrent.
  let mf = null, gl = null;
  try { mf = await recuperer('meteofrance_seamless', 4); } catch (e) { /* repli */ }
  try { gl = await recuperer('best_match', 7); } catch (e) { /* repli */ }

  if (!mf && !gl) {
    res.status(200).json({ ok: false, raison: 'API injoignable' });
    return;
  }

  // Fusion : chaque heure prend Météo-France si elle est complète, sinon le
  // modèle global. On garde la trace de la source pour l'afficher.
  const base = mf || gl;
  const h = {};
  const CLES = ['time', 'temperature_2m', 'relative_humidity_2m', 'wind_speed_10m',
                'wind_gusts_10m', 'precipitation', 'surface_pressure', 'cape'];
  CLES.forEach((k) => { h[k] = []; });
  const sourceParDate = {};

  base.time.forEach((iso, i) => {
    let src = null;
    if (mf && mf.time[i] === iso && heureComplete(mf, i)) src = { d: mf, i, nom: 'Météo-France' };
    else if (gl) {
      const j = gl.time.indexOf(iso);
      if (j !== -1 && heureComplete(gl, j)) src = { d: gl, i: j, nom: 'modèle global' };
    }
    if (!src) return;
    CLES.forEach((k) => { h[k].push(k === 'time' ? iso : (src.d[k] || [])[src.i]); });
    const date = iso.split('T')[0];
    if (!sourceParDate[date]) sourceParDate[date] = src.nom;
  });

  if (!h.time.length) {
    res.status(200).json({ ok: false, raison: 'aucune heure exploitable' });
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
      const base = Object.keys(POIDS).reduce((s, k) => s + POIDS[k] * c[k], 0);
      return base * (1 + (INSTAB_MAX - 1) * c.instab / 100);
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
      secheresse: Math.round(cs * 1000) / 1000,
      nuit: cn,
      modele: sourceParDate[date] || 'inconnu',
      periodes,
    });
  }

  // Open-Meteo ne dit pas de quel run viennent ses valeurs. On le détecte
  // nous-mêmes : une empreinte des séries horaires est gardée en Redis, et
  // tant qu'elle ne bouge pas, c'est le même run ; dès qu'elle change, un
  // nouveau run vient d'être assimilé et on retient l'heure du changement.
  let actualise = null;
  try {
    const p = getClient();
    const redis = p ? await p : null;
    if (redis) {
      const empreinte = crypto.createHash('sha1')
        .update(JSON.stringify([mf, gl]))
        .digest('hex');
      const CLE = 'meteo:run:v1';
      const brut = await redis.get(CLE);
      const etat = brut ? JSON.parse(brut) : null;
      if (etat && etat.empreinte === empreinte) {
        actualise = etat.depuis;
      } else {
        actualise = Date.now();
        await redis.set(CLE, JSON.stringify({ empreinte, depuis: actualise }), { EX: 7 * 86400 });
      }
    }
  } catch (e) { /* la détection de run est un confort, jamais une dépendance */ }

  const modeles = [...new Set(Object.values(sourceParDate))];
  res.status(200).json({
    ok: true,
    source: 'Open-Meteo · ' + modeles.join(' puis '),
    instabilite: capeDispo ? 'CAPE mesurée' : 'repli sur la pression de surface',
    // Dernier changement détecté dans les données du modèle (ms epoch), ou
    // null si Redis est absent. La précision est limitée par le cache de
    // cette API (~30 min) : c'est « le run a changé vers telle heure ».
    actualise,
    jours: sortie,
  });
};
