// Contour précis de la France métropolitaine (+ Corse), pour ne garder que
// les points chauds réellement en France — une simple boîte lat/lon
// laisserait passer des bouts d'Espagne, d'Italie, de Suisse, d'Allemagne,
// de Belgique et du Luxembourg près des frontières.
//
// Le tracé exact (des milliers de points) n'est pas dans ce dépôt : il est
// téléchargé une fois depuis une source publique, puis mis en cache
// longtemps (les frontières ne bougent pas). Si ce téléchargement échoue
// (source indisponible, réseau), on se replie sur la simple boîte
// englobante déjà utilisée pour interroger FIRMS — moins précis aux
// frontières, mais le site continue de fonctionner plutôt que de planter ;
// la dégradation est signalée à l'appelant (voir précis: false).

const CLE_CACHE = 'geo:france:v1';
const URL_FRONTIERE = 'https://raw.githubusercontent.com/johan/world.geo.json/master/countries/FRA.geo.json';
const DELAI_MS = 5000;
const DUREE_CACHE_S = 30 * 86400;

// Cache mémoire du process : tant que l'instance serverless reste chaude,
// pas besoin de retourner à Redis à chaque requête.
let enMemoire = null;

async function telecharger() {
  const stop = new AbortController();
  const minuteur = setTimeout(() => stop.abort(), DELAI_MS);
  try {
    const r = await fetch(URL_FRONTIERE, { signal: stop.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    const geometrie = json.type === 'Feature' ? json.geometry : json;
    if (!geometrie || !geometrie.type || !geometrie.coordinates) {
      throw new Error('géométrie absente de la réponse');
    }
    return geometrie;
  } finally {
    clearTimeout(minuteur);
  }
}

// Renvoie la géométrie (Polygon ou MultiPolygon GeoJSON), ou null si
// indisponible — jamais d'exception, pour que l'appelant puisse se replier
// proprement sur la boîte englobante.
async function frontiereFrance(redis) {
  if (enMemoire) return enMemoire;

  if (redis) {
    try {
      const brut = await redis.get(CLE_CACHE);
      if (brut) {
        enMemoire = JSON.parse(brut);
        return enMemoire;
      }
    } catch (e) { /* on retélécharge */ }
  }

  let geometrie;
  try {
    geometrie = await telecharger();
  } catch (e) {
    return null;
  }

  enMemoire = geometrie;
  if (redis) {
    try {
      await redis.set(CLE_CACHE, JSON.stringify(geometrie), { EX: DUREE_CACHE_S });
    } catch (e) { /* tant pis, on l'aura retéléchargée la prochaine fois */ }
  }
  return geometrie;
}

// Ray casting classique sur un seul anneau (liste de [lon, lat]).
function pointDansAnneau(lon, lat, anneau) {
  let dedans = false;
  for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) {
    const xi = anneau[i][0], yi = anneau[i][1];
    const xj = anneau[j][0], yj = anneau[j][1];
    const intersecte = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersecte) dedans = !dedans;
  }
  return dedans;
}

// Polygon = [anneauExterieur, ...trous] ; MultiPolygon = plusieurs Polygon
// (la Corse et la France continentale, par exemple). Un point est dedans
// s'il est dans l'anneau extérieur d'AU MOINS un polygone, et dans aucun de
// ses trous.
function dansGeometrie(lon, lat, geometrie) {
  const polygones = geometrie.type === 'Polygon' ? [geometrie.coordinates] : geometrie.coordinates;
  for (const anneaux of polygones) {
    if (!anneaux || !anneaux.length) continue;
    let dedans = pointDansAnneau(lon, lat, anneaux[0]);
    for (let k = 1; k < anneaux.length && dedans; k++) {
      if (pointDansAnneau(lon, lat, anneaux[k])) dedans = false;
    }
    if (dedans) return true;
  }
  return false;
}

module.exports = { frontiereFrance, dansGeometrie };
