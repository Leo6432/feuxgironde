# -*- coding: utf-8 -*-
"""Génère le <tbody> du tableau des prévisions à partir de l'indice calculé."""
from indice import analyse

META = {
 "Mar 28": dict(num=28, id="mar28", date="2026-07-28", tag="En cours",         tagc="tag-red",  risque=40, lvl="mid",
                proj="42 000 ha (estimé, 22h30)", peak=False),
 "Mer 29": dict(num=29, id="mer29", date="2026-07-29", tag="Fenêtre 15h–17h",  tagc="tag-red",  risque=61, lvl="mid",
                proj="42 000 – 48 000 ha", peak=True),
 "Jeu 30": dict(num=30, id="jeu30", date="2026-07-30", tag="Prévision ARPEGE", tagc="tag-blue", risque=10, lvl="lo",
                proj="Accalmie, mais toujours aucune pluie · 42 000 – 57 000 ha", peak=False),
 "Ven 31": dict(num=31, id="ven31", date="2026-07-31", tag="Prévision ARPEGE", tagc="tag-blue", risque=8,  lvl="lo",
                proj="42 000 – 58 000 ha", peak=False),
}

def fr(x):
    return f'{x:.2f}'.replace('.', ',')

def niveau(s):
    return "hi" if s >= 75 else ("mid" if s >= 55 else "lo")

out = []
for nom, m in META.items():
    r = analyse(nom, m["num"])
    s = r["score"]
    tr = ' class="peak"' if m["peak"] else ''
    tr += f' data-date="{m["date"]}"'
    out.append(f'''          <tr{tr}>
            <td class="t-daytag" data-label="Jour">
              <button class="day-toggle" type="button" aria-expanded="false" aria-controls="{m['id']}">
                <span class="chev" aria-hidden="true"></span><b>{nom}</b><span class="tag {m['tagc']}">{m['tag']}</span>
              </button>
            </td>
            <td class="num t-sub" data-label="T° max">{max(x[1] for x in __import__('meteo').JOURS[nom]['h'])} °C</td>
            <td class="num t-sub" data-label="Humidité">{min(x[2] for x in __import__('meteo').JOURS[nom]['h'])} %</td>
            <td class="num t-sub" data-label="Rafales">{max(x[4] for x in __import__('meteo').JOURS[nom]['h'])} km/h</td>
            <td class="num lvl lvl-{niveau(s)} js-diff" data-label="Difficulté">{s}</td>
            <td data-label="Risque d’orage de feu">
              <div class="risk js-risk"><div class="bar"><i class="{m['lvl']}" style="width:{m['risque']}%"></i></div><span class="lvl lvl-{m['lvl']}">{m['risque']} %</span></div>
            </td>
            <td class="t-note" data-label="Projection">{m['proj']}</td>
          </tr>
          <tr class="day-detail" id="{m['id']}" data-date="{m['date']}" hidden>
            <td colspan="7">
              <div class="periodes">''')
    for p in r["periodes"]:
        out.append(f'''                <div class="periode">
                  <div class="p-lab">{p['label']}</div>
                  <div class="p-score lvl-{niveau(p['score'])}">{p['score']}</div>
                  <div class="p-meta">{p['t']} °C · {p['hum']} % · {p['raf']} km/h</div>
                  <div class="p-pic">pic à {p['heure']}h</div>
                </div>''')
    out.append(f'''              </div>
              <p class="p-note">Difficulté maximale de la journée : <strong>{s}</strong>, atteinte à {r['pire_heure']}h.
              Score brut {r['brut']:.0f}, multiplié par {fr(r['cs'])} (sécheresse) et {fr(r['cn'])} (récupération nocturne).</p>
            </td>
          </tr>''')

open('tbody.html','w',encoding='utf-8').write("\n".join(out))
print("\n".join(out)[:1200])
print("\n[...]  ->  data/tbody.html")
