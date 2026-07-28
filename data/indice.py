# -*- coding: utf-8 -*-
"""Indice de difficulté — version enrichie, calculée heure par heure."""
from meteo import JOURS, DERNIERE_PLUIE, PRECIP

def norm(v, lo, hi):
    return max(0.0, min(100.0, (v - lo) / (hi - lo) * 100))

# Poids des composantes horaires (somme = 1)
POIDS = {"temp":0.25, "hum":0.30, "rafales":0.20, "vent":0.10, "instab":0.15}

def composantes(heures, i, nom=None):
    """Les 5 composantes 0-100 pour l'heure i."""
    h, t, hum, moy, raf, pres = heures[i]
    # Instabilité : chute de pression sur les 6 heures précédentes, MAIS
    # uniquement par temps sec. Une baisse de pression accompagnée de pluie
    # signale un front humide, qui calme le feu au lieu de l'exciter : la
    # compter comme de l'instabilité inverserait le sens du signal.
    j = max(0, i - 6)
    chute = heures[j][5] - pres
    if nom is not None:
        pluie = sum(PRECIP[nom][max(0, i-6):i+1])
        if pluie > 0.2:
            chute = 0.0
    return {
        "temp":    norm(t, 15, 42),
        "hum":     norm(80 - hum, 0, 65),     # air sec = score haut
        "rafales": norm(raf, 0, 60),
        "vent":    norm(moy, 0, 30),
        "instab":  norm(chute, 0, 5),         # 5 hPa en 6 h = 100
    }

def score_horaire(heures, i, nom=None):
    c = composantes(heures, i, nom)
    return sum(POIDS[k] * c[k] for k in POIDS)

def coef_secheresse(jour_num):
    """Multiplicateur selon les jours écoulés depuis la dernière pluie."""
    d = jour_num - DERNIERE_PLUIE
    if d <= 1:  return 0.90
    if d <= 3:  return 1.00
    if d <= 6:  return 1.08
    return 1.15

def coef_nuit(heures):
    """Le feu ne se couche pas si l'air ne se réhumidifie pas la nuit."""
    nuit = [x[2] for x in heures if x[0] >= 22 or x[0] <= 6]
    return 1.05 if nuit and max(nuit) < 60 else 1.00

PERIODES = [("Matin", 6, 11), ("Midi", 11, 14), ("Après-midi", 14, 18), ("Soir", 18, 23)]

def analyse(nom, jour_num):
    d = JOURS[nom]; heures = d["h"]
    scores = [score_horaire(heures, i, nom) for i in range(len(heures))]
    cs, cn = coef_secheresse(jour_num), coef_nuit(heures)
    pire_i = max(range(len(heures)), key=lambda i: scores[i])
    final = min(100, round(scores[pire_i] * cs * cn))
    periodes = []
    for lab, a, b in PERIODES:
        idxs = [i for i in range(len(heures)) if a <= heures[i][0] < b]
        pi = max(idxs, key=lambda i: scores[i])
        periodes.append({
            "label": lab,
            "score": min(100, round(scores[pi] * cs * cn)),
            "heure": heures[pi][0],
            "t":   max(heures[i][1] for i in idxs),
            "hum": min(heures[i][2] for i in idxs),
            "raf": max(heures[i][4] for i in idxs),
        })
    return {"nom":nom, "modele":d["modele"], "score":final, "pire_heure":heures[pire_i][0],
            "cs":cs, "cn":cn, "brut":scores[pire_i],
            "comp":composantes(heures, pire_i, nom), "periodes":periodes}
