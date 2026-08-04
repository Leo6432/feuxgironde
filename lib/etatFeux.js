// Calcul de l'état d'activité des feux de France, partagé par la lecture à la
// demande (api/perimetre.js) et le précalcul de tous les crans temporels
// (api/perimetre-precalcul.js).
//
// Reprise du produit `last_activity_state` du dépôt
// github.com/nicolaslecorvec/fumees-nouvelle_aquitaine :
//   — chaque détection FIRMS marque les cellules d'une grille couvertes par
//     l'empreinte de son capteur ;
//   — chaque cellule retient l'horodatage de sa DERNIÈRE détection ;
//   — les cellules sont réparties en paliers selon l'ancienneté de cette
//     dernière activité, du rouge « vu chaud à l'instant » au beige pâle
//     « plus rien depuis plus de 40 h ».
//
// Une cellule n'appartient qu'à un seul palier : les zones ne se superposent
// pas, chacune montre l'état réel de sa portion de terrain. Les bords en
// escalier viennent de la grille — ce sont de vrais pixels, pas des arrondis.
//
// Couverture : la France métropolitaine et la Corse. Une grille unique sur
// tout le pays serait ingérable ; les détections sont donc regroupées en
// foyers, chacun calculé sur sa propre petite grille, et les zones obtenues
// sont fusionnées par palier.
//
// Ce n'est pas un périmètre brûlé officiel. C'est une estimation de l'emprise
// brûlée, et de sa date de dernière activité, reconstituée à partir de ce que
// les satellites ont vu chaud. Elle est volontairement généreuse autour de
// chaque détection (voir RAYON_M) : un satellite ne repasse que toutes les
// quelques heures, et le feu continue d'avancer entre deux passages.

const { frontiereFrance, dansGeometrie } = require('./france');
const { historiser, HORIZON_JOURS } = require('./histoDetections');
const sourcesRecurrentes = require('./sourcesRecurrentes');
const {
  pasEnDegres, celluleDe, creerGrille, polygonesDeCellules,
  fermerTrous, creerAtelierFermeture, MAX_CELLULES_GRILLE,
} = require('./pixels');

// Latitude de référence pour le pas de grille en longitude : le milieu de la
// France, pour que les cellules restent à peu près carrées du nord au sud.
const LAT_REFERENCE = 46.5;

// France métropolitaine et Corse, avec une petite marge. Les points sont
// ensuite filtrés par le contour réel du pays (voir lib/france.js), sans quoi
// des feux espagnols, italiens ou allemands entreraient dans la boîte.
const BBOX = '-5.3,41.2,9.7,51.3';

// Regroupement des détections en foyers distincts : une grille unique couvrant
// toute la France serait impossible à allouer. On découpe donc les détections
// en foyers séparés, chacun recevant sa propre petite grille locale — celle
// d'un feu de 30 km ne fait que 300 × 300 à la maille de base.
// Le pas ci-dessous sert uniquement à ce regroupement grossier : deux
// détections dans des cellules voisines (y compris en diagonale) sont
// considérées comme appartenant au même foyer.
const PAS_REGROUPEMENT_KM = 3;
const MAX_FOYERS = 400;

// Échelle des mailles. Un très grand feu ne doit JAMAIS être écarté : c'est
// justement le plus important à montrer. Quand son emprise ne tient pas dans
// le plafond ci-dessous, on élargit sa maille au cran suivant plutôt que de le
// laisser tomber — un feu de 60 km affiché grossièrement reste vrai, alors
// qu'un feu absent est un mensonge.
//
// La maille part de 100 m, et non plus de 20. Avec une empreinte de 900 m,
// dessiner des marches de 20 m affichait une précision que la donnée n'a pas :
// le bord exact d'un pixel de 375 m vu toutes les six heures ne se connaît pas
// à vingt mètres près. Au passage, la carte est vingt fois plus légère et le
// calcul vingt fois plus rapide.
//
// Les derniers crans ne servent qu'en dernier recours : au-delà, la carte
// devient grossière. Ils existent parce que l'alternative est pire — passé ce
// que la fonction peut renvoyer, la carte ne s'affiche pas du tout.
const PAS_M_LADDER = [100, 200, 400, 800, 1600, 3200];
const MAX_CELLULES_PAR_FOYER = 12e6;

// Plafond cumulé sur tous les foyers : un pays entier en feu ne doit pas
// épuiser la mémoire de la fonction. Quand il est dépassé, c'est la finesse
// qu'on sacrifie — jamais un foyer (voir preparerFoyers).
const MAX_CELLULES_TOTAL = 24e6;

// L'API FIRMS en temps quasi réel ne remonte pas au-delà de 10 jours : c'est
// une limite de leur service, pas un choix. Ce plafond ne borne donc que ce
// qu'on peut *demander* à chaque moisson.
//
// Ce qu'on affiche va plus loin : les détections moissonnées sont conservées
// journée par journée (lib/histoDetections.js) et rejouées ensuite. Sans cette
// mémoire, une zone éteinte s'effaçait de la carte le jour où elle quittait la
// fenêtre FIRMS, puis réapparaissait en rouge au passage satellite suivant —
// alors qu'un terrain brûlé ne se débrûle pas.
const JOURS_FIRMS_MAX = 10;
const FENETRE_JOURS = 10;
const DEPART_FEU = '2026-07-22';
const FENETRE_ACTIVE_H = 6;

// Empreinte au sol du pixel, par instrument, en mètres — l'équivalent de leur
// FOOTPRINT_RADIUS_M. Exprimée en distance réelle et non en nombre de
// cellules : la finesse de la grille peut ainsi changer sans déformer
// l'empreinte des capteurs.
//
// On s'en tenait auparavant à la demi-largeur réelle du pixel — 190 m pour
// VIIRS, 500 pour MODIS — pour ne pas surestimer la surface. Le résultat était
// juste au sens strict et illisible en pratique : sur un feu de dix jours, la
// carte sortait 1706 morceaux séparés et 105 trous, une dentelle là où le
// terrain a brûlé d'un seul tenant.
//
// La raison est physique. Une détection VIIRS dit qu'il faisait chaud dans un
// pixel de 375 m à un instant donné ; elle ne dit pas que le reste n'a pas
// brûlé. Entre deux passages, six heures s'écoulent et le feu avance. Peindre
// le seul pixel détecté revient à confondre « ce qui a brûlé » avec « ce qui a
// été vu en train de brûler ».
//
// On retient donc l'empreinte du dépôt de référence
// (nicolaslecorvec/fumees-nouvelle_aquitaine, POINT_BUFFER_M = 900) : elle
// couvre le pixel et ce que le feu a parcouru autour d'ici au passage suivant.
// Sur le même jeu de détections, 14 morceaux et aucun trou.
//
// Ce que la carte annonce change avec ce choix : ce n'est plus un décompte de
// pixels vus chauds, mais une estimation de l'emprise brûlée. La surface est
// environ trois fois plus grande — et c'est bien celle-là qui est comparable
// aux bilans publiés.
const RAYON_M = { VIIRS: 900, MODIS: 1400, LANDSAT: 300 };
const RAYON_M_DEFAUT = 900;

// Comblement des interstices, en mètres. Deux détections voisines mais pas
// jointives laissent un trou, et le terrain ressort en morceaux là où il a
// brûlé d'un seul tenant. La fermeture comble ces trous sans élargir le
// contour extérieur (voir fermerTrous dans pixels.js) : elle remplit, elle
// n'étend pas.
//
// 100 m ne comblait rien de ce qui se voit : les vides entre deux passages
// satellite se comptent en kilomètres, pas en dizaines de mètres. Le dépôt de
// référence ferme à 2 km (SMOOTH_OUT_M/SMOOTH_IN_M), et c'est ce qui donne à
// sa carte une tache continue plutôt qu'un semis.
const FERMETURE_M = 2000;

function rayonCellules(capteur, pasM) {
  const m = RAYON_M[instrumentDe(capteur)] || RAYON_M_DEFAUT;
  const pas = pasM || PAS_M_LADDER[0];
  // (2r+1) cellules doivent couvrir les 2m de large du pixel : r = m/pas − ½.
  //
  // Le plancher est zéro, et non un. À maille grossière, une seule cellule
  // dépasse déjà l'empreinte du capteur ; imposer un voisinage de 3×3 triplait
  // la largeur au sol — à 320 m, un pixel VIIRS de 380 m en occupait 960, soit
  // six fois trop de surface. La surface annoncée dépendait donc de la maille,
  // et sautait dès que celle-ci changeait.
  return Math.max(0, Math.round(m / pas - 0.5));
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
  if (!r.ok) {
    // Le corps porte souvent la vraie raison (paramètre invalide, capteur
    // sans produit SP, plage hors de ce que l'archive couvre encore...) —
    // la perdre revient à deviner à l'aveugle pourquoi NASA a refusé.
    const corps = await r.text().catch(() => '');
    throw new Error(`${capteur}: HTTP ${r.status}${corps ? ' — ' + sansCle(corps, cle) : ''}`);
  }
  const texte = await r.text();
  if (/invalid|error|exceed/i.test(texte.slice(0, 200))) {
    throw new Error(`${capteur}: ${sansCle(texte.slice(0, 120), cle)}`);
  }
  return parseCsv(texte)
    // MODIS seul distingue, par détection, un feu de végétation présumé
    // (type 0) d'une source fixe au sol — usine, torchère... (type 2) ou en
    // mer (type 3) : `type` est une colonne de son produit, absente de VIIRS
    // et LANDSAT. `l.type` vaut alors `undefined` et la ligne passe telle
    // quelle, comme avant ce filtre — seul MODIS est concerné, ce qui laisse
    // filer toute usine vue par un autre capteur (la plupart des détections).
    .filter((l) => l.type === undefined || Number(l.type) === 0)
    .map((l) => ({
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
  const ancre = new Date(DEPART_FEU + 'T00:00:00Z').getTime();
  const pas = PAS_HEURES * 3600000;

  // Fenêtre glissante, jamais avant le départ du feu : remonter plus loin
  // n'afficherait que du vide.
  const plancher = Math.max(ancre, fin - FENETRE_JOURS * 86400000);

  // Les crans sont calés sur une grille ancrée au départ du feu, et non sur
  // « maintenant ». Calés sur maintenant, ils glissaient de dix minutes tous
  // les quarts d'heure dès que la fenêtre commençait à défiler : chaque cran
  // changeait alors de clé d'archive à chaque appel, plus rien n'était jamais
  // relu, et tout était recalculé en boucle. Une position du curseur montrait
  // donc un état légèrement différent d'une visite à l'autre.
  const debut = ancre + Math.ceil((plancher - ancre) / pas) * pas;

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

// v2 : le cache contient désormais l'union de la moisson et de l'archive, et
// non plus la seule fenêtre FIRMS.
const CLE_DETECTIONS = 'feux:detections:v2';
// v3 : les états archivés sous v2 l'ont été sur la seule fenêtre glissante de
// FIRMS — c'est-à-dire amputés de tout ce qui en était déjà sorti. Comme un
// état archivé est servi tel quel (voir api/perimetre.js) et conservé
// 30 jours, brancher la mémoire des détections ne suffit pas : il faut aussi
// cesser de lire ces archives-là, sinon la correction resterait invisible
// pendant un mois.
//
// (v2 corrigeait un contour de France périmé qui écartait presque tous les
// feux hors de sa zone.)
// v4 : l'empreinte au sol et la fermeture des trous ont changé — la carte
// n'est plus une dentelle de pixels vus chauds mais une emprise brûlée
// estimée. Les états archivés sous v3 montreraient encore l'ancienne, pendant
// un mois.
// v5 : la clé n'inclut plus la maille (v4 la mêlait à la clé pour invalider
// l'archive quand le plancher commun changeait — voir preparerFoyers) et la
// valeur n'est plus l'état complet mais ses seules métadonnées, les zones
// étant désormais sous des clés de page séparées (voir enregistrerEtat).
const CLE_ETAT = 'feux:etat:v5:';

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

  // La moisson rejoint la mémoire, et c'est l'union qui sert de base à la
  // carte : ce que FIRMS a cessé de servir reste affiché, au bon âge.
  // La fusion étant purement additive, une moisson incomplète peut y être
  // versée sans risque — elle apporte moins de nouveautés, jamais un trou.
  const tousBruts = await historiser(redis, points, CAPTEURS, Date.now());

  // Écarte les sources connues (voir lib/sourcesRecurrentes.js) : une
  // cellule déjà vue chaude avant le début de cette saison — l'hiver
  // précédent, où elle ne peut pas être ce feu-ci — n'est pas un feu.
  // Appliqué ici plutôt qu'après coup : ça nettoie aussi bien la moisson du
  // jour que ce qui a pu être archivé avant que cette cellule soit connue.
  const connues = await sourcesRecurrentes.sourcesConnues(redis, DEPART_FEU).catch(() => new Set());
  const tous = connues.size
    ? tousBruts.filter((p) => !sourcesRecurrentes.estConnue(connues, p.lat, p.lon))
    : tousBruts;

  const donnees = { points: tous, duCache: false, complet, erreurs, requetes: resultats.length };

  if (redis) {
    // Une moisson incomplète n'est PAS mise en cache : elle serait resservie
    // pendant un quart d'heure, et tous les états précalculés dessus seraient
    // archivés amputés — donc faux durablement. Mieux vaut refaire la requête
    // au prochain appel.
    if (complet) {
      // Court : de nouvelles détections arrivent à chaque passage satellite.
      try { await redis.set(CLE_DETECTIONS, JSON.stringify(tous), { EX: 900 }); } catch (e) { /* tant pis */ }
    }
  }
  return donnees;
}

// Prépare les foyers et leurs grilles, une fois pour toutes : c'est ce qui
// permet ensuite d'avancer dans le temps sans tout recalculer.
//
// Chaque foyer part de la maille la plus fine (100 m) et ne s'élargit que si
// lui-même — ou le total nation entier, voir MAX_CELLULES_TOTAL plus bas — le
// justifie. Depuis que les zones se transmettent en pages (voir paginerZones),
// il n'y a plus de plafond de poids partagé à respecter : la finesse d'un
// foyer ne dépend donc plus de ce qui brûle ailleurs en France.
function preparerFoyers(points) {
  // Repli seulement : chaque foyer porte sa propre maille (voir plus bas).
  const pasGrille = pasEnDegres(LAT_REFERENCE, PAS_M_LADDER[0]);
  const origine = { lat: 0, lon: 0 };

  // Emprise de chaque foyer en degrés : indépendante de la maille, elle sert à
  // choisir la maille plutôt que d'en dépendre.
  const groupes = regrouperEnFoyers(points).map((pts) => {
    let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
    pts.forEach((p) => {
      if (p.lat < latMin) latMin = p.lat;
      if (p.lat > latMax) latMax = p.lat;
      if (p.lon < lonMin) lonMin = p.lon;
      if (p.lon > lonMax) lonMax = p.lon;
    });
    return { pts, latMin, latMax, lonMin, lonMax, rang: 0, grille: null };
  });

  function dimensionner(g, rang) {
    const pasM = PAS_M_LADDER[rang];
    const pas = pasEnDegres(LAT_REFERENCE, pasM);
    // La marge doit couvrir non seulement l'empreinte des capteurs, mais aussi
    // le rayon de fermeture des trous (voir FERMETURE_M) : sans quoi une
    // détection proche du bord de la grille du foyer se fait fermer sur un
    // voisinage tronqué — maxFenetre traite le hors-grille comme du vide — et
    // l'érosion ronge alors du terrain réellement brûlé. C'est ce qui
    // creusait de faux trous près du bord de l'emprise, précisément là où le
    // rayon de fermeture (jusqu'à 20 cellules à 100 m) dépassait largement
    // l'ancienne marge (10 cellules à cette même maille).
    const rFermeture = Math.round(FERMETURE_M / pasM);
    const marge = Math.max(...CAPTEURS.map((c) => rayonCellules(c, pasM))) + rFermeture + 1;
    const a = celluleDe(g.latMin, g.lonMin, origine, pas);
    const b = celluleDe(g.latMax, g.lonMax, origine, pas);
    const hauteur = (b.i - a.i) + 2 * marge + 1;
    const largeur = (b.j - a.j) + 2 * marge + 1;
    return { pas, i0: a.i - marge, j0: a.j - marge, hauteur, largeur, total: hauteur * largeur };
  }

  const plafondFoyer = Math.min(MAX_CELLULES_PAR_FOYER, MAX_CELLULES_GRILLE);
  let ignores = 0;

  // Premier temps : chaque foyer prend la maille la plus fine qu'il supporte,
  // sans se soucier des autres.
  const retenus = [];
  groupes.forEach((g) => {
    for (let rang = 0; rang < PAS_M_LADDER.length; rang++) {
      const grille = dimensionner(g, rang);
      if (grille.total <= plafondFoyer) {
        g.rang = rang;
        g.grille = grille;
        retenus.push(g);
        return;
      }
    }
    // Même à la maille la plus grossière, ça ne tient pas : c'est désormais le
    // seul cas où un foyer est écarté, et il est annoncé dans la réponse.
    ignores++;
  });

  // Second temps : si le total déborde, on dégrade — jamais on ne supprime.
  //
  // L'allocation se faisait auparavant au fil de l'eau, chaque foyer prenant
  // ce qui restait du budget. Les premiers servis l'épuisaient et tous les
  // suivants étaient purement écartés : des feux bien réels s'effaçaient de la
  // carte, puis revenaient dès que la répartition changeait — un clignotement
  // que rien, sur le terrain, ne justifiait. On élargit donc la maille du plus
  // gros consommateur, autant de fois qu'il le faut. Un feu affiché
  // grossièrement reste vrai ; un feu absent est un mensonge.
  let total = retenus.reduce((s, g) => s + g.grille.total, 0);
  while (total > MAX_CELLULES_TOTAL) {
    let pire = null;
    retenus.forEach((g) => {
      if (g.rang >= PAS_M_LADDER.length - 1) return;
      if (!pire || g.grille.total > pire.grille.total) pire = g;
    });
    if (!pire) break;   // tout est déjà à la maille la plus grossière
    total -= pire.grille.total;
    pire.rang++;
    pire.grille = dimensionner(pire, pire.rang);
    total += pire.grille.total;
  }

  const foyers = [];
  let elargis = 0;
  let alloues = 0;
  let mailleMinM = null;
  retenus.forEach((g) => {
    // Le budget peut rester dépassé si tous les foyers sont déjà à la maille
    // la plus grossière ; on s'arrête alors plutôt que d'allouer sans limite.
    // À 320 m, il faudrait des milliers de foyers pour en arriver là — et les
    // plus fournis passent en premier (voir regrouperEnFoyers).
    if (alloues + g.grille.total > MAX_CELLULES_TOTAL && foyers.length) {
      ignores++;
      return;
    }
    alloues += g.grille.total;
    if (g.rang > 0) elargis++;
    if (mailleMinM === null || g.grille.pas.pasM < mailleMinM) mailleMinM = g.grille.pas.pasM;
    foyers.push({
      points: g.pts,
      pas: g.grille.pas,
      grille: creerGrille(g.grille.i0, g.grille.j0, g.grille.hauteur, g.grille.largeur),
      masque: null,
      curseur: 0,   // combien de ses points ont déjà été marqués
    });
  });

  return { foyers, ignores, elargis, origine, pasGrille, mailleMinM };
}

// Plafond de poids par page (voir paginerZones). Une fonction Vercel ne peut
// pas renvoyer plus de 4,5 Mo ; la marge couvre le reste de la réponse.
//
// Avant la pagination, ce plafond portait sur la réponse entière et forçait à
// élargir la maille — d'un feu à l'autre, y compris les plus petits — dès que
// le total national dépassait le seuil. Il ne s'applique plus qu'à une page :
// chaque foyer garde donc la maille la plus fine qu'il supporte lui-même (voir
// preparerFoyers), quel que soit le nombre de pages qu'il faut au total pour
// tout transmettre.
const MAX_OCTETS_PAGE = 3.8e6;

// Découpe les zones d'un état en pages qui tiennent chacune sous
// MAX_OCTETS_PAGE, plus une table de métadonnées sans géométrie.
//
// Le découpage se fait polygone par polygone, et non zone par zone : une zone
// regroupe déjà les contours de TOUS les foyers pour un même palier d'âge, et
// peut à elle seule dépasser une page. Les fragments d'un même palier, quand
// ils sont répartis sur plusieurs pages, sont reconnus par leur `palier` — le
// client les refusionne avant affichage (voir emprise.js).
function paginerZones(zones, maxOctets) {
  const meta = (zones || []).map((z) => ({
    palier: z.palier, libelle: z.libelle, couleur: z.couleur,
    cellules: z.cellules, surfaceKm2: z.surfaceKm2,
  }));

  const pages = [];
  let page = [];
  let fragmentCourant = null;
  let poidsPage = 2; // taille de « [] »

  function nouvellePage() {
    if (page.length) pages.push(page);
    page = [];
    fragmentCourant = null;
    poidsPage = 2;
  }

  (zones || []).forEach((z) => {
    fragmentCourant = null; // un palier commence toujours un nouveau fragment
    (z.surfaces.coordinates || []).forEach((polygone) => {
      const poids = Buffer.byteLength(JSON.stringify(polygone)) + 1;
      // Une page garde au moins un polygone même si lui seul dépasse le
      // plafond : une carte un peu lourde vaut mieux qu'un polygone perdu.
      if (page.length && poidsPage + poids > maxOctets) nouvellePage();
      if (!fragmentCourant) {
        fragmentCourant = { palier: z.palier, coordinates: [] };
        page.push(fragmentCourant);
        poidsPage += Buffer.byteLength(JSON.stringify({ palier: z.palier, coordinates: [] }));
      }
      fragmentCourant.coordinates.push(polygone);
      poidsPage += poids;
    });
  });
  nouvellePage();

  return { meta, pages };
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
    // Portée de la mémoire des détections : au-delà de la fenêtre parcourable,
    // c'est elle qui détermine jusqu'où le terrain brûlé reste affiché.
    horizonJours: HORIZON_JOURS,
    pasGrilleM: PAS_M_LADDER[0],
    // Maille réellement employée par le foyer le plus finement rendu : elle
    // ne s'élargit plus que si le foyer lui-même, ou le total national des
    // cellules, le justifie (voir preparerFoyers) — plus par poids de réponse.
    mailleFineM: (mailles && mailles.mailleMinM) || null,
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

// FIRMS ne publie pas ses détections à l'instant du passage : il s'écoule
// quelques heures en temps quasi réel, davantage quand un capteur est
// retraité. Un cran calculé peu après son instant est donc incomplet — il lui
// manque le passage qui n'a pas encore été diffusé.
//
// C'était le défaut : cet état incomplet partait à l'archive pour trente
// jours, donc figé tel quel, alors que le cran le plus récent, lui, est
// recalculé en continu et voit tout. La progression montrait des marches que
// le terrain n'a jamais connues — trente heures sans presque rien, puis deux
// cents kilomètres carrés d'un coup, qui n'étaient que du retard de
// publication rattrapé.
//
// Un cran n'est donc réputé définitif qu'une fois ce délai passé. Avant, il
// est gardé une heure et recalculé.
const DELAI_PUBLICATION_H = 24;

function estFige(instant, maintenant) {
  return (maintenant || Date.now()) - instant > DELAI_PUBLICATION_H * 3600000;
}

function cleEtat(instant) {
  return CLE_ETAT + instant;
}

// Lit l'état archivé d'un cran, sans ses zones : juste les métadonnées
// (zonesMeta, pages) nécessaires pour savoir combien de pages demander (voir
// lirePage). C'est ce que sert directement /api/perimetre en l'absence de
// paramètre `page`.
async function lireEtat(redis, instant) {
  if (!redis) return null;
  try {
    const brut = await redis.get(cleEtat(instant));
    return brut ? JSON.parse(brut) : null;
  } catch (e) { return null; }
}

async function lirePage(redis, instant, page) {
  if (!redis) return null;
  try {
    const brut = await redis.get(cleEtat(instant) + ':p' + page);
    return brut ? JSON.parse(brut) : null;
  } catch (e) { return null; }
}

// Découpe l'état en pages (voir paginerZones) et archive le tout : les
// métadonnées sous la clé du cran, chaque page sous une clé dérivée. Rendu au
// même moment sous la même durée de vie, pour qu'une page ne survive jamais
// aux métadonnées qui annoncent son existence.
//
// Retourne le découpage : l'appelant en a besoin pour répondre tout de suite,
// sans relire ce qui vient d'être écrit.
async function enregistrerEtat(redis, instant, etat, estDernier) {
  const { meta, pages } = paginerZones(etat.zones, MAX_OCTETS_PAGE);
  if (redis) {
    // Le dernier cran reçoit encore des détections à chaque passage satellite ;
    // les crans récents, du retard de publication. Seuls les crans réellement
    // arrêtés sont gardés longtemps — ils restent alors consultables même une
    // fois sortis de la fenêtre de FIRMS.
    const duree = estDernier ? 1200 : (estFige(instant) ? 30 * 86400 : 3600);
    const enveloppe = Object.assign({}, etat, { zones: undefined, zonesMeta: meta, pages: pages.length });
    delete enveloppe.zones;
    try {
      await redis.set(cleEtat(instant), JSON.stringify(enveloppe), { EX: duree });
      await Promise.all(pages.map((p, i) =>
        redis.set(cleEtat(instant) + ':p' + i, JSON.stringify(p), { EX: duree })
      ));
    } catch (e) { /* tant pis */ }
  }
  return { meta, pages };
}

module.exports = {
  detectionsFrance, recuperer, preparerFoyers, avancerJusqua, zonesDepuisFoyers,
  foyersActifs, instantsDisponibles, sortie, lireEtat, lirePage, enregistrerEtat,
  paginerZones, MAX_OCTETS_PAGE,
  estFige, cleEtat,
  DELAI_PUBLICATION_H, PAS_M_LADDER,
  frontiereFrance, dansGeometrie,
  JOURS_FIRMS_MAX, FENETRE_JOURS, HORIZON_JOURS, PAS_HEURES, PALIERS_AGE,
  DEPART_FEU, CLE_ETAT, CLE_DETECTIONS,
};
