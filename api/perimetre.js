// État d'activité des feux de France, cellule par cellule — reprise du
// produit `last_activity_state` du dépôt
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
// Couverture : la France métropolitaine et la Corse. Une grille unique à 40 m
// sur tout le pays ferait 625 millions de cellules ; les détections sont donc
// regroupées en foyers, chacun calculé sur sa propre petite grille, et les
// zones obtenues sont fusionnées par palier dans la réponse.
//
// Ce n'est ni un périmètre brûlé officiel, ni un front de flammes continu :
// juste ce que les satellites ont vu chaud, et quand.
//
// Différence d'exécution assumée : leur pipeline tourne hors ligne (Python,
// geopandas/shapely) et publie un fichier figé ; ici tout est calculé à la
// demande puis mis en cache, faute de pipeline programmé.

const { getClient } = require('../lib/redis');
const { frontiereFrance, dansGeometrie } = require('../lib/france');
const { pasEnDegres, celluleDe, creerGrille, polygonesDeCellules, PAS_M } = require('../lib/pixels');

// Latitude de référence pour le pas de grille en longitude : le milieu de la
// France, pour que les cellules restent à peu près carrées du nord au sud.
const LAT_REFERENCE = 46.5;

// France métropolitaine et Corse, avec une petite marge. Les points sont
// ensuite filtrés par le contour réel du pays (voir lib/france.js), sans quoi
// des feux espagnols, italiens ou allemands entreraient dans la boîte.
const BBOX = '-5.3,41.2,9.7,51.3';

// Regroupement des détections en foyers distincts : une grille à 40 m sur
// toute la France ferait 625 millions de cellules, impossible à allouer. On
// découpe donc les détections en foyers séparés, chacun recevant sa propre
// petite grille locale — celle d'un feu de 30 km ne fait que 750 × 750.
// Le pas ci-dessous sert uniquement à ce regroupement grossier : deux
// détections dans des cellules voisines (y compris en diagonale) sont
// considérées comme appartenant au même foyer.
const PAS_REGROUPEMENT_KM = 3;
const MAX_FOYERS = 400;
const MAX_CELLULES_PAR_FOYER = 4e6;

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

// Regroupe les détections en foyers distincts. Plutôt qu'une comparaison de
// chaque point à tous les autres — impraticable sur des milliers de points —
// on les range dans une grille grossière, puis on relie les cellules
// voisines par propagation. Deux détections à moins d'une cellule l'une de
// l'autre, diagonales comprises, finissent dans le même foyer.
function regrouperEnFoyers(points) {
  const pasLat = PAS_REGROUPEMENT_KM / 111.32;
  const paquets = new Map();   // "i:j" grossier -> indices de points

  points.forEach((p, n) => {
    const pasLon = PAS_REGROUPEMENT_KM / (111.32 * Math.max(Math.cos(p.lat * Math.PI / 180), 0.2));
    const gi = Math.floor(p.lat / pasLat);
    const gj = Math.floor(p.lon / pasLon);
    const k = gi + ':' + gj;
    const liste = paquets.get(k);
    if (liste) liste.push(n); else paquets.set(k, [n]);
  });

  const vues = new Set();
  const foyers = [];

  paquets.forEach((_, depart) => {
    if (vues.has(depart)) return;
    vues.add(depart);

    // Propagation de proche en proche sur les cellules grossières.
    const aVoir = [depart];
    const indices = [];
    while (aVoir.length) {
      const k = aVoir.pop();
      const liste = paquets.get(k);
      if (liste) indices.push(...liste);
      const [gi, gj] = k.split(':').map(Number);
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          if (!di && !dj) continue;
          const voisin = (gi + di) + ':' + (gj + dj);
          if (paquets.has(voisin) && !vues.has(voisin)) {
            vues.add(voisin);
            aVoir.push(voisin);
          }
        }
      }
    }
    if (indices.length) foyers.push(indices.map((n) => points[n]));
  });

  // Les plus gros foyers d'abord : si le plafond est atteint, ce sont les
  // feux importants qui restent, pas des détections isolées.
  foyers.sort((a, b) => b.length - a.length);
  return foyers.slice(0, MAX_FOYERS);
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
  const cleCache = 'perimetre:v9:' + instant;
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

  // Lancé en parallèle des requêtes FIRMS : le contour du pays ne doit pas
  // ajouter sa latence en série à une réponse déjà faite de plusieurs appels.
  const frontierePromise = frontiereFrance(redis).catch(() => null);

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

  // Contour réel du pays : une simple boîte laisserait entrer des feux
  // espagnols, italiens, suisses ou allemands proches des frontières. En cas
  // d'indisponibilité, on se replie sur la boîte, en le signalant.
  const geometrieFrance = await frontierePromise;

  // Seules les détections antérieures à l'instant choisi comptent : c'est ce
  // qui permet de rejouer l'état du feu tel qu'il était alors.
  const tous = ok.flatMap((r) => r.pts)
    .filter((p) => isFinite(p.lat) && isFinite(p.lon) && isFinite(p.ts))
    .filter((p) => p.ts <= instant)
    .filter((p) => (geometrieFrance ? dansGeometrie(p.lon, p.lat, geometrieFrance) : true))
    .sort((a, b) => a.ts - b.ts);

  if (!tous.length) {
    res.status(200).json({ ok: true, zones: [], actifs: [], instant, instants, paliers: PALIERS_AGE.map((p) => ({ id: p.id, libelle: p.libelle, couleur: p.couleur })) });
    return;
  }

  const HEURE = 3600000;

  // Repère commun à toutes les grilles : les indices de cellule sont calculés
  // depuis cette origine unique, donc deux foyers voisins tombent sur la même
  // trame et le contour ne glisse pas d'un calcul au suivant.
  const pasGrille = pasEnDegres(LAT_REFERENCE);
  const origine = { lat: 0, lon: 0 };

  let zones = [];
  let cellulesTotal = 0;
  let foyersTraites = 0;
  let foyersIgnores = 0;
  try {
    const foyers = regrouperEnFoyers(tous);
    const marge = Math.max(...CAPTEURS.map(rayonCellules)) + 1;

    // Anneaux accumulés par palier, tous foyers confondus : la sortie ne
    // contient qu'une entrée par palier, quel que soit le nombre de feux.
    const anneauxParPalier = new Map();
    const cellulesParPalier = new Map();
    PALIERS_AGE.forEach((p) => { anneauxParPalier.set(p.id, []); cellulesParPalier.set(p.id, 0); });

    foyers.forEach((points) => {
      let iMin = Infinity, iMax = -Infinity, jMin = Infinity, jMax = -Infinity;
      points.forEach((p) => {
        const c = celluleDe(p.lat, p.lon, origine, pasGrille);
        if (c.i < iMin) iMin = c.i;
        if (c.i > iMax) iMax = c.i;
        if (c.j < jMin) jMin = c.j;
        if (c.j > jMax) jMax = c.j;
      });

      const hauteur = (iMax - iMin) + 2 * marge + 1;
      const largeur = (jMax - jMin) + 2 * marge + 1;
      // Un foyer démesuré est écarté plutôt que de faire tomber la fonction
      // sur un dépassement mémoire — le fait est signalé dans la réponse.
      if (hauteur * largeur > MAX_CELLULES_PAR_FOYER) { foyersIgnores++; return; }

      const grille = creerGrille(iMin - marge, jMin - marge, hauteur, largeur);
      points.forEach((p) => marquer(grille, p, origine, pasGrille));

      // Répartition des cellules de CE foyer par palier. Une cellule
      // n'appartient qu'à un seul palier : les zones ne se superposent pas,
      // chacune montre son propre état.
      const parPalier = new Map();
      PALIERS_AGE.forEach((p) => parPalier.set(p.id, []));
      const valeurs = grille.valeurs;
      for (let idx = 0; idx < valeurs.length; idx++) {
        const ts = valeurs[idx];
        if (!ts) continue;
        cellulesTotal++;
        parPalier.get(palierDe((instant - ts) / HEURE).id).push(idx);
      }

      // Masque de travail propre à ce foyer, partagé par ses paliers.
      const masque = new Uint8Array(valeurs.length);
      PALIERS_AGE.forEach((p) => {
        const indices = parPalier.get(p.id);
        if (!indices.length) return;
        // 4 décimales ≈ 11 m : la précision utile pour une grille de 40 m, au
        // lieu d'afficher un centimètre qui n'existe pas. Les coins partagés
        // entre deux cellules voisines sont identiques avant arrondi, donc ils
        // le restent après : aucun interstice ne peut apparaître.
        const surfaces = polygonesDeCellules(grille, indices, masque, origine, pasGrille, 4);
        if (!surfaces) return;
        anneauxParPalier.get(p.id).push(...surfaces.coordinates);
        cellulesParPalier.set(p.id, cellulesParPalier.get(p.id) + indices.length);
      });

      foyersTraites++;
    });

    // Ordre du plus ancien au plus récent : le front encore chaud se dessine
    // par-dessus les zones éteintes.
    PALIERS_AGE.slice().reverse().forEach((p) => {
      const polygones = anneauxParPalier.get(p.id);
      if (!polygones || !polygones.length) return;
      const cellules = cellulesParPalier.get(p.id);
      zones.push({
        palier: p.id,
        libelle: p.libelle,
        couleur: p.couleur,
        cellules,
        // Surface au sol : chaque cellule fait PAS_M × PAS_M.
        surfaceKm2: Math.round(cellules * (PAS_M / 1000) * (PAS_M / 1000) * 100) / 100,
        surfaces: { type: 'MultiPolygon', coordinates: polygones },
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
    zone: 'France métropolitaine et Corse',
    foyers: foyersTraites,
    frontierePrecise: !!geometrieFrance,
    avertissement: !geometrieFrance
      ? 'contour précis de la France indisponible — le filtrage retombe sur une boîte englobante, qui peut inclure des feux juste au-delà des frontières'
      : (foyersIgnores ? foyersIgnores + ' foyer(s) trop étendu(s) pour être détaillé(s) à cette résolution' : undefined),
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
