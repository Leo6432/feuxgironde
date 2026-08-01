// Position des avions de la Sécurité civile (bombardiers d'eau, avions de
// coordination) au-dessus de la France, via OpenSky Network — gratuit, à la
// différence de FlightRadar24.
//
// Endpoint et format de réponse vérifiés sur le client officiel
// (github.com/openskynetwork/opensky-api, module Python) : OpenSky lui-même
// est injoignable depuis cet environnement de développement, donc rien
// ci-dessous n'a pu être testé contre le service réel. Ce qui suit est fondé
// sur leur documentation, pas sur une observation en direct.
//
// Identification des avions : OpenSky ne dit pas « ceci est un bombardier
// d'eau ». On ne le déduit que de l'indicatif radio diffusé par le
// transpondeur. C'est un filtrage BEST-EFFORT, construit à partir de
// connaissances publiques (presse, sites d'observation aérienne) et NON
// vérifié en direct :
//   — « PELICAN » : indicatif des Canadair CL-415 de la Sécurité civile.
//   — « F-ZB » (sans le tiret, tel que diffusé) : bloc d'immatriculation de
//     la Direction générale de la sécurité civile — Canadair (F-ZBEx),
//     Dash 8 (F-ZBMx), Beechcraft de coordination, hélicoptères. Un avion
//     sans indicatif dédié diffuse souvent son immatriculation en guise
//     d'indicatif.
//   — « DASH » : plus incertain, ajouté au cas où les Dash 8 l'utilisent.
// Si des avions manquent ou qu'un avion étranger à la lutte contre le feu
// apparaît une fois le site en service, PATRONS ci-dessous est l'endroit à
// corriger — un seul tableau, pas de logique éparpillée.
const PATRONS = [/^PELICAN/, /^FZB/, /^DASH/];

function estAvionFeu(indicatif) {
  return PATRONS.some((p) => p.test(indicatif));
}

// France métropolitaine et Corse, avec une marge — les mêmes bornes que pour
// les feux (voir lib/etatFeux.js BBOX), pour couvrir un avion qui décollerait
// de Nîmes-Garons ou Marignane vers un feu proche de la frontière.
const LAMIN = 41.2, LAMAX = 51.3, LOMIN = -5.3, LOMAX = 9.7;

const DELAI_MS = 12000;

const CLES = {
  keys: [
    'icao24', 'callsign', 'origin_country', 'time_position', 'last_contact',
    'longitude', 'latitude', 'baro_altitude', 'on_ground', 'velocity',
    'true_track', 'vertical_rate', 'sensors', 'geo_altitude', 'squawk',
    'spi', 'position_source', 'category',
  ],
};

function vecteurVersAvion(arr) {
  const v = {};
  CLES.keys.forEach((cle, i) => { v[cle] = arr[i]; });
  const indicatif = String(v.callsign || '').trim().toUpperCase();
  if (!indicatif || !estAvionFeu(indicatif)) return null;
  if (v.on_ground) return null;   // au sol : pas de trajet à tracer
  // `Number.isFinite`, pas le global : celui-ci convertirait `null` — la
  // position « inconnue » d'OpenSky — en 0, soit un point au large du Ghana.
  if (!Number.isFinite(v.latitude) || !Number.isFinite(v.longitude)) return null;

  return {
    icao24: v.icao24,
    indicatif,
    lat: Math.round(v.latitude * 1e5) / 1e5,
    lon: Math.round(v.longitude * 1e5) / 1e5,
    // geo_altitude (au-dessus de l'ellipsoïde) est préféré à baro_altitude
    // (pression) quand il est présent : plus stable près du sol, utile pour
    // un avion en train d'écoper sur un plan d'eau.
    altitudeM: Number.isFinite(v.geo_altitude) ? Math.round(v.geo_altitude)
      : (Number.isFinite(v.baro_altitude) ? Math.round(v.baro_altitude) : null),
    vitesseKmh: Number.isFinite(v.velocity) ? Math.round(v.velocity * 3.6) : null,
    capDeg: Number.isFinite(v.true_track) ? Math.round(v.true_track) : null,
    verticalMs: Number.isFinite(v.vertical_rate) ? Math.round(v.vertical_rate * 10) / 10 : null,
  };
}

// Jeton OAuth2, uniquement si des identifiants OpenSky ont été configurés.
// Sans eux, la requête part en anonyme — c'est le mode par défaut, sans
// aucune configuration à faire. OpenSky limite plus sévèrement les requêtes
// anonymes ; si ça se révèle insuffisant une fois le site en service, un
// compte OpenSky (gratuit) et deux variables d'environnement suffiront à
// passer en mode authentifié, sans toucher au reste de ce fichier.
const URL_JETON = 'https://auth.opensky-network.org/auth/realms/'
  + 'opensky-network/protocol/openid-connect/token';

let jetonEnCache = null;   // { valeur, expire }

async function jetonOAuth() {
  const id = process.env.OPENSKY_CLIENT_ID;
  const secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;

  if (jetonEnCache && jetonEnCache.expire > Date.now() + 30000) {
    return jetonEnCache.valeur;
  }

  const r = await fetch(URL_JETON, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: id, client_secret: secret,
    }),
  });
  if (!r.ok) throw new Error('authentification OpenSky refusée : HTTP ' + r.status);
  const d = await r.json();
  jetonEnCache = { valeur: d.access_token, expire: Date.now() + (d.expires_in || 1800) * 1000 };
  return jetonEnCache.valeur;
}

async function recupererAvions() {
  const url = 'https://opensky-network.org/api/states/all?'
    + `lamin=${LAMIN}&lamax=${LAMAX}&lomin=${LOMIN}&lomax=${LOMAX}`;

  const entetes = {};
  const jeton = await jetonOAuth().catch(() => null);   // anonyme si ça échoue
  if (jeton) entetes.Authorization = 'Bearer ' + jeton;

  const stop = new AbortController();
  const minuteur = setTimeout(() => stop.abort(), DELAI_MS);
  let r;
  try {
    r = await fetch(url, { signal: stop.signal, headers: entetes });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? `OpenSky : délai dépassé (${DELAI_MS / 1000}s)`
      : `OpenSky : ${e.message}`);
  } finally {
    clearTimeout(minuteur);
  }
  if (!r.ok) throw new Error('OpenSky : HTTP ' + r.status);

  const d = await r.json();
  const brut = Array.isArray(d.states) ? d.states : [];
  const avions = brut.map(vecteurVersAvion).filter(Boolean);
  const instant = Number.isFinite(d.time) ? d.time * 1000 : Date.now();
  return { instant, avions };
}

module.exports = { recupererAvions, estAvionFeu, vecteurVersAvion, PATRONS, LAMIN, LAMAX, LOMIN, LOMAX };
