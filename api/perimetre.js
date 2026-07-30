// État d'activité du feu de Saumos, cellule par cellule — reprise du produit
// `last_activity_state` du dépôt
// github.com/nicolaslecorvec/fumees-nouvelle_aquitaine.
//
// Principe :
//   — chaque détection FIRMS marque des cellules sur une grille de 40 m
//     (voisinage plus large pour MODIS, dont le pixel couvre ~1 km) ;
//   — chaque cellule retient l'horodatage de sa DERNIÈRE détection ;
//   — les cellules sont réparties en paliers selon l'ancienneté de cette
//     dernière activité (PROGRESSION_AGE_BINS chez eux), du rouge « vu chaud
//     à l'instant » au beige pâle « plus rien depuis plus de 40 h ».
//
// Le paramètre ?instant= rejoue l'état du feu à une date passée : seules les
// détections antérieures comptent, et l'ancienneté se mesure par rapport à
// cet instant — c'est ce qui alimente la barre temporelle de la page.
//
// Une cellule n'appartient qu'à un seul palier : les zones ne se superposent
// pas, chacune montre l'état réel de sa portion de terrain. Les bords en
// escalier viennent de la grille — ce sont de vrais pixels, pas des arrondis.
//
// Ce n'est ni un périmètre brûlé officiel, ni un front de flammes continu :
// juste ce que les satellites ont vu chaud, et quand.
//
// Différence d'exécution assumée : leur pipeline tourne hors ligne (Python,
// geopandas/shapely) et publie un fichier figé ; ici tout est calculé à la
// demande puis mis en cache, faute de pipeline programmé.

const { getClient } = require('../lib/redis');
const { pasEnDegres, celluleDe, creerGrille, polygonesDeCellules, PAS_M } = require('../lib/pixels');

const LAT = 44.98;   // Saumos, Gironde
const LON = -1.02;
const BBOX = '-1.45,44.60,-0.55,45.35';
const RAYON_KM = 34;

const JOURS_MAX = 10;
const DEPART_FEU = '2026-07-22';
const FENETRE_ACTIVE_H = 6;

// Empreinte au sol du pixel, par instrument, en mètres — FOOTPRINT_RADIUS_M
// chez eux. Exprimée en distance réelle et non en nombre de cellules : la
// finesse de la grille peut ainsi changer sans déformer l'empreinte des
// capteurs. Le pixel MODIS couvre ~1 km là où VIIRS est à ~375 m, et c'est
// lui qui relie des détections que VIIRS seul laisserait isolées.
const RAYON_M = { VIIRS: 300, MODIS: 750, LANDSAT: 300 };
const RAYON_M_DEFAUT = 300;

function rayonCellules(capteur) {
  const m = RAYON_M[instrumentDe(capteur)] || RAYON_M_DEFAUT;
  return Math.max(1, Math.round(m / PAS_M));
}

function instrumentDe(capteur) {
  if (capteur.indexOf('MODIS') === 0) return 'MODIS';
  if (capteur.indexOf('LANDSAT') === 0) return 'LANDSAT';
  return 'VIIRS';
}

const CAPTEURS = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT', 'LANDSAT_NRT'];

function joursDepuisDepart() {
  const debut = new Date(DEPART_FEU + 'T00:00:00Z');
  const ecoules = Math.ceil((Date.now() - debut.getTime()) / 86400000) + 1;
  return Math.min(JOURS_MAX, Math.max(1, ecoules));
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function tsUtc(date, heureBrute) {
  const hhmm = String(heureBrute || '0').padStart(4, '0');
  return Date.UTC(
    +date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10),
    +hhmm.slice(0, 2), +hhmm.slice(2, 4)
  );
}

function parseCsv(texte) {
  const lignes = texte.trim().split('\n');
  if (lignes.length < 2) return [];
  const entetes = lignes[0].split(',').map((c) => c.trim());
  return lignes.slice(1).map((ligne) => {
    const valeurs = ligne.split(',');
    const o = {};
    entetes.forEach((c, i) => { o[c] = valeurs[i]; });
    return o;
  });
}

function sansCle(message, cle) {
  return String(message || 'erreur inconnue').split(cle).join('CLE').slice(0, 160);
}

const DELAI_MS = 7000;

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
  if (/invalid|error|exceed/i.test(texte.slice(0, 200))) {
    throw new Error(`${capteur}: ${sansCle(texte.slice(0, 120), cle)}`);
  }
  return parseCsv(texte).map((l) => ({
    lat: parseFloat(l.latitude),
    lon: parseFloat(l.longitude),
    frp: parseFloat(l.frp) || 0,
    ts: tsUtc(l.acq_date, l.acq_time),
    capteur,
  }));
}

// Marque les cellules de grille couvertes par une détection : la cellule du
// point, plus son voisinage selon l'empreinte de l'instrument. C'est ce
// marquage qui donne les bords en escalier — des pixels carrés, pas des
// arrondis.
//
// Chaque cellule retient l'horodatage de sa DERNIÈRE détection : c'est lui
// qui dira, plus bas, si la zone est encore active ou éteinte depuis
// longtemps (leur partition « last_activity_state »).
function marquer(grille, point, origine, pas) {
  const { i, j } = celluleDe(point.lat, point.lon, origine, pas);
  const r = rayonCellules(point.capteur);
  const valeurs = grille.valeurs;
  // Empreinte carrée, pas arrondie : le pixel d'un capteur est une tuile au
  // sol, et arrondir les coins d'une détection isolée lui donnerait l'allure
  // d'un rond — exactement ce qu'on cherche à éviter.
  for (let di = -r; di <= r; di++) {
    const li = i + di - grille.i0;
    if (li < 0 || li >= grille.hauteur) continue;
    const base = li * grille.largeur - grille.j0;
    for (let dj = -r; dj <= r; dj++) {
      const co = j + dj - grille.j0;
      if (co < 0 || co >= grille.largeur) continue;
      const idx = base + j + dj;
      if (point.ts > valeurs[idx]) valeurs[idx] = point.ts;
    }
  }
}

// Paliers d'ancienneté de la dernière activité, reprise de leur
// PROGRESSION_AGE_BINS : du rouge (vu chaud à l'instant) au beige pâle
// (plus rien depuis plus de 40 h).
const PALIERS_AGE = [
  { id: 'h00_08', min: 0, max: 8, libelle: '0–8 h', couleur: '#d7191c' },
  { id: 'h08_16', min: 8, max: 16, libelle: '8–16 h', couleur: '#f03b20' },
  { id: 'h16_24', min: 16, max: 24, libelle: '16–24 h', couleur: '#fd8d3c' },
  { id: 'h24_32', min: 24, max: 32, libelle: '24–32 h', couleur: '#feb24c' },
  { id: 'h32_40', min: 32, max: 40, libelle: '32–40 h', couleur: '#fed976' },
  { id: 'h40_plus', min: 40, max: Infinity, libelle: '40 h et plus', couleur: '#fff7bc' },
];

// Positions du curseur temporel : un cran toutes les PAS_HEURES depuis le
// départ du feu, plus l'instant présent en bout de course. Le client s'en
// sert pour construire sa barre, sans dupliquer ce découpage.
const PAS_HEURES = 6;

function instantsDisponibles(maintenant) {
  const debut = new Date(DEPART_FEU + 'T00:00:00Z').getTime();
  const pas = PAS_HEURES * 3600000;
  const liste = [];
  for (let t = debut + pas; t < maintenant; t += pas) liste.push(t);
  liste.push(maintenant);
  return liste;
}

function palierDe(ageHeures) {
  return PALIERS_AGE.find((b) => ageHeures >= b.min && ageHeures < b.max)
    || PALIERS_AGE[PALIERS_AGE.length - 1];
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=3600');

  const cle = process.env.FIRMS_MAP_KEY;
  if (!cle) {
    res.status(200).json({ ok: false, raison: 'clé FIRMS non configurée' });
    return;
  }

  const maintenant = Date.now();
  const instants = instantsDisponibles(maintenant);

  // Instant demandé par le curseur : on le recale sur la position la plus
  // proche de la liste, pour que deux requêtes voisines partagent le même
  // cache au lieu d'en créer une entrée par pixel de curseur.
  let instant = instants[instants.length - 1];
  try {
    const brut = Number(new URL(req.url, 'http://x').searchParams.get('instant'));
    if (isFinite(brut) && brut > 0) {
      instant = instants.reduce((meilleur, t) =>
        Math.abs(t - brut) < Math.abs(meilleur - brut) ? t : meilleur, instants[0]);
    }
  } catch (e) { /* on reste sur l'instant le plus récent */ }

  const estDernier = instant === instants[instants.length - 1];
  const cleCache = 'perimetre:v8:' + instant;
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
    redis = null;
  }

  const jours = joursDepuisDepart();
  const morceaux = decoupes(jours);
  const taches = [];
  CAPTEURS.forEach((c) => morceaux.forEach((m) => taches.push(
    recuperer(c, cle, m.jours, m.date).then(
      (pts) => ({ ok: true, pts }),
      (e) => ({ ok: false, err: sansCle(e && e.message, cle) })
    )
  )));
  const resultats = await Promise.all(taches);
  const ok = resultats.filter((r) => r.ok);

  if (!ok.length) {
    res.status(200).json({
      ok: false,
      raison: 'API FIRMS injoignable',
      details: resultats.map((r) => r.err),
    });
    return;
  }

  // Seules les détections antérieures à l'instant choisi comptent : c'est ce
  // qui permet de rejouer l'état du feu tel qu'il était alors.
  const tous = ok.flatMap((r) => r.pts)
    .filter((p) => isFinite(p.lat) && isFinite(p.lon) && isFinite(p.ts))
    .filter((p) => p.ts <= instant)
    .filter((p) => distanceKm(LAT, LON, p.lat, p.lon) <= RAYON_KM)
    .sort((a, b) => a.ts - b.ts);

  if (!tous.length) {
    res.status(200).json({ ok: true, zones: [], actifs: [], instant, instants, paliers: PALIERS_AGE.map((p) => ({ id: p.id, libelle: p.libelle, couleur: p.couleur })) });
    return;
  }

  const HEURE = 3600000;

  // Repère de la grille de pixels : origine calée sur un multiple du pas,
  // pour que les cellules tombent toujours au même endroit d'un calcul au
  // suivant (sinon le contour glisserait à chaque rafraîchissement).
  const pasGrille = pasEnDegres(LAT);
  const origine = {
    lat: Math.floor(LAT / pasGrille.dLat) * pasGrille.dLat,
    lon: Math.floor(LON / pasGrille.dLon) * pasGrille.dLon,
  };

  let zones = [];
  let cellulesTotal = 0;
  try {
    // Étendue réelle des détections, élargie de la plus grande empreinte :
    // la grille n'est allouée que sur la zone utile, pas sur toute la boîte
    // de requête, qui serait bien plus vaste que le feu.
    let iMin = Infinity, iMax = -Infinity, jMin = Infinity, jMax = -Infinity;
    tous.forEach((p) => {
      const c = celluleDe(p.lat, p.lon, origine, pasGrille);
      if (c.i < iMin) iMin = c.i;
      if (c.i > iMax) iMax = c.i;
      if (c.j < jMin) jMin = c.j;
      if (c.j > jMax) jMax = c.j;
    });
    const marge = Math.max(...CAPTEURS.map(rayonCellules)) + 1;
    const grille = creerGrille(
      iMin - marge, jMin - marge,
      (iMax - iMin) + 2 * marge + 1,
      (jMax - jMin) + 2 * marge + 1
    );

    // Dernière activité par cellule : c'est la base de la coloration.
    tous.forEach((p) => marquer(grille, p, origine, pasGrille));

    // Répartition des cellules par palier. Une cellule n'appartient qu'à un
    // seul palier : les zones ne se superposent pas, chacune montre son
    // propre état.
    const parPalier = new Map();
    PALIERS_AGE.forEach((p) => parPalier.set(p.id, []));
    const valeurs = grille.valeurs;
    for (let idx = 0; idx < valeurs.length; idx++) {
      const ts = valeurs[idx];
      if (!ts) continue;
      cellulesTotal++;
      parPalier.get(palierDe((instant - ts) / HEURE).id).push(idx);
    }

    // Masque de travail partagé par tous les paliers, remis à zéro après
    // chaque usage : une seule allocation au lieu d'une par palier.
    const masque = new Uint8Array(valeurs.length);

    // Ordre du plus ancien au plus récent : le front encore chaud se dessine
    // par-dessus les zones éteintes.
    PALIERS_AGE.slice().reverse().forEach((p) => {
      const indices = parPalier.get(p.id);
      if (!indices || !indices.length) return;
      const surfaces = polygonesDeCellules(grille, indices, masque, origine, pasGrille, 5);
      if (!surfaces) return;
      zones.push({
        palier: p.id,
        libelle: p.libelle,
        couleur: p.couleur,
        cellules: indices.length,
        // Surface au sol : chaque cellule fait PAS_M × PAS_M.
        surfaceKm2: Math.round(indices.length * (PAS_M / 1000) * (PAS_M / 1000) * 100) / 100,
        surfaces,
      });
    });
  } catch (e) {
    res.status(200).json({ ok: false, raison: 'calcul des zones échoué : ' + e.message });
    return;
  }

  // Foyers encore chauds dans les dernières heures : rendus à part, en
  // points colorés par puissance, comme la couche « foyers actuels » de leur
  // carte — le contour, lui, ne dit pas ce qui brûle encore.
  const actifs = tous
    .filter((p) => instant - p.ts <= FENETRE_ACTIVE_H * HEURE)
    .map((p) => [+p.lat.toFixed(5), +p.lon.toFixed(5), Math.round(p.frp), p.ts]);

  const sortie = {
    ok: true,
    source: 'NASA FIRMS · VIIRS + MODIS + Landsat',
    produit: 'last_activity_state',
    depuis: DEPART_FEU,
    pasGrilleM: PAS_M,
    pasHeures: PAS_HEURES,
    instant,
    instants,
    detections: tous.length,
    cellules: cellulesTotal,
    paliers: PALIERS_AGE.map((p) => ({ id: p.id, libelle: p.libelle, couleur: p.couleur })),
    zones,
    actifs,
  };

  if (redis) {
    // Un instant passé ne bougera plus : on le garde longtemps. Le dernier
    // cran, lui, reçoit encore des détections à chaque passage satellite.
    const duree = estDernier ? 1200 : 30 * 86400;
    try { await redis.set(cleCache, JSON.stringify(sortie), { EX: duree }); } catch (e) { /* tant pis */ }
  }

  res.setHeader('X-Cache', redis ? 'miss' : 'none');
  res.status(200).json(sortie);
};
