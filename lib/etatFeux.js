// Calcul de l'état d'activité des feux de France, partagé par la lecture à la
// demande (api/perimetre.js) et le précalcul de tous les crans temporels
// (api/perimetre-precalcul.js).
//
// Reprise du produit `last_activity_state` du dépôt
// github.com/nicolaslecorvec/fumees-nouvelle_aquitaine :
//   — chaque détection FIRMS marque des cellules sur une grille de 40 m
//     (voisinage plus large pour MODIS, dont le pixel couvre ~1 km) ;
//   — chaque cellule retient l'horodatage de sa DERNIÈRE détection ;
//   — les cellules sont réparties en paliers selon l'ancienneté de cette
//     dernière activité, du rouge « vu chaud à l'instant » au beige pâle
//     « plus rien depuis plus de 40 h ».
//
// Une cellule n'appartient qu'à un seul palier : les zones ne se superposent
// pas, chacune montre l'état réel de sa portion de terrain. Les bords en
// escalier viennent de la grille — ce sont de vrais pixels, pas des arrondis.
//
// Couverture : la France métropolitaine et la Corse. Une grille unique à 40 m
// sur tout le pays ferait 625 millions de cellules ; les détections sont donc
// regroupées en foyers, chacun calculé sur sa propre petite grille, et les
// zones obtenues sont fusionnées par palier.
//
// Ce n'est ni un périmètre brûlé officiel, ni un front de flammes continu :
// juste ce que les satellites ont vu chaud, et quand.

const { frontiereFrance, dansGeometrie } = require('./france');
const {
  pasEnDegres, celluleDe, creerGrille, polygonesDeCellules,
  fermerTrous, creerAtelierFermeture, PAS_M, MAX_CELLULES_GRILLE,
} = require('./pixels');

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

// Un très grand feu ne doit JAMAIS être écarté : c'est justement le plus
// important à montrer. Quand son emprise ne tient pas dans le plafond
// ci-dessous à 20 m, on élargit sa maille au cran suivant plutôt que de le
// laisser tomber — un feu de 60 km affiché à 40 m reste juste, alors qu'un
// feu absent est un mensonge.
//
// C'était le défaut : l'incendie de Saumos s'étend sur 36 × 65 km, soit
// 5,95 M de cellules à 20 m, au-delà de l'ancien plafond de 4 M. Il était donc
// écarté en entier, et la carte ne montrait plus que les petits feux autour —
// des fragments épars là où il fallait une grande tache continue.
const PAS_M_LADDER = [20, 40, 80, 160, 320];
const MAX_CELLULES_PAR_FOYER = 12e6;

// Plafond cumulé sur tous les foyers : un pays entier en feu ne doit pas
// épuiser la mémoire de la fonction. Les foyers sont traités du plus fourni au
// moins fourni, donc ce sont les feux marginaux qui s'élargissent en premier.
const MAX_CELLULES_TOTAL = 24e6;

// L'API FIRMS en temps quasi réel ne remonte pas au-delà de 10 jours : c'est
// une limite de leur service, pas un choix. La barre temporelle s'aligne
// dessus, pour que chaque cran ait toujours de vraies données derrière lui.
//
// Les états calculés restent archivés (voir enregistrerEtat), ce qui permettra
// d'élargir la fenêtre plus tard sans rien perdre. En attendant, si FIRMS
// renvoie moins que ces 10 jours, un cran sans donnée le dit explicitement
// plutôt que d'afficher une carte vide comme si rien n'avait brûlé.
const JOURS_FIRMS_MAX = 10;
const FENETRE_JOURS = 10;
const DEPART_FEU = '2026-07-22';
const FENETRE_ACTIVE_H = 6;

// Empreinte au sol du pixel, par instrument, en mètres — l'équivalent de leur
// FOOTPRINT_RADIUS_M. Exprimée en distance réelle et non en nombre de
// cellules : la finesse de la grille peut ainsi changer sans déformer
// l'empreinte des capteurs.
//
// Ce sont ici les demi-largeurs réelles des pixels — VIIRS fait ~375 m au sol,
// MODIS ~1 km — là où leur pipeline retient 300 et 750 m. Leurs valeurs sont
// volontairement généreuses : elles servent à relier des détections voisines
// sur une grille de 250 m. À 20 m, cette générosité se voit — ce sont les gros
// blocs visibles autour d'une détection isolée — et elle surestime la surface
// (95 km² contre 84 sur le même jeu de détections). On s'en tient donc au
// pixel réel. Le pixel MODIS reste bien plus large que celui de VIIRS, et
// c'est toujours lui qui relie des détections que VIIRS seul laisserait
// isolées.
const RAYON_M = { VIIRS: 190, MODIS: 500, LANDSAT: 190 };
const RAYON_M_DEFAUT = 190;

// Comblement des petits interstices, en mètres — leur SMALL_GAP_CLOSING_M.
// Deux détections voisines mais pas jointives laissent un trou, et le terrain
// ressort en morceaux là où il a brûlé d'un seul tenant. La fermeture comble
// ces trous sans élargir le contour extérieur (voir fermerTrous dans
// pixels.js) : c'est ce qui manquait pour obtenir une tache continue plutôt
// que des fragments.
const FERMETURE_M = 100;

function rayonCellules(capteur, pasM) {
  const m = RAYON_M[instrumentDe(capteur)] || RAYON_M_DEFAUT;
  return Math.max(1, Math.round(m / (pasM || PAS_M)));
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
  return Math.min(JOURS_FIRMS_MAX, Math.max(1, ecoules));
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

// Une requête couvrant toute la France renvoie bien plus de lignes que
// l'ancienne boîte girondine : 7 s suffisaient pour un seul feu, plus pour un
// pays entier. La limite d'exécution de la fonction est de plusieurs minutes,
// on peut donc être large — mieux vaut attendre que perdre une tranche
// entière de détections.
const DELAI_MS = 25000;

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
// Les grilles rangent les horodatages en minutes depuis cette base, pour
// tenir dans un entier 32 bits (voir creerGrille) : en millisecondes il
// faudrait deux fois plus de mémoire par cellule, donc des feux deux fois
// moins étendus à finesse égale. La minute est bien plus fine que le rythme
// des passages satellite, on ne perd rien.
const BASE_MS = Date.UTC(2020, 0, 1);

function enMinutes(ts) { return Math.max(1, Math.round((ts - BASE_MS) / 60000)); }
function enMs(minutes) { return BASE_MS + minutes * 60000; }

function marquer(grille, point, origine, pas) {
  const { i, j } = celluleDe(point.lat, point.lon, origine, pas);
  const r = rayonCellules(point.capteur, pas.pasM);
  const minutes = enMinutes(point.ts);
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
      if (minutes > valeurs[idx]) valeurs[idx] = minutes;
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

// Le dernier cran vaut « maintenant », mais arrondi à ce quantum. Sans cet
// arrondi il changerait à la milliseconde d'une requête à l'autre, chaque
// appel créerait sa propre entrée d'archive, et le cran courant serait
// recalculé indéfiniment.
const QUANTUM_MS = 10 * 60000;

function instantsDisponibles(maintenant) {
  const fin = Math.floor(maintenant / QUANTUM_MS) * QUANTUM_MS;
  // Fenêtre glissante de 14 jours, jamais avant le départ du feu : remonter
  // plus loin n'afficherait que du vide.
  const debut = Math.max(
    new Date(DEPART_FEU + 'T00:00:00Z').getTime(),
    fin - FENETRE_JOURS * 86400000
  );
  const pas = PAS_HEURES * 3600000;
  const liste = [];
  for (let t = debut + pas; t < fin; t += pas) liste.push(t);
  liste.push(fin);
  return liste;
}

function palierDe(ageHeures) {
  return PALIERS_AGE.find((b) => ageHeures >= b.min && ageHeures < b.max)
    || PALIERS_AGE[PALIERS_AGE.length - 1];
}


// ── Interface publique ────────────────────────────────────────────────────

const CLE_DETECTIONS = 'feux:detections:v1';
// v2 : les états archivés sous v1 l'ont été avec un contour de France périmé,
// qui écartait la quasi-totalité des feux hors de sa zone. Comme un état
// archivé est servi tel quel (voir api/perimetre.js) et conservé 30 jours,
// corriger le contour ne suffisait pas : il faut aussi cesser de lire ces
// archives-là.
const CLE_ETAT = 'feux:etat:v2:';

// Détections FIRMS de toute la France, mises en cache quelques minutes. Sans
// ce cache, calculer plusieurs crans temporels d'affilée relancerait à chaque
// fois cinq requêtes FIRMS pour les mêmes données — c'est ce qui rendait la
// barre temporelle lente.
async function detectionsFrance(cle, redis) {
  if (redis) {
    try {
      const brut = await redis.get(CLE_DETECTIONS);
      // Seule une moisson complète est mise en cache (voir plus bas) : ce qui
      // en ressort l'est donc aussi.
      if (brut) return { points: JSON.parse(brut), duCache: true, complet: true, erreurs: [], requetes: 0 };
    } catch (e) { /* on refait la requête */ }
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
    const err = new Error('API FIRMS injoignable');
    err.details = resultats.map((r) => r.err);
    throw err;
  }

  const points = ok.flatMap((r) => r.pts)
    .filter((p) => isFinite(p.lat) && isFinite(p.lon) && isFinite(p.ts))
    .sort((a, b) => a.ts - b.ts);

  const erreurs = resultats.filter((r) => !r.ok).map((r) => r.err);
  const complet = erreurs.length === 0;
  const donnees = { points, duCache: false, complet, erreurs, requetes: resultats.length };

  if (redis) {
    // Une moisson incomplète n'est PAS mise en cache : elle serait resservie
    // pendant un quart d'heure, et tous les états précalculés dessus seraient
    // archivés amputés — donc faux durablement. Mieux vaut refaire la requête
    // au prochain appel.
    if (complet) {
      // Court : de nouvelles détections arrivent à chaque passage satellite.
      try { await redis.set(CLE_DETECTIONS, JSON.stringify(points), { EX: 900 }); } catch (e) { /* tant pis */ }
    }
  }
  return donnees;
}

// Prépare les foyers et leurs grilles, une fois pour toutes : c'est ce qui
// permet ensuite d'avancer dans le temps sans tout recalculer.
function preparerFoyers(points) {
  const pasGrille = pasEnDegres(LAT_REFERENCE);
  const origine = { lat: 0, lon: 0 };
  const foyers = [];
  let ignores = 0;
  let elargis = 0;
  let cellulesAllouees = 0;

  regrouperEnFoyers(points).forEach((pts) => {
    // Emprise du foyer en degrés : indépendante de la maille, elle sert à
    // choisir la maille plutôt que d'en dépendre.
    let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
    pts.forEach((p) => {
      if (p.lat < latMin) latMin = p.lat;
      if (p.lat > latMax) latMax = p.lat;
      if (p.lon < lonMin) lonMin = p.lon;
      if (p.lon > lonMax) lonMax = p.lon;
    });

    // On descend l'échelle des mailles jusqu'à ce que la grille tienne, dans
    // le plafond du foyer comme dans ce qui reste du budget global.
    const budget = Math.min(MAX_CELLULES_PAR_FOYER, MAX_CELLULES_TOTAL - cellulesAllouees);
    let retenu = null;
    for (let n = 0; n < PAS_M_LADDER.length; n++) {
      const pasM = PAS_M_LADDER[n];
      const pas = pasEnDegres(LAT_REFERENCE, pasM);
      const marge = Math.max(...CAPTEURS.map((c) => rayonCellules(c, pasM))) + 1;
      const a = celluleDe(latMin, lonMin, origine, pas);
      const b = celluleDe(latMax, lonMax, origine, pas);
      const hauteur = (b.i - a.i) + 2 * marge + 1;
      const largeur = (b.j - a.j) + 2 * marge + 1;
      const total = hauteur * largeur;
      if (total <= budget && total <= MAX_CELLULES_GRILLE) {
        retenu = { pas, i0: a.i - marge, j0: a.j - marge, hauteur, largeur, total };
        if (n > 0) elargis++;
        break;
      }
    }

    // Même à la maille la plus grossière, ça ne tient pas : c'est le seul cas
    // où un foyer est écarté, et il est annoncé dans la réponse.
    if (!retenu) { ignores++; return; }

    cellulesAllouees += retenu.total;
    foyers.push({
      points: pts,
      pas: retenu.pas,
      grille: creerGrille(retenu.i0, retenu.j0, retenu.hauteur, retenu.largeur),
      masque: null,
      curseur: 0,   // combien de ses points ont déjà été marqués
    });
  });

  return { foyers, ignores, elargis, origine, pasGrille };
}

// Assemble les zones à un instant donné, à partir de grilles déjà marquées.
function zonesDepuisFoyers(foyers, instant, origine, pasGrille) {
  const anneauxParPalier = new Map();
  const cellulesParPalier = new Map();
  const surfaceParPalier = new Map();
  PALIERS_AGE.forEach((p) => {
    anneauxParPalier.set(p.id, []);
    cellulesParPalier.set(p.id, 0);
    surfaceParPalier.set(p.id, 0);
  });
  let cellulesTotal = 0;

  foyers.forEach((f) => {
    const pas = f.pas || pasGrille;
    // Les foyers n'ont pas tous la même maille (voir preparerFoyers) : la
    // surface se calcule donc foyer par foyer, et non en multipliant un
    // total de cellules par une taille unique.
    const aireCellule = (pas.pasM / 1000) * (pas.pasM / 1000);

    // Les interstices sont comblés avant le classement par palier, sur une
    // copie : la grille d'origine continue d'accumuler les détections d'un
    // cran au suivant et ne doit pas être modifiée.
    const rFermeture = Math.round(FERMETURE_M / pas.pasM);
    let valeurs = f.grille.valeurs;
    if (rFermeture >= 1) {
      if (!f.atelier) {
        f.atelier = creerAtelierFermeture(valeurs.length, f.grille.largeur, f.grille.hauteur);
      }
      valeurs = fermerTrous(valeurs, f.grille.largeur, f.grille.hauteur, rFermeture, f.atelier);
    }

    const parPalier = new Map();
    PALIERS_AGE.forEach((p) => parPalier.set(p.id, []));
    for (let idx = 0; idx < valeurs.length; idx++) {
      const minutes = valeurs[idx];
      if (!minutes) continue;
      cellulesTotal++;
      parPalier.get(palierDe((instant - enMs(minutes)) / 3600000).id).push(idx);
    }
    if (!f.masque) f.masque = new Uint8Array(valeurs.length);
    PALIERS_AGE.forEach((p) => {
      const indices = parPalier.get(p.id);
      if (!indices.length) return;
      // 4 décimales ≈ 11 m : la précision utile à ces mailles.
      const surfaces = polygonesDeCellules(f.grille, indices, f.masque, origine, pas, 4);
      if (!surfaces) return;
      anneauxParPalier.get(p.id).push(...surfaces.coordinates);
      cellulesParPalier.set(p.id, cellulesParPalier.get(p.id) + indices.length);
      surfaceParPalier.set(p.id, surfaceParPalier.get(p.id) + indices.length * aireCellule);
    });
  });

  const zones = [];
  // Du plus ancien au plus récent : le front encore chaud passe devant.
  PALIERS_AGE.slice().reverse().forEach((p) => {
    const polygones = anneauxParPalier.get(p.id);
    if (!polygones.length) return;
    const cellules = cellulesParPalier.get(p.id);
    zones.push({
      palier: p.id,
      libelle: p.libelle,
      couleur: p.couleur,
      cellules,
      surfaceKm2: Math.round(surfaceParPalier.get(p.id) * 100) / 100,
      surfaces: { type: 'MultiPolygon', coordinates: polygones },
    });
  });

  return { zones, cellulesTotal };
}

// Avance les grilles jusqu'à `instant` : seuls les points nouvellement
// atteints sont marqués. C'est ce qui rend le précalcul de tous les crans
// abordable — le marquage, de loin le plus coûteux, n'est fait qu'une fois au
// total au lieu d'une fois par cran.
function avancerJusqua(foyers, instant, origine, pasGrille) {
  foyers.forEach((f) => {
    const pas = f.pas || pasGrille;
    while (f.curseur < f.points.length && f.points[f.curseur].ts <= instant) {
      marquer(f.grille, f.points[f.curseur], origine, pas);
      f.curseur++;
    }
  });
}

function sortie(instant, instants, zones, cellulesTotal, foyers, actifs, geometrieFrance, mailles, moisson) {
  // `mailles` est le résultat de preparerFoyers ; un simple nombre de foyers
  // écartés reste accepté, c'est ce que passaient les appelants d'avant.
  const ignores = typeof mailles === 'number' ? mailles : (mailles && mailles.ignores) || 0;
  const elargis = (mailles && mailles.elargis) || 0;
  // Une moisson partielle change tout : la carte montre alors moins de feu
  // qu'il n'y en a eu. Le dire est indispensable — sans quoi une zone absente
  // se lit comme une zone qui n'a pas brûlé.
  const manquantes = moisson && !moisson.complet ? moisson.erreurs.length : 0;
  const alerteMoisson = manquantes
    ? manquantes + ' requête(s) FIRMS sur ' + moisson.requetes + ' ont échoué — '
      + 'des détections manquent, la surface affichée est incomplète'
    : null;
  return {
    ok: true,
    source: 'NASA FIRMS · VIIRS + MODIS + Landsat',
    produit: 'last_activity_state',
    zone: 'France métropolitaine et Corse',
    depuis: DEPART_FEU,
    fenetreJours: FENETRE_JOURS,
    pasGrilleM: PAS_M,
    pasHeures: PAS_HEURES,
    instant,
    instants,
    foyers,
    detections: actifs.total,
    cellules: cellulesTotal,
    frontierePrecise: !!geometrieFrance,
    complet: !moisson || moisson.complet,
    foyersElargis: elargis,
    foyersIgnores: ignores,
    avertissement: alerteMoisson
      // Un foyer écarté est le pire des cas : du feu manque à l'écran.
      || (ignores
        ? ignores + ' foyer(s) trop étendu(s) même à la maille la plus grossière — '
          + 'ils n’apparaissent pas sur la carte'
        : (!geometrieFrance
          ? 'contour précis de la France indisponible — le filtrage retombe sur une boîte englobante, qui peut inclure des feux juste au-delà des frontières'
          : undefined)),
    paliers: PALIERS_AGE.map((p) => ({ id: p.id, libelle: p.libelle, couleur: p.couleur })),
    zones,
    actifs: actifs.liste,
  };
}

function foyersActifs(points, instant) {
  const liste = points
    .filter((p) => p.ts <= instant && instant - p.ts <= FENETRE_ACTIVE_H * 3600000)
    .map((p) => [+p.lat.toFixed(5), +p.lon.toFixed(5), Math.round(p.frp), p.ts]);
  return { liste, total: points.filter((p) => p.ts <= instant).length };
}

async function lireEtat(redis, instant) {
  if (!redis) return null;
  try {
    const brut = await redis.get(CLE_ETAT + instant);
    return brut ? JSON.parse(brut) : null;
  } catch (e) { return null; }
}

async function enregistrerEtat(redis, instant, etat, estDernier) {
  if (!redis) return;
  // Un état passé ne bougera plus : gardé longtemps, il reste consultable même
  // une fois sorti de la fenêtre de 10 jours de FIRMS. Le dernier cran, lui,
  // reçoit encore des détections à chaque passage satellite.
  const duree = estDernier ? 1200 : 30 * 86400;
  try { await redis.set(CLE_ETAT + instant, JSON.stringify(etat), { EX: duree }); } catch (e) { /* tant pis */ }
}

module.exports = {
  detectionsFrance, preparerFoyers, avancerJusqua, zonesDepuisFoyers,
  foyersActifs, instantsDisponibles, sortie, lireEtat, enregistrerEtat,
  frontiereFrance, dansGeometrie,
  JOURS_FIRMS_MAX, FENETRE_JOURS, PAS_HEURES, PALIERS_AGE, DEPART_FEU, CLE_ETAT,
};
