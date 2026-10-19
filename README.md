# Trio

Version en ligne du jeu de cartes **Trio** (Kaya Miyano, Cogitum / Cocktail Games), pour jouer entre amis ou contre des bots. Usage personnel.

Dépôt : `s-foerster/trio`. Servi par `koyeb-apps` sous `/trio/` (le Dockerfile de koyeb-apps clone ce dépôt). Fonctionne aussi seul à la racine.

## Lancer en local

```powershell
cd C:\Users\Stephen\Documents\dev\trio
node server.js          # http://localhost:3004/
npm test                # 2 100 parties entre bots + test WebSocket bout en bout
```

Aucune dépendance npm : Node 18+ suffit (Node 22 pour `npm test`, qui utilise le client WebSocket intégré).

## Jouer

1. Entre un pseudo, puis **Créer une partie**. Un code à 4 chiffres s'affiche, et **Copier le lien** donne un lien direct.
2. Les autres entrent le code puis **Rejoindre**.
3. L'hôte ajoute des bots (facile, normal ou expert), choisit le mode et les équipes, puis lance la partie (3 à 6 joueurs).
4. À ton tour : touche une carte face cachée du milieu, **Min** / **Max** sous un adversaire, ou ta carte la plus à gauche / la plus à droite (surlignées).

Recharger la page ou perdre le réseau ne fait pas perdre sa place : on revient dans la partie automatiquement. Un joueur absent depuis 20 s pendant son tour est joué par un bot jusqu'à son retour. Quitter en pleine partie laisse sa place à un bot.

## Règles appliquées

- 36 cartes : 1 à 12, trois fois chacune. Mains triées.
- Distribution : 3 joueurs 9 cartes (9 au milieu), 4 joueurs 7 (8), 5 joueurs 6 (6), 6 joueurs 5 (6).
- À son tour, on révèle une par une : une carte du milieu, ou la plus petite / plus grande d'une main (la sienne comprise). Trois identiques : trio gagné. Deux nombres différents : le tour s'arrête et tout reprend sa place.
- Simple : 3 trios ou le trio de 7. Piquant : 2 trios liés (somme ou différence égale à 7) ou le trio de 7. Les nombres liés sont affichés en bas des cartes en mode piquant.
- Équipes (4 ou 6) : partenaires face à face (même couleur dans le salon, les flèches ↑↓ permettent de composer les équipes), toutes les cartes distribuées, échange d'une carte au début et après chaque trio d'une équipe adverse.

## Bots

Les bots ne trichent pas : ils ne connaissent que leur main et ce qui a été montré à tous. Leur mémoire dépend du niveau (facile 45 %, normal 80 %, expert 100 % de ce qu'ils ont vu). Ils cherchent d'abord un trio sûr, privilégient le 7 et les trios qui les feraient gagner, sinon ils tentent le coup le plus probable.

## Déployer

Push sur `main`, puis **Redeploy** du service Koyeb (koyeb-apps reconstruit sans cache et récupère la dernière version).

## Cartes

Les cartes sont dessinées par le jeu (couleur par nombre, anneau de points). Pour utiliser tes propres images, dépose `1.png` … `12.png` et `back.png` dans `public/cards/` : elles remplacent automatiquement les cartes dessinées.

## Fichiers

| Fichier | Rôle |
|---|---|
| `engine.js` | Règles (aucune entrée/sortie) |
| `bot.js` | Décisions des bots |
| `server.js` | HTTP statique + WebSocket `/ws`, salons à code, bots, reconnexion |
| `ws.js` | Mini serveur WebSocket sans dépendance |
| `public/` | Client (HTML / CSS / JS, sans build) |
| `test/` | Simulation de parties et test bout en bout |
