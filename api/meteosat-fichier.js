// EXPÉRIMENTAL — étape 3 : télécharger UN produit Sentinel-3 FRP (fichier
// .SEN3, distribué en ZIP), l'ouvrir, et lister ce qu'il contient — sans
// encore extraire les points chauds. Chaque étape précédente a montré qu'il
// valait mieux révéler la vraie structure que deviner : pareil ici pour les
// noms des variables NetCDF (latitude/longitude/FRP), inconnus avec
// certitude sans avoir jamais ouvert un de ces fichiers.
//
// Le vrai risque de cette étape : la taille du fichier et le temps total.
// Un budget de temps global (voir BUDGET_TOTAL_MS) évite qu'une étape lente
// laisse la fonction tourner indéfiniment.
const BUDGET_TOTAL_MS = 8000;

const TAILLE_MAX_OCTETS = 20 * 1024 * 1024;

const JSZip = require('jszip');
// netcdfjs est distribué en ESM pur ("type": "module" dans son package.json)
// — un require() classique le fait planter au chargement du fichier sur les
// environnements Node où require() d'un module ESM n'est pas supporté
// (c'était la vraie cause du plantage HTTP 500 "FUNCTION_INVOCATION_FAILED"
// observé sur Vercel : 0 requête sortante, échec en ~200ms, donc avant même
// la moindre tentative réseau — un crash au chargement du module, pas un
// problème de temps ou de réseau). Un import() dynamique fonctionne partout.
let NetCDFReaderPromise = null;
function chargerNetCDFReader() {
  if (!NetCDFReaderPromise) NetCDFReaderPromise = import('netcdfjs').then((m) => m.NetCDFReader);
  return NetCDFReaderPromise;
}

const TOKEN_URL = 'https://api.eumetsat.int/token';

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

// Pour les étapes qui ne sont pas de simples appels réseau (ouverture du zip,
// lecture NetCDF) : pas d'AbortController possible, mais on peut au moins
// abandonner l'attente et répondre proprement si ça prend trop longtemps,
// plutôt que de risquer que Vercel coupe tout sans réponse JSON.
function courseContreLeTemps(promesse, delaiMs, nomEtape) {
  return Promise.race([
    promesse,
    new Promise((_, rejeter) => setTimeout(() => rejeter(new Error(`${nomEtape} : délai dépassé (${Math.round(delaiMs / 1000)}s), plus de temps disponible`)), delaiMs)),
  ]);
}

async function obtenirJeton(cle, secret, delaiMs) {
  const identifiants = Buffer.from(`${cle}:${secret}`).toString('base64');
  const r = await requeteAvecDelai(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${identifiants}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  }, delaiMs);
  const texte = await r.text();
  if (!r.ok) throw new Error(`jeton refusé (HTTP ${r.status}): ${sansSecret(texte, [cle, secret])}`);
  const json = JSON.parse(texte);
  if (!json.access_token) throw new Error('jeton : access_token absent');
  return json.access_token;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const debut = Date.now();
  const tempsRestant = () => BUDGET_TOTAL_MS - (Date.now() - debut);
  // Marge de sécurité gardée de côté à chaque étape pour laisser le temps de
  // sérialiser et envoyer la réponse JSON elle-même.
  const MARGE_MS = 300;

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
    if (tempsRestant() < MARGE_MS) {
      res.status(200).json({ ok: false, etape: 'budget_temps', raison: 'plus de temps disponible avant même de commencer' });
      return;
    }
    try {
      jeton = await obtenirJeton(cle, secret, tempsRestant() - MARGE_MS);
    } catch (e) {
      res.status(200).json({ ok: false, etape: 'authentification', raison: sansSecret(e.message, [cle, secret]) });
      return;
    }
  }

  if (tempsRestant() < MARGE_MS) {
    res.status(200).json({ ok: false, etape: 'budget_temps', raison: 'plus assez de temps disponible pour télécharger le fichier après l’authentification' });
    return;
  }

  let reponse;
  try {
    reponse = await requeteAvecDelai(url, { headers: { Authorization: `Bearer ${jeton}` } }, tempsRestant() - MARGE_MS);
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

  if (tempsRestant() < MARGE_MS) {
    res.status(200).json({
      ok: false,
      etape: 'budget_temps',
      raison: 'fichier téléchargé, mais plus assez de temps pour l’ouvrir (zip) et le lire',
      tailleOctets: tampon.length,
    });
    return;
  }

  let zip;
  try {
    zip = await courseContreLeTemps(JSZip.loadAsync(tampon), tempsRestant() - MARGE_MS, 'ouverture du zip');
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

  if (candidatFrp && tempsRestant() >= MARGE_MS) {
    try {
      const contenu = await courseContreLeTemps(
        zip.files[candidatFrp].async('nodebuffer'),
        tempsRestant() - MARGE_MS,
        'extraction du fichier NetCDF',
      );
      const NetCDFReader = await chargerNetCDFReader();
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
  } else if (candidatFrp) {
    sortie.erreurLectureNetCDF = 'zip ouvert, mais plus assez de temps pour lire le fichier NetCDF';
  }

  res.status(200).json(sortie);
};
