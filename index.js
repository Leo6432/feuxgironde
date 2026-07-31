(function () {
  'use strict';

  var FUSEAU = 'Europe/Paris';
  var MINUTE = 60000;
  var HEURE = 3600000;

  function partie(ms, options, type) {
    var morceaux = new Intl.DateTimeFormat('fr-FR', options).formatToParts(new Date(ms));
    for (var i = 0; i < morceaux.length; i++) {
      if (morceaux[i].type === type) return morceaux[i].value;
    }
    return '';
  }

  function heureMinFr(ms) {
    var opts = { hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone: FUSEAU };
    return partie(ms, opts, 'hour').padStart(2, '0') + 'h' + partie(ms, opts, 'minute').padStart(2, '0');
  }

  function texte(id, valeur) {
    var el = document.getElementById(id);
    if (el) el.textContent = valeur;
  }

  Promise.all([
    fetch('/api/perimetre').then(function (r) { return r.json(); }).catch(function () { return null; }),
    fetch('/api/firms?jours=1').then(function (r) { return r.json(); }).catch(function () { return null; }),
  ]).then(function (resultats) {
    var perimetre = resultats[0];
    var firms = resultats[1];
    if ((!perimetre || !perimetre.ok) && (!firms || !firms.ok)) return;

    document.getElementById('chiffres').hidden = false;

    if (perimetre && perimetre.ok) {
      texte('v-foyers', String(perimetre.foyers || 0));
      texte('v-foyers-detail', (perimetre.detections || 0).toLocaleString('fr-FR') + ' détections actives');

      var surface = (perimetre.zones || []).reduce(function (s, z) { return s + (z.surfaceKm2 || 0); }, 0);
      texte('v-surface', (Math.round(surface * 10) / 10).toLocaleString('fr-FR') + ' km²');

      if (perimetre.avertissement) {
        var av = document.getElementById('avertissement');
        av.textContent = perimetre.avertissement;
        av.hidden = false;
      }
    }

    if (firms && firms.ok) {
      texte('v-frp', firms.frpMax ? Math.round(firms.frpMax) + ' MW' : '—');

      var cible = isFinite(firms.prochainPasse) ? firms.prochainPasse : null;
      if (cible) {
        function majPassage() {
          var attente = cible - Date.now();
          if (attente <= 0) { texte('v-passage', 'en cours'); return; }
          var h = Math.floor(attente / HEURE);
          var mn = Math.round((attente % HEURE) / MINUTE);
          texte('v-passage', h ? '≈ ' + h + ' h' + (mn ? ' ' + String(mn).padStart(2, '0') : '') : '≈ ' + mn + ' min');
          var opts = { day: 'numeric', timeZone: FUSEAU };
          var libJour = partie(cible, opts, 'day') === partie(Date.now(), opts, 'day') ? 'aujourd’hui' : 'demain';
          texte('v-passage-detail', libJour + ' vers ' + heureMinFr(cible));
        }
        majPassage();
        setInterval(majPassage, 60 * 1000);
      } else {
        texte('v-passage-detail', 'historique trop court');
      }
    }
  }).catch(function () { /* les chiffres restent masqués, le reste de la page fonctionne */ });
})();
