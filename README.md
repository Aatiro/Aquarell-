# Aquarell

Web-App zum Malen realistischer Aquarelle – Vite + TypeScript, Simulation komplett in
WebGL2-Fragment-Shadern, kein Backend. Läuft auf Desktop und Mobilgeräten (Touch, Stylus-Druck).

```bash
npm install
npm run dev      # Entwicklungsserver
npm run build    # Typecheck + Produktionsbuild nach dist/
```

## Simulation

Alle Zustände liegen pro Pixel in Float-Texturen (Ping-Pong):

| Textur | Inhalt |
| --- | --- |
| `W` | Oberflächenwasser, Papierfeuchte, gelöstes Salz (RGBA32F, wenn verfügbar) |
| `P0/P1` | im Wasser schwebendes Pigment |
| `D0/D1` | am Papier abgesetztes Pigment der nassen Schicht |
| `Dry` | Transmission aller getrockneten Lasuren + deren Granulation |

Pigmente werden als **mixbox-Latentvektoren** (gewichtet mit der Pigmentmasse) gespeichert.
Summieren = Kubelka-Munk-Mischung; Blau + Gelb ergibt Grün.

Pro Simulationsschritt laufen zwei Passes:

1. **Fluss** – Wasser fliesst nur zwischen nassen/feuchten Zellen (Nass-in-Nass-Bluten),
   auf trockenes Papier kriecht es nur bei tiefen Pfützen entlang der Papierfasern.
   Pigment wird mit dem Wasser transportiert und wandert schneller als das Wasser nach aussen;
   Ränder und Papierspitzen verdunsten schneller → **Randabdunklung**.
   Salzkörner lösen sich, saugen Wasser und drängen Pigment weg.
2. **Ablagerung** – Pigment setzt sich ab (stärker, je weniger Wasser; granulierende
   Pigmente bevorzugt in den Tälern der prozeduralen Papiertextur), viel Wasser löst es wieder.
   Ist ein Pixel vollständig trocken, wird die nasse Schicht als **Lasur** multiplikativ
   (Beer-Lambert) in `Dry` eingebrannt – spätere Schichten liegen transparent darüber.

Papier (rau / glatt / Bütten) wird prozedural erzeugt (Worley + fBm + Fasern) und in
Simulations-, Anzeige- und Exportauflösung identisch berechnet, daher bleibt die
Granulation auch im 2×-Export scharf.

## Bedienung

- Werkzeuge: Pinsel (B), nasser Pinsel (W), Schwamm (S), Salz (X); `[` / `]` Pinselgrösse
- Regler für Grösse, Wasser, Pigment; Trocknungsgeschwindigkeit, Randabdunklung, Granulation
- 12 klassische Aquarellfarben + Mischfläche (Auftragen / Mischen / Aufnehmen)
- Rückgängig/Wiederholen (Strg+Z / Strg+Umschalt+Z), Leinwand leeren, PNG-Export in 2×
- **Generativ**: malt ein abstraktes Bild aus vielen transparenten Schichten deformierter Polygone
- **Zeitraffer**: spielt den Malvorgang aus dem Ereignisprotokoll neu ab (gleiche Simulation)

Für 60 FPS wird die Simulationsauflösung begrenzt (mobil ≈ 0,42 MP), bei langsamen Frames auf
einen Schritt pro Frame reduziert, und die Simulation pausiert, sobald alles getrocknet ist.
Die Undo-Tiefe richtet sich nach einem GPU-Speicherbudget.

## Lizenzhinweis

[mixbox](https://github.com/scrtwpns/mixbox) steht unter **CC BY-NC 4.0** – für kommerzielle
Nutzung ist eine Lizenz von Secret Weapons nötig.
