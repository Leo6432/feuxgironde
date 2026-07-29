// EXPÉRIMENTAL — étape 3 : télécharger UN produit Sentinel-3 FRP (fichier
// .SEN3, distribué en ZIP), l'ouvrir, et lister ce qu'il contient — sans
// encore extraire les points chauds. Chaque étape précédente a montré qu'il
// valait mieux révéler la vraie structure que deviner : pareil ici pour les
// noms des variables NetCDF (latitude/longitude/FRP), inconnus avec
// certitude sans avoir jamais ouvert un de ces fichiers.
//
// Le vrai risque de cette étape : la taille du fichier. Une fonction
// serverless Vercel (plan gratuit) a 10 s et une mémoire limitée — un
// produit satellite peut peser des dizaines de Mo. D'où une vérification de
// taille avant de télécharger en entier, et un abandon propre si c'est trop
// gros, plutôt qu'un blocage ou un plantage silencieux.

const JSZip = require('jszip');
const { NetCDFReader } = require('netcdfjs');

const TOKEN_URL = 'https://api.eumetsat.int/token';
const DELAI_AUTH_MS = 4000;
const DELAI_TELECHARGEMENT_MS = 8000;
// Au-delà, on renonce plutôt que de risquer d'épuiser le temps ou la
// mémoire de la fonction sans le savoir à l'avance.
const TAILLE_MAX_OCTETS = 20 * 1024 * 1024;

function sansSecret(message, valeurs) {
  let m = String(message || 'erreur inconnue');
  valeurs.forEach((v) => { if (v) m = m.split(v).join('SECRET'); });
  return m.slice(0, 300);
}

async function requeteAvecDelai(url, options, delaiMs) {
  const stop = new AbortController();
  const minuteur = setTimeout(() => stop.abort(), delaiMs);
  try {
    return await fetch(url, { ...options, signal: stop.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `délai dépassé (${delaiMs / 1000}s)` : e.message);
  } finally {
    clearTimeout(minuteur);
  }
}

async function obtenirJeton(cle, secret) {
  const identifiants = Buffer.from(`${cle}:${secret}`).toString('base64');
  const r = await requeteAvecDelai(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${identifiants}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  }, DELAI_AUTH_MS);
  const texte = await r.text();
  if (!r.ok) throw new Error(`jeton refusé (HTTP ${r.status}): ${sansSecret(texte, [cle, secret])}`);
  const json = JSON.parse(texte);
  if (!json.access_token) throw new Error('jeton : access_token absent');
  return json.access_token;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const jetonDirect = process.env.EUMETSAT_ACCESS_TOKEN;
  const cle = process.env.EUMETSAT_CONSUMER_KEY;
  const secret = process.env.EUMETSAT_CONSUMER_SECRET;

  let url;
  try {
    url = new URL(req.url, 'http://x').searchParams.get('url');
  } catch (e) { /* url reste vide */ }
  if (!url) {
    res.status(200).json({ ok: false, etape: 'parametre', raison: 'paramètre ?url= manquant (lien de téléchargement du produit)' });
    return;
  }

  let jeton = jetonDirect;
  if (!jeton) {
    if (!cle || !secret) {
      res.status(200).json({ ok: false, etape: 'configuration', raison: 'aucun accès EUMETSAT configuré' });
      return;
    }
    try {
      jeton = await obtenirJeton(cle, secret);
    } catch (e) {
      res.status(200).json({ ok: false, etape: 'authentification', raison: sansSecret(e.message, [cle, secret]) });
      return;
    }
  }

  let reponse;
  try {
    reponse = await requeteAvecDelai(url, { headers: { Authorization: `Bearer ${jeton}` } }, DELAI_TELECHARGEMENT_MS);
  } catch (e) {
    res.status(200).json({ ok: false, etape: 'telechargement', raison: sansSecret(e.message, [cle, secret, jeton]) });
    return;
  }
  if (!reponse.ok) {
    const texte = await reponse.text().catch(() => '');
    res.status(200).json({
      ok: false,
      etape: 'telechargement',
      raison: `HTTP ${reponse.status}: ${sansSecret(texte, [cle, secret, jeton])}`,
    });
    return;
  }

  const tailleAnnoncee = Number(reponse.headers.get('content-length') || 0);
  if (tailleAnnoncee > TAILLE_MAX_OCTETS) {
    res.status(200).json({
      ok: false,
      etape: 'taille',
      raison: `fichier trop volumineux (${Math.round(tailleAnnoncee / 1024 / 1024)} Mo) pour cette fonction — nécessiterait une autre approche (téléchargement partiel ou traitement ailleurs)`,
      tailleOctets: tailleAnnoncee,
    });
    return;
  }

  let tampon;
  try {
    const buf = await reponse.arrayBuffer();
    if (buf.byteLength > TAILLE_MAX_OCTETS) {
      res.status(200).json({
        ok: false,
        etape: 'taille',
        raison: `fichier trop volumineux (${Math.round(buf.byteLength / 1024 / 1024)} Mo, taille non annoncée à l'avance)`,
      });
      return;
    }
    tampon = Buffer.from(buf);
  } catch (e) {
    res.status(200).json({ ok: false, etape: 'telechargement', raison: sansSecret(e.message, [cle, secret, jeton]) });
    return;
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(tampon);
  } catch (e) {
    res.status(200).json({
      ok: false,
      etape: 'zip',
      raison: 'ouverture du zip échouée : ' + e.message,
      tailleOctets: tampon.length,
      // Si ce n'est pas un zip, ce sont peut-être directement les premiers
      // octets d'un NetCDF (signature "CDF" ou "HDF") — utile à savoir.
      premiersOctets: tampon.slice(0, 8).toString('hex'),
    });
    return;
  }

  const fichiers = Object.keys(zip.files).filter((n) => !zip.files[n].dir);

  // On cherche le fichier NetCDF le plus susceptible de porter le FRP —
  // sans certitude sur son nom exact, on liste tout pour décider avec les
  // vrais noms sous les yeux plutôt que d'en deviner un.
  const candidatFrp = fichiers.find((n) => /frp/i.test(n) && n.endsWith('.nc'))
    || fichiers.find((n) => n.endsWith('.nc'));

  const sortie = {
    ok: true,
    etape: 'zip_ouvert',
    tailleOctets: tampon.length,
    fichiers,
    fichierAnalyse: candidatFrp || null,
  };

  if (candidatFrp) {
    try {
      const contenu = await zip.files[candidatFrp].async('nodebuffer');
      const nc = new NetCDFReader(contenu);
      sortie.variables = nc.variables.map((v) => ({
        nom: v.name,
        dimensions: v.dimensions,
        type: v.type,
      }));
      sortie.dimensions = nc.dimensions;
    } catch (e) {
      sortie.erreurLectureNetCDF = e.message;
    }
  }

  res.status(200).json(sortie);
};
