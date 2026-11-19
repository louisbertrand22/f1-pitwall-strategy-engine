# f1-pitwall-strategy-engine

Simulateur de mur des stands et moteur de stratégie de course F1, 100 % navigateur : un moteur de course déterministe (20 monoplaces, physique des pneus, météo évolutive, incidents, IA des neuf écuries rivales, projection Monte-Carlo) tourne dans un Web Worker, et l'interface React est un cockpit de télémétrie depuis lequel on dirige les deux voitures d'une écurie.

## Démarrer

```bash
npm install
```

```bash
npm run dev
```

Puis ouvrir http://localhost:5173 : choisir un circuit (Monaco, Silverstone, Spa-Francorchamps, Monza, Suzuka), une écurie, la météo et une graine, régler les plans A / B / C sur la grille, puis « Lights out ».

```bash
npm test
```

```bash
npm run build
```

## Ce que fait le cockpit

- **Timing tower** : position, intervalle, écart au leader, gomme et âge, secteurs violet / vert / jaune, arrêts, DRS.
- **Radar de piste** : 20 voitures en GPS temps réel, zones DRS, secteurs sous drapeau jaune, voiture de sécurité, voie des stands et **Pit Rejoin Ghost** (où la voiture ressortirait si elle rentrait à ce tour).
- **Pit wall** : pour les voitures #1 et #2 simultanément — rythme (Push / Balanced / Lift & Coast), ERS (Overtake / Balanced / Harvest), Defend, « Box, box » avec choix du train de pneus, consignes d'équipe (Free race / Hold / Swap) et double stack avec risque d'attente.
- **Simulateur d'undercut / overcut** : race trace projetée jusqu'au drapeau pour des arrêts à T+1, T+3, T+5 et pour le plan actif, avec distribution Monte-Carlo de la position finale.
- **Radar météo** : pluie, humidité de piste, prévision avec incertitude et fenêtres de transition slick ↔ inter ↔ wet.
- **Radio ingénieur-pilote** avec réponses rapides, **planificateur Plan A / B / C** (avant et pendant la course), **analyse de course** (lap chart, écarts, relais, impact de chaque arrêt, replay tour par tour).
- Vitesse de simulation x1 à x30, auto-ralenti quand une décision est attendue, et « race director » pour injecter SC, VSC, drapeau rouge ou averse.

Raccourcis : `Espace` pause, `1`–`5` vitesse de simulation.

La grille (écuries et pilotes) est fictive et se modifie dans `src/simulation/gridData.ts`. L'architecture, les formules du modèle de dégradation et le protocole du Worker sont décrits dans `CLAUDE.md`.
