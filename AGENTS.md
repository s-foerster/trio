# Trio — contexte projet

## État
- Créé le 2026-10-19. Dépôt GitHub `s-foerster/trio` (local : `Documents\dev\trio`). Servi sous `/trio/` par le `gateway.js` de koyeb-apps (port interne 3004) ; le Dockerfile de koyeb-apps clone ce dépôt (branche main).
- Fonctionnel et testé (moteur, bots, salons, reconnexion, passage par le gateway). Poussé sur main le 2026-10-19, en attente du Redeploy Koyeb par Stephen.

## Choix
- Pour Stephen uniquement (usage personnel).
- Règles officielles Cogitum / Cocktail Games : modes simple et piquant, mode équipes à 4 ou 6. Pas de mode 2 joueurs (absent des règles officielles).
- Créer / rejoindre par code à 4 chiffres, comme Odin et Maboul. L'hôte ajoute des bots (facile / normal / expert).
- Aucune dépendance npm (le proxy npm de l'environnement de dev Claude était bloqué, et ça économise la mémoire sur Koyeb 512 Mo). Mémoire plafonnée à 64 Mo dans le gateway.
- Cartes dessinées par le jeu ; images perso possibles dans `public/cards/` (1.png … 12.png, back.png).

## Architecture
- `engine.js` règles pures ; `bot.js` IA (mémoire publique avec oubli selon le niveau) ; `server.js` HTTP + WebSocket ; `ws.js` WebSocket maison ; `public/` client vanilla JS.
- Messages client → serveur : create, join, resume, leave, addBot, removeMember, botLevel, options, seat, shuffleSeats, start, backToLobby, reveal, swap.
- Le serveur renvoie l'état complet filtré (`state`) après chaque action.
- `TRIO_FAST=1` accélère les pauses (tests).

## À faire / idées
- Vérifier en ligne après le Redeploy : `/trio/` et `/__gateway/health`.
