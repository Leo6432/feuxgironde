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

const CLE_CACHE = 'geo:france:v2';
const DELAI_MS = 5000;
const DUREE_CACHE_S = 30 * 86400;

// Un contour trop simplifié est pire que pas de contour du tout : la côte
// atlantique y est réduite à quelques segments, et un feu côtier — Saumos et
// Lacanau en sont — tombe alors « en mer » et disparaît de la carte. Or une
// zone absente se lit comme une zone qui n'a pas brûlé, alors qu'un feu
// espagnol qui passe se voit tout de suite. En dessous de ce nombre de
// sommets, on préfère donc la boîte englobante, qui n'exclut jamais rien.
const SOMMETS_MIN = 500;

function compterSommets(geometrie) {
  const polygones = geometrie.type === 'Polygon' ? [geometrie.coordinates] : geometrie.coordinates;
  let n = 0;
  polygones.forEach((anneaux) => (anneaux || []).forEach((a) => { n += a.length; }));
  return n;
}

// Deux sources indépendantes : si la première ne répond pas ou change de
// forme sans prévenir (dépôt GitHub externe, jamais garanti), la seconde
// prend le relais plutôt que de se rabattre silencieusement sur la simple
// boîte englobante (qui déborde sur l'Espagne, la Belgique, la Suisse…).
// La plus détaillée passe en premier : c'est un fichier « tous pays » dont il
// faut extraire la bonne entrée (~4 600 sommets). La seconde ne donne que la
// France (~55 sommets) et sera écartée par SOMMETS_MIN — elle ne reste là que
// si la première venait à changer de forme et à gagner en précision.
// Accepte les trois emballages GeoJSON courants : géométrie nue, Feature, ou
// FeatureCollection (dont on prend la première entrée — ces fichiers
// « un pays » n'en contiennent qu'une).
function premiereGeometrie(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.type === 'FeatureCollection') {
    const f = (json.features || [])[0];
    return f && f.geometry ? f.geometry : null;
  }
  if (json.type === 'Feature') return json.geometry || null;
  return json;
}

const CANDIDATS = [
  {
    url: 'https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson',
    extraire(json) {
      const features = Array.isArray(json.features) ? json.features : [];
      const f = features.find((ft) => {
        const p = ft.properties || {};
        return p.ISO_A3 === 'FRA' || p.ADMIN === 'France' || p.ADM0_A3 === 'FRA' || p.name === 'France';
      });
      return (f && f.geometry && f.geometry.type && f.geometry.coordinates) ? f.geometry : null;
    },
  },
  {
    url: 'https://raw.githubusercontent.com/johan/world.geo.json/master/countries/FRA.geo.json',
    extraire(json) {
      // Ce fichier est une FeatureCollection, pas une Feature : ne traiter
      // que les deux derniers cas revenait à toujours échouer ici, et donc à
      // n'avoir en réalité qu'une seule source au lieu de deux.
      const g = premiereGeometrie(json);
      return (g && g.type && g.coordinates) ? g : null;
    },
  },
];

// Cache mémoire du process : tant que l'instance serverless reste chaude,
// pas besoin de retourner à Redis à chaque requête.
let enMemoire = null;

async function telechargerUn(candidat) {
  const stop = new AbortController();
  const minuteur = setTimeout(() => stop.abort(), DELAI_MS);
  try {
    const r = await fetch(candidat.url, { signal: stop.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    const geometrie = candidat.extraire(json);
    if (!geometrie) throw new Error('France introuvable dans la réponse');
    const sommets = compterSommets(geometrie);
    if (sommets < SOMMETS_MIN) {
      throw new Error(`contour trop simplifié (${sommets} sommets), il exclurait des feux côtiers`);
    }
    return geometrie;
  } finally {
    clearTimeout(minuteur);
  }
}

async function telecharger() {
  for (const candidat of CANDIDATS) {
    try {
      return await telechargerUn(candidat);
    } catch (e) { /* source suivante */ }
  }
  throw new Error('aucune source de contour France disponible');
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
