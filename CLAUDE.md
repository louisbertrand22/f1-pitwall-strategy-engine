# Pit Wall Strategy Engine

Simulateur de mur des stands F1 : un moteur de course déterministe (20 voitures, pneus, météo, incidents, IA des 9 écuries rivales, projection Monte-Carlo) tourne dans un Web Worker ; l'UI React est un cockpit de télémétrie où l'on pilote les deux voitures d'une écurie. Vite 8 · React 19 · TypeScript 7 strict · Tailwind 4 · Vitest 5.

## Commandes

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # tsc --noEmit puis bundle Vite (worker inclus)
npx tsc --noEmit       # typage seul
npm test               # vitest run (≈ 200 tests, ≈ 10 s)
npx vitest run src/simulation/physicsModel.test.ts   # un fichier
```

## Carte du code

| Chemin | Rôle |
|---|---|
| `src/simulation/types.ts` | Contrat de domaine partagé (types uniquement). À lire en premier. |
| `src/simulation/physicsModel.ts` | Fonctions pures : temps au tour, pneus, météo, pit loss, dépassement, incidents. |
| `src/simulation/trackData.ts` · `trackGeometry.ts` | 5 circuits (tracé SVG, secteurs, DRS, stands) → polyligne, profil de vitesse, mapping distance ↔ temps. |
| `src/simulation/aiStrategist.ts` | Optimiseur de stratégie, plans pré-course, décision en course (IA rivale + conseiller du joueur). |
| `src/simulation/projection.ts` | Simulateur undercut/overcut tour par tour + Monte-Carlo (générateur découpé en tranches). |
| `src/simulation/raceEngine.ts` | Moteur de course à pas fixe (drapeaux, SC/VSC/rouge, stands, radio, télémétrie joueur). Sans dépendance Worker → testable en headless. |
| `src/workers/raceSimulation.worker.ts` · `protocol.ts` | Boucle 60 Hz, échelle de temps, tranches de projection, protocole de messages. |
| `src/state/raceStore.ts` | Côté UI : possède le Worker, état React (flush 10 Hz), `LiveFrameSource` pour le canvas. |
| `src/components/` | Cockpit. Composants = vues pures de props (`contracts.ts`) ; ordres via `PitWallActions`. |

## Invariants à respecter

- **Domaine temporel** : la coordonnée d'une voiture est `tau` = secondes du tour de référence parcourues. Un écart de `tau` est un écart de temps ; la géométrie ne sert qu'à l'affichage (`timeToDistance`).
- **Déterminisme** : pas fixe `ENGINE_DT = 0.05 s`, tout l'aléa vient de `SeededRandom` (flux forkés). Jamais de `Math.random()` dans `src/simulation` ni dans le worker. La projection a son propre flux.
- Une seule physique : IA, projection, moteur et UI appellent `physicsModel.ts`, ne jamais redupliquer une formule.
- UI : la couleur encode du sens (pneus, drapeaux, secteurs, équipes, statuts), le chrome est neutre. Tokens dans `src/index.css` (`@theme static` : requis pour que les variables utilisées en SVG inline soient émises).
- Grille fictive (10 écuries / 20 pilotes) dans `gridData.ts` ; seul ce fichier connaît les noms.

## Modèle de temps au tour et de dégradation (`physicsModel.ts`)

Effets « par tour » définis pour un tour de 90 s et mis à l'échelle par `lapScale = baseLapTime / 90`.

```
lapTime = base + car + fuel + compound + degradation + warmup + wetness + dirtyAir + paceMode + ers + evolution − drs
```

- **Carburant** : `fuelKg × fuelEffectPerKg` (≈ 0,03 s/kg). Départ à 99,4 % du besoin → un peu de lift & coast (−7 % de conso).
- **Gommes** (`COMPOUNDS`) — usure `w` = fraction de vie utile (1 = cliff) :

  | | vie (tours) | k1 | k2 | chauffe W (s) | τ chauffe (tours) |
  |---|---|---|---|---|---|
  | SOFT | 16 | 1,30 | 0,90 | 2,4 | 0,25 |
  | MEDIUM | 28 | 1,25 | 0,75 | 3,4 | 0,40 |
  | HARD | 42 | 1,15 | 0,65 | 4,4 | 0,50 |
  | INTER | 30 | 1,20 | 0,70 | 4,0 | 0,40 |
  | WET | 36 | 1,10 | 0,60 | 4,5 | 0,50 |

  - Dégradation : `deg(w) = k1·w + k2·w² + [w > 1]·0,55·(e^{6,5·(w−1)} − 1)` (cliff, plafonné à 14 s).
  - Chauffe : `W·(1 − r)` ; la « readiness » `r` part de ≈ 0,5 (couvertures) et relaxe vers 1 : `r ← 1 + (r − 1)·e^{−tours/τ}` (cible 0,72 sous SC, 0,8 sous VSC).
  - Usure par tour : `(1/vie) · abrasiveness · tyreStress · mode · (1 + 0,2·fuel/110)/1,1 · temp · (1 + 0,15·dirtyAir) · drapeau · pilote · wetnessWearFactor` (inter/wet détruits sur piste sèche).
  - Écart entre gommes sèches : `track.compoundGap` (S→M, M→H). Crevaison possible au-delà de `w = 1,15`.
- **Piste mouillée** (`W` ∈ [0,1], s par tour de 90 s) : slick `75·max(0, W−0,03)^1,75` (×1,06 M, ×1,14 H) · inter `4,5 + 9W + 3,5W² + 60·max(0, W−0,5)²` · wet `9 + 6,5W + 2W²`. Les croisements sont résolus numériquement : `WEATHER_CROSSOVER ≈ { slickToInter: 0,30, interToWet: 0,69 }`. Humidité : relaxation du 1er ordre vers `1,15·R^0,75`.
- **Air sale** : `0,55 · dirtyAirSensitivity · f(gap)`, plein sous 0,3 s, nul à 1,2 s (quadratique). **DRS** : +4,2 % de vitesse dans la zone si ≤ 1,0 s à la détection ; activé 2 tours après départ/relance, coupé au-delà de 20 % d'humidité.
- **Modes** : PUSH −0,38 s (usure ×1,22, conso ×1,035) · CONSERVE +0,48 s (×0,78, ×0,93) · ERS OVERTAKE −0,32 s (−26 %/tour) · HARVEST +0,28 s (+24 %/tour).
- **Pit loss** : `track.pitLossSeconds` inclut 2,5 s d'immobilisation ; ×0,65 sous VSC, ×0,55 sous SC. Arrêt ≈ moyenne équipe + |N(0, 0,22)|, 6 % d'arrêts lents (+1,5 à 6,5 s). Double stack : attente `max(0, arrêt₁ + 1,2 − écart)`.
- **Dépassement** : avantage requis `(0,3 + 1,9·d² + 2,6·d¹²)·lapScale` (`d` = overtakingDifficulty), probabilité logistique par opportunité (fin de zone DRS, gros freinages).
- **Incidents** : taux par voiture-tour `−ln(1 − P)/(voitures·tours)` calé sur `safetyCarProbability` / `vscProbability` du circuit.

Équilibrage : toute modification de `COMPOUNDS` ou des paramètres de `trackData.ts` déplace l'optimum 1 arrêt / 2 arrêts — vérifier avec `aiStrategist.test.ts` et `integration.test.ts`.

## Protocole du Web Worker (`src/workers/protocol.ts`)

UI → worker (`WorkerCommand`) :

| Type | Effet |
|---|---|
| `INIT { config }` | Construit la course (grille, allocations, météo, plans) → `READY` |
| `START` · `PAUSE` · `RESUME` · `SET_TIME_SCALE { scale: 1\|2\|5\|15\|30 }` · `SET_AUTO_SLOW` | Horloge de simulation |
| `SET_PACE_MODE` · `SET_ERS_MODE` · `SET_DEFEND` | Ordres par voiture |
| `SET_TEAM_ORDER` · `SWAP_POSITIONS` | Consignes d'équipe |
| `BOX { carId, setId }` · `CANCEL_BOX` · `DOUBLE_STACK { setIds }` | Appels aux stands |
| `SET_STRATEGY` · `SET_ACTIVE_PLAN` · `SET_AUTO_BOX` | Plans A/B/C |
| `RADIO_REPLY { messageId, replyId }` | Réponse rapide à la radio |
| `REQUEST_PROJECTION { carId, compound, offsets }` | Lance la projection (candidats T+n) |
| `RACE_CONTROL { action }` | Bac à sable : SC, VSC, drapeau rouge, averse, séchage |

Worker → UI (`WorkerEvent`) : `READY` · `SNAPSHOT` (~30 Hz, état complet) · `LAPS` · `PIT_STOP` · `RACE_EVENT` · `RADIO` (création ou mise à jour par `id`) · `WEATHER` (échantillon + prévision) · `PROJECTION` · `FINISHED` (classement) · `ERROR`.

Le snapshot est la seule source de vérité : l'UI ne garde que de l'état transitoire. L'historique (`LAPS`, `PIT_STOP`, …) est en ajout seul.
