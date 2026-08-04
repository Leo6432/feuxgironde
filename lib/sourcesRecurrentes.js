// Mémoire longue durée des cellules chaudes récurrentes (usines, torchères,
// décharges...), indépendante de l'historique de 60 jours des feux (voir
// lib/histoDetections.js) et jamais purgée.
//
// Ce que le filtre MODIS (type=2/3, voir etatFeux.js) ne peut pas faire :
// VIIRS, qui fournit la majorité des détections, n'a pas ce champ (voir la
// discussion dans etatFeux.js). La seule façon de repérer une source
// industrielle vue par VIIRS est de constater qu'elle s'allume, encore et
// encore, au même endroit, sur des mois — bien au-delà de ce qu'un feu de
// forêt, même exceptionnel, tient.
//
// Ce module ne fait qu'observer et compter pour l'instant : rien ici ne
// filtre quoi que ce soit sur la carte. La distinction sûre entre « très
// gros feu qui dure des semaines » et « usine allumée toute l'année » exige
// de voir une cellule active hors saison des feux (l'hiver, quand un feu de
// forêt en France est quasiment impossible) — et on n'a tout simplement pas
// encore cette profondeur de recul (le site tourne depuis DEPART_FEU, voir
// etatFeux.js). Brancher un filtre avant ne présenterait aucune garantie de
// ne jamais masquer un vrai feu ; ce serait pire que de ne rien filtrer.

const PAS_SOURCE = 0.01; // ~1,1 km : absorbe le bruit GPS d'une détection à
// l'autre sans confondre deux sites industriels voisins.
const CLE_SOURCES = 'feux:sources:v1';

function celluleDe(lat, lon) {
  return Math.round(lat / PAS_SOURCE) + ':' + Math.round(lon / PAS_SOURCE);
}

function jourDe(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

// Enregistre les jours distincts d'activité de chaque cellule, à partir de
// TOUS les points retenus (pas seulement ceux du jour) : ça permet, dès la
// première exécution, de repartir de l'historique déjà accumulé par
// lib/histoDetections.js plutôt que de démarrer à zéro.
//
// Idempotent : rejouer les mêmes points (une moisson relancée, un jour déjà
// vu lors d'une exécution précédente) ne recompte jamais un jour déjà connu
// pour une cellule — c'est `dernierJour` qui sert de garde.
async function enregistrerJours(redis, points) {
  if (!redis || !points.length) return;

  const cellulesParJour = new Map(); // jour -> Set(cellule)
  points.forEach((p) => {
    const j = jourDe(p.ts);
    let s = cellulesParJour.get(j);
    if (!s) { s = new Set(); cellulesParJour.set(j, s); }
    s.add(celluleDe(p.lat, p.lon));
  });

  const toutesCellules = new Set();
  cellulesParJour.forEach((s) => s.forEach((c) => toutesCellules.add(c)));
  const cellules = [...toutesCellules];
  if (!cellules.length) return;

  let valeurs;
  try {
    valeurs = await redis.hmGet(CLE_SOURCES, cellules);
  } catch (e) { return; }

  const etat = new Map(); // cellule -> { nbJours, premierJour, dernierJour }
  const original = new Map();
  cellules.forEach((cle, i) => {
    if (!valeurs[i]) return;
    original.set(cle, valeurs[i]);
    const [n, p1, d1] = valeurs[i].split(':');
    etat.set(cle, { nbJours: Number(n), premierJour: p1, dernierJour: d1 });
  });

  // Chronologique : un jour ne fait avancer une cellule que s'il est
  // postérieur au dernier déjà compté pour elle, sinon on le rejoue sans
  // effet — c'est ce qui rend l'appel idempotent.
  [...cellulesParJour.keys()].sort().forEach((jour) => {
    cellulesParJour.get(jour).forEach((cle) => {
      const e = etat.get(cle);
      if (!e) { etat.set(cle, { nbJours: 1, premierJour: jour, dernierJour: jour }); return; }
      if (jour <= e.dernierJour) return;
      e.nbJours++;
      e.dernierJour = jour;
    });
  });

  const maj = {};
  let touchees = 0;
  etat.forEach((e, cle) => {
    const val = e.nbJours + ':' + e.premierJour + ':' + e.dernierJour;
    if (original.get(cle) !== val) { maj[cle] = val; touchees++; }
  });
  if (touchees) {
    try { await redis.hSet(CLE_SOURCES, maj); } catch (e) { /* la prochaine moisson réessaiera */ }
  }
  return { cellulesVues: cellules.length, cellulesMisesAJour: touchees };
}

// Diagnostic seulement : combien de cellules ont déjà atteint tel nombre de
// jours distincts. Aucun filtre ne s'appuie encore là-dessus (voir
// l'en-tête) — c'est juste de quoi suivre l'accumulation au fil du temps.
async function statistiques(redis, seuilsJours) {
  if (!redis) return null;
  let brut;
  try { brut = await redis.hGetAll(CLE_SOURCES); } catch (e) { return null; }
  const valeurs = Object.values(brut || {}).map((v) => Number(v.split(':')[0]));
  const parSeuil = {};
  (seuilsJours || [7, 30, 45, 60]).forEach((s) => {
    parSeuil[s] = valeurs.filter((n) => n >= s).length;
  });
  return { cellulesTotal: valeurs.length, parSeuil };
}

// Cellules considérées comme des sources connues plutôt que des feux : leur
// PREMIÈRE détection remonte à avant `avantDate` — typiquement le début de
// la saison en cours (DEPART_FEU dans etatFeux.js), donc pendant l'hiver
// précédent, où un feu de forêt est quasiment impossible en France.
//
// C'est délibérément la seule preuve retenue, pas un simple compte de jours
// : un compte élevé confondrait à tort un très gros feu d'été avec une
// source industrielle (voir l'en-tête du fichier). Une cellule vue hors
// saison, elle, ne peut pas être ce feu-ci — il n'avait pas encore démarré.
async function sourcesConnues(redis, avantDate) {
  if (!redis) return new Set();
  let brut;
  try { brut = await redis.hGetAll(CLE_SOURCES); } catch (e) { return new Set(); }
  const connues = new Set();
  Object.keys(brut || {}).forEach((cle) => {
    const premierJour = brut[cle].split(':')[1];
    if (premierJour && premierJour <= avantDate) connues.add(cle);
  });
  return connues;
}

function estConnue(connues, lat, lon) {
  return connues.has(celluleDe(lat, lon));
}

module.exports = {
  enregistrerJours, statistiques, sourcesConnues, estConnue,
  celluleDe, jourDe, PAS_SOURCE, CLE_SOURCES,
};
