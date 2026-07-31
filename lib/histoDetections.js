// Mémoire des détections FIRMS, une clé par journée.
//
// L'API FIRMS ne sert qu'une fenêtre glissante — dix jours au plus, souvent
// moins. Passé ce délai une détection disparaît de ses réponses, et jusqu'ici
// elle disparaissait de la carte avec elle : une zone éteinte affichée en
// sable s'effaçait du jour au lendemain, puis « ressuscitait » en rouge dès
// qu'un satellite repassait dessus. Or un terrain brûlé ne se débrûle pas.
// Seule sa date de dernière activité vieillit — c'est-à-dire que sa couleur
// doit dériver vers le sable et s'y arrêter, jamais s'effacer.
//
// On garde donc les détections nous-mêmes. Une journée sortie de la fenêtre
// FIRMS ne bougera plus jamais : sa clé est écrite une fois, puis relue telle
// quelle. C'est ce découpage par jour qui rend l'archive tenable — sans lui il
// faudrait réécrire un bloc unique de plusieurs mégaoctets à chaque moisson,
// toutes les quinze minutes.
//
// La fusion est strictement additive : on n'enlève jamais une détection déjà
// archivée. Deux invocations simultanées peuvent donc se recouvrir sans
// dommage, et une moisson partielle n'inscrit pas de trou — elle apporte
// simplement moins de nouveautés que la suivante.

// Deux mois. Au-delà, un foyer relève de l'historique de saison et non plus
// d'une carte d'activité ; cette durée borne à la fois le stockage et le
// nombre de foyers à calculer à chaque cran.
const HORIZON_JOURS = 60;

// Garde-fou par journée. Une journée d'incendies sur toute la France reste
// très en dessous ; il s'agit d'empêcher un jeu de données aberrant de gonfler
// l'archive sans fin. Ce sont les plus récentes qui sont gardées.
const MAX_PAR_JOUR = 80000;

const CLE_JOUR = 'feux:histo:v1:';

function jourDe(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function joursHorizon(maintenant) {
  const jours = [];
  for (let n = HORIZON_JOURS; n >= 0; n--) jours.push(jourDe(maintenant - n * 86400000));
  return jours;
}

// Rangées en tableaux plutôt qu'en objets : sur des dizaines de milliers de
// points, répéter les noms de champs pèse plus lourd que les données.
function encoder(points, capteurs) {
  return JSON.stringify(points.map((p) => [
    +p.lat.toFixed(5), +p.lon.toFixed(5),
    Math.round((p.frp || 0) * 10) / 10, p.ts,
    capteurs.indexOf(p.capteur),
  ]));
}

function decoder(brut, capteurs) {
  let lignes;
  try { lignes = JSON.parse(brut); } catch (e) { return []; }
  if (!Array.isArray(lignes)) return [];
  return lignes
    .filter((l) => Array.isArray(l) && l.length >= 4)
    .map((l) => ({
      lat: l[0], lon: l[1], frp: l[2], ts: l[3],
      // Un capteur inconnu (indice -1, par exemple si la liste change un jour)
      // retombe sur le premier : son empreinte au sol sera peut-être fausse,
      // mais la détection reste sur la carte.
      capteur: capteurs[l[4]] || capteurs[0],
    }))
    .filter((p) => isFinite(p.lat) && isFinite(p.lon) && isFinite(p.ts));
}

function signature(p) {
  return p.lat.toFixed(5) + ',' + p.lon.toFixed(5) + ',' + p.ts + ',' + p.capteur;
}

// Fusionne la moisson du jour dans l'archive et renvoie l'union, triée.
// Sans Redis, il n'y a pas d'archive : on rend la moisson telle quelle, et la
// carte retrouve son ancien comportement — amputée du passé, mais pas fausse.
async function historiser(redis, pointsFrais, capteurs, maintenant) {
  if (!redis) return pointsFrais;

  const cles = joursHorizon(maintenant).map((j) => CLE_JOUR + j);
  let anciens = [];
  try {
    const bruts = await redis.mGet(cles);
    (bruts || []).forEach((b) => { if (b) anciens = anciens.concat(decoder(b, capteurs)); });
  } catch (e) {
    // Archive illisible : mieux vaut la fenêtre FIRMS seule qu'une erreur.
    return pointsFrais;
  }

  // Le dédoublonnage vaut aussi à l'intérieur de la moisson : elle est
  // découpée en tranches de dates, et deux tranches qui se recouvriraient
  // feraient entrer deux fois la même détection dans l'archive — définitivement.
  const connus = new Set(anciens.map(signature));
  const nouveaux = pointsFrais.filter((p) => {
    const s = signature(p);
    if (connus.has(s)) return false;
    connus.add(s);
    return true;
  });

  const plancher = maintenant - HORIZON_JOURS * 86400000;
  // Tolérance d'une heure vers l'avant : une détection ne peut pas être dans
  // le futur, mais les horloges des capteurs ne sont pas à la seconde.
  const plafond = maintenant + 3600000;
  const union = anciens.concat(nouveaux)
    .filter((p) => p.ts >= plancher && p.ts <= plafond)
    .sort((a, b) => a.ts - b.ts);

  // Seules les journées effectivement enrichies sont réécrites : les autres
  // sont déjà correctes en base, les toucher ne ferait que coûter du réseau.
  const aReecrire = new Set(nouveaux.map((p) => jourDe(p.ts)));
  if (aReecrire.size) {
    const parJour = new Map();
    union.forEach((p) => {
      const j = jourDe(p.ts);
      if (!aReecrire.has(j)) return;
      const liste = parJour.get(j);
      if (liste) liste.push(p); else parJour.set(j, [p]);
    });
    for (const [jour, points] of parJour) {
      const gardes = points.length > MAX_PAR_JOUR
        ? points.slice(points.length - MAX_PAR_JOUR)
        : points;
      try {
        await redis.set(CLE_JOUR + jour, encoder(gardes, capteurs),
          { EX: (HORIZON_JOURS + 2) * 86400 });
      } catch (e) { /* la moisson suivante réessaiera */ }
    }
  }

  return union;
}

module.exports = {
  historiser, encoder, decoder, jourDe, joursHorizon,
  CLE_JOUR, HORIZON_JOURS, MAX_PAR_JOUR,
};
